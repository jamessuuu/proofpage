#!/usr/bin/env node
// scripts/lint.mjs - the project's "lint" script. proofpage ships with zero
// dependencies, so there is no ESLint here; this is a genuine, if minimal,
// static check: every .mjs file under bin/, src/, tests/, and scripts/ must
// parse as valid JavaScript. It will not catch style issues, but it does
// catch syntax errors, and it never lies about what it checked.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const p = path.join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p, out);
    } else if (entry.endsWith('.mjs')) {
      out.push(p);
    }
  }
  return out;
}

const roots = ['bin', 'src', 'tests', 'scripts'];
let checked = 0;
let failed = 0;

for (const root of roots) {
  const dir = path.join(repoRoot, root);
  let files;
  try {
    files = walk(dir);
  } catch {
    continue;
  }
  for (const f of files) {
    checked++;
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      failed++;
      process.stderr.write(`FAIL  ${path.relative(repoRoot, f)}\n`);
      process.stderr.write(String(e.stderr || e.message) + '\n');
    }
  }
}

if (failed) {
  process.stderr.write(`\n${failed}/${checked} file(s) failed syntax check\n`);
  process.exit(1);
}
process.stdout.write(`${checked}/${checked} file(s) passed syntax check\n`);
