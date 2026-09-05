// tests/cli.test.mjs - end-to-end proof that the packaged CLI (not just the
// library functions) actually runs commands and exits non-zero in CI when a
// measured check failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'proofpage.mjs');

test('CLI default command runs checks, writes proof.json + proof.html, and exits non-zero when a check fails', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'proofpage-cli-'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(1)"' } }), // fails on purpose
  );

  const result = spawnSync(process.execPath, [BIN], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.ok(existsSync(path.join(dir, 'proof.json')));
  assert.ok(existsSync(path.join(dir, 'proof.html')));

  const checkResult = spawnSync(process.execPath, [BIN, '--check', path.join(dir, 'proof.html')], { encoding: 'utf8' });
  assert.equal(checkResult.status, 0, checkResult.stdout + checkResult.stderr); // our own output must be honest by construction
  assert.ok(checkResult.stdout.includes('PASS'));

  rmSync(dir, { recursive: true, force: true });
});

test('CLI exits 0 when every discovered check passes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'proofpage-cli-ok-'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  const result = spawnSync(process.execPath, [BIN], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI run+render split works and --out is respected', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'proofpage-cli-split-'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  const runResult = spawnSync(process.execPath, [BIN, 'run'], { cwd: dir, encoding: 'utf8' });
  assert.equal(runResult.status, 0, runResult.stdout + runResult.stderr);
  assert.ok(existsSync(path.join(dir, 'proof.json')));
  assert.ok(!existsSync(path.join(dir, 'proof.html')));

  const renderResult = spawnSync(process.execPath, [BIN, 'render', '--out', 'custom.html'], { cwd: dir, encoding: 'utf8' });
  assert.equal(renderResult.status, 0, renderResult.stdout + renderResult.stderr);
  assert.ok(existsSync(path.join(dir, 'custom.html')));
  assert.ok(!existsSync(path.join(dir, 'proof.html')));

  rmSync(dir, { recursive: true, force: true });
});

test('CLI --check reports a non-zero exit and FAIL lines for a dishonest file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'proofpage-cli-badcheck-'));
  const badFile = path.join(dir, 'bad.html');
  writeFileSync(badFile, '<!doctype html><html><head><script>1</script></head><body></body></html>');
  const result = spawnSync(process.execPath, [BIN, '--check', badFile], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('FAIL'));
  rmSync(dir, { recursive: true, force: true });
});

test('CLI --help and --version exit cleanly', () => {
  const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('proofpage'));

  const version = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.ok(/^\d+\.\d+\.\d+/.test(version.stdout.trim()));
});
