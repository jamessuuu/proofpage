# proofpage

`npx proofpage` runs your repo's real test, typecheck, build, and lint
commands and turns the result into one self-contained HTML page. Every
number on that page traces back to a command that actually ran and the exit
code it actually returned.

## The honesty law

proofpage refuses to print any number it did not measure.

- If a check did not run, the page says so. It does not print a blank or a
  zero that could be mistaken for "everything's fine."
- If a check's output cannot be parsed into a count with confidence, the page
  says "unparsed" and gives the reason. It never guesses a number from noisy
  output.
- If the working tree was dirty (uncommitted changes) when the checks ran,
  the page says so, next to the commit SHA, not somewhere easy to miss.
- The rendered page has zero JavaScript and zero network requests. Every
  `<details>` block that folds evidence is open by default, because a
  collapsed block disappears entirely when the page is printed to PDF.

Run `proofpage --check <file>` against any rendered page (including one you
didn't generate yourself) to verify these rules mechanically instead of
trusting them.

"Zero network requests" means the page fetches nothing when it opens: no
remote stylesheet, script, font or image. A plain `<a href>` out to the commit
or the repo is allowed, because it requests nothing until somebody clicks it,
and a receipts page that cannot link to the artifact it measured would be
worse at its only job.

## Install

    npm install --save-dev proofpage
    # or run it without installing:
    npx proofpage

## Usage

    proofpage                       run every discovered check, write proof.json and proof.html
    proofpage run                   run checks, write proof.json only
    proofpage render                render proof.html from an existing proof.json
    proofpage --check <file.html>   verify a rendered page is honest
    proofpage --out <file>          choose the output HTML file (default: proof.html)
    proofpage --help
    proofpage --version

proofpage exits non-zero if any measured check failed, or if a check could
not run at all, so it works as a CI gate.

## What it checks

If a `proofpage.json` is present in the repo root, proofpage runs exactly the
checks listed in it:

    {
      "checks": [
        { "name": "test", "command": "npm test" },
        { "name": "typecheck", "command": "npm run typecheck" }
      ]
    }

If there's no `proofpage.json`, proofpage looks at `package.json` for
`test`, `typecheck`, `lint`, and `build` scripts and runs whichever of those
exist, each as `npm run <script>`. The rendered page states which of the two
happened ("checks discovered via proofpage.json" or "auto-detected from
package.json scripts"). It does not blur that distinction.

## Worked example

This repo runs proofpage on itself, and the committed output is the demo.
Open the demo, [`examples/self-proof.html`](examples/self-proof.html), in a
browser, or print it. Nothing is fetched when it loads, so it works offline
and survives a PDF. Every row traces to a command you can rerun yourself:

    npm test
    node scripts/lint.mjs

In any repo that has proofpage installed, the whole thing is two commands:

```sh
proofpage --out proof.html
proofpage --check proof.html
```

That writes into the current directory, which always exists. Point `--out` at a
subdirectory only if you have already made it: proofpage will not create one
for you, and until 2026-09-05 this section told you to write into `examples/`,
which fails with ENOENT on a fresh install. CL6 in the harness caught it by
running this snippet against the packed tarball, which is the entire reason
that check exists.

From a clone of this repo, without installing, the same two steps are:

```sh
node bin/proofpage.mjs --out proof.html
node bin/proofpage.mjs --check proof.html
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every discovered check ran and passed, or `--check` found no violations. |
| `1` | A check ran and failed, a check could not be run at all, or `--check` found a violation. This is the CI signal. |
| `2` | proofpage was used wrongly or could not read what it needs: an unknown flag, a missing file passed to `--check`, an unreadable `package.json`. Nothing was measured, so nothing is reported. |

The `1` and `2` split matters: `1` means the repo is in a state you should
look at, `2` means proofpage never got far enough to have an opinion.

## What ends up in proof.json

A machine-readable record: the exact command that ran, its exit code,
wall-clock duration, a UTC timestamp, a bounded tail of stdout/stderr (the
real total line count is recorded even when the tail is truncated), whatever
counts were parsed from a known output shape, the git commit/branch/dirty
state, and the node/OS the checks ran on.

## Limitations

- proofpage only parses two output shapes with confidence: `node:test`'s
  `# pass N` / `# fail N` summary lines, and `tsc`'s `Found N errors.` line.
  Everything else is reported as "unparsed." proofpage does not try to guess
  counts out of ESLint, Jest, Mocha, pytest, or any other tool's output. If
  you want a tool's numbers on the page, have it print one of the two shapes
  above, or treat the unparsed row as the honest answer: the command ran,
  here's its exit code and its output, and nobody guessed at a count.
- proofpage measures whatever command you point it at. It cannot tell you
  whether your tests are any good, whether your typecheck config is strict,
  or whether a "build" script that just echoes "ok" is actually building
  anything. The receipts page proves a command ran and what it returned. It
  does not vouch for the command's design.
- Git provenance (commit, branch, dirty state) needs `git` on PATH and a real
  git repository. Outside of one, the page says so instead of leaving those
  fields blank or invented.
- Redaction of credential-shaped strings is pattern-based (JWTs, common
  vendor token prefixes, database URLs with embedded passwords, PEM private
  keys, generic `key=value` secrets). It is a safety net, not a guarantee.
  Do not rely on it as your only defense against leaking a real secret into a
  page you hand to someone else.
- Zero runtime dependencies, on purpose. If a check needs a tool, that tool
  is your repo's dependency, not proofpage's.

## License

MIT. See [LICENSE](LICENSE).
