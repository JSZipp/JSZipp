# JSZipp Contract

This package exposes the JSZipp stream-native ZIP API shape:

- `ZipTransformStream`
- `ZipWriter`
- `ZipSyncInputEntry`
- `readZipStream`
- `openZip`
- `TimestampMode`

It also exposes a default `JSZipp` namespace object containing
`ZipTransformStream`, `ZipWriter`, `readZipStream`, `openZip`, and
`TimestampMode`.

The implementation targets modern browsers with WHATWG Streams, `Blob`, and
`DecompressionStream`. ZIP writing uses JSZipp's in-repo raw DEFLATE encoder
with LZ77 matching, per-block dynamic/fixed/stored block selection, and
entry-level store fallback when an unspecified-method DEFLATE attempt would
expand the payload; ZIP64 framing is implemented by JSZipp, not delegated to a
ZIP dependency.

## Error Diagnostics

JSZipp preserves the observable exception category across builds: `RangeError`,
`TypeError`, plain `Error`, and DOMException names such as `SecurityError`,
`InvalidStateError`, and `NotSupportedError` remain the compatibility surface.

The production bundles shorten `error.message` to stable codes such as
`E_PATH`, `E_LIMIT`, `E_STRUCTURE`, `E_ZIP64`, and `E_UNSUPPORTED` to keep the
browser payload small. Source/dev execution keeps the detailed human-readable
messages used by the tests and implementation docs. Applications should branch
on exception type and DOMException `name`, not exact human message text.

## Current Boundaries

- `ZipWriter` supports `outputAs: "stream" | "blob" | "response" |
  "uint8array" | "arraybuffer"`. The default is `"stream"`, so `close()` returns
  `ReadableStream<Uint8Array>` unless a different output mode is selected.
- `ZipWriter` response output uses `Content-Type: application/zip` by default
  and accepts a custom `mimeType`.
- `ZipWriter` accepts `string`, `Uint8Array`, `ArrayBuffer`, `Blob`, and
  `ReadableStream<Uint8Array>` entry data through async `add()`.
- `ZipWriter` also exposes synchronous `writeSync()` and `closeSync()` methods
  for in-memory `string`, `Uint8Array`, and `ArrayBuffer` entry data. A writer
  must be used in either async mode (`add()`/`close()`) or sync mode
  (`writeSync()`/`closeSync()`); mixing modes throws `InvalidStateError`.
- `ZipWriter` supports archive comments, explicit directory entries, per-entry
  `method: "store" | "deflate"`, per-entry `level`, and basic external
  attributes / Unix mode and DOS-attribute bits.
- Options that affect the ZIP file specification itself — `level`, `zip64`,
  `comment`, `timestamps`, `pathMode`, and `explicitDirectoryEntries` — belong on
  `ZipEncoderOptions` (shared by `ZipWriter` and `ZipTransformStream`), **not** on
  `ZipWriterOptions`. `ZipWriterOptions` adds only output-shaping options
  (`outputAs`, `mimeType`). Any future spec-related option must be added to
  `ZipEncoderOptions` so both the writer and the transform stream honor it.
- `explicitDirectoryEntries` (per-archive, default `false`) controls whether the
  writer synthesizes a standalone entry for each parent directory implied by an
  entry's path, emitting them (root-to-leaf) before the entry itself and skipping
  any already written. The default reproduces the historical behavior exactly
  (only caller-added directory entries are written). JSZipp never scans for empty
  directories; an empty folder still has to be added explicitly.
- `level` must be an integer from 0 to 9. `level: 0`, directory entries, and
  `method: "store"` are stored without compression. Unspecified methods use the
  in-repo raw DEFLATE encoder, but JSZipp stores the entry instead when the
  DEFLATE payload would be no smaller than the source. Explicit
  `method: "deflate"` always writes a DEFLATE ZIP entry.
- The ZIP compression method field is written per entry as `0x0000` for stored
  ZIP entries and `0x0008` for DEFLATE ZIP entries. A DEFLATE payload may contain
  internal stored blocks for incompressible data, but that does not change the
  enclosing ZIP entry method from `0x0008` to `0x0000`.
- Generated entries set the general-purpose bit flags field to `0x0800` to mark
  filenames and comments as UTF-8. This field is distinct from the compression
  method field.
- Writer paths are normalized by replacing backslashes with `/` and removing
  leading `/` characters. Paths ending in `/` are treated as directories.
- `ZipWriter` and `ZipTransformStream` accept a `pathMode` option that runs
  after that normalization. It defaults to `"unsafe"`, which keeps the legacy
  behavior above (normalization only). `"strict"` rejects any path the default
  reader (`pathMode: "strict"`) would refuse — `..` segments, absolute paths,
  drive-letter paths (including drive-relative names like `C:name`), and paths
  containing a NUL byte — with `SecurityError`, guaranteeing the archive is
  readable by a default `openZip`. `"sanitize"` strips those unsafe components
  instead, and rejects a path that sanitizes to empty.
- `modifiedAt` is written to the legacy DOS date/time fields as local
  wall-clock time for compatibility and, when representable as a 32-bit Unix
  timestamp and the `timestamps` mode includes `unix`, to the Extended Timestamp
  extra field (`0x5455`) as UTC mtime for timezone correctness. Readers prefer
  `0x5455` mtime and fall back to the DOS fields when it is absent or unusable.
  DOS seconds are rounded down to the nearest two-second boundary and DOS years
  are clamped to the 1980..2107 range; the Extended Timestamp field preserves
  one-second precision through early 2106. Because bare DOS fields carry no
  timezone, DOS-only timestamps can only be interpreted as local wall-clock time
  and may not identify the creator's exact instant.
- The `timestamps` option selects which modification-time fields are written. It
  is a bitmask of `TimestampMode` flags (`TimestampMode.Dos` = 1,
  `TimestampMode.Unix` = 2, `TimestampMode.Ntfs` = 4) combined with bitwise OR,
  defaulting to `TimestampMode.Dos | TimestampMode.Unix`. A value outside `0`–`7`
  (or non-integer) is rejected with `RangeError` at writer construction. The
  legacy DOS date/time pair is always present; the flags control the UTC timestamp
  extras layered on top. `Unix` adds the Extended Timestamp extra (`0x5455`,
  whole-second UTC), and `Ntfs` adds the NTFS extra (`0x000a`, 100-nanosecond
  UTC). The NTFS field stores modification, access, and creation FILETIME values;
  when an `Ntfs` mode is active and `meta.createdAt` or `meta.lastAccess` is
  omitted, each missing value defaults to `meta.modifiedAt`. A timestamp extra is
  skipped for an entry that already carries one of the same id in its `extraField`.
- On write, an entry's timestamps must each be a valid `Date` on or after the Unix
  epoch (negative or `NaN` values are rejected with `RangeError`) and causally
  consistent: when `meta.createdAt` is supplied (or defaulted under an `Ntfs`
  mode), neither `meta.modifiedAt` (which defaults to the write time when omitted)
  nor `meta.lastAccess` may be earlier than it. An entry that violates either rule
  is rejected with `RangeError` before compression.
- On read, timestamp precedence is: when an entry's NTFS extra carries both
  creation and last-access times, it is authoritative — `modifiedAt`,
  `createdAt`, and `lastAccess` come from it and the DOS and Extended-Timestamp
  fields are ignored. Otherwise `modifiedAt` is taken from the Extended Timestamp
  (`0x5455`) mtime when present, falling back to the legacy DOS date/time fields;
  `createdAt` and `lastAccess` are then `undefined`.
- Every ZIP entry already has a local file header before the file data and a
  Central Directory header near the end of the archive. When the `Unix` flag is
  selected, the Extended Timestamp field is written into both locations, adding
  18 timestamp extra-field bytes per entry on top of the base headers. The `Ntfs`
  flag adds 72 timestamp extra-field bytes per entry across the two locations.
  In many-small-file benchmarks, these extras can make JSZipp's whole archive
  larger than libraries that omit UTC timestamp extras even when the compressed
  payload bytes are comparable or smaller. ZIP metadata does not store the
  Deflate compression level; a reported level is the configured encoder setting,
  not archive metadata.
- For byte-identical (reproducible) archives, supply an explicit `modifiedAt`
  for every entry. When `modifiedAt` is omitted it defaults to `new Date()`
  (wall-clock time at write), which is not reproducible.
- `ZipRandomAccessEntry` and `ZipStreamEntry` expose the raw parsed
  `externalAttributes`. The Unix file attributes (high 16 bits,
  `externalAttributes >>> 16`) and the MS-DOS attribute byte (low 8 bits,
  `externalAttributes & 0xff`) are derivable from that value.
- Unix store permissions are recorded for an entry when `meta.unixPermissions` is
  supplied, or when a Unix Extended Timestamp (`0x5455`) is written for that entry
  — which the default `TimestampMode.Dos | TimestampMode.Unix` does for every
  entry. When recorded, the Central Directory's external attributes carry a Unix
  mode (the regular-file or directory type bits OR the permission bits) and the
  "version made by" host is set to Unix (3) so external tools apply the
  permissions. `meta.unixPermissions` is the permission portion
  of a Unix mode (e.g. `0o644` or `0o755`) and must be a three-octal-digit value
  in the range `0o000`..`0o777`; any combination within that range is accepted,
  while out-of-range or non-integer values (including setuid/setgid/sticky bits in
  `0o7000`) are rejected with `RangeError`. Because a Unix mode is meaningless
  without a Unix-host advertisement, `meta.unixPermissions` is rejected with
  `RangeError` unless `timestamps` includes `TimestampMode.Unix`. When omitted,
  the default is `0o644` for regular files and `0o755` for directories.
- `meta.dosAttributes` is the DOS-attribute counterpart to `unixPermissions`: the
  MS-DOS attribute byte written into the low 8 bits of the external attributes. It
  must be an integer in `0x00`..`0xff`. The directory bit `0x10` encodes the
  file/folder distinction and must match the entry kind (set for a directory
  entry, clear for a file); a mismatch is rejected with `RangeError`. DOS
  attributes suit a DOS or NTFS host but would confuse Unix-oriented tools, so
  they are accepted for the `Dos`, `Dos | Ntfs`, and `Dos | Unix | Ntfs` modes and
  rejected (with `RangeError`) when the Unix flag is set without the NTFS flag
  (`Dos | Unix`). When both `Unix` and `Ntfs` are set, the external attributes
  carry the Unix mode (high 16 bits) and the DOS attributes (low byte) together.
  `dosAttributes` never influences "version made by" (which reflects only the Unix
  mode). An explicit `meta.externalAttributes` overrides both `unixPermissions`
  and `dosAttributes`.
- `meta.externalAttributes` is the low-level escape hatch behind permissions: a
  raw 32-bit value written verbatim to the Central Directory (high 16 bits = Unix
  mode, low 8 bits = MS-DOS attribute flags). Supplying it overrides
  `unixPermissions` and `dosAttributes`. The "version made by" host advertises
  Unix (3) whenever the high 16 bits of the written external attributes are
  non-zero, otherwise DOS (0).
  **Use with caution:** it is an unchecked override. JSZipp writes the value as
  given and cannot reconcile it with the entry kind, the directory bit, or
  `unixPermissions` / `dosAttributes`, so a value that disagrees with the rest of
  the entry can mislead extractors or corrupt the archive's metadata. Prefer
  `unixPermissions` or `dosAttributes`.
- `meta.extraField` is written verbatim before the writer's own extras (ZIP64,
  Extended-Timestamp, NTFS). **Use with caution:** it is an unchecked override.
  It must already be well-formed ZIP extra-field bytes (repeated `id(2) +
  size(2) + payload`); JSZipp does not validate the bytes or reconcile them with
  the extras it adds, so malformed records or ids that collide with the writer's
  own extras can corrupt the archive. Most callers should leave it unset and let
  `timestamps` add the standard extras.
- `ZipWriter` and `ZipTransformStream` default to `zip64: "auto"`, emitting
  ZIP64 records only when entry sizes, entry count, or Central Directory
  placement exceed standard ZIP limits.
- When ZIP64 records are emitted, the ZIP64 extra field carries only the fields
  whose 32-bit header slot is saturated. The local file header has no
  local-offset slot, so its ZIP64 extra holds just the uncompressed and
  compressed sizes (16 data bytes); the Central Directory header additionally
  carries the local-header offset (24 data bytes). Earlier builds wrote the
  24-byte form in both headers, so external fixtures pinning the old 24-byte
  local extra must be regenerated.
- `ZipWriter` and `ZipTransformStream` expose stream-shaped output APIs, but
  each entry payload and compressed payload is still materialized in memory
  before its ZIP records are emitted.
- Runtime ZIP64 parsing and generation use JavaScript `number` values and reject
  64-bit values beyond `Number.MAX_SAFE_INTEGER`.
- Encrypted archives and unsupported compression methods throw
  `NotSupportedError`.
- `openZip` accepts `Blob`, `File`, `Uint8Array`, and `ArrayBuffer` sources and
  materializes them as bytes before parsing.
- `openZip` uses the Central Directory as source of truth and preserves duplicate
  paths in append order. Parsing requires the Central Directory to be internally
  consistent: the number of records parsed must equal the EOCD (or ZIP64 EOCD)
  entry count, and those records must consume exactly the declared
  Central Directory size; otherwise parsing throws.
- `openZip` cross-checks each entry against its local file header and rejects
  hostile divergences that would let a scanner and an extractor see different
  trees: a local/central filename mismatch, a local/central disagreement in the
  security-relevant flag bits (encryption and data descriptor), and two central
  entries that reuse the same local-header offset all throw. These checks are
  additive and do not affect archives whose local and central metadata agree
  (including JSZipp's own output and valid data-descriptor archives).
- `openZip` locates the EOCD by content, not by position: among the EOCD
  signatures in the archive tail it selects the record whose Central Directory is
  coherent (ending exactly at its EOCD/ZIP64 anchor) and content-bearing. An
  EOCD-like sequence embedded in the archive comment, or a fake EOCD appended
  after a complete archive, therefore cannot hide the real entries.
- `openZip` and `readZipStream` accept anti-zip-bomb caps for untrusted input:
  `maxArchiveSize` bounds the input archive byte length, and `maxEntrySize`
  bounds each entry's decompressed size. `maxEntrySize` is enforced during
  inflate (bounded reading), so a header that misreports its uncompressed size
  cannot expand past the cap; exceeding either cap throws a `RangeError`. The cap
  values are themselves validated: a negative or non-finite `maxArchiveSize` or
  `maxEntrySize` is rejected with `RangeError` before any input is read.
- Decompression failures are reported distinctly: a runtime without
  `deflate-raw` support throws `NotSupportedError`; a corrupt or truncated
  DEFLATE stream throws a "Corrupt DEFLATE stream" error; a decoded length that
  disagrees with the recorded size throws an inflated-size-mismatch error; and a
  `maxEntrySize` breach throws `RangeError`.
- `ZipRandomAccessReader#comment` exposes the archive-level EOCD comment when
  present.
- `openZip` decodes UTF-8 filenames when the ZIP UTF-8 flag is set. For legacy
  filenames without that flag, `filenameEncoding` can be `"cp437"`, one of the
  supported browser `TextDecoder` charset labels, or a custom decoder-shaped
  object; the default fallback is `"utf-8"`.
- `openZip` honours the Info-ZIP Unicode Path extra field (`0x7075`) as the
  entry name when present, but only after verifying its embedded CRC-32 against
  the primary header name bytes. A field whose CRC does not match is treated as
  stale and ignored, falling back to the header name under the rules above.
- `openZip` defaults to `pathMode: "strict"` and rejects `..`, absolute paths,
  drive-letter paths (including drive-relative names like `C:name`),
  backslash-separated paths, and paths containing a NUL byte with `SecurityError`.
  `pathMode: "sanitize"` removes unsafe path components; `pathMode: "unsafe"`
  exposes raw archive names.
- `pathMode: "strict-package"` is an opt-in profile for archives crossing a trust
  boundary (uploads, packages, CI artifacts). It does everything `"strict"` does
  and adds two cross-entry checks the default deliberately omits to preserve
  documented behaviour: a local/central size cross-check (with general-purpose
  bit 3 clear, the local and central sizes must agree; bit-3/data-descriptor
  entries are exempt), and rejection of entry paths that collide after Unicode
  (NFC) and case normalization (this covers exact duplicates, case-only twins
  like `Readme.txt`/`README.TXT`, and NFC/NFD twins). The default reader still
  preserves duplicate paths and defers size integrity to read time; only
  `"strict-package"` rejects them. On `ZipWriter`, `"strict-package"` is treated
  as `"strict"` per-path safety.
- `ZipRandomAccessReader#get(path)` returns the most recently appended matching
  entry and also tries the writer-style normalized form of the requested path.
- `ZipRandomAccessEntry` exposes reusable `stream()`, `text()`, `bytes()`, and
  `arrayBuffer()` helpers.
- `ZipRandomAccessReader#close()` marks the reader closed, clears path lookup
  state, and causes later entry payload access to throw `InvalidStateError`.
- `ZipStreamEntry` payload methods are single-use and throw `InvalidStateError`
  after `stream()`, `text()`, `bytes()`, `arrayBuffer()`, or `skip()` is used.
- `readZipStream` currently exposes the forward-only iterator contract by first
  collecting the source stream and parsing the Central Directory. This avoids
  ambiguous local-header parsing while the lower-level streaming decoder is still
  being hardened.
- Writer and reader operations accept `AbortSignal` and coarse `onProgress`
  hooks. Cancellation is checked between stream reads and ZIP structure steps,
  not inside synchronous DEFLATE work.
  
