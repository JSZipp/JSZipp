# Memory Control and Usage Concerns in JSZipp

JSZipp is designed to provide a compact ZIP writer and reader for JavaScript environments. It supports stream-shaped APIs, Blob/File inputs, byte-array inputs, synchronous writing, asynchronous writing, ZIP64, CRC32 validation, and raw DEFLATE compression.

However, JSZipp is **not a fully streaming ZIP compressor** in its current design. This has important memory implications.

This document explains how memory is used, what is retained, what can be released, and what users should watch out for when using JSZipp with large files or many entries.

---

## 1. Key Memory Model

When writing a ZIP file, JSZipp processes each entry as a complete unit.

For each file entry, the current model is approximately:

```text
read the full entry into memory
→ compute CRC32
→ compress the full entry
→ create local ZIP record
→ enqueue or return the ZIP chunk
→ retain central directory metadata
```

This means JSZipp can stream the **ZIP output**, but it does not currently stream the **compression of each input file** chunk-by-chunk.

In practical terms:

```text
output can be streamed
each input entry is still materialized before it is written
```

---

## 2. What “Not True Streaming” Means

A true streaming ZIP writer would do this:

```text
write local header before final size is known
→ read input chunks
→ update CRC32 incrementally
→ compress chunks incrementally
→ emit compressed chunks immediately
→ write data descriptor after the entry
```

JSZipp currently does this instead:

```text
read full input entry
→ know CRC32, compressed size, and uncompressed size
→ write local header with final values
→ write compressed payload
```

This simplifies the implementation and keeps ZIP headers predictable, but it means the peak memory for one large entry can be high.

---

## 3. Memory Used While Adding One Entry

When adding one file, memory may temporarily include:

```text
original Blob/File backing storage
+ ArrayBuffer copy of the input
+ Uint8Array view over the input
+ CRC32 processing state
+ LZ77 / DEFLATE scratch buffers
+ token arrays
+ Huffman frequency/code arrays
+ compressed output working buffer
+ final compressed payload
+ local ZIP header + payload chunk
```

For small files, this is usually not a problem.

For very large files, peak memory may be significantly larger than the original file size.

---

## 4. Blob and File Inputs

When a `Blob` or `File` is passed to JSZipp, the library must read it before it can compress it.

Conceptually:

```ts
const bytes = new Uint8Array(await blob.arrayBuffer());
```

This creates an in-memory byte representation of the Blob/File.

Important implications:

* The Blob/File may already have browser-managed backing storage.
* `blob.arrayBuffer()` creates a separate memory copy.
* During compression, JSZipp may also allocate compression buffers and compressed output.
* Large Blob/File entries can cause high peak memory usage.

Example:

```ts
await writer.add({
  path: "video.mp4",
  data: largeBlob
});
```

Even if `largeBlob` itself is file-backed by the browser, JSZipp still needs an in-memory byte copy to process it under the current model.

---

## 5. Uint8Array and ArrayBuffer Inputs

When using `Uint8Array` or `ArrayBuffer`, the input is already in memory.

```ts
await writer.add({
  path: "data.bin",
  data: bytes
});
```

This avoids the extra Blob-to-ArrayBuffer read step, but the entry may still require:

```text
input bytes
+ compression scratch
+ compressed output
+ ZIP output chunk
```

If the caller keeps a reference to the original `Uint8Array`, that memory remains owned by the caller and cannot be released by JSZipp.

---

## 6. ReadableStream Inputs

JSZipp may accept `ReadableStream<Uint8Array>` as an input type, but in the current design the stream is read into memory before compression.

That means:

```text
ReadableStream input does not imply true streaming compression
```

The stream input is useful as a convenient input format, but it does not eliminate per-entry buffering.

A large stream may still become a large `Uint8Array` internally before compression starts.

---

## 7. What Is Retained After `add()` Completes?

After an entry has been added, JSZipp generally does **not** intentionally retain the original uncompressed source bytes as entry state.

However, memory may still remain occupied for several reasons.

### 7.1 Queued ZIP Output

If output is not being consumed, the generated ZIP chunk may remain queued in the writer’s output stream.

That chunk contains:

```text
local file header + compressed payload
```

So after:

```ts
await writer.add({ path: "a.bin", data: blob1 });
await writer.add({ path: "b.bin", data: blob2 });
await writer.add({ path: "c.bin", data: blob3 });
```

the previous entries’ compressed ZIP chunks may still occupy memory if no consumer has read `writer.output`.

### 7.2 Central Directory Metadata

JSZipp must retain central directory information until `close()`.

This includes metadata such as:

```text
path
comment
extra fields
CRC32
compressed size
uncompressed size
local header offset
external attributes
```

This metadata is usually small compared with file payloads, but it grows with the number of entries.

For archives with many thousands of entries, central directory metadata is still worth considering.

### 7.3 Reusable Internal Scratch Buffers

JSZipp may keep reusable internal buffers for compression, such as:

```text
LZ77 hash tables
previous-position arrays
token arrays
Huffman arrays
output working buffer
```

These buffers are reused across entries to reduce allocation churn.

This means that after a very large entry is compressed, some internal buffers may remain large enough to handle that entry size again.

This does not mean JSZipp is intentionally keeping the previous file content. It means the allocated capacity may remain for reuse.

### 7.4 JavaScript Garbage Collection

Even when JSZipp releases references to temporary buffers, the JavaScript engine decides when to actually reclaim memory.

As a result:

```text
eligible for garbage collection
```

does not mean:

```text
immediately returned to the operating system
```

Memory shown in browser DevTools or system monitors may stay high after a large entry has finished processing.

---

## 8. Output Mode Matters

JSZipp may support several output modes, such as:

```text
stream
blob
response
uint8array
arraybuffer
```

Different output modes have different memory behavior.

---

## 9. `outputAs: "stream"`

This is the most memory-friendly output mode.

The ZIP bytes are exposed as a `ReadableStream`.

Best case:

```text
entry is added
→ ZIP chunk is emitted
→ consumer reads it
→ chunk can be released
```

However, if the stream is not consumed while entries are added, chunks may accumulate in memory.

Recommended pattern:

```ts
const writer = new JSZipp.ZipWriter({ outputAs: "stream" });

const output = writer.output;

// Start consuming output as early as possible.
// For example, pipe it to a WritableStream if available.

await writer.add({ path: "a.bin", data: blobA });
await writer.add({ path: "b.bin", data: blobB });
await writer.add({ path: "c.bin", data: blobC });

await writer.close();
```

The important point is:

```text
stream output only helps if the stream is actually consumed
```

---

## 10. `outputAs: "blob"`

When output is requested as a Blob, JSZipp must eventually assemble the ZIP output into a Blob.

This is convenient for downloads:

```ts
const zipBlob = await writer.close();
```

But it may require retaining the final ZIP content.

Use this mode when:

```text
the final archive is reasonably sized
you need a browser-downloadable Blob
you are okay with holding the final ZIP result
```

Avoid this mode for very large archives if memory is a concern.

---

## 11. `outputAs: "uint8array"` or `"arraybuffer"`

These modes require the final ZIP to exist as one contiguous memory object.

This is convenient for APIs that need bytes directly:

```ts
const zipBytes = await writer.close();
```

But it is the least memory-friendly output mode for large archives.

Memory may include:

```text
queued output chunks
+ final concatenated Uint8Array or ArrayBuffer
```

Use these modes only when the archive size is known to be manageable.

---

## 12. `outputAs: "response"`

A `Response` output can be useful for web APIs and service-worker-like flows.

Its memory behavior depends on how the response body is consumed.

If the body remains stream-backed and is consumed progressively, memory usage can be better. If the consumer calls:

```ts
await response.arrayBuffer()
```

or:

```ts
await response.blob()
```

then the full archive is materialized.

---

## 13. Compression Level and Memory

JSZipp supports compression levels:

```text
0 through 9
```

General expectations:

| Level | Behavior                  | Memory/CPU Concern                   |
| ----: | ------------------------- | ------------------------------------ |
|   `0` | Store without compression | Lowest CPU, lower compression memory |
| `1–3` | Faster compression        | Lower CPU, weaker ratio              |
| `4–6` | Balanced compression      | Default-friendly                     |
| `7–9` | Stronger search           | Higher CPU, potentially slower       |

The default level is typically a balanced choice.

Higher levels mainly increase CPU time and match-search work. Some scratch buffers are reused and bounded by implementation constants, but large inputs still require large per-entry buffers because entries are materialized.

---

## 14. Already-Compressed Files

Files such as these often do not benefit from DEFLATE:

```text
.jpg
.jpeg
.png
.webp
.mp4
.mov
.mp3
.zip
.gz
.pdf
```

For these files, compression may:

```text
waste CPU
increase peak memory pressure
produce little or no size reduction
sometimes make the payload larger
```

Consider using:

```ts
await writer.add({
  path: "photo.jpg",
  data: photoBlob,
  method: "store"
});
```

This avoids unnecessary compression work.

---

## 15. Large File Recommendations

For large files, prefer:

```text
outputAs: "stream"
consume the output stream immediately
use method: "store" for already-compressed files
avoid uint8array / arraybuffer output for huge archives
add files sequentially
release your own references when no longer needed
```

Example:

```ts
const writer = new JSZipp.ZipWriter({ outputAs: "stream", level: 6 });

// Begin consuming writer.output here.

await writer.add({
  path: "large-video.mp4",
  data: videoBlob,
  method: "store"
});

await writer.add({
  path: "large-data.json",
  data: jsonBlob,
  level: 6
});

await writer.close();
```

---

## 16. Many Small File Recommendations

For many small files, memory concerns are different.

The per-file payload may be small, but the number of entries increases:

```text
central directory metadata
file name bytes
comments
extra fields
queued output chunks
JavaScript object overhead
```

Recommendations:

```text
avoid unnecessary comments and large extra fields
consume output while writing
avoid keeping all input blobs/bytes in your own arrays if not needed
prefer short normalized paths when possible
use store for tiny files if compression overhead is not worthwhile
```

For very tiny files, ZIP metadata can be larger than the file content itself.

---

## 17. Caller-Owned References

JSZipp can only release memory that it owns.

If your application stores inputs like this:

```ts
const files = [blob1, blob2, blob3];

for (const file of files) {
  await writer.add({
    path: file.name,
    data: file
  });
}
```

then the `files` array still holds references to every Blob.

JSZipp cannot release those references.

If possible, process files from an iterator or release references after use:

```ts
for (let i = 0; i < files.length; i++) {
  const file = files[i];

  await writer.add({
    path: file.name,
    data: file
  });

  files[i] = undefined as any;
}
```

Whether this helps depends on the browser and how the Blob data is backed.

---

## 18. Output Backpressure

A stream is only memory-efficient when backpressure is respected.

If a writer produces ZIP chunks faster than the consumer reads them, chunks can accumulate.

A memory-conscious design should connect the ZIP output to a consumer as early as possible:

```text
ZIP writer output
→ WritableStream
→ file system / network / download sink
```

Avoid this pattern for huge archives:

```text
add all entries
→ close
→ only then start reading output
```

because output chunks may already be queued.

---

## 19. Peak Memory vs Final Memory

It is important to distinguish between:

```text
peak memory during processing
```

and:

```text
memory retained after processing
```

Peak memory may be high while a large entry is being added.

After `add()` completes, temporary source and compression buffers may be eligible for garbage collection, but:

```text
output chunks may remain queued
central metadata remains until close
scratch buffers may remain allocated
the final ZIP may remain in memory depending on output mode
the JS engine may delay garbage collection
```

---

## 20. Example Memory Timeline

Suppose an application writes three files:

```text
blob1: 500 MB
blob2: 10 MB
blob3: 10 MB
```

### During `add(blob1)`

Memory may include:

```text
blob1 backing storage
+ blob1 ArrayBuffer copy
+ compression scratch
+ compressed output
+ local ZIP chunk
```

### After `add(blob1)`

The source copy may become collectible, but memory may still include:

```text
queued compressed ZIP chunk for blob1
+ large reusable scratch buffers
+ central directory metadata
+ original blob1 if the caller still references it
```

### During `add(blob2)`

Memory may include:

```text
blob2 source copy
+ reused scratch buffers
+ blob2 compressed output
+ queued output chunks
```

The large scratch buffers from `blob1` may be reused rather than reallocated.

### After `close()`

Memory depends heavily on output mode:

```text
stream:
  final central directory is emitted; chunks can be released once consumed

blob:
  final Blob remains available

uint8array / arraybuffer:
  final archive remains as one large memory allocation
```

---

## 21. Practical Checklist

Use this checklist when memory matters:

```text
Use outputAs: "stream" for large archives.
Start consuming writer.output before or while adding entries.
Avoid outputAs: "uint8array" or "arraybuffer" for large archives.
Use method: "store" for already-compressed files.
Add entries sequentially instead of preparing many at once.
Avoid keeping large input references longer than needed.
Avoid collecting all output chunks manually unless necessary.
Expect one full entry to be materialized during add().
Expect reusable scratch buffers to remain allocated after large entries.
Expect garbage collection to be delayed and non-deterministic.
Use smaller batches if the environment is memory-constrained.
```

---

## 22. When JSZipp May Not Be the Right Fit

JSZipp may not be ideal when:

```text
individual files are very large
the archive must be generated with very low peak memory
input data arrives as long-running streams
output must begin before an entry is fully read
the environment has strict memory limits
```

In those cases, a true streaming ZIP writer may be a better fit.

A true streaming writer should support:

```text
incremental CRC32
incremental DEFLATE
data descriptors
bounded per-entry buffering
backpressure-aware output
```

---

## 23. Summary

JSZipp provides stream-shaped ZIP output, but current entry compression is not fully streaming.

The most important memory facts are:

```text
Each entry is read into memory before it is written.
Each compressed payload is produced before the local ZIP record is emitted.
Previous source bytes are not intentionally retained after add() completes.
Previous compressed output may remain queued if output is not consumed.
Central directory metadata is retained until close().
Reusable compression buffers may stay allocated after large entries.
Final archive memory depends strongly on outputAs.
Garbage collection timing is controlled by the JavaScript runtime.
```

For best memory behavior:

```text
consume stream output immediately
store already-compressed files
avoid final byte-array output for huge archives
release caller-owned input references
expect high peak memory for large individual entries
```
