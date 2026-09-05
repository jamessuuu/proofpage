// tests/render.test.mjs - proves every --check rule actually bites (a
// fixture that violates exactly that rule fails, a clean fixture passes),
// and proves the honesty law holds in rendered output.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkHtmlString, renderProof } from '../src/render.mjs';

// A minimal, self-contained document that satisfies every --check rule.
// Every mutation test below starts from this and breaks exactly one rule.
function cleanHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test</title>
<style>@media print { body { color: black; } }</style>
</head>
<body>
<h1>Report</h1>
<details open><summary>details</summary><pre>output</pre></details>
</body>
</html>
`;
}

test('the clean baseline document passes --check with zero problems', () => {
  const { problems } = checkHtmlString(cleanHtml());
  assert.deepEqual(problems, []);
});

test('--check FAILS on a remote-fetched resource (src=)', () => {
  const html = cleanHtml().replace('<h1>Report</h1>', '<h1>Report</h1><img src="https://example.com/x.png">');
  const { problems } = checkHtmlString(html);
  assert.ok(problems.some((p) => p.includes('remote resource')));
});

test('--check FAILS on a remote-fetched resource (protocol-relative href)', () => {
  const html = cleanHtml().replace(
    '<style>',
    '<link rel="stylesheet" href="//fonts.example.com/x.css"><style>',
  );
  const { problems } = checkHtmlString(html);
  assert.ok(problems.some((p) => p.includes('remote resource')));
});

test('--check FAILS on a <script> tag', () => {
  const html = cleanHtml().replace('</body>', '<script>console.log(1)</script></body>');
  const { problems } = checkHtmlString(html);
  assert.ok(problems.some((p) => p.includes('<script>')));
});

test('--check FAILS when the viewport meta is missing', () => {
  const html = cleanHtml().replace('<meta name="viewport" content="width=device-width,initial-scale=1">\n', '');
  const { problems } = checkHtmlString(html);
  assert.ok(problems.some((p) => p.includes('viewport')));
});

test('--check FAILS when there is no print stylesheet', () => {
  const html = cleanHtml().replace('<style>@media print { body { color: black; } }</style>', '<style>body{color:black}</style>');
  const { problems } = checkHtmlString(html);
  assert.ok(problems.some((p) => p.includes('print')));
});

test('--check FAILS on unbalanced <details>', () => {
  const html = cleanHtml().replace('</details>', ''); // drop the closing tag, leave </pre> alone
  const { problems } = checkHtmlString(html);
  assert.ok(problems.some((p) => p.includes('unbalanced <details>')));
});

test('--check FAILS on unbalanced <pre>', () => {
  const html = cleanHtml().replace('</pre>', ''); // drop the closing tag, leave </details> alone
  const { problems } = checkHtmlString(html);
  assert.ok(problems.some((p) => p.includes('unbalanced <pre>')));
});

test('--check FAILS on a collapsed <details> (missing the open attribute)', () => {
  const html = cleanHtml().replace('<details open>', '<details>');
  const { problems } = checkHtmlString(html);
  assert.ok(problems.some((p) => p.includes('collapsed <details>')));
  // and it must stay tag-balanced, so this is an isolated violation
  assert.ok(!problems.some((p) => p.includes('unbalanced')));
});

test('--check FAILS on a credential-shaped string', () => {
  const fakeToken = 'ghp_' + '1234567890abcdefghijklmnopqrstuv';
  const html = cleanHtml().replace('output', `output ${fakeToken}`);
  const { problems } = checkHtmlString(html);
  assert.ok(problems.some((p) => p.includes('credential-shaped')));
});

test('--check FAILS on missing doctype', () => {
  const html = cleanHtml().replace('<!doctype html>\n', '');
  const { problems } = checkHtmlString(html);
  assert.ok(problems.some((p) => p.includes('doctype')));
});

// ---- renderProof: honesty law -----------------------------------------------

function baseProof(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/repo',
    source: 'proofpage.json',
    env: { node: 'v24.0.0', platform: 'linux', arch: 'x64', osRelease: '6.0.0' },
    git: { available: true, sha: 'a'.repeat(40), branch: 'main', dirty: false },
    checks: [],
    summary: { totalChecks: 0, passed: 0, failed: 0, didNotRun: 0 },
    ...overrides,
  };
}

test('renderProof output always passes --check (the renderer only ever produces honest HTML)', () => {
  const proof = baseProof({
    checks: [
      {
        name: 'test',
        command: 'npm test',
        auto: true,
        ran: true,
        spawnError: null,
        exitCode: 0,
        signal: null,
        durationMs: 42,
        startedAt: '2026-01-01T00:00:00.000Z',
        output: { capLines: 40, totalLines: 2, truncated: false, tail: ['ok 1', '# pass 1'] },
        parsed: { ok: true, kind: 'node:test', counts: { pass: 1, fail: 0, total: 1 } },
      },
    ],
    summary: { totalChecks: 1, passed: 1, failed: 0, didNotRun: 0 },
  });
  const html = renderProof(proof);
  const { problems } = checkHtmlString(html);
  assert.deepEqual(problems, []);
});

test('a check that did not run shows no exit code number and no parsed count', () => {
  const proof = baseProof({
    checks: [
      {
        name: 'ghost',
        command: 'this-binary-does-not-exist',
        auto: false,
        ran: false,
        spawnError: 'spawn this-binary-does-not-exist ENOENT',
        exitCode: null,
        signal: null,
        durationMs: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        output: { capLines: 40, totalLines: 0, truncated: false, tail: [] },
        parsed: { ok: false, reason: 'command did not run, so there is no output to parse' },
      },
    ],
    summary: { totalChecks: 1, passed: 0, failed: 0, didNotRun: 1 },
  });
  const html = renderProof(proof);
  assert.ok(html.includes('DID NOT RUN'));
  assert.ok(html.includes('did not run'));
  // no bare "0" masquerading as an exit code or a count for this check
  assert.ok(!/exit code<\/dt><dd>0/.test(html));
  assert.ok(!html.includes('parsed result'));
});

test('a check with unparseable output renders "unparsed" and the reason, never a fabricated 0', () => {
  const proof = baseProof({
    checks: [
      {
        name: 'weird',
        command: 'node -e "console.log(1)"',
        auto: false,
        ran: true,
        spawnError: null,
        exitCode: 0,
        signal: null,
        durationMs: 5,
        startedAt: '2026-01-01T00:00:00.000Z',
        output: { capLines: 40, totalLines: 1, truncated: false, tail: ['1'] },
        parsed: { ok: false, reason: 'output did not match a known shape (node:test summary or tsc "Found N errors")' },
      },
    ],
    summary: { totalChecks: 1, passed: 1, failed: 0, didNotRun: 0 },
  });
  const html = renderProof(proof);
  assert.ok(html.includes('unparsed'));
  assert.ok(html.includes('did not match a known shape'));
});

test('a dirty working tree surfaces a visible warning', () => {
  const dirty = renderProof(baseProof({ git: { available: true, sha: 'b'.repeat(40), branch: 'main', dirty: true } }));
  assert.ok(dirty.includes('DIRTY'));
  const clean = renderProof(baseProof({ git: { available: true, sha: 'b'.repeat(40), branch: 'main', dirty: false } }));
  assert.ok(!clean.includes('DIRTY'));
});

test('when git is unavailable, the header says so rather than showing a fabricated commit', () => {
  const html = renderProof(baseProof({ git: { available: false, reason: 'not a git repository, or git is not installed' } }));
  assert.ok(html.includes('not available'));
  assert.ok(html.includes('not a git repository'));
});

test('renderProof redacts a credential-shaped string even if it arrives already embedded in proof data (defense in depth)', () => {
  const fakeToken = 'ghp_' + 'zzzz1234567890abcdefghijklmno';
  const proof = baseProof({
    checks: [
      {
        name: 'leaky',
        command: 'echo hi',
        auto: false,
        ran: true,
        spawnError: null,
        exitCode: 0,
        signal: null,
        durationMs: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        output: { capLines: 40, totalLines: 1, truncated: false, tail: [`token=${fakeToken}`] },
        parsed: { ok: false, reason: 'output did not match a known shape (node:test summary or tsc "Found N errors")' },
      },
    ],
    summary: { totalChecks: 1, passed: 1, failed: 0, didNotRun: 0 },
  });
  const html = renderProof(proof);
  assert.ok(!html.includes(fakeToken));
  assert.ok(html.includes('[REDACTED]'));
  const { problems } = checkHtmlString(html);
  assert.deepEqual(problems, []);
});
