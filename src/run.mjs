#!/usr/bin/env node
// src/run.mjs - measure. Actually execute a repo's checks and record what
// really happened. Nothing in this file is allowed to invent a number: if a
// command can't be spawned, that is recorded as "did not run", not as a
// fabricated exit code; if a command's output doesn't match a known shape,
// that is recorded as "unparsed", not as a guessed count.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSecrets } from './redact.mjs';

const DEFAULT_CAP_LINES = 40;
const AUTO_DETECT_KEYS = ['test', 'typecheck', 'lint', 'build'];

// ---- discovery -------------------------------------------------------------

/**
 * Discover checks for a repo at `cwd`. If proofpage.json exists, its
 * "checks" array is used verbatim (and only that - auto-detection does not
 * also run). Otherwise, package.json's `test`/`typecheck`/`lint`/`build`
 * scripts are used, each run as `npm run <name>`, marked auto:true so the
 * rendered page can say detection was automatic.
 * @param {string} cwd
 * @returns {{ source: 'proofpage.json'|'auto-detected'|'none', checks: Array<{name:string, command:string, auto:boolean}> }}
 */
export function discoverChecks(cwd) {
  const configPath = path.join(cwd, 'proofpage.json');
  if (existsSync(configPath)) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`proofpage.json is not valid JSON: ${e.message}`);
    }
    const checks = Array.isArray(raw.checks) ? raw.checks : [];
    if (!checks.length) {
      throw new Error('proofpage.json has no "checks" array (or it is empty)');
    }
    for (const c of checks) {
      if (!c || typeof c.name !== 'string' || typeof c.command !== 'string') {
        throw new Error('every entry in proofpage.json "checks" needs a string "name" and a string "command"');
      }
    }
    return {
      source: 'proofpage.json',
      checks: checks.map((c) => ({ name: c.name, command: c.command, auto: false })),
    };
  }

  const pkgPath = path.join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    return { source: 'none', checks: [] };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return { source: 'none', checks: [] };
  }
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const checks = [];
  for (const key of AUTO_DETECT_KEYS) {
    if (typeof scripts[key] === 'string') {
      checks.push({ name: key, command: `npm run ${key}`, auto: true });
    }
  }
  return { source: checks.length ? 'auto-detected' : 'none', checks };
}

// ---- output parsing ---------------------------------------------------------
// Only parse shapes that are unambiguous. Anything else is reported as
// unparsed, with a reason, rather than guessed.

// node:test's summary lines come in two known shapes depending on reporter:
// the TAP reporter prints "# pass N" / "# fail N" / "# tests N"; the default
// "spec"-style reporter prints "ℹ pass N" / "ℹ fail N" / "ℹ tests N"
// (the same info marker used for every summary line). Both are unambiguous,
// deterministic lines emitted by node:test itself, never a heuristic guess.
function parseNodeTest(output) {
  const passM = /^[#ℹ]\s*pass\s+(\d+)\s*$/m.exec(output);
  const failM = /^[#ℹ]\s*fail\s+(\d+)\s*$/m.exec(output);
  if (!passM || !failM) return null;
  const testsM = /^[#ℹ]\s*tests\s+(\d+)\s*$/m.exec(output);
  return {
    kind: 'node:test',
    counts: {
      pass: Number(passM[1]),
      fail: Number(failM[1]),
      total: testsM ? Number(testsM[1]) : Number(passM[1]) + Number(failM[1]),
    },
  };
}

function parseTsc(output) {
  const m = /Found (\d+) errors?\b/.exec(output);
  if (!m) return null;
  return { kind: 'tsc', counts: { errors: Number(m[1]) } };
}

const PARSERS = [parseNodeTest, parseTsc];

/**
 * Try each known parser against raw combined stdout+stderr. Returns either
 * `{ ok: true, kind, counts }` for a confident parse, or
 * `{ ok: false, reason }` when nothing matched - never a guess.
 * @param {string} output
 */
export function parseOutput(output) {
  for (const parser of PARSERS) {
    const result = parser(output);
    if (result) return { ok: true, ...result };
  }
  return {
    ok: false,
    reason: 'output did not match a known shape (node:test summary or tsc "Found N errors")',
  };
}

// ---- git provenance ---------------------------------------------------------

function gitCommand(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/**
 * Commit SHA, branch, and dirty-tree state for `cwd`. Returns
 * `{ available: false, reason }` when there is no usable git repo (or git
 * isn't installed) rather than fabricating provenance.
 * @param {string} cwd
 */
export function getGitInfo(cwd) {
  const sha = gitCommand(['rev-parse', 'HEAD'], cwd);
  if (sha === null) {
    return { available: false, reason: 'not a git repository, or git is not installed' };
  }
  const branchRaw = gitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const statusRaw = gitCommand(['status', '--porcelain'], cwd);
  return {
    available: true,
    sha: sha.trim(),
    branch: branchRaw === null ? 'unknown' : branchRaw.trim(),
    // null (not false) when we genuinely could not determine dirtiness, so
    // the renderer can say "unknown" instead of implying a clean tree.
    dirty: statusRaw === null ? null : statusRaw.trim().length > 0,
  };
}

// ---- executing one check ----------------------------------------------------

/**
 * Actually execute one check's command. Always returns a result object;
 * never throws. If the command could not be spawned at all (e.g. `cwd`
 * doesn't exist), `ran` is false, `exitCode` is null, and `spawnError` names
 * what happened - this is never rendered as a pass.
 * @param {{name:string, command:string, auto?:boolean}} check
 * @param {{cwd:string, capLines?:number}} opts
 */
export function runOneCheck(check, { cwd, capLines = DEFAULT_CAP_LINES } = {}) {
  const startedAt = new Date().toISOString();

  // If proofpage itself is running under `node --test` (e.g. its own test
  // suite, or a user's outer harness), node sets NODE_TEST_CONTEXT /
  // NODE_TEST_WORKER_ID in the environment. A check command that shells out
  // to its own `node --test` would inherit that and hit node's built-in
  // recursion guard, which SKIPS running the tests entirely and exits 0 -
  // a silent false pass. Strip those before spawning so a real check never
  // gets no-op'd by an artifact of the environment it happens to run in.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;

  const t0 = process.hrtime.bigint();
  const result = spawnSync(check.command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: childEnv,
  });
  const t1 = process.hrtime.bigint();
  const durationMs = Number(t1 - t0) / 1e6;

  if (result.error) {
    return {
      name: check.name,
      command: check.command,
      auto: !!check.auto,
      ran: false,
      spawnError: result.error.message,
      exitCode: null,
      signal: null,
      durationMs,
      startedAt,
      output: { capLines, totalLines: 0, truncated: false, tail: [] },
      parsed: { ok: false, reason: 'command did not run, so there is no output to parse' },
    };
  }

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const combinedRaw = stdout + (stderr ? (stdout ? '\n' : '') + stderr : '');
  const { text: combined } = redactSecrets(combinedRaw);

  const parsed = parseOutput(combined);

  const lines = combined.length ? combined.replace(/\r\n/g, '\n').split('\n') : [];
  const totalLines = lines.length;
  const truncated = totalLines > capLines;
  const tail = truncated ? lines.slice(-capLines) : lines;

  return {
    name: check.name,
    command: check.command,
    auto: !!check.auto,
    ran: true,
    spawnError: null,
    exitCode: result.status === null ? null : result.status,
    signal: result.signal || null,
    durationMs,
    startedAt,
    output: { capLines, totalLines, truncated, tail },
    parsed,
  };
}

// ---- orchestration -----------------------------------------------------------

/**
 * Discover, run, and record every check for `cwd`. Writes proof.json unless
 * `outFile` is falsy. Returns the proof object either way.
 * @param {{cwd?:string, outFile?:string|null, capLines?:number}} opts
 */
export function run({ cwd = process.cwd(), outFile = 'proof.json', capLines = DEFAULT_CAP_LINES } = {}) {
  const generatedAt = new Date().toISOString();
  const { source, checks: discovered } = discoverChecks(cwd);
  const git = getGitInfo(cwd);

  const checks = discovered.map((check) => runOneCheck(check, { cwd, capLines }));

  const passed = checks.filter((c) => c.ran && c.exitCode === 0).length;
  const failed = checks.filter((c) => c.ran && c.exitCode !== 0).length;
  const didNotRun = checks.filter((c) => !c.ran).length;

  const proof = {
    schemaVersion: 1,
    generatedAt,
    cwd,
    source,
    env: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
    },
    git,
    checks,
    summary: {
      totalChecks: checks.length,
      passed,
      failed,
      didNotRun,
    },
  };

  if (outFile) {
    const outPath = path.isAbsolute(outFile) ? outFile : path.join(cwd, outFile);
    writeFileSync(outPath, JSON.stringify(proof, null, 2) + '\n', 'utf8');
  }

  return proof;
}

// ---- standalone CLI use (bin/proofpage.mjs is the documented entry point;
// this just makes `node src/run.mjs` a convenient way to measure without
// rendering, e.g. while developing) ------------------------------------------

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const proof = run({ cwd: process.cwd() });
  process.stdout.write(
    `wrote proof.json - ${proof.summary.passed}/${proof.summary.totalChecks} checks passed` +
      (proof.summary.didNotRun ? `, ${proof.summary.didNotRun} did not run` : '') +
      '\n',
  );
  process.exit(proof.summary.failed > 0 || proof.summary.didNotRun > 0 ? 1 : 0);
}
