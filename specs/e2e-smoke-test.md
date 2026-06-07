# JSZipp End-to-End (Playwright) Smoke Test Guide

This file is normative. See [Specification Index](README.md) for repository-wide
specification scope and keyword meaning.

This bundle adds a real-browser end-to-end smoke test and updates the docs, the
demo page, and the test scripts to match. Everything here is laid out to mirror
the repository, so files drop straight into place.

## Why this test

The existing layers are Vitest (runs the **source** tree / native polyfill seam)
and the compat smoke test (runs the **built compat bundles** in Node with floor
globals deleted). Neither loads the **shipped bundle in a real browser** through
the demo UI — the one gap `specs/browser-compatibility.md` §8.5 flagged as a manual
step. This Playwright suite automates exactly that.

It drives `demo/compress.html` (which imports the real `dist/jszipp.mjs`) in
headless Chromium, compresses a fixture folder, captures the download, and re-reads
the archive with **yauzl** — an independent reader — so a green run proves the
bytes the browser produced are a structurally valid ZIP, not merely something
JSZipp can read back. It asserts entry names/content, deflate vs store
(method 8 vs 0), and that Clear resets the demo.

## Files

New:

- `playwright.config.ts` — starts the static server via `webServer`, Chromium project.
- `scripts/serve-demo.mjs` — zero-dependency static server (serves repo root so the
  demo's `import("../dist/jszipp.mjs")` resolves over HTTP with a JS MIME type).
- `e2e/compress.spec.ts` — the smoke test.
- `e2e/fixtures/hello.txt`, `e2e/fixtures/notes.txt` — input fixtures.

Modified (see `CHANGES.diff.md` for exact diffs):

- `package.json` — adds `@playwright/test` devDependency and a `test:e2e` script
  (`pnpm run build && playwright test`).
- `demo/compress.html` — two small, justified edits:
  1. sets `document.body.dataset.ready = "true"` after bootstrap so the test never
     races the module-bound listeners;
  2. defers `URL.revokeObjectURL` to the next task in `downloadZip()`. Revoking in
     the same tick as the click can truncate or abort the download on some engines
     and under headless automation — a real latent bug, not just a test concern.
- `specs/testing-requirements.md` — new "End-to-end browser smoke test" section + a How-to-Run note.
- `specs/browser-compatibility.md` — §8.5 now distinguishes the automated
  modern-engine ESM round-trip (this suite) from the still-manual legacy-floor
  UMD check.

## Run it

```sh
pnpm install
pnpm exec playwright install chromium   # one-time browser provisioning
pnpm run test:e2e                 # builds, then runs playwright test
```

`test:e2e` chains the build so `dist/jszipp.mjs` exists before the browser loads it.

## Verified

The full flow was run against the real built bundle in headless Chromium:

- Balanced level → `Created compressed-files.zip.`, download captured, yauzl reads
  `fixtures/hello.txt` + `fixtures/notes.txt`, method 8, content exact.
- Store level → method 0 on both entries.
- Clear → counts reset, Compress/Download disabled, ZIP size back to `-`.

`tsc --strict` is clean on the spec and config, and `playwright test --list`
resolves all three tests.

## Notes / decisions

- The demo's file input is `webkitdirectory`, so Playwright requires a **directory**
  path (in-memory buffers are rejected). Chromium prefixes entry names with the
  folder basename, hence the asserted `fixtures/` prefix.
- The compression radios are visually hidden behind styled labels, so the spec uses
  `check(..., { force: true })`; the demo reads `:checked` only at Compress time.
- `test:e2e` is intentionally **not** wired into `prepack`, matching how
  `test:jszipp-npm-package` is kept separate — it needs a browser binary and is
  slower. Enable it in CI alongside `pnpm exec playwright install`.
- `tsconfig.json` includes only `src`, so `pnpm run typecheck` is unaffected;
  Playwright transpiles the spec itself. Firefox/WebKit projects are present but
  commented out in the config.
- `specs/documentation-maintenance.md` is left unchanged: `specs/testing-requirements.md` remains the
  canonical home for "what the tests prove," and `specs/browser-compatibility.md`
  cross-links to it, which is the ownership model that file prescribes.
