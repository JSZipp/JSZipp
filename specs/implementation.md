# JSZipp Compression and Decompression Implementation Outline

This file is normative. See [Specification Index](README.md) for repository-wide
specification scope and keyword meaning.

Source: [`src/index.ts`](../src/index.ts) and [`src/types.ts`](../src/types.ts).

## 1. High-Level Architecture

JSZipp implements a ZIP archive writer and reader around two layers:

1. **ZIP container layer**
   - Writes and parses ZIP local file headers.
   - Writes and parses central directory records.
   - Writes and parses EOCD / ZIP64 EOCD records.
   - Tracks per-entry metadata: path, timestamps, comments, extra fields, CRC32, sizes, offsets, and attributes.

2. **Compression layer**
   - Compression uses a custom raw DEFLATE encoder.
   - Decompression uses the platform `DecompressionStream("deflate-raw")`.
   - Each ZIP entry is compressed independently.
   - The whole archive is not compressed as one stream.

---

## 2. Public API Surface

### 2.1 Writer APIs

JSZipp exposes three writer-oriented APIs:

```ts
ZipTransformStream
ZipWriter
ZipWriter.writeSync()
```

### 2.2 Reader APIs

JSZipp exposes two reader-oriented APIs:

```ts
readZipStream()
openZip()
```

### 2.3 Design Split

| API                     | Purpose                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `ZipTransformStream`    | Transform stream of ZIP input entries into ZIP bytes            |
| `ZipWriter.add()`       | Async entry-by-entry writer                                     |
| `ZipWriter.writeSync()` | Synchronous in-memory entry writer                              |
| `readZipStream()`       | Reads a ZIP stream, parses entries, yields stream-style entries |
| `openZip()`             | Opens a Blob / File / bytes source for random access by path    |

`TimestampMode` is also exported as a runtime constant for building the
`timestamps` bitmask. The default `JSZipp` namespace object includes
`ZipTransformStream`, `ZipWriter`, `readZipStream`, `openZip`, and
`TimestampMode`; type-only exports such as `ZipSyncInputEntry` are named exports
only because they do not exist at runtime.

---

## 3. ZIP Writer Flow

### 3.1 Entry Preparation

For each input entry, JSZipp performs:

```text
input entry
→ validate compression level
→ normalize path
→ detect directory
→ read input into Uint8Array
→ choose compression method
→ compress if needed
→ compute CRC32
→ prepare metadata
```

The relevant functions are:

```ts
prepareEntry()
prepareEntrySync()
buildPreparedEntry()
```

### 3.2 Async vs Sync Preparation

Async input supports:

```ts
string
Uint8Array
ArrayBuffer
Blob
ReadableStream<Uint8Array>
```

Sync input supports only:

```ts
string
Uint8Array
ArrayBuffer
```

Justification:

* `Blob` and `ReadableStream` cannot be read synchronously.
* Keeping sync mode separate allows `writeSync()` and `closeSync()` to complete without `await`.
* The implementation rejects mixing async and sync modes to avoid silently routing output chunks to different internal buffers.

### 3.3 Optional Worker Preparation

`ZipEncoderOptions.worker` is an optional async backend hook:

```ts
interface ZipWorkerBackend {
  prepare(
    input: ZipInputEntry,
    options: ZipEncoderRuntimeOptions,
    pathInfo: { path: string; isDirectory: boolean }
  ): Promise<ZipPreparedEntry | undefined>;
}
```

`ZipWriter.add()` and `ZipTransformStream` both reserve and validate the path
first, then ask the backend to prepare the entry. If the backend returns a
`ZipPreparedEntry`, JSZipp commits those already-compressed bytes. If it returns
`undefined`, JSZipp runs the normal in-thread `prepareEntry()` path. If it
throws, the reserved path is released and the write rejects.

The bundled implementation is `createWorkerBackend()` from
`web-jszipp/worker-plugin`. It posts eligible async entries to the static worker
script built from `src/worker-script.ts`, which calls
`__privatePrepareEntryForWorker()` and returns the prepared entry. Directory
entries, `ReadableStream` inputs, and inputs below `minSize` fall back to the
normal path. `writeSync()` and `closeSync()` never call the backend.

`src/worker-plugin.ts` and `src/worker-script.ts` are a matched pair and MUST
share one internal build-flag/polyfill seam module (`src/worker-common.ts`).
That shared module owns:

- the `__DEV__` / compat-flag selection logic;
- the worker-side polyfill bindings (`AbortController_`, `throwIfAborted_`,
  `installPolyfills_`);
- the worker-only production error-code strings.

Do not duplicate that selection logic or those constants separately in both
entries. The worker script in particular MUST construct its placeholder signal
via `new AbortController_().signal`, never raw `new AbortController().signal`,
so the compat worker builds keep working on floors where the native class is
missing or patched through the seam.

JSZipp does not construct blob URL workers internally. Applications usually pass
a worker factory so extension and app CSP can point at a static script while
the backend keeps control over when the worker is created:

```ts
const worker = createWorkerBackend({
  workerSource: () => new Worker("/vendor/jszipp.worker.mjs", { type: "module" })
});
```

`workerSource` also accepts a plain `Worker` instance. That form is valid when
the caller wants to own one specific pre-created worker, but it gives up lazy
construction and automatic recreation after that instance is terminated or
fails. JSZipp treats an instance-backed worker as dedicated to that backend and
wraps `worker.terminate()` so a direct termination retires the backend and
rejects in-flight worker requests instead of leaving them pending.

The worker script must match the main build:

| Main build | Plugin import or script | Worker script |
| ---------- | ----------------------- | ------------- |
| Modern ESM/CJS | `web-jszipp/worker-plugin` | `web-jszipp/worker-script` / `dist/jszipp.worker.mjs` module worker |
| Modern UMD | `dist/jszipp.worker-plugin.umd.js` | `dist/jszipp.worker.js` classic worker |
| CR61FF58 compat | `web-jszipp/browser-legacy/cr61ff58/worker-plugin` or `dist/cr61ff58/jszipp.worker-plugin.umd.js` | `dist/cr61ff58/jszipp.worker.js` classic worker |
| CR86FF68 compat | `web-jszipp/browser-legacy/cr86ff68/worker-plugin` or `dist/cr86ff68/jszipp.worker-plugin.umd.js` | `dist/cr86ff68/jszipp.worker.js` classic worker |

Do not pass `{ type: "module" }` for the compat worker scripts. They are classic
worker bundles so older browsers can load them.

---

## 4. Compression Method Selection

### 4.1 Supported Methods

JSZipp supports:

```ts
METHOD_STORE = 0
METHOD_DEFLATE = 8
```

These correspond to standard ZIP methods:

| Method | Meaning                   |
| ------ | ------------------------- |
| `0` / `0x0000` | Store without compression |
| `8` / `0x0008` | Deflate                   |

For the generic ZIP-format meaning of compression method values and
general-purpose bit flags, see
[ZIP validation spec](../specs/zip-validation.md#21-the-compression-method-compatibility-trap).

### 4.2 Selection Logic

The method is selected roughly as:

```ts
let method =
  input.method === "store" ||
  level === 0 ||
  isDirectory
    ? METHOD_STORE
    : METHOD_DEFLATE;

let compressed = method === METHOD_DEFLATE ? deflateRaw(source, level) : source;
if (input.method === undefined && method === METHOD_DEFLATE && compressed.length >= source.length) {
  method = METHOD_STORE;
  compressed = source;
}
```

### 4.3 Justification

| Condition                                      | Reason                                                  |
| ---------------------------------------------- | ------------------------------------------------------- |
| `input.method === "store"`                     | User explicitly requested no compression                |
| `level === 0`                                  | Compression level 0 conventionally means no compression |
| `isDirectory`                                  | Directory entries have no payload                       |
| `input.method === "deflate"`                   | User explicitly requested a DEFLATE ZIP entry           |
| Unspecified method and DEFLATE is not smaller  | Store the entry to avoid expanding the archive          |
| Unspecified method and DEFLATE is smaller      | Use DEFLATE for regular files                           |

### 4.4 DEFLATE Stored-Block Fallback

When a regular file is explicitly selected for DEFLATE, JSZipp writes ZIP method
`0x0008`. Inside that DEFLATE stream, individual blocks may still be emitted as
stored DEFLATE blocks when that is cheaper than Huffman/LZ77 coding. That
block-level choice does not change the enclosing ZIP entry method.

When the caller leaves the method unspecified, JSZipp may instead write ZIP
method `0x0000` if the finished DEFLATE payload would be no smaller than the
source bytes.

---

## 5. ZIP Local Header and Central Directory Writing

### 5.1 ZIP Entry Layout

Each file is written as:

```text
[local file header][compressed payload]
```

Later, at close time, JSZipp writes:

```text
[central directory entries][EOCD / ZIP64 EOCD]
```

### 5.2 Why the Entry Is Fully Prepared Before Writing

JSZipp does **not** use ZIP data descriptors. It computes these values before writing the local header:

```text
CRC32
compressed size
uncompressed size
compression method
extra field
local offset
```

This allows local headers to contain final values directly.

### 5.3 Local File Header Fields

The local file header includes:

```text
signature:          0x04034b50
version needed
flags
method
DOS time/date
CRC32
compressed size
uncompressed size
file name length
extra field length
file name bytes
extra field bytes
compressed payload
```

For generated JSZipp archives, the local header writes:

```text
flags:   0x0800
method:  0x0000 or 0x0008
```

`0x0800` in the flags field is the ZIP UTF-8 filename/comment flag. JSZipp does
not use data descriptors, so it does not set the general-purpose data-descriptor
flag `0x0008`.

### 5.4 Central Directory Fields

The central directory includes:

```text
signature:          0x02014b50
version made by
version needed
flags
method
DOS time/date
CRC32
compressed size
uncompressed size
file name length
extra field length
comment length
external attributes
local header offset
file name bytes
extra field bytes
comment bytes
```

The central directory writes the same generated flags and method values as the
local header:

```text
flags:   0x0800
method:  0x0000 or 0x0008
```

Keeping the local and central method/flag fields consistent prevents parser
differentials where one tool lists entries using central metadata and another
extracts using local metadata.

### 5.5 Justification

The ZIP format requires a central directory so readers can locate entries efficiently. JSZipp stores one central directory record per entry and appends all of them during `close()`.

---

## 6. ZIP64 Handling

### 6.1 ZIP64 Modes

JSZipp supports:

```ts
type Zip64Mode = "auto" | "force" | "off";
```

### 6.2 ZIP64 Trigger Conditions

ZIP64 is needed when any of these exceed classic ZIP limits:

```text
uncompressed size > 0xffffffff
compressed size   > 0xffffffff
local offset      > 0xffffffff
entry count       > 0xffff
central size      > 0xffffffff
central offset    > 0xffffffff
```

### 6.3 Behavior by Mode

| Mode    | Behavior                         |
| ------- | -------------------------------- |
| `auto`  | Use ZIP64 only when required     |
| `force` | Always emit ZIP64 records        |
| `off`   | Throw if ZIP64 would be required |

### 6.4 Justification

* `auto` gives compatibility with small ZIP files while supporting large files.
* `force` is useful for tests or environments that require ZIP64.
* `off` lets users reject archives that exceed classic ZIP limits.

---

## 7. CRC32 Implementation

### 7.1 Algorithm

JSZipp builds a CRC32 lookup table at runtime.

It uses a **slicing-by-8** table:

```text
256 entries × 8 tables
```

### 7.2 Polynomial

The CRC polynomial used is:

```text
0xedb88320
```

### 7.3 Justification

* CRC32 is required by ZIP for integrity validation.
* Slicing-by-8 processes 8 bytes per iteration, improving speed over byte-at-a-time CRC.
* Building the table at runtime avoids embedding a large static table in the bundle.

---

## 8. Raw DEFLATE Compression

### 8.1 Compression Entry Point

Compression uses:

```ts
deflateRaw(input, level)
```

The output is raw DEFLATE bytes, not gzip and not zlib-wrapped data.

### 8.2 Compression Steps

```text
input bytes
→ LZ77 tokenization
→ split into DEFLATE blocks
→ choose best block type per block
→ emit Huffman-coded tokens
→ compare final compressed size with stored output
→ return smaller candidate
```

---

## 9. LZ77 Tokenization

### 9.1 Token Types

JSZipp tokenizes input into two parallel arrays:

```text
lengths[]
distances[]
```

A token is interpreted as:

| Condition        | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `distance === 0` | Literal byte, stored in `lengths[k]`                                             |
| `distance > 0`   | Match, with `lengths[k]` as match length and `distances[k]` as backward distance |

### 9.2 Core DEFLATE Constants

```ts
MIN_MATCH = 3
MAX_MATCH = 258
WINDOW_SIZE = 32768
HASH_SIZE = 65536
```

### 9.3 Parameter Justification

| Parameter     |   Value | Justification                                                        |
| ------------- | ------: | -------------------------------------------------------------------- |
| `MIN_MATCH`   |     `3` | DEFLATE minimum match length                                         |
| `MAX_MATCH`   |   `258` | DEFLATE maximum match length                                         |
| `WINDOW_SIZE` | `32768` | DEFLATE maximum backward distance                                    |
| `HASH_SIZE`   | `65536` | Large enough for efficient match lookup while keeping memory bounded |

### 9.4 Sliding Window

The implementation uses:

```ts
LZ77_HEAD = new Int32Array(HASH_SIZE)
LZ77_PREVIOUS = new Int32Array(WINDOW_SIZE)
```

This forms a hash-chain match finder:

```text
current 4-byte hash
→ head[hash]
→ previous positions in same hash chain
→ candidate matches
```

### 9.5 Reused Scratch Buffers

The LZ77 arrays are module-level scratch buffers reused across calls.

Justification:

* Avoids repeated allocation per ZIP entry.
* Multi-file archives grow scratch memory only up to the largest entry.
* Safe because `deflateRaw()` is synchronous and does not `await`, so two calls cannot interleave inside the scratch usage.

---

## 10. Compression Level Parameters

### 10.1 Supported Range

```ts
level: integer from 0 to 9
```

Default:

```ts
level = 6
```

### 10.2 Parameter Tables

JSZipp maps level to search parameters:

```ts
niceLength = [0, 32, 48, 64, 96, 128, 160, 192, 224, 258][level]
maxChain   = [0, 8, 16, 32, 64, 128, 256, 512, 1024, 4096][level]
goodMatch  = [0, 4, 4, 4, 4, 8, 8, 32, 32, 32][level]
```

### 10.3 `niceLength`

`niceLength` means:

```text
If a match reaches this length, stop searching the hash chain early.
```

It is **not** the maximum match length. Matches may still extend up to `MAX_MATCH = 258`.

Justification:

* Lower levels stop earlier for speed.
* Higher levels search longer for better compression.
* Level 9 allows full-length “nice” matches.

### 10.4 `maxChain`

`maxChain` limits the number of hash-chain candidates searched.

Justification:

* Larger values improve compression ratio but cost CPU.
* Level 9 uses `4096`, near the high end of zlib-style search depth.
* The implementation comments note that deeper search beyond this has limited benefit because `niceLength` early-stop dominates on real data.

### 10.5 `goodMatch`

`goodMatch` controls lazy matching.

If the current match is already good enough, JSZipp skips the lazy next-position search.

Justification:

* Lazy matching improves compression when the next byte starts a better match.
* But lazy matching costs an additional search.
* `goodMatch` avoids spending CPU when the current match is already strong.

---

## 11. Lazy Matching

### 11.1 Behavior

For level `>= 4`, JSZipp may perform lazy matching:

```text
find match at current position
if match is short enough:
  search for a better match at next position
  if next match is strictly longer:
    emit current byte as literal
    use next match later
```

### 11.2 Search Depth

Lazy matching uses:

```ts
maxChain >>> 2
```

That is, one quarter of the normal chain depth.

### 11.3 Justification

* Full lazy matching can be expensive.
* A shallow lazy search recovers most of the ratio benefit at much lower CPU cost.
* Enabled only from level 4 upward to keep low levels fast.

---

## 12. DEFLATE Block Splitting

### 12.1 Token-Based Block Size

JSZipp uses:

```ts
DEFLATE_BLOCK_TOKENS = 16384
```

Blocks are split by token count, not raw input byte count.

### 12.2 Justification

Compressible data can represent a large input span with relatively few tokens. Splitting by token count means:

* Fewer blocks on compressible data.
* Fewer dynamic Huffman headers.
* Better compression ratio than splitting only by input byte count.

---

## 13. Block Type Selection

For each block, JSZipp computes the cost of:

```text
stored block
fixed Huffman block
dynamic Huffman block
```

Then it emits the cheapest block.

### 13.1 Stored Block

Stored block means uncompressed DEFLATE block.

Cost model:

```text
3 bits block header
+ padding to byte boundary
+ 32 bits LEN/NLEN
+ 8 × raw length
```

Stored blocks are only allowed up to:

```ts
UINT16_LIMIT = 65535
```

because DEFLATE stored block length is 16-bit.

### 13.2 Fixed Huffman Block

Fixed Huffman uses standard DEFLATE fixed code lengths:

| Symbol Range           | Bit Length |
| ---------------------- | ---------: |
| literals `0–143`       |          8 |
| literals `144–255`     |          9 |
| length codes `256–279` |          7 |
| length codes `280–287` |          8 |
| distance codes         |          5 |

### 13.3 Dynamic Huffman Block

Dynamic Huffman builds per-block code lengths based on actual symbol frequencies.

Cost includes:

```text
dynamic header
code-length alphabet
encoded literal/distance code lengths
literal/length symbol bits
distance symbol bits
extra bits
```

### 13.4 Justification

Choosing the cheapest block per block avoids a single global decision that might be bad for mixed data. For example:

```text
text segment       → dynamic Huffman may win
small random chunk → stored may win
medium chunk       → fixed Huffman may win
```

---

## 14. Huffman Code Generation

### 14.1 Frequency Counting

For each block, JSZipp counts:

```ts
LITERAL_FREQUENCIES[286]
DISTANCE_FREQUENCIES[30]
```

It also always emits end-of-block symbol:

```ts
literalFrequencies[256]++
```

### 14.2 Huffman Tree Construction

JSZipp builds Huffman lengths using a min-heap.

Justification:

* Repeatedly merge the two lowest-frequency nodes.
* Heap-based construction is `O(k log k)`.
* Tie-breaking by node id gives deterministic output.

### 14.3 DEFLATE Bit-Length Limits

DEFLATE limits code lengths:

| Alphabet             | Max bits |
| -------------------- | -------: |
| literal/length       |       15 |
| distance             |       15 |
| code-length alphabet |        7 |

If an optimal tree exceeds the bit limit, JSZipp applies length limiting.

### 14.4 Length-Limited Huffman

JSZipp uses a package-merge style fallback in:

```ts
limitHuffmanCodeLengths()
```

Justification:

* DEFLATE requires bounded code lengths.
* Package-merge avoids falling back to fixed Huffman for difficult blocks.
* This prevents a compression-ratio cliff on blocks whose optimal tree would exceed 15 bits.

---

## 15. Canonical Huffman Codes

### 15.1 Canonicalization

After code lengths are known, JSZipp builds canonical Huffman codes:

```ts
makeCanonicalCodes()
```

The packed representation is:

```text
reversedBits | (length << 16)
```

### 15.2 Bit Reversal

DEFLATE writes Huffman codes least-significant-bit first, so JSZipp reverses bits before writing.

### 15.3 Justification

Canonical Huffman codes are required by DEFLATE dynamic blocks and allow compact representation of the code tree.

---

## 16. Dynamic Header Code-Length RLE

### 16.1 Code-Length Encoding

Dynamic DEFLATE headers encode the literal and distance code lengths using a third Huffman alphabet.

JSZipp combines:

```text
literal code lengths + distance code lengths
```

Then run-length encodes them using symbols:

| Symbol | Meaning                         |
| ------ | ------------------------------- |
| `16`   | Repeat previous non-zero length |
| `17`   | Repeat zero 3–10 times          |
| `18`   | Repeat zero 11–138 times        |

### 16.2 Code-Length Order

JSZipp uses DEFLATE’s required code-length alphabet order:

```ts
[16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
```

### 16.3 Justification

This minimizes the size of dynamic Huffman headers, especially when many code lengths are zero.

---

## 17. Final Compression Fallback

After writing compressed output, JSZipp compares:

```ts
compressed.length < input.length
```

If not, it creates a raw stored DEFLATE stream:

```ts
deflateStoredRaw(input)
```

Then returns the smaller of:

```text
compressed DEFLATE
stored DEFLATE
```

### 17.1 Justification

Some inputs are already compressed or random:

```text
PNG
JPEG
MP4
encrypted data
random bytes
```

For such data, DEFLATE can expand the payload. The fallback avoids obviously bad compressed output.

---

## 18. Deflate Bit Writer

### 18.1 Purpose

`DeflateBitWriter` writes DEFLATE bits into a reusable byte buffer.

### 18.2 Initial Capacity

```ts
need = max(64, inputSize + (inputSize >>> 3) + 1024)
```

### 18.3 Justification

This preallocates approximately:

```text
input size + 12.5% + 1024 bytes
```

That is usually enough for compressed data and moderate overhead, while still allowing growth if needed.

### 18.4 Reused Output Buffer

The working buffer is module-level and reused:

```ts
deflateOutBuffer
```

`finish()` returns an exact-size copy, so the reusable buffer is never exposed to callers.

---

## 19. Why Compression Does Not Use `CompressionStream`

JSZipp implements compression itself instead of using `CompressionStream`.

### 19.1 Main Reasons

1. **Compression level control**

   * JSZipp supports levels `0–9`.
   * `CompressionStream` does not provide the same explicit level control.

2. **Synchronous writer support**

   * `CompressionStream` is async stream-based.
   * JSZipp supports `writeSync()` and `closeSync()`.

3. **Per-entry ZIP header requirements**

   * JSZipp writes local headers with known CRC and sizes.
   * That requires materializing the compressed payload before writing the entry.

4. **Custom block decisions**

   * JSZipp chooses dynamic, fixed, or stored blocks per block by exact bit cost.

5. **Memory reuse**

   * JSZipp reuses LZ77, Huffman, and output buffers across entries.

---

## 20. ZIP Reader Flow

### 20.1 Reading Input

`readZipStream()` reads the whole stream into bytes first.

`openZip()` converts the source into `Uint8Array` if needed.

Then both call:

```ts
parseZip()
```

### 20.2 Parse Steps

```text
find EOCD
  (scan the tail for EOCD signatures; pick the record whose central
   directory is coherent and content-bearing, so EOCD-like bytes in the
   comment or appended after the archive cannot be selected)
read archive comment
read entry count
read central directory size
read central directory offset
if ZIP64 marker values appear:
  read ZIP64 locator
  read ZIP64 EOCD
iterate central directory entries
read each local payload slice
return parsed entries
```

---

## 21. EOCD Detection

### 21.1 EOCD Signature

JSZipp searches for:

```text
0x06054b50
```

### 21.2 Search Strategy

The implementation searches backward from the end of the file and validates the ZIP comment length.

Conceptually:

```text
for offset from file.length - 22 backward:
  if signature matches:
    read commentLength
    if offset + 22 + commentLength == file.length:
      accept EOCD
```

### 21.3 Justification

* EOCD is at the end of the ZIP file.
* ZIP comments can be up to 65535 bytes.
* Searching backward avoids accidentally selecting earlier matching bytes.
* Validating comment length greatly reduces false positives.

---

## 22. Central Directory Parsing

### 22.1 Central Header Validation

Each central directory entry must start with:

```text
0x02014b50
```

If not, parsing fails.

### 22.2 Unsupported Features

JSZipp rejects:

```text
encrypted entries
unsupported compression methods
```

Supported compression methods are only:

```text
store
deflate
```

### 22.3 ZIP64 Extra Parsing

If classic ZIP fields contain sentinel values:

```text
0xffffffff
```

then JSZipp reads real values from the ZIP64 extra field.

Fields may include:

```text
uncompressed size
compressed size
local header offset
```

---

## 23. Local Payload Reading

For each central directory entry, JSZipp:

```text
rejects a local-header offset already used by another entry
goes to localOffset
validates local header signature 0x04034b50
cross-checks local vs central security-relevant flag bits (encryption, data descriptor)
reads local filename length
cross-checks local vs central filename bytes
reads local extra length
computes payload start
slices compressed payload by compressedSize
```

The central directory is authoritative for reading, and these cross-checks
ensure the local header a sequential reader would see agrees with it, so a
hostile archive cannot present a scanner and an extractor with different trees.
The flag and filename checks are additive: archives whose local and central
metadata agree (JSZipp output and valid data-descriptor archives) are
unaffected.

---

## 24. Decompression

### 24.1 Entry Inflation

Entry inflation uses:

```ts
inflateEntry()
```

Logic:

```text
if method is DEFLATE:
  inflateRaw(compressed, expectedSize)
else:
  use compressed bytes directly
```

Then JSZipp validates:

```text
inflated length == expected uncompressed size
crc32(inflated bytes) == expected crc32
```

### 24.2 Raw DEFLATE Inflate

`inflateRaw()` uses:

```ts
new DecompressionStream("deflate-raw")
```

It wraps the compressed bytes in a `ReadableStream`, pipes through the decompressor, reads the result, then checks the inflated size.

### 24.3 Justification

Decompression is simpler than compression here:

* The ZIP parser already knows the compressed payload slice.
* It already knows the expected uncompressed size.
* It already knows the CRC32.
* There is no need to choose compression level or block type.
* Native `DecompressionStream` is likely faster and smaller than shipping a custom inflate implementation.

---

## 25. Path Handling

### 25.1 Path Normalization

Writer-side paths are normalized before writing.

Reader-side paths can be handled with:

```ts
type ZipPathMode = "strict" | "sanitize" | "unsafe" | "strict-package";
```

`"strict-package"` is an opt-in reader profile for archives crossing a trust
boundary. It applies `"strict"` per-path safety and adds two cross-entry checks
the default deliberately omits to preserve documented behaviour: a local/central
size cross-check (bit 3 clear) and rejection of paths colliding after Unicode
(NFC) and case normalization (exact duplicates, case-only twins, NFC/NFD twins).
On the writer it behaves like `"strict"` for path safety. All writer modes reject
duplicate normalized entry paths before emitting an entry.

### 25.2 Purpose

Path handling prevents dangerous ZIP paths such as:

```text
../outside.txt
/absolute/path
C:\absolute\path
```

depending on the selected mode.

### 25.3 Justification

ZIP path handling is security-sensitive because extracting archives naively can cause path traversal issues.

---

## 26. Filename Encoding

### 26.1 Supported Fallback Encodings

```ts
type FilenameEncoding = "cp437" | StandardFilenameEncoding;

interface ZipReadOptions {
  filenameEncoding?: FilenameEncoding | ITextDecoder;
}
```

`StandardFilenameEncoding` is the curated set of browser `TextDecoder` labels in
`src/types.ts`. `ITextDecoder` is a decoder-shaped object with `encoding`,
`fatal`, `ignoreBOM`, and `decode(bytes)` properties, allowing callers to provide
custom legacy filename decoding.

### 26.2 UTF-8 Flag

JSZipp writes:

```ts
UTF8_FLAG = 0x0800
```

for generated archives.

### 26.3 Unicode Path Extra Field (0x7075)

On read, JSZipp also honours the Info-ZIP Unicode Path extra field:

```text
0x7075: version(1) | crc32(4) of the primary header name | UTF-8 name
```

The UTF-8 name is used as the entry path only when the embedded CRC-32 matches
the primary header name bytes. A stale field (mismatched CRC, e.g. the header
name changed after creation) is ignored, falling back to the header name under
the UTF-8-flag / fallback-encoding rules above.

### 26.4 Justification

* New ZIP files should use UTF-8 filenames.
* Older ZIPs may omit the UTF-8 flag.
* Fallback encoding support improves interoperability with legacy ZIP files.
* The Unicode Path CRC check prevents trusting a stale or forged override.

---

## 27. Metadata Handling

Each entry can include:

```ts
comment
extraField
modifiedAt
createdAt
lastAccess
unixPermissions
dosAttributes
externalAttributes
```

### 27.1 Modification Time

JSZipp always writes the mandatory DOS date/time header fields as local
wall-clock time for legacy tool compatibility. The `timestamps` option is a
bitmask of `TimestampMode` flags (`Dos` = 1, `Unix` = 2, `Ntfs` = 4, default
`Dos | Unix`) that selects which UTC timestamp extras are layered on top. When
the mask includes `Unix` and the timestamp fits in a 32-bit Unix timestamp,
JSZipp writes an Extended Timestamp (`0x5455`) extra containing UTC mtime. When
the mask includes `Ntfs`, JSZipp writes an NTFS (`0x000a`) extra containing
modification, last-access, and creation FILETIMEs (100-nanosecond UTC). The NTFS
field needs all three values, so JSZipp defaults an omitted `meta.createdAt` or
`meta.lastAccess` value to `meta.modifiedAt`. Testing membership with bitwise ANDs
keeps the writer's hot path small.

Regardless of the timestamps mode, the writer rejects causally impossible
timestamps: when `meta.createdAt` is supplied, neither `meta.modifiedAt` (which
defaults to the write time) nor `meta.lastAccess` may be earlier than it. Such
an entry throws `RangeError` before any compression work is done.

On read, an NTFS extra carrying both creation and last-access times is
authoritative: `modifiedAt`, `createdAt`, and `lastAccess` are taken from it and
the DOS and Extended-Timestamp fields are ignored. Otherwise the reader prefers
the UTC mtime from `0x5455` and falls back to the DOS fields, interpreted as
local wall-clock time, when no usable extra timestamp is present.

### 27.2 File Attributes

External attributes can represent:

```text
directory bit
Unix mode
custom external attributes
```

JSZipp records Unix store permissions for an entry when `meta.unixPermissions`
is supplied, or when a Unix Extended Timestamp (`0x5455`) is written for the
entry — which the default `Dos | Unix` mode does for every entry. When recorded,
the high 16 bits of the external attributes carry a Unix mode (the regular-file
or directory type bits OR the permission bits) and the "version made by" host
byte is set to Unix (3) so external tools apply the permissions. The default
permission is `0o644` for regular files and `0o755` for directories.

`meta.unixPermissions` is the permission portion of a Unix mode and must be a
three-octal-digit value in the range `0o000`..`0o777`; out-of-range or
non-integer values (including setuid/setgid/sticky bits in `0o7000`) are rejected
with `RangeError`. Because a Unix mode is only meaningful alongside a Unix-host
advertisement, `unixPermissions` is rejected with `RangeError` unless the
`timestamps` mode includes `TimestampMode.Unix`.

`meta.dosAttributes` is the DOS-attribute counterpart, written into the low 8
bits of the external attributes. It must be an integer in `0x00`..`0xff`, with the
directory bit `0x10` matching the entry kind (set for directories, clear for
files) or the entry is rejected. DOS attributes suit a DOS or NTFS host, so they
are accepted for the `Dos`, `Dos | Ntfs`, and `Dos | Unix | Ntfs` modes and
rejected for `Dos | Unix` (a Unix host without NTFS), where DOS bits would confuse
Unix tools. When both `Unix` and `Ntfs` are set the external attributes carry the
Unix mode (high 16 bits) and the DOS byte (low 8 bits) together; `dosAttributes`
does not change the "version made by" host, which reflects only the Unix mode.

`meta.externalAttributes` and `meta.extraField` are unchecked manual overrides
and should be used with caution. `externalAttributes` is written verbatim and
overrides both `unixPermissions` and `dosAttributes`; `extraField` is written
verbatim before the writer's own extras. JSZipp cannot detect every conflict — a
value that disagrees with the entry's directory bit, or extra-field bytes that are
malformed or reuse an id the writer also emits, can mislead extractors or corrupt
the archive. On read, JSZipp exposes only the raw `externalAttributes`; the full
Unix mode is `externalAttributes >>> 16` and the DOS attribute byte is
`externalAttributes & 0xff`.

### 27.3 Justification

This preserves basic file metadata while keeping the implementation compact.

---

## 28. Progress and Cancellation

### 28.1 Progress Phases

JSZipp reports progress using:

```ts
phase: "read" | "compress" | "write" | "parse"
```

### 28.2 Abort Support

Most major operations call:

```ts
signal.throwIfAborted()
```

### 28.3 Justification

ZIP operations may be expensive for large files. Progress and cancellation allow UI integration without blocking user control.

---

## 29. Memory Management Strategy

### 29.1 Reused Global Scratch

JSZipp reuses:

```text
LZ77 hash tables
token arrays
frequency arrays
Huffman working arrays
canonical-code arrays
dynamic-header token arrays
stored-block header
deflate output buffer
block boundary arrays
```

### 29.2 Justification

This avoids per-entry and per-block allocation churn, especially for multi-file ZIP archives.

### 29.3 Safety Condition

The compression pipeline is synchronous inside `deflateRaw()`, so scratch buffers cannot be concurrently mutated by interleaved awaits.

---

## 30. Multi-File ZIP Example

Given:

```ts
writer.add({ path: "a.txt", data: "hello" });
writer.add({ path: "b.json", data: "{\"x\":1}" });
writer.add({ path: "assets/logo.png", data: logoBytes });
await writer.close();
```

JSZipp writes:

```text
[a.txt local header][a.txt compressed payload]
[b.json local header][b.json compressed payload]
[assets/logo.png local header][logo compressed or stored payload]
[a.txt central directory record]
[b.json central directory record]
[assets/logo.png central directory record]
[EOCD / ZIP64 EOCD]
```

Each file is compressed independently. The archive itself is not compressed as one continuous stream.

---

## 31. Important Design Tradeoffs

### 31.1 Current Writer Is Not Fully Streaming Per Payload

Even when the output is a stream, each entry is prepared first:

```text
read whole entry
compress whole entry
write local header + payload
```

This simplifies:

```text
CRC32 calculation
compressed size calculation
ZIP64 decision
sync writer support
central directory generation
```

But it means large entries are materialized in memory.

### 31.2 No Data Descriptor

JSZipp does not currently write ZIP data descriptors.

Advantages of current design:

```text
simpler writer
simpler compatibility
known sizes in local header
works well with sync API
```

Potential advantage of adding data descriptors:

```text
true streaming compression of large entries
lower memory usage for Blob / ReadableStream inputs
```

But data descriptors would not usually make the compressed data smaller. They mainly allow writing before CRC and sizes are known.

### 31.3 Native Decompression but Custom Compression

This asymmetry is intentional:

| Direction     | Implementation                       | Reason                                                                      |
| ------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| Compression   | Custom DEFLATE                       | Needs level control, sync mode, block choice, size comparison, memory reuse |
| Decompression | `DecompressionStream("deflate-raw")` | Payload slice is already known; native inflate is simple and efficient      |

---

## 32. Validation and Error Handling

JSZipp validates:

```text
compression level is integer 0–9
writer is not closed
async/sync writer modes are not mixed
ZIP64 is allowed when needed
EOCD exists
ZIP64 locator exists when required
central directory signature is valid
local file header signature is valid
local and central filenames agree
local and central security-relevant flag bits agree
no two central entries reuse one local-header offset
a 0x7075 Unicode Path extra field matches its embedded name CRC
entry is not encrypted
compression method is supported
inflated size matches expected size
CRC32 matches expected CRC
```

In `pathMode: "strict-package"` it additionally validates:

```text
local and central sizes agree (general-purpose bit 3 clear)
no entry path collides after Unicode (NFC) and case normalization
```

This catches both malformed archives and unsupported ZIP features.

---

## 33. Summary

JSZipp is a compact ZIP implementation with:

```text
custom raw DEFLATE compression
native raw DEFLATE decompression
ZIP64 support
central-directory-based parsing
CRC32 validation
path normalization
sync and async writer modes
allocation-conscious compression internals
```

Its compression side is intentionally custom because it must control ZIP-specific metadata, compression level, block selection, and synchronous operation. Its decompression side delegates raw DEFLATE inflation to `DecompressionStream` because, after ZIP parsing, decompression is a narrow and well-defined task: convert one entry’s raw deflate payload back into bytes and validate size and CRC.
