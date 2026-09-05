#!/usr/bin/env node
// src/render.mjs - turn a proof.json into ONE self-contained HTML page, and
// gate that page with --check.
//
// Design constraints (deliberate, do not "improve" them away - each was
// learned from a real defect in an earlier renderer of this shape):
//   * zero network requests. No CDN, no web fonts, no analytics.
//   * zero JavaScript. Collapsing uses native <details>/<summary>.
//   * every <details> renders `open` by default - a collapsed <details>
//     drops its content out of a printed PDF entirely, and this page's
//     <details> blocks ARE the evidence.
//   * long unbreakable strings (paths, commands, hashes) wrap.
//   * no credential-shaped strings, even ones already present in captured
//     command output.
//   * the honesty law: every number traces to a command that ran. A check
//     that did not run says so; a count that couldn't be parsed says
//     "unparsed" and why. Never a 0 standing in for "unknown".
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSecrets, containsSecretShape } from './redact.mjs';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function statusOf(check) {
  if (!check.ran) return 'errored';
  if (check.exitCode === 0) return 'pass';
  return 'fail';
}

function statusLabel(check) {
  const s = statusOf(check);
  if (s === 'pass') return 'PASS';
  if (s === 'fail') return 'FAIL';
  return 'DID NOT RUN';
}

function fmtExitCode(check) {
  if (!check.ran) return 'n/a - command did not run';
  if (check.exitCode === null) {
    return check.signal
      ? `n/a - terminated by signal ${esc(check.signal)}`
      : 'n/a - no exit code reported';
  }
  return String(check.exitCode);
}

function fmtParsed(check) {
  if (!check.ran) return null; // nothing was measured; no parsed row at all
  const p = check.parsed;
  if (!p) return null;
  if (!p.ok) return `unparsed - ${esc(p.reason)}`;
  if (p.kind === 'node:test') {
    return `node:test summary - pass ${p.counts.pass}, fail ${p.counts.fail}, total ${p.counts.total}`;
  }
  if (p.kind === 'tsc') {
    return `tsc summary - ${p.counts.errors} error${p.counts.errors === 1 ? '' : 's'}`;
  }
  return `${esc(p.kind)} - ${esc(JSON.stringify(p.counts))}`;
}

function renderCheck(check) {
  const status = statusOf(check);
  const cleanCommand = redactSecrets(check.command).text;
  const cleanTail = check.output.tail.map((line) => redactSecrets(line).text);
  const parsedLine = fmtParsed(check);

  const metaRows = [
    ['command', `<code>${esc(cleanCommand)}</code>`],
    ['exit code', esc(fmtExitCode(check))],
    ['duration', esc(formatDuration(check.durationMs))],
    ['measured at', `${esc(check.startedAt)} (UTC)`],
    ['discovered via', check.auto ? 'auto-detected from package.json' : 'proofpage.json'],
  ];
  if (!check.ran) {
    metaRows.push(['error', esc(check.spawnError || 'unknown error')]);
  }
  if (parsedLine !== null) {
    metaRows.push(['parsed result', parsedLine]);
  }

  const dl = `<dl class="check-meta">${metaRows
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join('')}</dl>`;

  let outputBlock = '';
  if (check.ran) {
    const lineWord = check.output.totalLines === 1 ? 'line' : 'lines';
    const summary = check.output.truncated
      ? `output (last ${check.output.tail.length} of ${check.output.totalLines} ${lineWord}, truncated)`
      : `output (${check.output.totalLines} ${lineWord})`;
    const body = cleanTail.length ? esc(cleanTail.join('\n')) : '(no output)';
    outputBlock = `<details open><summary>${esc(summary)}</summary><pre>${body}</pre></details>`;
  }

  return `<section class="check status-${status}">
<div class="check-head"><h2>${esc(check.name)}</h2><span class="badge badge-${status}">${esc(statusLabel(check))}</span></div>
${dl}
${outputBlock}
</section>`;
}

function renderHeader(proof) {
  const rows = [];
  if (proof.git.available) {
    rows.push(['commit', `<code>${esc(proof.git.sha)}</code>`]);
    rows.push(['branch', esc(proof.git.branch)]);
    let dirtyText;
    if (proof.git.dirty === null) {
      dirtyText = 'unknown (git status could not be read)';
    } else if (proof.git.dirty) {
      dirtyText = 'DIRTY - uncommitted changes were present when these checks ran';
    } else {
      dirtyText = 'clean';
    }
    rows.push(['working tree', esc(dirtyText)]);
  } else {
    rows.push(['commit', `not available - ${esc(proof.git.reason)}`]);
  }
  rows.push(['node', esc(proof.env.node)]);
  rows.push(['platform', `${esc(proof.env.platform)} ${esc(proof.env.arch)} (${esc(proof.env.osRelease)})`]);
  rows.push(['measured at', `${esc(proof.generatedAt)} (UTC)`]);
  const sourceText =
    proof.source === 'proofpage.json'
      ? 'proofpage.json'
      : proof.source === 'auto-detected'
        ? 'auto-detected from package.json scripts'
        : 'none found';
  rows.push(['checks discovered via', esc(sourceText)]);

  const dl = `<dl class="meta-head">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

  const dirtyBanner =
    proof.git.available && proof.git.dirty === true
      ? '<p class="banner banner-warn">Working tree was DIRTY when these checks ran. Uncommitted changes may not be reflected in the commit shown above.</p>'
      : '';

  return `<h1>proofpage report</h1>\n${dl}\n${dirtyBanner}`;
}

const CSS = `
:root{
  --ink:#16191d; --muted:#5b6570; --rule:#dfe3e8; --bg:#fff;
  --code-bg:#f6f7f9; --accent:#1f4b73;
  --pass-bg:#eaf6ec; --pass-ink:#116329; --pass-rule:#9fd3ab;
  --fail-bg:#fdecec; --fail-ink:#8a1f1f; --fail-rule:#eba3a3;
  --err-bg:#fff6e5; --err-ink:#7a4b00; --err-rule:#f0cf8a;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  overflow-wrap:break-word;
}
.wrap{max-width:52rem;margin:0 auto;padding:3rem 1.25rem 5rem}
h1{font-size:1.6rem;margin:0 0 .5em;letter-spacing:-.01em;font-weight:650}
h2{font-size:1.05rem;margin:0;font-weight:650}
p{margin:0 0 1em}
code{
  background:var(--code-bg);border:1px solid var(--rule);border-radius:3px;
  padding:.08em .34em;font-size:.86em;
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  overflow-wrap:anywhere;word-break:break-word;
}
dl.meta-head{
  margin:1.4rem 0 0;padding:1rem 1.15rem;border:1px solid var(--rule);
  border-radius:6px;display:grid;grid-template-columns:max-content 1fr;
  gap:.5rem 1.15rem;font-size:.92rem;
}
dl.meta-head dt{font-weight:640;color:var(--muted);white-space:nowrap}
dl.meta-head dd{margin:0;overflow-wrap:anywhere}
.banner{margin:1.1rem 0 0;padding:.75rem 1rem;border-radius:6px;font-size:.92rem;font-weight:600}
.banner-warn{background:var(--err-bg);color:var(--err-ink);border:1px solid var(--err-rule)}
.summary-line{margin:1.6rem 0 0;font-size:1rem}
section.check{
  margin:1.6rem 0 0;border:1px solid var(--rule);border-radius:8px;
  padding:1rem 1.15rem;
}
section.check.status-pass{border-color:var(--pass-rule)}
section.check.status-fail{border-color:var(--fail-rule)}
section.check.status-errored{border-color:var(--err-rule)}
.check-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.badge{
  font-size:.75rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
  padding:.25em .6em;border-radius:999px;white-space:nowrap;
}
.badge-pass{background:var(--pass-bg);color:var(--pass-ink)}
.badge-fail{background:var(--fail-bg);color:var(--fail-ink)}
.badge-errored{background:var(--err-bg);color:var(--err-ink)}
dl.check-meta{
  margin:.9rem 0 0;padding:0;display:grid;grid-template-columns:max-content 1fr;
  gap:.4rem 1rem;font-size:.9rem;
}
dl.check-meta dt{font-weight:600;color:var(--muted);white-space:nowrap}
dl.check-meta dd{margin:0;overflow-wrap:anywhere}
details{margin:.9rem 0 0;border:1px solid var(--rule);border-radius:6px;background:var(--code-bg)}
details>summary{
  cursor:pointer;padding:.55rem .85rem;color:var(--muted);font-size:.83rem;
  list-style:none;user-select:none;
}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"\\25BE  ";display:inline-block}
details>summary:hover{color:var(--ink)}
details pre{
  margin:0;border:0;border-top:1px solid var(--rule);padding:.85rem 1rem;
  font:.8rem/1.5 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;
}
footer.meta{margin-top:3rem;padding-top:1.1rem;border-top:1px solid var(--rule);
  color:var(--muted);font-size:.82rem}
@media(max-width:640px){
  .wrap{padding:2rem 1rem 4rem}
  h1{font-size:1.35rem}
  dl.meta-head,dl.check-meta{grid-template-columns:1fr;gap:0}
  dl.meta-head dt,dl.check-meta dt{margin-top:.5rem}
  dl.meta-head dt:first-child,dl.check-meta dt:first-child{margin-top:0}
}
@media print{
  .wrap{max-width:none;padding:0}
  section.check,details{page-break-inside:avoid}
  details>summary{display:none}
  details>*{display:block !important}
  h2{page-break-after:avoid}
}
`;

/**
 * Render a full, self-contained HTML page from a proof object.
 * @param {object} proof
 * @returns {string}
 */
export function renderProof(proof) {
  const header = renderHeader(proof);
  const sections = proof.checks.map(renderCheck).join('\n');
  const s = proof.summary;
  const summaryLine =
    s.totalChecks === 0
      ? '<p class="summary-line">No checks were discovered. Add a proofpage.json, or a test/typecheck/lint/build script to package.json.</p>'
      : `<p class="summary-line"><strong>${s.passed} of ${s.totalChecks}</strong> checks passed` +
        (s.didNotRun ? `, ${s.didNotRun} did not run` : '') +
        '.</p>';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>proofpage report</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
${header}
${summaryLine}
${sections}
<footer class="meta">Generated by proofpage. Every number above traces to a command that actually ran; a row that could not run or could not be parsed says so instead of showing a number.</footer>
</main>
</body>
</html>
`;

  // Defense in depth: even though callers (run.mjs) already redact captured
  // output, redact the finished document one more time so a hand-edited or
  // older proof.json can never leak a credential-shaped string through this
  // renderer.
  return redactSecrets(html).text;
}

// ---- --check ----------------------------------------------------------------

/**
 * Validate an already-rendered HTML string against every honesty/safety
 * rule this tool promises. Pure function - no file I/O.
 * @param {string} html
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function checkHtmlString(html) {
  const problems = [];
  const warnings = [];

  if (!/<!doctype html>/i.test(html)) problems.push('missing <!doctype html>');

  // The rule is "this page fetches nothing when it opens", so it targets
  // SUBRESOURCES the browser loads on its own: src= on img/script/iframe and
  // friends, href= on <link>. A plain <a href> is deliberately NOT a
  // violation. It issues no request until somebody clicks it, and a receipts
  // page whose entire job is to point at the artifact it measured has to be
  // able to link to the commit and the repo. Treating a navigation as a fetch
  // is a category error that would make the product worse at the one thing it
  // is for. The <a> is still held to the offline rule below: it may not be the
  // page's only evidence, because a reader offline must still see the numbers.
  const remoteSrc = [...html.matchAll(/\bsrc\s*=\s*"((?:https?:)?\/\/[^"]*)"/gi)].map((m) => m[1]);
  const remoteLink = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*"((?:https?:)?\/\/[^"]*)"/gi)].map((m) => m[1]);
  const remote = [...remoteSrc, ...remoteLink];
  if (remote.length) {
    problems.push(`remote resource referenced: ${[...new Set(remote)].join(', ')}`);
  }
  if (/@import\b|url\(\s*['"]?(?:https?:)?\/\//i.test(html)) {
    problems.push('CSS references a remote resource (@import or url(...))');
  }

  if (/<script\b/i.test(html)) {
    problems.push('contains a <script> tag; this page must run without JavaScript');
  }

  if (!/<meta[^>]+name\s*=\s*"viewport"/i.test(html)) {
    problems.push('missing <meta name="viewport">');
  }

  if (!/@media\s+print/i.test(html)) {
    problems.push('missing an @media print stylesheet');
  }

  const countTag = (tag) => ({
    open: (html.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length,
    close: (html.match(new RegExp(`</${tag}>`, 'gi')) || []).length,
  });
  const details = countTag('details');
  if (details.open !== details.close) {
    problems.push(`unbalanced <details>: ${details.open} open, ${details.close} close`);
  }
  const pre = countTag('pre');
  if (pre.open !== pre.close) {
    problems.push(`unbalanced <pre>: ${pre.open} open, ${pre.close} close`);
  }

  // A <details> without an `open` attribute hides its content on screen and
  // drops it out of the printed page entirely - this renderer never emits
  // one, so seeing one means the HTML was hand-edited (or generated by
  // something other than this renderer).
  const collapsed = (html.match(/<details\b(?![^>]*\bopen\b)[^>]*>/gi) || []).length;
  if (collapsed) {
    problems.push(`${collapsed} collapsed <details> block(s): evidence would be hidden on screen and lost from print`);
  }

  if (containsSecretShape(html)) {
    problems.push('a credential-shaped string was found in the document');
  }

  const bytes = Buffer.byteLength(html);
  if (bytes > 5_000_000) warnings.push(`large file (${Math.round(bytes / 1024)} KB)`);

  return { problems, warnings };
}

/**
 * Validate a rendered HTML file on disk, printing FAIL/WARN/PASS lines like
 * a CI gate, and return an exit code (0 clean, 1 problems found).
 * @param {string} filePath
 * @returns {number}
 */
export function checkFile(filePath) {
  const html = readFileSync(filePath, 'utf8');
  const { problems, warnings } = checkHtmlString(html);
  for (const p of problems) process.stdout.write(`FAIL  ${p}\n`);
  for (const w of warnings) process.stdout.write(`WARN  ${w}\n`);
  if (!problems.length) {
    process.stdout.write('PASS  no remote resources, no JS, no collapsed evidence, print-ready, no credential-shaped strings.\n');
  }
  return problems.length ? 1 : 0;
}

// ---- standalone CLI use (bin/proofpage.mjs is the documented entry point;
// this mirrors it so `node src/render.mjs --check <file>` also works) --------

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--check')) {
    const f = argv[argv.indexOf('--check') + 1];
    if (!f || !existsSync(f)) {
      process.stderr.write('usage: render.mjs --check <file.html>\n');
      process.exit(2);
    }
    process.exit(checkFile(f));
  }
  process.stderr.write('usage: render.mjs --check <file.html>\n');
  process.exit(2);
}
