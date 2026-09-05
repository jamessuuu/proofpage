#!/usr/bin/env node
// bin/proofpage.mjs - the CLI. Thin: it only wires argv to src/run.mjs and
// src/render.mjs, and decides the process exit code.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../src/run.mjs';
import { renderProof, checkFile } from '../src/render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp() {
  process.stdout.write(`proofpage - turn a repo's real test/typecheck/build/lint run into a verifiable receipts page.

Usage:
  proofpage                run every discovered check and write proof.json + proof.html
  proofpage run            run every discovered check and write proof.json only
  proofpage render         render an HTML page from an existing proof.json
  proofpage --check <file> verify a rendered HTML file is honest

Options:
  --out <file>    output HTML file (default: proof.html)
  --help, -h      show this help
  --version, -v   show the installed version

proofpage refuses to print any number it did not measure. If a check did not
run, or its output could not be parsed with confidence, the page says so
instead of guessing. It exits non-zero if any measured check failed (or
could not run), so it works as a CI gate.
`);
}

function flagValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] ?? null;
}

function stripFlagWithValue(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      i++; // also skip its value
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

function exitCodeForProof(proof) {
  return proof.summary.failed > 0 || proof.summary.didNotRun > 0 ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${readPkgVersion()}\n`);
    return 0;
  }

  const cwd = process.cwd();

  if (argv.includes('--check')) {
    const file = flagValue(argv, 'check');
    if (!file || !existsSync(file)) {
      process.stderr.write('usage: proofpage --check <file.html>\n');
      return 2;
    }
    return checkFile(file);
  }

  const outFile = flagValue(argv, 'out') || 'proof.html';
  const remaining = stripFlagWithValue(argv, 'out');
  const subcommand = remaining.find((a) => !a.startsWith('--')) || 'default';

  if (subcommand === 'run') {
    const proof = run({ cwd });
    process.stdout.write(
      `wrote proof.json - ${proof.summary.passed}/${proof.summary.totalChecks} checks passed` +
        (proof.summary.didNotRun ? `, ${proof.summary.didNotRun} did not run` : '') +
        '\n',
    );
    return exitCodeForProof(proof);
  }

  if (subcommand === 'render') {
    const jsonPath = path.join(cwd, 'proof.json');
    if (!existsSync(jsonPath)) {
      process.stderr.write('no proof.json found in the current directory. Run `proofpage run` first.\n');
      return 2;
    }
    const proof = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const html = renderProof(proof);
    const outPath = path.isAbsolute(outFile) ? outFile : path.join(cwd, outFile);
    writeFileSync(outPath, html, 'utf8');
    process.stdout.write(`wrote ${outFile}\n`);
    return exitCodeForProof(proof);
  }

  if (subcommand !== 'default') {
    process.stderr.write(`unknown subcommand: ${subcommand}\n`);
    printHelp();
    return 2;
  }

  // default: run + render
  const proof = run({ cwd });
  const html = renderProof(proof);
  const outPath = path.isAbsolute(outFile) ? outFile : path.join(cwd, outFile);
  writeFileSync(outPath, html, 'utf8');
  process.stdout.write(
    `wrote proof.json and ${outFile} - ${proof.summary.passed}/${proof.summary.totalChecks} checks passed` +
      (proof.summary.didNotRun ? `, ${proof.summary.didNotRun} did not run` : '') +
      '\n',
  );
  return exitCodeForProof(proof);
}

process.exit(main(process.argv.slice(2)));
