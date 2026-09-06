# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
match `package.json`; nothing is bumped ahead of what has actually shipped.

## [Unreleased]

Release-grade hardening pass: hostile input, CI, and reproducibility.

### Fixed
- The CLI printed a raw Node stack trace, instead of a stated error, for:
  `--check` against a directory (`EISDIR`), a malformed `proofpage.json`, an
  empty (0-byte) `proofpage.json`, a `proofpage.json` with no usable
  `"checks"` array, a malformed `proof.json` fed to `proofpage render`, and
  `proofpage render` when `proof.json` is actually a directory (`EISDIR`).
  All six now exit `2` with a one-line stated reason instead of a trace.
- `bin/proofpage.mjs` had no main-module guard (`process.exit(main(...))` ran
  unconditionally at import time), unlike `src/run.mjs` and `src/render.mjs`,
  which already used one. Brought it in line, and exported `main` so it can
  be exercised directly in tests instead of only via a child process.
- The README's "Install" section told a reader to `npm install --save-dev
  proofpage` / `npx proofpage`, both of which fail: this package is not
  published to the npm registry. Replaced with the clone-and-run path that
  actually works, and removed the same false assumption from the worked
  example.
- The committed demo (`examples/self-proof.html`) was stale from an earlier
  commit's test count; regenerated against the current suite.

### Added
- `tests/hostile.test.mjs`: 10 tests pinning the fixes above by feeding the
  real bad input and asserting the stated error and exit code, per R6 of the
  release standard -- not by a `try/catch` that merely swallows. Includes
  `--check` against a multi-megabyte HTML file for the "file far larger than
  expected" case. (A check whose output floods past `spawnSync`'s 64MB
  `maxBuffer` was tried here too and dropped: real, repeated stress-testing
  on Windows showed it can orphan the grandchild process `shell: true`
  spawns, which then holds its temp-dir cwd open indefinitely. That code
  path -- `runOneCheck`'s `result.error` handling -- was already covered
  safely at the unit level in `tests/run.test.mjs`, via a nonexistent `cwd`
  that fails before any subprocess exists to orphan.)
- `.github/workflows/ci.yml`: installs from the committed lockfile on a
  pinned Node version and runs `npm test` and `npm run lint`.
- `package-lock.json`, committed for the first time.
- A real, pasted terminal transcript of the worked example in the README.

## [0.1.0] - 2026-09-05

Initial build.

### Added
- `run()`: discovers checks from `proofpage.json` or auto-detected
  `package.json` scripts (`test`/`typecheck`/`lint`/`build`), actually
  executes each one, and records exit code, duration, git provenance, and a
  bounded output tail -- never a fabricated pass or a guessed count.
- `renderProof()`: a single self-contained HTML report (no JS, no network
  requests, a print stylesheet, every `<details>` open by default) and a
  `checkFile()` / `--check` gate that verifies a rendered page actually obeys
  those rules.
- Secret redaction (`src/redact.mjs`) applied to captured command output and,
  as defense in depth, to the finished rendered document.
- The CLI (`bin/proofpage.mjs`): default (run + render), `run`, `render`,
  `--check`, `--out`, `--help`, `--version`, with exit codes `0` / `1` / `2`
  documented and each one covered by a dedicated test.
- A committed self-proof demo (`examples/self-proof.html`) and a landing
  page under `site/`.
- Two dogfooding fixes from the first real runs: a navigational `<a href>`
  wrongly flagged as a fetched remote resource, and the README's first
  worked-example command failing with `ENOENT` on a fresh install (CL6).
- Initial test suite (56 tests, across `cli`/`redact`/`render`/`run`) and
  README.
