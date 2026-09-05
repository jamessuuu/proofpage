# The first command in my README did not work, and 51 passing tests never noticed

**Reproduce this:** `npm test` — 54 tests, zero dependencies. Then
`node bin/proofpage.mjs --out proof.html && node bin/proofpage.mjs --check proof.html`,
and open the page. Every row on it names the command that produced it and the
exit code that command returned.

Proofpage turns a repo's real test, typecheck, build and lint run into one
self-contained HTML receipts page. The product claim is narrow and it is the
whole thing: **it refuses to print any number it did not measure.**

## The finding: a green suite cannot see outside its own repo

The tool shipped with 51 passing tests. The README's first example said:

```sh
proofpage --out examples/self-proof.html
```

A fresh install has no `examples/` directory. Proofpage does not create one. So
the first command a new user copy-pasted died with `ENOENT`.

Fifty-one tests could not catch it, and no amount of adding tests in that style
would have. They all run inside this repo, where `examples/` exists because it
is committed. The bug lived in the gap between "works on the author's machine"
and "works on a machine that just installed it" — which is where install bugs
always live, and which is invisible from inside.

What caught it was a check that packs the tarball, installs it into a temp
directory, and runs the README's first command there. It failed immediately.
The snippet now writes `proof.html` into the current directory, which always
exists, and says plainly that proofpage will not create a directory for you.

I am leading with this because it is the most useful thing in the repo. The
lesson is not "write more tests". It is that a test suite is a closed world, and
some claims — the install snippet, the flag list, the exit-code table — are
claims *about* the world outside it, and need a check that leaves the room.

Three smaller gaps came from the same sweep: no `repository`/`homepage`/`bugs`
metadata, no exit-code table at all, and a committed demo that was never
described as a demo.

## The honesty law, and what it costs

Every number on the page traces to a command that ran. Concretely:

- A check that did not run shows no exit code and no count. Not `0` — nothing,
  with a line saying it did not run. `0` is a measurement, and printing it for
  "unknown" is the exact lie the tool exists to prevent.
- Output that cannot be parsed into a count with confidence is marked
  `unparsed`, with the reason. Proofpage parses `node:test` and `tsc` summaries
  because those shapes are unambiguous. It guesses at nothing else. This repo's
  own lint row renders as `unparsed`, because the lint script is a plain
  `node --check` sweep with no standard summary line — the demo page shows my
  own tool declining to score my own script.
- If the working tree was dirty when the checks ran, the page says so next to
  the commit SHA, not somewhere easy to miss. A receipt from an uncommitted tree
  is a receipt for code nobody else can check out.
- If git is unavailable, the header says so rather than showing a fabricated
  commit.

Each of those is a test, not a policy. The test for the first one asserts that a
check which did not run produces no number anywhere in the output.

## Zero network, zero JavaScript, and one thing I got wrong

The page fetches nothing when it opens. No CDN, no webfont, no analytics. Every
`<details>` is open by default, because a collapsed `<details>` is dropped
entirely when the page is printed to PDF — a receipts page that silently loses
its evidence when printed is worse than no receipts page.

`proofpage --check <file>` enforces all of it mechanically, on any page,
including one you did not generate. Every rule has a fixture that violates
exactly that rule and a test asserting the check fails on it. A check that
cannot fail is not a check.

I got one rule wrong at first. It flagged **any** external `href`, including a
plain `<a href="https://github.com/...">` link. That conflates a navigation with
a fetch: an `<a>` requests nothing until somebody clicks it. Worse, it forbade
the one link a receipts page most needs — the commit it measured. The rule now
targets what the browser actually loads on open: `src=` on images, scripts and
frames, `href=` on `<link>`. There is a test asserting the navigational link
passes, so a future tightening cannot quietly take it back.

## Limitations

- It measures what you tell it to run. It cannot know whether your tests are any
  good, or whether they assert anything at all. A green proofpage page over a
  suite of empty tests is an honest report of a worthless suite.
- Count parsing covers `node:test` and `tsc`. Everything else is `unparsed` on
  purpose. Vitest, Jest and pytest shapes are not parsed yet.
- Auto-detection reads `test`, `typecheck`, `lint` and `build` from
  `package.json`. Anything else needs a `proofpage.json`.
- The captured output tail is bounded to 40 lines. The true total line count is
  recorded, so a truncated tail is visibly truncated rather than silently short.
- It is a snapshot, not a monitor. The page is true about one commit at one
  moment on one machine, and says which.
