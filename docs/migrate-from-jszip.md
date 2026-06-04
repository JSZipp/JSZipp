# Upgrading from JSZip to JSZipp: A Migration Guide

JSZipp is a small, dependency-free ZIP library for modern browser APIs. It can
be a good fit when you want a compact package, a writer that exposes Web Stream
output, ZIP64 support, and a direct `ZipWriter` / `openZip` API.

It is **not a drop-in replacement for JSZip**. JSZip gives you a mutable archive
object; JSZipp gives you append-style writers and readers. Most migrations need
some API reshaping.

---

## Quick Comparison

| Feature | JSZip | JSZipp |
| --- | --- | --- |
| Architecture | Mutable in-memory archive object | Append-style writer plus random-access and iterator readers |
| Writing API | `zip.file()`, `zip.folder()`, `generateAsync()` | `writer.add()`, `writer.close()`, `ZipTransformStream` |
| Reading API | `JSZip.loadAsync()`, `zip.file(path).async(type)` | `openZip(source)`, `reader.get(path)`, `readZipStream(stream)` |
| Modification model | Load, mutate, remove, overwrite, then generate | No in-place mutation; rebuild a new archive |
| Output types | Browser and Node-oriented types, including Base64 and Node `Buffer` | Web-native types: `ReadableStream`, `Blob`, `Response`, `Uint8Array`, `ArrayBuffer` |
| Streaming | Has stream-related generation options; still generally archive-object oriented | Stream-shaped output APIs, but each entry is materialized before it is written |
| ZIP64 | Can load ZIP64 only within JavaScript number and memory limits | Writes and reads ZIP64 records, rejecting values beyond `Number.MAX_SAFE_INTEGER` |
| Runtime target | Broad compatibility surface | Modern browsers with Web Streams, `Blob`, and `DecompressionStream` for deflated reads |

---

## Migration Dealbreakers

If your project relies heavily on any of these JSZip patterns, migrating to
JSZipp will require more than a rename of methods.

### 1. Fluent Folder And File Chaining

JSZip supports a mutable folder tree:

```js
const zip = new JSZip();
zip.folder("images")?.file("logo.png", data);
```

JSZipp has no nested folder object API. Pass full ZIP paths to a writer instead:

```js
import { ZipWriter } from "jszipp";

const writer = new ZipWriter({ outputAs: "blob" });
await writer.add({ path: "images/logo.png", data });
const zipBlob = await writer.close();
```

Directories are explicit entries when you need them:

```js
await writer.add({ path: "images/", data: "" });
```

### 2. In-Place Modifications

JSZip lets you load an archive, remove entries, overwrite entries, and generate
the result from the mutated object:

```js
const zip = await JSZip.loadAsync(input);
zip.remove("temp.txt");
zip.file("report.txt", newReport);
const output = await zip.generateAsync({ type: "blob" });
```

JSZipp does not mutate an existing archive. To edit, open the old archive and
write a new one:

```js
import { ZipWriter, openZip } from "jszipp";

const source = await openZip(input);
const writer = new ZipWriter({ outputAs: "blob" });

for (const entry of source.entries) {
  if (entry.path === "temp.txt") continue;
  await writer.add({
    path: entry.path,
    data: entry.isDirectory ? "" : await entry.bytes(),
    meta: {
      comment: entry.comment,
      extraField: entry.extraField,
      modifiedAt: entry.modifiedAt,
      externalAttributes: entry.externalAttributes
    }
  });
}

await writer.add({ path: "report.txt", data: newReport });
const output = await writer.close();
await source.close();
```

That pattern is a rebuild, not an in-place update. It also materializes each
copied entry when `entry.bytes()` is used.

### 3. Synchronous Input Limits

JSZipp exposes `writeSync()` and `closeSync()`, but only for data that can be
read synchronously:

```js
const writer = new ZipWriter({ outputAs: "uint8array" });
writer.writeSync({ path: "hello.txt", data: "Hello" });
const bytes = writer.closeSync();
```

`writeSync()` accepts `string`, `Uint8Array`, and `ArrayBuffer`. Use async
`add()` for `Blob` and `ReadableStream<Uint8Array>` inputs. A single writer must
stay in one mode: do not mix `add()` / `close()` with `writeSync()` /
`closeSync()`.

### 4. Legacy Browser And Node-Specific APIs

JSZipp targets modern browser primitives: Web Streams, `Blob`, `TextEncoder`,
`TextDecoder`, `AbortController`, and `DecompressionStream` for reading deflated
entries. It does not provide JSZip's Base64 or Node `Buffer` output modes
directly.

Choose JSZip when your compatibility requirements include older browsers or when
your app depends on JSZip's Node-oriented output types. Choose JSZipp when
Web-native `Blob`, `Response`, `ReadableStream`, `Uint8Array`, or `ArrayBuffer`
outputs are what you want.

---

## Where JSZipp Fits Better

### 1. Smaller Browser-Focused Dependency Surface

JSZipp has no runtime dependencies. ZIP writing uses its in-repo raw DEFLATE
encoder; reading deflated entries delegates inflation to the platform's
`DecompressionStream` when needed.

This can reduce bundle complexity for modern browser apps that do not need
JSZip's broader compatibility and mutation model.

### 2. Web-Native Output Shapes

`ZipWriter` can return a `ReadableStream`, `Blob`, `Response`, `Uint8Array`, or
`ArrayBuffer`:

```js
const stream = await new ZipWriter().close();
const blob = await new ZipWriter({ outputAs: "blob" }).close();
const response = await new ZipWriter({ outputAs: "response" }).close();
```

The default output is a `ReadableStream<Uint8Array>`, which fits browser
streaming pipelines and service-worker-style responses.

Important limitation: this is stream-shaped output, not true streaming
compression. JSZipp currently reads each input entry into memory, computes CRC32,
compresses the complete entry, and then emits ZIP records. Output streaming can
avoid collecting the whole final archive in one result object, but large
individual entries still have high peak memory usage.

### 3. ZIP64 Writing And Reading

JSZipp supports ZIP64 in writer and reader code. `zip64: "auto"` is the default:

```js
const writer = new ZipWriter({
  zip64: "auto",
  outputAs: "blob"
});
```

Use `zip64: "off"` if you want standard ZIP only and prefer a hard error when
an entry size, entry count, or archive offset would require ZIP64. Runtime ZIP64
values are represented as JavaScript numbers, so values beyond
`Number.MAX_SAFE_INTEGER` are rejected.

### 4. Safer Path Defaults When Reading

`openZip()` rejects unsafe paths by default, including `..`, absolute paths,
drive-letter paths (including drive-relative names like `C:name`),
backslash-separated paths, and paths containing a NUL byte:

```js
const reader = await openZip(file, { pathMode: "strict" });
```

Use `pathMode: "sanitize"` to normalize unsafe names, or `pathMode: "unsafe"`
only when you intentionally need raw archive names and handle extraction safety
yourself.

For untrusted input crossing a trust boundary (uploads, packages, CI artifacts),
use `pathMode: "strict-package"`. It adds a local/central size cross-check and
rejects entry paths that collide after Unicode and case normalization (exact
duplicates, case-only twins, NFC/NFD twins) — checks the default omits so it can
preserve duplicate paths:

```js
const reader = await openZip(untrustedUpload, { pathMode: "strict-package" });
```

Writer-side duplicates are rejected in JSZipp. To replace a file while migrating
from JSZip's mutable archive model, decide the final content for that path before
calling `writer.add()` or `writer.writeSync()`.

---

## Common JSZip-To-JSZipp Translations

### Create A ZIP Blob

```js
// JSZip
const zip = new JSZip();
zip.file("hello.txt", "Hello");
const blob = await zip.generateAsync({ type: "blob" });
```

```js
// JSZipp
const writer = new ZipWriter({ outputAs: "blob" });
await writer.add({ path: "hello.txt", data: "Hello" });
const blob = await writer.close();
```

### Read One File

```js
// JSZip
const zip = await JSZip.loadAsync(file);
const text = await zip.file("docs/readme.md")?.async("text");
```

```js
// JSZipp
const reader = await openZip(file);
const text = await reader.get("docs/readme.md")?.text();
await reader.close();
```

### Preserve Duplicate Names

JSZipp exposes archive order directly:

```js
const reader = await openZip(file);
const copies = reader.entries.filter((entry) => entry.path === "data.json");
const latest = reader.get("data.json");
```

This is the default. If you instead want to *reject* duplicate or colliding
paths (for a strict package profile), use `pathMode: "strict-package"`.

`reader.get(path)` returns the most recently appended matching entry.

---

## Decision Matrix

Stay on JSZip if:

- Your code depends on `zip.folder().file()` and a mutable archive object.
- You need to remove or overwrite files inside a loaded archive before
  generating output.
- You need Base64 or Node `Buffer` output modes from the ZIP library itself.
- You target older browsers or broad legacy environments.

Consider JSZipp if:

- Your app targets modern browsers and Web Streams.
- You want a compact, dependency-free ZIP package.
- Your output naturally wants `ReadableStream`, `Blob`, `Response`,
  `Uint8Array`, or `ArrayBuffer`.
- You need ZIP64 writing or reading within JavaScript's safe integer range.
- You can rebuild archives instead of mutating them in place.

Do not migrate to JSZipp solely because you need true streaming compression of a
single huge file. JSZipp's public APIs are stream-shaped, but the current writer
still materializes each entry before emitting it.
