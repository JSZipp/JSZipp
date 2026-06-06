# Testing Overview and Limitations

This document summarizes what the current `test/jszipp.test.ts` suite is designed
to prove, where it intentionally goes deeper than public round trips, and where
the remaining limits are.

## Testing Goals

The suite is built around a few practical goals:

- Verify the public APIs behave correctly for normal browser-style usage.
- Verify generated ZIP bytes are structurally valid, not just readable by this
  library.
- Exercise important edge cases in ZIP metadata, ZIP64 records, path handling,
  compression, decompression, and stream consumption.
- Keep tests tied to observable behavior. Internal branches are covered through
  public APIs plus controlled byte patching, rather than by exporting internals.
- Fail loudly on malformed archives, unsafe paths, inconsistent sizes, corrupt
  compressed data, and unsupported features.

## Main Coverage Areas

### Writer APIs

The tests cover `ZipWriter`, `ZipWriter.writeSync()`, `ZipWriter.closeSync()`,
and `ZipTransformStream`.

Covered behavior includes:

- Default namespace export and named API exports.
- Published package export map coverage for ESM and CommonJS root,
  `jszipp/writer`, and `jszipp/reader` entry points.
- Stored entries when `level: 0` is used.
- Deflated entries with metadata preservation.
- Archive comments and entry comments.
- Custom extra fields.
- Directory entries.
- Unix mode bits and external attributes.
- Blob, Uint8Array, ArrayBuffer, string, and ReadableStream input.
- Blob, ReadableStream, Uint8Array, ArrayBuffer, and Response output.
- Custom Response MIME types.
- Async writer mode and sync writer mode separation.
- Rejection of writes or closes after the writer is already closed.
- Rejection of duplicate normalized entry paths while writing.
- Progress callbacks and abort signals.
- Per-entry compression method overrides.
- Per-entry compression level overrides.
- Invalid compression level validation.
- Oversized path, comment, extra field, and archive comment validation.
- Unsupported input type rejection.

The sync writer tests intentionally stay focused on in-memory inputs, because
`Blob` and `ReadableStream` cannot be consumed synchronously.

### Reader APIs

The tests cover both reader styles:

- `openZip()` for random-access reading.
- `readZipStream()` for forward stream-style iteration.

Covered behavior includes:

- Blob, Uint8Array, and ArrayBuffer archive input.
- Duplicate paths: `entries` preserves archive order while `get()` returns the
  latest matching path.
- Independent reusable streams from random-access entries.
- Single-use stream entry tokens in `readZipStream()`.
- Explicit `skip()` behavior for stream entries.
- Text, bytes, ArrayBuffer, and stream helpers.
- Entry metadata exposed by both reader APIs.
- Entry access rejection after closing a reader.
- Already-aborted signal handling.
- `get()` fallback through normalized paths.

### ZIP64

The suite verifies both normal and error paths for ZIP64:

- `zip64: "auto"` avoids ZIP64 records for small archives.
- `zip64: "force"` emits ZIP64 EOCD and locator records.
- Auto ZIP64 emission is triggered when standard entry-count limits are exceeded.
- ZIP64-disabled writers reject offsets that require ZIP64.
- Forced ZIP64 archives preserve comments, extra fields, timestamps, and mode
  metadata.
- Local ZIP64 extras omit the local-header offset while central-directory ZIP64
  extras keep it.
- Missing ZIP64 values, missing locators, corrupt ZIP64 EOCD records, and
  malformed ZIP64 extras are rejected.

Some ZIP64 tests use controlled internal counter/offset setup to avoid allocating
multi-gigabyte archives. This keeps the test fast while still validating the
writer's boundary decisions.

### Compression and DEFLATE

The suite tests both high-level compression behavior and specific DEFLATE block
selection outcomes:

- Stored output for `level: 0`.
- Deflated output for compressible entries.
- Smaller output from higher compression levels on representative text.
- Stored DEFLATE blocks for incompressible data.
- Fixed-Huffman block emission when fixed codes are cheaper than a dynamic
  header.
- Multiple DEFLATE blocks for large entries.
- Multiple stored sub-blocks for incompressible input larger than 65535 bytes.
- Compatibility with Node zlib-generated deflated ZIP entries.
- Round-trip validation against fixture ZIP files parsed independently with
  Node zlib.

These tests do not require direct access to the compressor internals. They inspect
ZIP method fields, compressed sizes, raw payload block types, and round-trip
content.

### Metadata and Timestamp Behavior

The tests verify metadata at both API and byte-field levels:

- Archive comments.
- Entry comments.
- Extra fields.
- Directory flags.
- External attributes.
- Unix mode derivation.
- ZIP host system marker selection.
- DOS timestamp encoding as local wall-clock time for boundary dates.
- Extended Timestamp (`0x5455`) UTC mtime encoding and read precedence.
- Safe decoding of zero date fields.
- Year clamping beyond the ZIP DOS timestamp maximum year.
- Stable timestamp fields for the same absolute instant on the same host.
- UTC mtime preservation across GMT-12 through GMT+14 inputs.

The timestamp tests compare raw local-header and central-directory fields, not
only decoded `Date` objects.

### Path Safety

Path handling is covered on both write and read:

- Default writer behavior remains legacy-compatible.
- Strict writer mode rejects unsafe paths.
- Sanitize writer mode produces strict-readable archives.
- All writer path modes reject duplicate normalized entry paths.
- Reader default mode rejects unsafe paths.
- Reader sanitize mode normalizes absolute paths, drive-letter paths,
  backslashes, dot components, and traversal.
- Reader strict mode also rejects drive-relative names (e.g. `C:name`) and paths
  containing a NUL byte; sanitize mode strips them.
- Reader unsafe mode can intentionally expose unsafe archive paths.
- Sanitizing to an empty path is rejected.

This area is intentionally tested with byte-patched archives too, because unsafe
paths may appear in archives created by other tools.

### Structural Validation and Hardening

Malformed archive tests cover:

- Missing EOCD records.
- EOCD-like bytes inside comments (including a self-anchored empty fake).
- A fake legacy EOCD attempting to preempt the real ZIP64 records.
- A fake EOCD appended after a complete archive (must not erase real entries).
- Corrupt central-directory signatures.
- Corrupt local-header signatures.
- Central-directory entry count mismatch.
- Central-directory size mismatch.
- Central-directory offsets outside archive bounds.
- Local payload ranges outside archive bounds.
- Encrypted entries.
- Unsupported compression methods.

These tests are meant to ensure parsing fails close to the structural problem and
does not silently accept inconsistent archive metadata.

### Integrity and Size Limits

The tests cover content integrity and configurable limits:

- CRC32 mismatch rejection.
- Stored-entry size mismatch rejection.
- Deflated-entry inflated-size mismatch rejection.
- Corrupt deflate stream reporting.
- `maxEntrySize` checks before and during inflation.
- `maxArchiveSize` checks in `openZip()`.
- `maxArchiveSize` checks in `readZipStream()`.

One important behavior is that size caps are enforced during actual inflate
output, even if the archive header understates the uncompressed size.

### Filename Encoding

Legacy filename decoding is tested for:

- CP437.
- CP866.
- Shift_JIS.
- Windows-1252.
- GBK.
- Big5.
- EUC-KR.
- Custom `TextDecoder`-shaped decoder objects.

The tests clear the UTF-8 flag and patch filename bytes to simulate archives
written by non-UTF-8 ZIP tools.

### Compat Smoke Test (Legacy Bundles)

The Vitest suite and the typecheck both run the **source** tree, which uses the
native polyfill seam (`polyfill.ts`). They therefore cannot prove that a *legacy*
bundle works on its floor: a polyfill can be bundled yet never actually wire up, or
a ponyfill stream can fail to `pipeThrough` the inflater. The compat smoke test
(`scripts/compat-smoke-test.mjs`, run via `pnpm run test:compat-smoke` after a
build) closes that gap.

It is **not a real browser**: it runs in Node on a modern V8 and *emulates* a floor
by deleting the native Web-API globals that floor's weaker engine lacks before the
bundle loads, so the lookups miss exactly as the old engine's would. That makes it
a faithful test of the **runtime-API gap only** — not the syntax gap (covered by
the transpiled-syntax audit) and not the UMD wrapper or `FileReader` paths (covered
by an actual browser). For each compat build it spawns a child process, deletes the
floor's missing globals, loads the built UMD via global assignment, and runs real
round-trips: a `ZipWriter → openZip` round-trip whose deflated entry forces the
pure-JS inflater (native `DecompressionStream` removed), the writer's ponyfill
`ReadableStream` piped into `readZipStream` `for await`, a lying-header
`maxEntrySize` regression that must fail during compat inflate, and an
already-aborted signal on CR86FF68. The full procedure, the per-target deletion
sets, and the explicit list of what a green run does **not** prove are documented
canonically in [Browser compatibility → How to verify](browser-compatibility.md#8-how-to-verify-a-compatibility-change).

### End-to-End Browser Smoke Test (Real Engine)

The Vitest suite runs the source tree and the compat smoke test runs the built
compat bundles in Node with floor globals deleted. Neither loads the **shipped
ESM bundle in a real browser engine** through the public demo UI — historically a
manual step (see browser-compatibility.md §8.5). The Playwright suite under `e2e/`
automates exactly that one gap.

It drives the `demo/compress.html` demo, which imports the real
`dist/jszipp.mjs`, in headless Chromium. A small zero-dependency static server
(`scripts/serve-demo.mjs`) serves the repository root so the demo's relative
`import("../dist/jszipp.mjs")` resolves over HTTP with a JavaScript MIME type; a
`file://` origin cannot load the module. `playwright.config.ts` starts that server
through its `webServer` option.

`e2e/compress.spec.ts` selects the `e2e/fixtures/` folder, exercises the
compression-level control, clicks **Compress**, and captures the resulting
download. The downloaded archive is then re-read with **yauzl** — an independent
reader, the same cross-tool strategy used for fixtures elsewhere — so a green run
means the bytes the browser produced are a structurally valid ZIP, not merely
something JSZipp can read back. The spec asserts entry names and content, that the
balanced level deflates (method 8) while the store level does not (method 0), and
that **Clear** resets the demo. The demo sets a `data-ready` flag once its module
bootstrap finishes so the test never races the listeners.

What a green run does **not** prove: it runs Playwright's bundled Chromium, a
*modern* engine, so it does not exercise the legacy floors (Chrome 61 / Firefox 58
or 86 / 68) — those still need the manual real-browser check in
browser-compatibility.md §8.5 — nor the UMD wrapper (the demo loads the ESM build).
However, the Blob/File input path in `ZipWriter.add()` **is** exercised here: the
demo selects files via the file input control (`<input webkitdirectory>`), which
creates `File` / `Blob` objects and passes them to the writer in the real browser.
The compat floors' `Blob.prototype.arrayBuffer` FileReader fallback (when native
`Blob.arrayBuffer` is absent on CR61FF58 / CR86FF68) would need to be tested in an
actual Chrome 61 / Firefox 58 / 68 respectively, not in Chromium.
Run it after a build:

```sh
pnpm run build
pnpm run test:e2e
```

`test:e2e` chains the build for you, then runs `playwright test`. The browser
binary is provisioned once with `pnpm exec playwright install chromium`. Firefox and
WebKit projects are present but commented out in the config; enable them (and
`pnpm exec playwright install firefox webkit`) for broader coverage in CI.

## Validation Style

The suite uses several validation strategies:

- Public round trips through `ZipWriter` and `openZip()`.
- Stream-based round trips through `ZipTransformStream` and `readZipStream()`.
- Raw byte inspection of ZIP headers, central directory records, EOCD records,
  ZIP64 records, timestamps, method fields, and attributes.
- Byte patching to create malformed archives with precise failure modes.
- Independent zlib validation for fixture archives and recompressed output.
- Hash and CRC checks for generated binary fixtures.

This mix is intentional. Round trips alone can hide bugs when the writer and
reader share the same mistake, so important ZIP container fields are checked
directly.

Duplicate-path reader tests use hand-built or patched foreign archives. Writer
tests assert that `ZipWriter` and `writeSync()` refuse duplicate adds instead of
emitting ambiguous archives.

## Known Limitations

The suite is broad, but it does not prove every possible ZIP behavior.

### Public API Scope

The library supports stored entries and deflated entries. Tests do not cover ZIP
features that are intentionally unsupported, except to verify rejection where
relevant. Examples include encrypted entries and unsupported compression methods.

### Environment-Dependent Behavior

Deflate decompression depends on the platform `DecompressionStream("deflate-raw")`.
The suite validates normal and corrupt-stream behavior in the current test
environment, but it does not exhaustively simulate every browser implementation
or a runtime where `DecompressionStream` is missing or partially implemented. The
compat smoke test (above) does exercise the **pure-JS inflater** that replaces a
missing `DecompressionStream` on the legacy bundles, but only in a Node faithful
emulation, not in every real engine.

### Internal Defensive Branches

Some branches are defensive guards for states that are not reachable through the
public API with valid inputs. The tests generally do not force those by exposing
or monkey-patching internals. Examples include impossible Huffman overflow paths,
64-bit overflow helpers, and low-level buffer growth branches that normal routing
does not hit.

### Large Archive Scale

The suite avoids constructing genuinely huge archives. ZIP64 boundary behavior is
tested by setting counters or offsets and by using small forced-ZIP64 archives.
That verifies decision logic and record layout, but it is not a full multi-GB
stress test.

### Compatibility Matrix

The tests include Node zlib-generated archives, local fixture ZIPs, and several
legacy filename encodings. They do not claim compatibility with every ZIP tool,
every historical extra field, every platform-specific attribute convention, or
every malformed archive found in the wild.

### Performance and Memory

The suite checks functional size limits and some large-entry block behavior. It
does not benchmark throughput, peak memory, garbage collection behavior, or
browser download performance. Those concerns should be evaluated separately with
the demo and benchmark pages.

### Security Boundaries

Path traversal policy and size caps are tested as hardening features. The suite
does not constitute a full security audit. ZIP bombs, hostile browser runtime
behavior, and application-level extraction policy still need separate review when
embedding the library in a product.

## How to Run

Run the test suite with:

```sh
pnpm test
```

The Vitest suite runs the **source** tree, i.e. the native polyfill seam. To prove
the legacy compat bundles actually run on their floors, build first and run the
compat smoke test (see *Compat smoke test* below):

```sh
pnpm run build
pnpm run test:compat-smoke
```

Useful adjacent checks are:

```sh
pnpm run typecheck
pnpm run build
```

To exercise the shipped bundle in a real browser through the demo UI, build then
run the Playwright end-to-end smoke test (see *End-to-end browser smoke test*
above):

```sh
pnpm run build
pnpm run test:e2e
```

## Maintenance Notes

When adding tests, prefer the existing style:

- Start from a public API behavior.
- Use byte patching only when a malformed archive is required.
- Assert the reason the behavior matters, not only that a value changed.
- Keep synthetic large inputs bounded and deterministic.
- Avoid exporting internals purely for test convenience.
- If a branch cannot be reached through the public API, document that limitation
  instead of adding brittle test-only hooks.
