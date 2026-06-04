# Why JSZipp Does Not Use True Streaming Compression

JSZipp intentionally does **not** implement true streaming ZIP compression in its current design. Although the public writer can expose a `ReadableStream` output, each ZIP entry is still prepared as a complete unit before it is written to the archive.

In other words, JSZipp currently follows this model:

```text
read the full entry
→ compute CRC32
→ compress the full entry
→ know compressed and uncompressed sizes
→ write the local file header
→ write the compressed payload
→ remember the central directory record
```

A true streaming ZIP writer would instead follow this model:

```text
write a local file header before sizes are known
→ stream input chunks
→ update CRC32 incrementally
→ compress chunks incrementally
→ write compressed chunks immediately
→ write a data descriptor after the payload
→ write the central directory at the end
```

JSZipp chooses the first model for several practical reasons.

---

## 1. Simpler and More Predictable ZIP Headers

A ZIP local file header normally contains:

```text
CRC32
compressed size
uncompressed size
compression method
file name
extra fields
```

JSZipp knows these values before writing the local header. This keeps the archive layout simple:

```text
[local header with final CRC and sizes][compressed payload]
```

A true streaming writer would not know the CRC32 or sizes when the local header is written. It would need to write placeholder values and then append a **data descriptor** after the compressed payload:

```text
[local header with unknown CRC and sizes]
[compressed payload]
[data descriptor with final CRC and sizes]
```

That is valid ZIP, but it adds complexity to both the writer and compatibility surface.

---

## 2. True Streaming Requires Data Descriptors

To stream an entry before its final sizes are known, JSZipp would need to enable the ZIP general purpose bit that means:

```text
CRC32 and sizes will appear after the file data
```

Then it would need to write a data descriptor containing:

```text
CRC32
compressed size
uncompressed size
```

For normal ZIP entries, that usually adds about **16 additional data-descriptor
bytes per entry** when the descriptor signature is included. This is on top of
the normal local header, Central Directory header, filename bytes, and payload:

```text
4 bytes  data descriptor signature
4 bytes  CRC32
4 bytes  compressed size
4 bytes  uncompressed size
```

For ZIP64 entries, the descriptor is usually about **24 additional
data-descriptor bytes per entry** because sizes use 8-byte fields.

This means true streaming would usually make the final ZIP file slightly larger, not smaller.

---

## 3. Compression Ratio Would Usually Not Improve

True streaming is mainly a memory and latency improvement. It is not a compression-ratio improvement.

If the streaming compressor produced the same raw DEFLATE bytes as the current implementation, the final ZIP size would be approximately:

```text
current ZIP size + 16 bytes × number of entries
```

or, with ZIP64 data descriptors:

```text
current ZIP size + 24 bytes × number of entries
```

The compressed payload itself does not become smaller just because it is streamed.

In fact, streaming can make compression worse if implemented carelessly. For example:

```text
bad streaming:
  compress each input chunk independently

better streaming:
  preserve the 32 KiB DEFLATE sliding window across chunks
```

If each chunk is compressed independently, matches across chunk boundaries are lost, and the output may become noticeably larger.

---

## 4. The Current Compressor Makes Whole-Entry Decisions

JSZipp’s compressor can inspect a complete entry before returning the final compressed payload. This allows it to make useful decisions such as:

```text
try DEFLATE
compare compressed output with stored output
return the smaller result
```

This is especially helpful for files that are already compressed, such as:

```text
PNG
JPEG
MP4
ZIP
encrypted data
random bytes
```

A true streaming writer cannot easily make a whole-entry decision after bytes have already been emitted. Once compressed bytes are written to the output stream, the writer cannot go back and decide that the entry should have been stored instead.

A streaming compressor can still choose stored, fixed Huffman, or dynamic Huffman blocks per block, but it cannot always reproduce the same final-entry fallback behavior without buffering the whole entry.

---

## 5. The Current DEFLATE Encoder Uses Block-Level Costing

JSZipp’s custom DEFLATE encoder tokenizes input, splits it into blocks, and chooses the cheapest representation for each block:

```text
stored block
fixed Huffman block
dynamic Huffman block
```

This is easier when the encoder can buffer enough tokens to calculate exact bit costs before writing output.

A streaming implementation would still need some buffering. It could not simply emit every byte as soon as it is received if it wants good compression. It would need to buffer at least one block of tokens, calculate block costs, then emit the selected block type.

So “true streaming” does not mean “no buffering.” It means “bounded buffering.”

---

## 6. Sync APIs Would Become Harder to Preserve

JSZipp supports synchronous writing for in-memory inputs:

```ts
writeSync()
closeSync()
```

A native stream-based compression pipeline would be asynchronous by nature. If JSZipp were redesigned around true streaming compression, the synchronous writer would either need:

```text
a separate synchronous compression path
```

or it would need to be removed.

Keeping the current entry-buffered design allows JSZipp to support both async and sync writer modes with a consistent ZIP generation model.

---

## 7. Memory Reuse Is Easier in the Current Design

JSZipp reuses internal scratch buffers for:

```text
LZ77 hash chains
token arrays
Huffman frequency arrays
canonical-code tables
DEFLATE output buffers
```

Because compression is synchronous within one entry, these buffers can be shared safely across entries without interleaving.

A streaming compressor would need long-lived per-entry compressor state. It would have to preserve:

```text
sliding window history
hash chains
pending tokens
pending output bits
CRC32 state
compressed size counter
uncompressed size counter
```

That is possible, but it makes the implementation larger and more stateful.

---

## 8. Reader Compatibility and Parser Complexity

Archives with data descriptors are valid ZIP files, but they add more cases for readers and test suites.

The current writer produces entries where the local header already contains final CRC and size values. This is straightforward for ZIP readers and easier to debug.

With true streaming, readers must rely more heavily on:

```text
central directory metadata
data descriptor parsing
ZIP64 descriptor rules
general purpose bit flags
```

JSZipp can support those cases, but generating them by default is not necessary unless true streaming is a primary goal.

---

## 9. True Streaming Is Worth It Only for Large Inputs

True streaming is valuable when JSZipp needs to handle very large inputs, such as:

```text
large Blob objects
large File objects
network streams
generated data streams
archives too large to comfortably fit in memory
```

For small or medium files, the current design is simpler and usually fast enough.

The current design favors:

```text
simplicity
predictable output
sync API support
better whole-entry decisions
compact implementation
easy metadata handling
```

True streaming would favor:

```text
lower peak memory usage
earlier output
better handling of very large files
```

These are different goals.

---

## 10. Final File Size Difference

For a well-designed streaming implementation that preserves the DEFLATE sliding window and uses similar block decisions, the final ZIP size would usually be:

```text
almost the same compressed payload
+ data descriptor overhead
```

Typical overhead:

```text
normal ZIP:  about 16 additional data-descriptor bytes per entry
ZIP64:       about 24 additional data-descriptor bytes per entry
```

Examples:

```text
1 file:
  about +16 bytes

100 files:
  about +1,600 bytes

10,000 files:
  about +160,000 bytes
```

If the streaming compressor flushes too often, resets history at chunk boundaries, or cannot make the same stored-vs-deflated decisions, the output may become larger than this.

Therefore, true streaming should not be expected to reduce the final archive size. Its main benefit is reducing memory usage and allowing output to begin before the full entry has been read and compressed.

---

## Summary

JSZipp does not use true streaming compression because the current entry-buffered design is simpler, more predictable, and better aligned with its goals.

The current design allows JSZipp to:

```text
write local headers with final CRC and sizes
support synchronous writing
choose compression strategy with full-entry knowledge
reuse internal compression buffers
avoid data descriptor overhead
keep the ZIP writer implementation compact
```

True streaming would be useful for very large files and lower-memory workflows, but it would require data descriptors, incremental CRC32, incremental DEFLATE state, more complex ZIP64 handling, and more careful block buffering.

Most importantly, true streaming would usually not make the final ZIP smaller. A high-quality streaming implementation would produce roughly the same compressed data plus a small data descriptor overhead per entry.
