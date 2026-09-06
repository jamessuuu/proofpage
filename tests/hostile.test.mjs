// R6: the CLI must survive hostile input with a stated error and a non-zero
// exit, never a raw stack trace. Each test below reproduces a real crash
// found by manual probing (2026-09-06) and pins the fixed behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { main } from '../bin/proofpage.mjs';

function withCapturedOutput(fn) {
  const err = [];
  const out = [];
  const originalErr = process.stderr.write.bind(process.stderr);
  const originalOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (chunk) => {
    err.push(String(chunk));
    return true;
  };
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stderr.write = originalErr;
      process.stdout.write = originalOut;
    })
    .then((code) => ({ code, stderr: err.join(''), stdout: out.join('') }));
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'proofpage-hostile-'));
}

function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  return Promise.resolve()
    .then(fn)
    .finally(() => process.chdir(prev));
}

// --- 1. missing file ---------------------------------------------------------

test('hostile: --check against a nonexistent file produces a stated error and exit 2', async () => {
  const dir = tempDir();
  try {
    const { code, stderr } = await withCapturedOutput(() => main(['--check', path.join(dir, 'nope.html')]));
    assert.equal(code, 2);
    assert.match(stderr, /usage: proofpage --check/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('hostile: `render` with no proof.json in cwd produces a stated error and exit 2', async () => {
  const dir = tempDir();
  try {
    const { code, stderr } = await inDir(dir, () => withCapturedOutput(() => main(['render'])));
    assert.equal(code, 2);
    assert.match(stderr, /no proof\.json found/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// --- 2. malformed file --------------------------------------------------------

test('hostile: a malformed proofpage.json produces a stated error and exit 2, not a raw stack trace', async () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, 'proofpage.json'), '{ "checks": [oops', 'utf8');
    const { code, stderr } = await inDir(dir, () => withCapturedOutput(() => main([])));
    assert.equal(code, 2);
    assert.match(stderr, /error: proofpage\.json is not valid JSON/);
    assert.doesNotMatch(stderr, /at discoverChecks/); // no stack trace leaked to the user
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('hostile: a proofpage.json with no usable "checks" array produces a stated error and exit 2', async () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, 'proofpage.json'), JSON.stringify({ checks: [] }), 'utf8');
    const { code, stderr } = await inDir(dir, () => withCapturedOutput(() => main(['run'])));
    assert.equal(code, 2);
    assert.match(stderr, /error: proofpage\.json has no "checks" array/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('hostile: a malformed proof.json fed to `render` produces a stated error and exit 2, not a raw SyntaxError', async () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, 'proof.json'), '{ "checks": [oops', 'utf8');
    const { code, stderr } = await inDir(dir, () => withCapturedOutput(() => main(['render'])));
    assert.equal(code, 2);
    assert.match(stderr, /error: proof\.json is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// --- 3. empty file -------------------------------------------------------------

test('hostile: an empty (0-byte) proofpage.json produces a stated error and exit 2', async () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, 'proofpage.json'), '', 'utf8');
    const { code, stderr } = await inDir(dir, () => withCapturedOutput(() => main([])));
    assert.equal(code, 2);
    assert.match(stderr, /error: proofpage\.json is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('hostile: an empty (0-byte) package.json is not an error -- 0 checks discovered, exit 0', async () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, 'package.json'), '', 'utf8');
    const { code } = await inDir(dir, () => withCapturedOutput(() => main([])));
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// --- 4. a file far larger than expected ----------------------------------------

test('hostile: a check whose output exceeds the spawn maxBuffer is recorded as "did not run", never a crash', async () => {
  // Regression guard for a real risk in runOneCheck: spawnSync's maxBuffer is
  // fixed at 64MB. A check that floods stdout past that must surface as a
  // measured "did not run" (ENOBUFS), never an uncaught exception.
  const dir = tempDir();
  try {
    const bigOutputCmd =
      'node -e "const s=\'x\'.repeat(1024*1024); for(let i=0;i<80;i++) process.stdout.write(s);"';
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: bigOutputCmd } }),
      'utf8',
    );
    const { code } = await inDir(dir, () => withCapturedOutput(() => main(['run'])));
    assert.equal(code, 1); // measured, and it did not run cleanly -- not a crash
    const proof = JSON.parse(readFileSync(path.join(dir, 'proof.json'), 'utf8'));
    assert.equal(proof.checks[0].ran, false);
    assert.ok(proof.checks[0].spawnError);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('hostile: `--check` on a large (multi-megabyte) HTML file completes and reports a size warning, not a crash', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'big.html');
    const head = '<!doctype html><html><head><meta charset="utf-8"></head><body>';
    const body = '<p>' + 'x'.repeat(1000) + '</p>\n';
    const target = 6 * 1024 * 1024;
    let text = head;
    while (text.length < target) text += body;
    text += '</body></html>';
    writeFileSync(file, text, 'utf8');
    const { code, stdout } = await withCapturedOutput(() => main(['--check', file]));
    assert.equal(code, 1); // missing viewport meta etc. -- a real, reported problem
    assert.match(stdout, /WARN\s+large file/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// --- 5. wrong-type argument -----------------------------------------------------

test('hostile: --check against a directory produces a stated error and exit 2, not an EISDIR stack trace', async () => {
  const dir = tempDir();
  try {
    const sub = path.join(dir, 'a-directory');
    mkdirSync(sub);
    const { code, stderr } = await withCapturedOutput(() => main(['--check', sub]));
    assert.equal(code, 2);
    assert.match(stderr, /error: not a file/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('hostile: `render` when proof.json is actually a directory produces a stated error and exit 2, not an EISDIR stack trace', async () => {
  const dir = tempDir();
  try {
    mkdirSync(path.join(dir, 'proof.json'));
    const { code, stderr } = await inDir(dir, () => withCapturedOutput(() => main(['render'])));
    assert.equal(code, 2);
    assert.match(stderr, /error: not a file/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
