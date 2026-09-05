// tests/run.test.mjs - proves that src/run.mjs actually executes commands
// and records reality, rather than fabricating results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverChecks, runOneCheck, run, parseOutput, getGitInfo } from '../src/run.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.join(__dirname, 'fixtures', 'sample-repo');

function tmpDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- discovery --------------------------------------------------------------

test('discoverChecks reads proofpage.json when present, and marks entries as not auto', () => {
  const { source, checks } = discoverChecks(FIXTURE_REPO);
  assert.equal(source, 'proofpage.json');
  assert.equal(checks.length, 5);
  assert.ok(checks.every((c) => c.auto === false));
  const names = checks.map((c) => c.name);
  assert.deepEqual(names, ['pass', 'fail', 'unittest', 'fake-tsc-shaped-output', 'unparseable']);
});

test('discoverChecks auto-detects from package.json scripts when there is no proofpage.json', () => {
  const dir = tmpDir('proofpage-autodetect-');
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'x',
      scripts: {
        test: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
        irrelevant: 'echo hi', // not one of the four recognized keys
      },
    }),
  );
  const { source, checks } = discoverChecks(dir);
  assert.equal(source, 'auto-detected');
  assert.deepEqual(
    checks.map((c) => c.name).sort(),
    ['lint', 'test'],
  );
  assert.ok(checks.every((c) => c.auto === true));
  assert.ok(checks.every((c) => c.command.startsWith('npm run ')));
  rmSync(dir, { recursive: true, force: true });
});

test('discoverChecks reports "none" when there is nothing to discover', () => {
  const dir = tmpDir('proofpage-empty-');
  const { source, checks } = discoverChecks(dir);
  assert.equal(source, 'none');
  assert.equal(checks.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ---- executing one check -----------------------------------------------------

test('runOneCheck actually executes the command and captures a real passing exit code', () => {
  const result = runOneCheck({ name: 'pass', command: 'npm run pass', auto: false }, { cwd: FIXTURE_REPO });
  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.spawnError, null);
  assert.ok(result.durationMs >= 0);
});

test('runOneCheck actually executes the command and captures a real non-zero exit code', () => {
  const result = runOneCheck({ name: 'fail', command: 'npm run fail', auto: false }, { cwd: FIXTURE_REPO });
  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 1);
});

test('runOneCheck parses a real node:test summary from a real `node --test` run', () => {
  const result = runOneCheck({ name: 'unittest', command: 'npm run unittest', auto: false }, { cwd: FIXTURE_REPO });
  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 1); // one of the two fixture tests fails on purpose
  assert.equal(result.parsed.ok, true);
  assert.equal(result.parsed.kind, 'node:test');
  assert.equal(result.parsed.counts.pass, 1);
  assert.equal(result.parsed.counts.fail, 1);
  assert.equal(result.parsed.counts.total, 2);
});

test('runOneCheck records unparsed, never a fabricated count, when the output shape is unknown', () => {
  const result = runOneCheck(
    { name: 'unparseable', command: "node -e \"console.log('nothing recognizable here')\"", auto: false },
    { cwd: FIXTURE_REPO },
  );
  assert.equal(result.ran, true);
  assert.equal(result.parsed.ok, false);
  assert.ok(result.parsed.reason.length > 0);
  assert.equal('counts' in result.parsed, false);
});

test('runOneCheck marks a check that could not be spawned as ran:false, never as a fake pass', () => {
  const bogusCwd = path.join(os.tmpdir(), `proofpage-does-not-exist-${Date.now()}`);
  const result = runOneCheck({ name: 'x', command: 'node -e "process.exit(0)"', auto: false }, { cwd: bogusCwd });
  assert.equal(result.ran, false);
  assert.equal(result.exitCode, null);
  assert.ok(result.spawnError);
  assert.equal(result.parsed.ok, false);
  assert.equal(result.output.tail.length, 0);
});

test('runOneCheck strips NODE_TEST_CONTEXT so a nested `node --test` check is never silently skipped by node\'s own recursion guard', () => {
  // This proves the fix for a real bug found while building this suite:
  // running under `node --test` (as this very test does) sets
  // NODE_TEST_CONTEXT in process.env; if that leaks to a spawned child that
  // itself runs `node --test`, node treats it as recursive and skips
  // running the tests entirely, exiting 0 with zero tests run - a silent
  // false pass. Since this test file itself runs under node --test,
  // process.env.NODE_TEST_CONTEXT is set right now, and runOneCheck must
  // not let it leak into the child.
  assert.ok(process.env.NODE_TEST_CONTEXT, 'expected this test itself to be running under node --test');
  const result = runOneCheck({ name: 'unittest', command: 'npm run unittest', auto: false }, { cwd: FIXTURE_REPO });
  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 1); // real failure from the fixture's one failing test
  assert.equal(result.parsed.ok, true);
  assert.equal(result.parsed.counts.total, 2);
  assert.ok(!result.output.tail.join('\n').includes('being called recursively'));
});

test('runOneCheck redacts credential-shaped strings from captured output before they reach proof.json', () => {
  const fakeSecret = 'ghp_' + 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4'; // github-token-shaped, not a real token
  const result = runOneCheck(
    { name: 'leaky', command: `node -e "console.log('token=${fakeSecret}')"`, auto: false },
    { cwd: FIXTURE_REPO },
  );
  const joined = result.output.tail.join('\n');
  assert.ok(!joined.includes(fakeSecret));
  assert.ok(joined.includes('[REDACTED]'));
});

// ---- output parsing -----------------------------------------------------------

test('parseOutput reads a real tsc-shaped "Found N errors" line', () => {
  const parsed = parseOutput('some noise\nFound 3 errors.\n');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, 'tsc');
  assert.equal(parsed.counts.errors, 3);
});

test('parseOutput also recognizes the classic TAP-reporter shape ("# pass N" / "# fail N")', () => {
  const tap = 'ok 1 - a\nnot ok 2 - b\n# tests 2\n# pass 1\n# fail 1\n';
  const parsed = parseOutput(tap);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, 'node:test');
  assert.deepEqual(parsed.counts, { pass: 1, fail: 1, total: 2 });
});

test('parseOutput handles the singular "Found 1 error." form', () => {
  const parsed = parseOutput('Found 1 error.\n');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.counts.errors, 1);
});

test('parseOutput does not guess a count when nothing matches a known shape', () => {
  const parsed = parseOutput('totally unrelated output, nothing to parse here');
  assert.equal(parsed.ok, false);
  assert.ok(parsed.reason.length > 0);
});

// ---- git provenance -----------------------------------------------------------

test('getGitInfo reports available:false outside of any git repository', () => {
  const dir = tmpDir('proofpage-nogit-');
  const info = getGitInfo(dir);
  assert.equal(info.available, false);
  assert.ok(info.reason);
  rmSync(dir, { recursive: true, force: true });
});

test('getGitInfo detects a dirty working tree honestly, against a real isolated git repo', () => {
  const dir = tmpDir('proofpage-gitdirty-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(path.join(dir, 'a.txt'), 'one');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

  const cleanInfo = getGitInfo(dir);
  assert.equal(cleanInfo.available, true);
  assert.equal(cleanInfo.dirty, false);
  assert.equal(cleanInfo.sha.length, 40);

  writeFileSync(path.join(dir, 'a.txt'), 'two'); // uncommitted change
  const dirtyInfo = getGitInfo(dir);
  assert.equal(dirtyInfo.dirty, true);
  assert.equal(dirtyInfo.sha, cleanInfo.sha); // same commit, tree just got dirty

  rmSync(dir, { recursive: true, force: true });
});

// ---- orchestration --------------------------------------------------------------

test('run() writes proof.json to disk and computes a real summary from real exit codes', () => {
  const dir = tmpDir('proofpage-writetest-');
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  const proof = run({ cwd: dir, outFile: 'proof.json' });
  assert.equal(proof.summary.totalChecks, 1);
  assert.equal(proof.summary.passed, 1);
  assert.equal(proof.summary.failed, 0);
  assert.ok(existsSync(path.join(dir, 'proof.json')));
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'proof.json'), 'utf8'));
  assert.equal(onDisk.summary.totalChecks, 1);
  assert.equal(onDisk.source, 'auto-detected');
  rmSync(dir, { recursive: true, force: true });
});

test('run() against the fixture repo computes an honest summary across pass/fail/parsed/unparsed checks', () => {
  const proof = run({ cwd: FIXTURE_REPO, outFile: null });
  assert.equal(proof.summary.totalChecks, 5);
  // pass:0 -> passed, fail:1 -> failed, unittest:1 -> failed,
  // fake-tsc-shaped-output:0 -> passed, unparseable:0 -> passed
  assert.equal(proof.summary.passed, 3);
  assert.equal(proof.summary.failed, 2);
  assert.equal(proof.summary.didNotRun, 0);
  assert.equal(proof.source, 'proofpage.json');
  assert.ok(!existsSync(path.join(FIXTURE_REPO, 'proof.json'))); // outFile:null must not write
});

test('run() records env and git fields without fabricating them', () => {
  const proof = run({ cwd: FIXTURE_REPO, outFile: null });
  assert.equal(proof.env.node, process.version);
  assert.equal(proof.env.platform, process.platform);
  assert.equal(typeof proof.git.available, 'boolean');
});
