# JSZipp

**The ZIP library for browser apps that need safety, streaming, and archive fidelity.**

JSZipp is a tiny, dependency-free ZIP reader and writer for modern browser apps.
It combines safe defaults, Web Streams integration, ZIP64, full archive metadata,
correct filename decoding, TypeScript types, and practical output shapes
(`Blob`, `Response`, `ReadableStream`, `Uint8Array`, `ArrayBuffer`) in one
focused package.

Reach for JSZipp when your app handles **ZIP archives in the browser** — file
uploads, downloadable exports, `.docx` / `.xlsx` / `.epub` inspection, plugin
bundles, templates, CI artifacts, generated reports, or package-like archives —
and you want the default path to be safe and productive.

```ts
import { ZipWriter, openZip } from "jszipp";

// Create a browser-downloadable ZIP.
const writer = new ZipWriter({ outputAs: "blob" });
await writer.add({ path: "hello.txt", data: "Hello from JSZipp" });
const download = await writer.close();

// Open an untrusted upload with the strict package profile.
const zip = await openZip(fileInput.files![0], {
  pathMode: "strict-package",
  maxArchiveSize: 50 * 1024 * 1024,
  maxEntrySize: 10 * 1024 * 1024
});

console.log(await zip.get("hello.txt")?.text());
await zip.close();
```

## Why JSZipp?

Most ZIP libraries make the happy path easy. JSZipp is designed to make the
**safe browser happy path** easy.

| General-user need | Why it matters | JSZipp's answer |
| --- | --- | --- |
| Accept user ZIP uploads | ZIP filenames are attacker-controlled paths, not harmless labels. | `openZip()` rejects unsafe paths by default; `strict-package` adds package-grade collision and local/central consistency checks. |
| Avoid zip-bomb surprises | A small upload can claim one size and expand into much more data. | `maxArchiveSize` bounds the archive and `maxEntrySize` is enforced while inflating. |
| Ship less JavaScript | Browser apps pay for every byte and every dependency. | Zero dependencies, native `DecompressionStream` for reading deflated entries, and tree-shakeable reader/writer entry points. |
| Work with real browser APIs | Downloads, fetch responses, service workers, and pipelines already speak Web APIs. | `ZipWriter` can return `Blob`, `Response`, `ReadableStream`, `Uint8Array`, or `ArrayBuffer`; `ZipTransformStream` is a native `TransformStream`. |
| Preserve real archive data | Archives are more than compressed bytes: comments, modes, timestamps, names, and ZIP64 matter. | ZIP64, comments, extra fields, Unix mode bits, DOS + UTC timestamps, CRC-32, CP437, `TextDecoder` fallbacks, and Info-ZIP Unicode Path support. |
| Keep the app code simple | Most teams do not want to write their own ZIP safety and metadata layer. | Random-access `entries` / `get(path)` plus `text()` / `bytes()` / `arrayBuffer()` / `stream()` helpers and full TypeScript types. |

The practical win is not that JSZipp beats every library at every benchmark. It
is that common browser ZIP tasks need fewer adapters, fewer security footguns,
and fewer project-specific validation rules.

## Highlights

- **Safe by default.** `openZip` rejects Zip Slip (`..`), absolute, drive-letter,
  drive-relative, backslash, and NUL-byte paths out of the box. It also
  cross-checks each entry's local header against the central directory for
  filename, security-flag, and reused-offset consistency, so a scanner and an
  extractor cannot be shown two different file trees.
- **A stricter profile for untrusted packages.** `pathMode: "strict-package"`
  adds local/central size cross-checks and rejects duplicate, case-only
  (`Readme.txt` vs `README.TXT`), and Unicode NFC/NFD path collisions — the
  parser-differential tricks that appear when one tool validates an archive and
  another extracts it.
- **Anti-zip-bomb caps.** `maxArchiveSize` and `maxEntrySize` bound input and
  per-entry output. `maxEntrySize` is enforced *during* inflate, so a header that
  lies about its uncompressed size cannot expand past the cap before JSZipp
  notices.
- **Browser-native output.** Create a ZIP byte stream by default, or ask for a
  `Blob` for downloads, a `Response` for fetch-like APIs, or raw bytes for
  storage and tests. `AbortSignal` and progress callbacks are first-class.
- **Stream-shaped APIs.** `ZipTransformStream` drops into Web Streams pipelines,
  while `readZipStream` gives you a `for await...of` reader for archive entries.
- **Full-fidelity ZIP handling.** ZIP64 (auto/force/off), store + deflate,
  per-file and archive comments, extra fields, Unix mode bits, DOS + UTC
  (`0x5455`) timestamps, CRC-32 integrity, and EOCD-by-content detection that
  resists comment/append forgery.
- **Correct filenames.** UTF-8 with the UTF-8 flag, a built-in CP437 decoder,
  `TextDecoder` fallbacks (`shift_jis`, `gbk`, `big5`, …), and CRC-verified
  Info-ZIP Unicode Path (`0x7075`) support.
- **Ergonomic and typed.** Random-access `entries` / `get(path)`, reusable
  `text()` / `bytes()` / `arrayBuffer()` / `stream()` helpers, synchronous
  in-memory writing, and full TypeScript types.

## JSZipp vs JSZip vs fflate

There are excellent ZIP libraries already. The honest summary:

- **JSZip** is a mature, friendly, general-purpose ZIP toolkit with a large
  ecosystem and a familiar API.
- **fflate** is a best-in-class JavaScript compression engine with fast raw
  DEFLATE/GZIP/Zlib/ZIP primitives and callback-style streaming tools.
- **JSZipp** focuses on *safe, browser-native, full-fidelity ZIP archive handling*
  for apps that read or write archives crossing a trust boundary.

| | **JSZipp** | JSZip | fflate |
| --- | --- | --- | --- |
| Best fit | Browser ZIP handling with safety defaults | Mature general ZIP toolkit | Fastest/smallest compression engine |
| Read unsafe paths | Rejects by default; `sanitize` / `unsafe` are opt-in | Sanitizes relative path traversal; strict rejection policy is app-defined | App-defined |
| Package hardening | `strict-package` collision + local/central checks | No strict-package profile | No strict-package profile |
| Parser-differential defenses | Filename, security flags, reused offsets; size checks in `strict-package` | Not the primary focus | Not the primary focus |
| Anti-zip-bomb caps | Built in (`maxArchiveSize`, bounded `maxEntrySize`) | App-defined | App-defined/filter-based |
| Browser Web Streams | Native `ReadableStream` + `TransformStream` shapes | Promise/StreamHelper/Node stream oriented | Callback stream APIs |
| Browser output targets | `ReadableStream`, `Blob`, `Response`, `Uint8Array`, `ArrayBuffer` | Common byte/blob outputs | Byte arrays/callback chunks |
| Random-access convenience | `entries`, `get(path)`, reusable entry readers | Yes, mature object API | Mostly lower-level ZIP primitives |
| Full archive metadata | Comments, extra fields, modes, timestamps, ZIP64 | Common metadata, but some input data is discarded on rewrite | Focused on compression/archive primitives |
| Filename encodings | UTF-8, CP437, `TextDecoder` fallbacks, Unicode Path extra | UTF-8 plus custom decode hooks | UTF-8-oriented API |
| Dependencies | None | None | None |
| Raw compression speed | Good | Moderate | Best-in-class |

Competitor cells are deliberately high-level and may change by version. Verify
library-specific behavior against the release you use.

### Choosing between them

- **Pick JSZipp** when you read ZIP uploads, inspect package-like archives, create
  downloadable ZIPs in a browser, need Web Streams or `Response` output, care
  about metadata, or want safe defaults instead of writing your own path,
  collision, and zip-bomb guardrails.
- **Pick JSZip** when you already rely on its API or ecosystem, want the most
  familiar general-purpose ZIP object model, and do not need JSZipp's stricter
  trust-boundary profile or browser-native stream shapes.
- **Pick fflate** when raw compression/decompression speed, worker-based
  throughput, or the smallest compression-focused primitive is the deciding
  factor, and you are comfortable building your own archive policy, metadata
  layer, and app-specific validation.

If your decision question is **"can my browser app safely open this ZIP
upload?"**, JSZipp is built for that job: use `openZip` with
`pathMode: "strict-package"` plus explicit `maxArchiveSize` and `maxEntrySize`
caps, and reject archives that do not meet the profile.

## Runtime

- ECMAScript 2019 output
- Modern browsers with `ReadableStream`, `TransformStream`, `Blob`, and
  `DecompressionStream` for reading deflated entries
- Intended browser baseline: Chrome 80+ and Firefox 113+ class browsers
- Node.js can run the tests, but the library is designed for browser APIs

## Error Messages

JSZipp keeps exception classes and DOMException names stable across builds
(`RangeError`, `TypeError`, `SecurityError`, `InvalidStateError`,
`NotSupportedError`, and so on). Production bundles shorten `error.message` to
codes such as `E_PATH`, `E_LIMIT`, and `E_STRUCTURE`; source/dev execution keeps
the detailed diagnostic messages used by the test suite.

## Install

```sh
pnpm add jszipp
```

```ts
import JSZipp, {
  ZipWriter,
  ZipTransformStream,
  openZip,
  readZipStream,
  TimestampMode
} from "jszipp";
```

`JSZipp` is the default namespace export and includes the same runtime values:
`ZipWriter`, `ZipTransformStream`, `openZip`, `readZipStream`, and
`TimestampMode`. Named exports are usually more convenient in application code.

Browser-legacy builds are opt-in npm subpaths for apps that must target older
browser pairs. They expose the same public API as the main entry point, but ship
extra compatibility code:

```ts
import { ZipWriter, openZip } from "jszipp/browser-legacy/cr61ff58";
```

```ts
import { ZipWriter, openZip } from "jszipp/browser-legacy/cr86ff68";
```

If you prefer CDN script tags, use one of the following UMD builds:

```html
<!-- Modern UMD default -->

<script src="https://unpkg.com/jszipp"></script>

<script src="https://cdn.jsdelivr.net/npm/jszipp"></script>


<!-- Chrome 61 / Firefox 58 compatible UMD -->

<script src="https://unpkg.com/jszipp/dist/cr61ff58/jszipp.umd.js"></script>

<script src="https://cdn.jsdelivr.net/npm/jszipp/dist/cr61ff58/jszipp.umd.js"></script>


<!-- Chrome 86 / Firefox 68 compatible UMD -->

<script src="https://unpkg.com/jszipp/dist/cr86ff68/jszipp.umd.js"></script>

<script src="https://cdn.jsdelivr.net/npm/jszipp/dist/cr86ff68/jszipp.umd.js"></script>
```

## Which API Should I Use?

| Your app needs to | Use | Why |
| --- | --- | --- |
| Create a ZIP Blob for download or upload | `new ZipWriter({ outputAs: "blob" })` | Easiest option for most browser apps. |
| Create a ZIP HTTP response | `new ZipWriter({ outputAs: "response" })` | Returns a native `Response` wrapper. |
| Create a ZIP byte stream | `new ZipWriter()` | Default mode returns `ReadableStream<Uint8Array>`. |
| Create raw ZIP bytes | `new ZipWriter({ outputAs: "uint8array" })` | Returns browser byte containers directly. |
| Insert ZIP creation into an existing Web Streams pipeline | `ZipTransformStream` | It is a native `TransformStream`. |
| Open a user-selected `.zip` file and read files by name | `openZip` | Best random-access API for `Blob`, `File`, `Uint8Array`, or `ArrayBuffer`. |
| Open an untrusted upload or package | `openZip(file, { pathMode: "strict-package", maxArchiveSize, maxEntrySize })` | Applies the strongest reader policy with explicit size caps. |
| List every entry in archive order, including duplicate names from foreign archives | `openZip(...).entries` | Preserves the archive's true entry order. |
| Get JSZipp's selected file for a path when duplicates exist | `openZip(...).get(path)` | Returns the last matching central-directory entry; external extractors vary. |
| Consume a ZIP as an async iterator | `readZipStream` | Forward-style iteration with single-use entry tokens. |
| Read a file more than once or concurrently | `openZip` | Random-access entries create independent streams. |
| Create a small in-memory ZIP synchronously | `writer.writeSync()` + `writer.closeSync()` | Useful for tests, fixtures, and already-in-memory data. |

Most browser apps should use:

- `ZipWriter` for creating archives
- `openZip` for reading archives selected by the user

Use `ZipTransformStream` only when you already think in Web Streams. Use
`readZipStream` when async iteration is a better fit than path lookup.

## Create A ZIP

`ZipWriter` is the simplest way to create an archive. For browser downloads,
ask it to return a `Blob`.

```ts
import { ZipWriter } from "jszipp";

const writer = new ZipWriter({ level: 6, outputAs: "blob" });

await writer.add({ path: "hello.txt", data: "Hello from JSZipp" });
await writer.add({ path: "docs/readme.md", data: "# Readme\n" });
const zipBlob = await writer.close();
```

Save it from the browser:

```ts
const url = URL.createObjectURL(zipBlob);
const link = document.createElement("a");
link.href = url;
link.download = "archive.zip";
link.click();
URL.revokeObjectURL(url);
```

## Add Different Data Types

`ZipInputEntry.data` accepts `string`, `Uint8Array`, `ArrayBuffer`, `Blob`, or
`ReadableStream<Uint8Array>`.

```ts
const writer = new ZipWriter({ level: 6, outputAs: "blob" });

await writer.add({ path: "text.txt", data: "plain text" });
await writer.add({ path: "bytes.bin", data: new Uint8Array([1, 2, 3]) });
await writer.add({ path: "buffer.bin", data: new Uint8Array([4, 5, 6]).buffer });
await writer.add({ path: "photo.jpg", data: fileInput.files![0] });
await writer.add({ path: "folder/", data: "" });
await writer.add({
  path: "stream.txt",
  data: new Blob(["streamed content"]).stream()
});

const zipBlob = await writer.close();
```

## Add Metadata

Each entry can include a comment, timestamps, Unix permissions, DOS attributes,
or low-level ZIP metadata. Writer options can also include an archive-level ZIP
comment.

```ts
const writer = new ZipWriter({
  outputAs: "blob",
  comment: "Generated by JSZipp"
});

await writer.add({
  path: "report.txt",
  data: "Quarterly report",
  meta: {
    comment: "Generated in the browser",
    modifiedAt: new Date("2026-05-31T12:00:00Z"),
    unixPermissions: 0o644
  }
});

await writer.add({
  path: "scripts/build.sh",
  data: "#!/bin/sh\npnpm build\n",
  meta: { unixPermissions: 0o755 }
});
```

## Compression Options

```ts
new ZipWriter({
  level: 6,
  zip64: "auto",
  outputAs: "blob"
});
```

`level`:

- `0`: store files without compression
- `1` to `9`: use DEFLATE compression with real level control
- default: `6`

`zip64`:

- `"auto"`: emit ZIP64 records only when standard ZIP limits are exceeded. This is the default.
- `"force"`: always emit ZIP64-compatible records.
- `"off"`: write standard ZIP records and throw if ZIP64 would be required.

`outputAs`:

- `"stream"`: `close()` returns `ReadableStream<Uint8Array>`. This is the default.
- `"blob"`: `close()` returns a native `Blob`.
- `"response"`: `close()` returns a native `Response`.
- `"uint8array"`: `close()` returns a `Uint8Array`.
- `"arraybuffer"`: `close()` returns an `ArrayBuffer`.

Use `level: 6` for text, JSON, CSV, HTML, and similar files. JSZipp will store
an entry automatically when the default DEFLATE attempt would not make it
smaller. Use `level: 0` or `method: "store"` when you want to skip compression
work entirely for already-compressed files such as JPEG, PNG, MP4, or PDF.

You can override compression per entry:

```ts
await writer.add({ path: "photo.jpg", data: photoFile, method: "store" });
await writer.add({ path: "data/report.json", data: jsonText, method: "deflate" });
```

`method: "store"` skips compression for that entry. `method: "deflate"` forces
JSZipp's in-repo raw DEFLATE writer. When no per-entry method is set, JSZipp
uses DEFLATE but stores the entry instead if the compressed payload would be no
smaller than the source. Entry-level `level` overrides the writer default for
that file, so you can use lower levels for faster files and higher levels for
deeper match search.

Generated archives use ZIP method `0x0000` for stored entries, ZIP method
`0x0008` for deflated entries, and general-purpose bit flags `0x0800` to mark
filenames/comments as UTF-8. For the ZIP-format distinction between compression
method values and general-purpose bit flags, see
[ZIP metadata traps](docs/zip-metadata-traps.md#compression-method-and-general-purpose-bit-flags).

## Choose The Output Type

Default streaming output:

```ts
const writer = new ZipWriter();

await writer.add({ path: "log.txt", data: "stream me" });
const stream = await writer.close();
```

Blob output for downloads, file uploads, or `openZip`:

```ts
const writer = new ZipWriter({ outputAs: "blob" });

await writer.add({ path: "report.txt", data: "download me" });
const blob = await writer.close();
```

Response output for service workers, route handlers, and fetch-like APIs:

```ts
const writer = new ZipWriter({ outputAs: "response" });

await writer.add({ path: "api.txt", data: "response body" });
const response = await writer.close();
```

Custom response MIME type:

```ts
const writer = new ZipWriter({
  outputAs: "response",
  mimeType: "application/x-zip-compressed"
});
```

Raw byte output:

```ts
const bytes = await new ZipWriter({ outputAs: "uint8array" }).close();
const buffer = await new ZipWriter({ outputAs: "arraybuffer" }).close();
```

## Synchronous In-Memory Writing

Use `writeSync()` / `closeSync()` for tests, fixtures, small generated archives,
or code paths where all entry data is already in memory. The synchronous API
accepts `string`, `Uint8Array`, and `ArrayBuffer` data. Use async `add()` for
`Blob` and `ReadableStream` input.

```ts
const writer = new ZipWriter({ outputAs: "uint8array" });

writer.writeSync({ path: "manifest.json", data: JSON.stringify({ ok: true }) });
writer.writeSync({ path: "data.bin", data: new Uint8Array([1, 2, 3]) });

const zipBytes = writer.closeSync();
```

Do not mix sync and async writes on the same writer. JSZipp rejects mixed usage
so entries are not accidentally routed to different output paths.

## Read A ZIP By File Name

Use `openZip` when the ZIP is a `Blob`, `File`, `Uint8Array`, or `ArrayBuffer`,
such as a file chosen from an `<input type="file">`.

```ts
import { openZip } from "jszipp";

const file = fileInput.files![0];
const reader = await openZip(file);

const readme = reader.get("docs/readme.md");
if (readme) {
  console.log(await readme.text());
}

await reader.close();
```

By default, `openZip()` rejects unsafe entry paths that could escape an
extraction root, including `..`, absolute paths, drive-letter paths (including
drive-relative names like `C:name`), backslash-separated paths, and paths
containing a NUL byte. Use `pathMode: "sanitize"` to normalize unsafe names
instead, or `pathMode: "unsafe"` only when you need raw archive names and will
handle extraction safety yourself.

```ts
const reader = await openZip(file, { pathMode: "sanitize" });
```

### Strict Package Mode

For archives that cross a trust boundary — uploads, software packages, CI
artifacts, document bundles — use `pathMode: "strict-package"`. It applies all
the `"strict"` path checks above and adds two cross-entry checks the default
deliberately leaves off (so the default can preserve duplicate paths and defer
size integrity to read time):

- the local file header and central directory sizes must agree (for non-streaming
  entries), and
- no two entries may collide after Unicode (NFC) and case normalization — this
  rejects exact duplicates, case-only twins (`Readme.txt` vs `README.TXT`), and
  NFC/NFD twins.

```ts
try {
  // A hostile package with duplicate, case-colliding, or size-spoofing entries
  // throws here instead of being silently accepted.
  const reader = await openZip(untrustedUpload, { pathMode: "strict-package" });
  for (const entry of reader.entries) {
    // ... safe to process
  }
} catch (error) {
  // Reject the upload: it does not meet the strict package profile.
}
```

The default reader (`pathMode: "strict"`) is unchanged: it still preserves
duplicate paths and verifies size/CRC integrity at read time.

Writers reject duplicate normalized entry paths. If you need to replace an entry,
choose the final payload before calling `add()` or `writeSync()`.

## List Every Entry

`reader.entries` preserves the real order inside the archive. This matters for
ZIP files from other tools that contain duplicate paths.

```ts
const reader = await openZip(zipBlob);

for (const entry of reader.entries) {
  console.log({
    path: entry.path,
    size: entry.size,
    compressedSize: entry.compressedSize,
    crc32: entry.crc32,
    isDirectory: entry.isDirectory,
    comment: entry.comment,
    modifiedAt: entry.modifiedAt,
    externalAttributes: entry.externalAttributes,
    unixFileAttributes: entry.externalAttributes !== undefined ? entry.externalAttributes >>> 16 : undefined,
    dosAttributeByte: entry.externalAttributes !== undefined ? entry.externalAttributes & 0xff : undefined
  });
}
```

## Duplicate File Names

ZIP archives can contain the same path more than once. `entries` shows all of
them. `get(path)` returns the latest matching entry.

```ts
const reader = await openZip(zipBlob);

const allCopies = reader.entries.filter((entry) => entry.path === "data.json");
const latest = reader.get("data.json");
```

## Read Entry Data

Random-access entries from `openZip` are reusable. You can call `stream()` or
`text()` many times.

```ts
const entry = reader.get("data.json");

if (entry) {
  const text = await entry.text();
  const bytes = await entry.bytes();
  const buffer = await entry.arrayBuffer();
}
```

## Read Legacy File Names

If an archive does not mark names as UTF-8, `openZip` can use a fallback
encoding.

```ts
const reader = await openZip(file, {
  filenameEncoding: "shift_jis",
  pathMode: "strict"
});
```

Supported fallback values:

- `"cp437"`
- any charset label supported by `TextDecoder`, such as `"utf-8"`,
  `"shift_jis"`, or `"windows-1252"`

See [Filename Charset Handling](docs/charset.md) for
details on ZIP filename charset behavior and choosing a fallback.

## Stream Pipeline Writing

Use `ZipTransformStream` when another part of your app already writes
`ZipInputEntry` objects into a stream.

```ts
import { ZipTransformStream } from "jszipp";

const zipStream = new ZipTransformStream({ level: 6 });
const archivePromise = new Response(zipStream.readable).blob();
const writer = zipStream.writable.getWriter();

await writer.write({ path: "a.txt", data: "A" });
await writer.write({ path: "b.txt", data: "B" });
await writer.close();

const zipBlob = await archivePromise;
```

## Async Iterator Reading

Use `readZipStream` when you want a `for await...of` style reader.

```ts
import { readZipStream } from "jszipp";

for await (const entry of readZipStream(zipBlob.stream())) {
  if (entry.isDirectory) {
    await entry.skip();
    continue;
  }

  if (entry.path.endsWith(".txt")) {
    console.log(entry.path, await entry.text());
  } else {
    await entry.skip();
  }
}
```

`ZipStreamEntry` payloads are single-use. For each entry, call exactly one of:

- `entry.stream()`
- `entry.text()`
- `entry.bytes()`
- `entry.arrayBuffer()`
- `entry.skip()`

If you need to read the same entry more than once, use `openZip` instead.

## API Reference

### `new ZipWriter(options?)`

High-level ZIP writer.

```ts
const writer = new ZipWriter({
  level: 6,
  zip64: "auto",
  outputAs: "blob"
});
```

Properties and methods:

- `writer.output: ReadableStream<Uint8Array>`
- `writer.add(entry: ZipInputEntry): Promise<void>`
- `writer.writeSync(entry: ZipSyncInputEntry): void`
- `writer.close(): Promise<ReadableStream<Uint8Array> | Blob | Response | Uint8Array | ArrayBuffer>`
- `writer.closeSync(): ReadableStream<Uint8Array> | Blob | Response | Uint8Array | ArrayBuffer`

The writer rejects duplicate normalized entry paths. It does not emit archives
where two records target the same path.

`close()` returns a more specific type when `outputAs` is known:

```ts
const stream = await new ZipWriter().close();
const blob = await new ZipWriter({ outputAs: "blob" }).close();
const response = await new ZipWriter({ outputAs: "response" }).close();
const bytes = await new ZipWriter({ outputAs: "uint8array" }).close();
```

Options:

```ts
interface ZipWriterOptions {
  level?: number;
  zip64?: "auto" | "force" | "off";
  comment?: string;
  timestamps?: number; // bitmask of TimestampMode flags (Dos=1, Unix=2, Ntfs=4)
  pathMode?: "strict" | "sanitize" | "unsafe" | "strict-package";
  signal?: AbortSignal;
  onProgress?: (progress: ZipProgress) => void;
  explicitDirectoryEntries?: boolean;
  outputAs?: "stream" | "blob" | "response" | "uint8array" | "arraybuffer";
  mimeType?: string;
}
```

### `new ZipTransformStream(options?)`

Native transform stream from `ZipInputEntry` objects to ZIP bytes.

```ts
const stream = new ZipTransformStream({ level: 0, zip64: "off" });
```

It extends:

```ts
TransformStream<ZipInputEntry, Uint8Array>
```

### `openZip(source, options?)`

Random-access reader for `Blob`, `File`, `Uint8Array`, or `ArrayBuffer`.

```ts
const reader = await openZip(file, {
  filenameEncoding: "utf-8",
  pathMode: "strict-package",
  maxArchiveSize: 50 * 1024 * 1024,
  maxEntrySize: 10 * 1024 * 1024
});
```

Options:

```ts
interface ZipReadOptions {
  filenameEncoding?: "cp437" | StandardFilenameEncoding | {
    encoding: string;
    fatal: boolean;
    ignoreBOM: boolean;
    decode(bytes: Uint8Array): string;
  };
  pathMode?: "strict" | "sanitize" | "unsafe" | "strict-package";
  maxArchiveSize?: number;
  maxEntrySize?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ZipProgress) => void;
}
```

Returns:

```ts
interface ZipRandomAccessReader {
  readonly comment?: string;
  readonly entries: readonly ZipRandomAccessEntry[];
  get(path: string): ZipRandomAccessEntry | undefined;
  close(): Promise<void>;
}
```

### `readZipStream(zipStream, options?)`

Async iterable reader.

```ts
for await (const entry of readZipStream(zipBlob.stream())) {
  await entry.skip();
}
```

Returns:

```ts
AsyncIterable<ZipStreamEntry>
```

### `ZipInputEntry`

```ts
interface ZipInputEntry {
  path: string;
  data: string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;
  method?: "store" | "deflate";
  level?: number;
  meta?: ZipEntryMeta;
}
```

### `ZipSyncInputEntry`

```ts
interface ZipSyncInputEntry extends Omit<ZipInputEntry, "data"> {
  data: string | Uint8Array | ArrayBuffer;
}
```

### `ZipEntryMeta`

```ts
interface ZipEntryMeta {
  comment?: string;          // per-entry comment (informational)
  extraField?: Uint8Array;   // raw, well-formed ZIP extra-field bytes — ⚠ unchecked override
  modifiedAt?: Date;         // mtime; defaults to write time; must be a valid Date ≥ 1970
  createdAt?: Date;          // defaults to modifiedAt when timestamps includes TimestampMode.Ntfs
  lastAccess?: Date;         // defaults to modifiedAt when timestamps includes TimestampMode.Ntfs
  unixPermissions?: number;  // Unix permission bits 0o000–0o777; needs the Unix timestamp mode
  dosAttributes?: number;    // MS-DOS attribute byte 0x00–0xff; 0x10 must match entry kind; not allowed in Dos|Unix
  externalAttributes?: number; // raw 32-bit external attributes — ⚠ unchecked override
}
```

`comment` is an informational per-entry comment. It does not affect extraction.

`modifiedAt` is the main entry timestamp and defaults to the current write time
when omitted. `createdAt` and `lastAccess` are stored only when the `timestamps`
mode includes `TimestampMode.Ntfs`; in that mode, omitted creation/access times
default to `modifiedAt`.

`unixPermissions` stores the permission portion of a Unix mode, such as `0o644`
for a regular file or `0o755` for a script or directory. JSZipp adds the
file-type bits from the entry kind. Use `unixPermissions: 0o755` when that
permission should survive extraction.

`dosAttributes` stores the MS-DOS attribute byte, such as read-only, hidden,
archive, or directory flags. Use it when you need Windows/DOS-style attributes;
for ordinary Unix permission restoration, prefer `unixPermissions`.

`externalAttributes` is the raw 32-bit Central Directory attribute field behind
Unix permissions and DOS attributes. Set it only when you need to round-trip an
exact value from another archive; it overrides the higher-level permission fields.

`extraField` appends raw ZIP extra-field records for callers that already know
the ZIP extra format. It is useful for exact metadata preservation, but most
callers should leave it unset.

`externalAttributes` and `extraField` are unchecked manual overrides. JSZipp
writes them as supplied and cannot detect every conflict with the entry kind or
with generated metadata, so prefer `unixPermissions`, `dosAttributes`, and the
`timestamps` option for normal writes.

For field validation and timestamp-mode interactions, see the
[API reference](pages/api.html#entry-meta). For ZIP-format background on what
metadata adds bytes, see [ZIP optional metadata](docs/zip-optional-metadata.md).

### `ZipRandomAccessEntry`

```ts
interface ZipRandomAccessEntry extends ZipEntryMeta {
  readonly path: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly crc32: number;
  readonly isDirectory: boolean;
  stream(): ReadableStream<Uint8Array>;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
```

### `ZipStreamEntry`

```ts
interface ZipStreamEntry extends ZipEntryMeta {
  readonly path: string;
  readonly size: number | null;
  readonly compressedSize: number | null;
  readonly crc32: number | null;
  readonly isDirectory: boolean;
  stream(): ReadableStream<Uint8Array>;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  skip(): Promise<void>;
}
```

## Timestamp Modes and Archive Size

ZIP stores timestamps in more than one place, and JSZipp lets you choose which
with the `timestamps` bitmask (`TimestampMode.Dos` = 1, `Unix` = 2, `Ntfs` = 4;
default `Dos | Unix`; values outside `0`–`7` are rejected). The legacy MS-DOS
date/time pair lives in the normal ZIP headers and is **always** written.

Every ZIP entry already has two per-entry metadata locations: a local file header
before the file data, and a Central Directory header near the end of the archive.
The byte counts below are the **additional timestamp extra-field bytes** JSZipp
writes into those existing locations. They do not include the base local header,
Central Directory header, filename bytes, comments, ZIP64 records, EOCD records,
or compressed file data. For a broader breakdown of ZIP metadata size, see
[ZIP optional metadata](docs/zip-optional-metadata.md).

- **`Dos` (always on).** Two bytes of date plus two of time are already reserved
  in every local header and Central Directory header, so it adds no extra bytes
  beyond the normal per-entry ZIP headers. The tradeoff is fidelity: 2-second
  granularity, no time zone (interpreted as local wall-clock), and a representable
  range of 1980–2107. Dates before 1980 clamp upward; the writer rejects pre-1970
  (negative) dates outright.
- **`Unix` (`0x5455` Extended Timestamp).** Whole-second UTC mtime. JSZipp writes
  a 9-byte extra-field record in both the local header and Central Directory
  header (**+18 timestamp bytes per entry**). It also lets you set
  `unixPermissions` and makes the archive advertise the Unix host. Skipped for
  dates outside the unsigned 32-bit Unix range (then only DOS applies).
- **`Ntfs` (`0x000a` NTFS extra).** 100-nanosecond UTC modification, access, and
  creation times. JSZipp writes a 36-byte extra-field record in both headers
  (**+72 timestamp bytes per entry**). When this flag is set, a missing
  `createdAt` or `lastAccess` defaults to `modifiedAt`. It also lets you set
  `dosAttributes`.

| `timestamps` | Extra timestamp bytes/entry | mtime precision | createdAt / lastAccess | `unixPermissions` | `dosAttributes` |
| --- | --- | --- | --- | --- | --- |
| `Dos` | 0 | 2 s, local | not stored | rejected | allowed |
| `Dos \| Unix` (default) | +18 | 1 s, UTC | not stored | allowed | rejected |
| `Dos \| Ntfs` | +72 | 100 ns, UTC | stored (default to mtime) | rejected | allowed |
| `Dos \| Unix \| Ntfs` | +90 | 100 ns, UTC | stored (default to mtime) | allowed | allowed |

`dosAttributes` is rejected for `Dos | Unix` specifically: a Unix-host archive
that also carried DOS attribute bits would confuse Unix-oriented tools. On read,
an NTFS extra carrying both creation and last-access times is authoritative;
otherwise JSZipp prefers the `0x5455` mtime and falls back to the DOS fields. For
the smallest archive use `Dos` alone; for portable UTC mtime use the default
`Dos | Unix`; reach for `Ntfs` only when you need sub-second or creation/access
times, since it is the largest of the three.

## Important Notes

- `ZipWriter` defaults to `outputAs: "stream"`. Use `outputAs: "blob"` for the
  easiest browser download flow.
- `writer.output` is still available for advanced streaming integrations, but
  most apps should use the value returned by `writer.close()`.
- `ZipWriter`, `ZipTransformStream`, and `readZipStream` expose Web Streams
  shapes but currently consume each entry payload, compression result, and read
  archive into memory before emitting the next ZIP structure.
- `ZipWriter`, `openZip`, and `readZipStream` accept `AbortSignal`; large
  operations can also report coarse progress with `onProgress`.
- Encrypted ZIP files are not supported.
- Unsupported compression methods are rejected.
- ZIP64 records are supported with JavaScript `number` precision limits.
- Modification times are always written to the legacy DOS fields. The
  `timestamps` option controls which UTC timestamp extras are added; see
  [Timestamp Modes and Archive Size](#timestamp-modes-and-archive-size) and
  [docs/timezone.md](./docs/timezone.md) for the detailed timezone model.
- `explicitDirectoryEntries` (default `false`) controls whether the writer
  materializes a standalone entry for every parent directory implied by an
  entry's path (`a/b/c.txt` also emits `a/` and `a/b/`). The default keeps the
  historical behavior — only the directory entries you add yourself are written.
  JSZipp never scans for empty directories, so an empty folder must still be added
  explicitly regardless of this flag.
- All options that affect the ZIP file specification itself — `level`, `zip64`,
  `comment`, `timestamps`, `pathMode`, and `explicitDirectoryEntries` — live on
  `ZipEncoderOptions`, shared by `ZipWriter` and `ZipTransformStream`. Only the
  output-shaping options (`outputAs`, `mimeType`) are `ZipWriter`-specific.
- `openZip` and `readZipStream` reject a negative or non-finite `maxArchiveSize`
  or `maxEntrySize`.
- `readZipStream` currently exposes the forward-iteration API by collecting the
  input stream and parsing the Central Directory first.

See [CONTRACT.md](./CONTRACT.md) for the detailed implementation contract and
current runtime boundaries. See [docs/timezone.md](./docs/timezone.md) for the
timestamp timezone model.

## Build

```sh
pnpm install
pnpm test
pnpm build
```

The npm package points at generated files under `dist/`. `prepack` runs the
build and test suite before `pnpm pack` / `pnpm publish`, so the published
tarball contains those generated artifacts even if the source repository omits
them.

Build output:

- `dist/jszipp.mjs`
- `dist/jszipp.cjs`
- `dist/jszipp.umd.js`
- `dist/jszipp.writer.umd.js`
- `dist/jszipp.reader.umd.js`
- `dist/cr61ff58/jszipp.mjs`
- `dist/cr61ff58/jszipp.cjs`
- `dist/cr61ff58/jszipp.umd.js`
- `dist/cr61ff58/jszipp.reader.umd.js`
- `dist/cr61ff58/jszipp.writer.umd.js`
- `dist/cr86ff68/jszipp.mjs`
- `dist/cr86ff68/jszipp.cjs`
- `dist/cr86ff68/jszipp.umd.js`
- `dist/cr86ff68/jszipp.reader.umd.js`
- `dist/cr86ff68/jszipp.writer.umd.js`
- `dist/index.d.ts`
- `dist/types.d.ts`
- `dist/writer.d.ts`
- `dist/reader.d.ts`

## License

MIT
