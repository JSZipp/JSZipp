import { StandardFilenameEncoding } from "./types";
// All three are imported but only one is selected at runtime; the unused two are
// tree-shaken in each build because the selecting ternary collapses on a literal
// flag (same mechanism as __DEV__). The modern build selects polyfillNative and
// drops both compat modules (and web-streams-polyfill with them).
import * as polyfillNative from "./polyfill";
import * as polyfillCR61FF58 from "./polyfill-CR61FF58";
import * as polyfillCR86FF68 from "./polyfill-CR86FF68";
import { E_WORKER } from "./worker-common";

declare const __DEV__: boolean;
// Build flags for the optional older-browser targets, injected like __DEV__ via
// rspack DefinePlugin. Both false in the modern build, so the ternary below
// collapses to the native passthrough and the compat modules tree-shake out.
declare const CR61FF58: boolean;
declare const CR86FF68: boolean;
// Build flag for UMD sub-entry pruning. Defaults to true in source/test runs so
// `src/index.ts` behaves like the published root entry when no bundler injects
// it.
declare const __JSZIPP_NAMESPACE__: boolean;

const DEV = typeof __DEV__ === "boolean" ? __DEV__ : true;
const CR61FF58_ = typeof CR61FF58 === "boolean" ? CR61FF58 : false;
const CR86FF68_ = typeof CR86FF68 === "boolean" ? CR86FF68 : false;
const JSZIPP_NAMESPACE_ = typeof __JSZIPP_NAMESPACE__ === "boolean" ? __JSZIPP_NAMESPACE__ : true;

const Uint16Array_ = Uint16Array;
type Uint16Array_ = Uint16Array<ArrayBuffer>;
const Uint8Array_ = Uint8Array;
type Uint8Array_ = Uint8Array<ArrayBuffer>;
const DataView_ = DataView;
type DataView_ = DataView;
const Int32Array_ = Int32Array;
type Int32Array_ = Int32Array<ArrayBuffer>;
const Uint32Array_ = Uint32Array;
type Uint32Array_ = Uint32Array<ArrayBuffer>;
// Web API bindings routed through the polyfill seam. In the modern build the
// ternaries collapse to native (compat modules dropped); in a compat build the
// matching module supplies polyfilled implementations. installPolyfills() patches
// AbortSignal.prototype.throwIfAborted where the base class exists but the method
// does not (a no-op in the modern build).
const polyfill_ = CR61FF58_ ? polyfillCR61FF58 : CR86FF68_ ? polyfillCR86FF68 : polyfillNative;
const {
  AbortController_,
  TransformStream_,
  ReadableStream_,
  isReadableStream_,
  arrayBuffer_,
  responseAcceptsStream_,
  throwIfAborted_,
  installPolyfills: installPolyfills_
} = polyfill_;
installPolyfills_();
// Optional: only reading deflated entries needs it. Looked up off globalThis so
// the module still loads (and the writer + stored-entry reading still work) in
// runtimes where DecompressionStream is undeclared; inflateRaw() guards on it.
const DecompressionStream_ = polyfill_.DecompressionStream_;

const { max, min, ceil, imul } = Math;
const { isInteger, isSafeInteger, isFinite } = Number;

// Per-entry metadata. On write, every field is optional input supplied via
// `ZipInputEntry.meta`; on read, reader entries expose the parsed values.
export interface ZipEntryMeta {
  // Free-form per-entry comment, stored in the Central Directory record. Purely
  // informational; it does not affect extraction. Defaults to "" (no comment).
  comment?: string;
  // Raw bytes for the entry's ZIP "extra field" — the sequence of
  // id(2) + size(2) + payload(size) records the format reserves for optional
  // metadata (UTC timestamps, Unicode paths, alignment, app-specific data).
  // Supply this ONLY if you are hand-crafting well-formed extra records and know
  // the ZIP extra-field layout; most callers should leave it unset and let the
  // writer add the timestamp extras selected by `timestamps`. The writer appends
  // its own extras (ZIP64, Extended-Timestamp, NTFS) after these bytes and skips
  // adding a timestamp extra whose id you already supplied here.
  // CAUTION: this is an unchecked manual override. JSZipp does not validate the
  // bytes or reconcile them with the extras it adds, so malformed records or ids
  // that collide with the writer's own extras can corrupt the archive.
  extraField?: Uint8Array<ArrayBuffer>;
  // Modification time. Written to the legacy DOS date/time fields and, when
  // `timestamps` includes the Unix flag, to the Extended Timestamp extra as UTC.
  // Defaults to the current time (`new Date()`) when omitted.
  modifiedAt?: Date;
  // Creation time. When `timestamps` includes the NTFS flag, omitted values
  // default to `modifiedAt` because the NTFS extra field 0x000a stores
  // creation/access/modification FILETIMEs together. On read, populated only
  // when the entry carries an NTFS field. Must not be later than `modifiedAt` or
  // `lastAccess`.
  createdAt?: Date;
  // Last-access time. When `timestamps` includes the NTFS flag, omitted values
  // default to `modifiedAt`. On read, populated only when the entry carries an
  // NTFS field.
  lastAccess?: Date;
  // Unix store permission bits — the standard three-octal-digit mode such as
  // 0o644 or 0o755 (valid range 0o000..0o777; the file-type bits are added
  // automatically from the entry kind). Any combination within that range is
  // accepted; out-of-range values throw. When set — or when a Unix Extended
  // Timestamp is written for the entry, which the default `timestamps` does — the
  // Central Directory records the resulting Unix mode in its external attributes
  // and advertises the Unix host in "version made by" so extractors apply the
  // permissions. When the permissions are recorded but this is unset, the default
  // is 0o644 for files and 0o755 for directories.
  unixPermissions?: number;
  // MS-DOS attribute bits stored in the low byte of the entry's external
  // attributes — for example 0x01 (read-only), 0x02 (hidden), 0x04 (system),
  // 0x20 (archive), and 0x10 (directory). Valid range is 0x00..0xff. The
  // directory bit 0x10 encodes the file/folder distinction and MUST agree with
  // the entry kind (set for a path ending in "/", clear otherwise); a mismatch
  // throws. This is the DOS-attribute counterpart to `unixPermissions`. DOS
  // attributes suit a DOS or NTFS host but would confuse Unix-oriented tools, so
  // they are accepted for dos-only, dos+ntfs, and dos+unix+ntfs `timestamps`
  // modes, and rejected when the Unix flag is set without the NTFS flag
  // (dos+unix). When the Unix flag is also present (dos+unix+ntfs) the external
  // attributes carry both these DOS bits (low byte) and the Unix mode (high 16
  // bits). It does not influence "version made by", which tracks only the Unix
  // mode.
  dosAttributes?: number;
  // Raw 32-bit external-attributes value, written verbatim to the Central
  // Directory. This is the low-level escape hatch behind `unixPermissions` and
  // `dosAttributes`: the high 16 bits hold the Unix mode (e.g. `(0o100644 << 16)`)
  // and the low 8 bits hold MS-DOS attribute flags (bit 4 = directory). Setting it
  // overrides `unixPermissions` and `dosAttributes` entirely. Most callers should
  // use those; reach for this only to round-trip an exact value read from another
  // archive. On read, exposes the entry's parsed external attributes (from which
  // both the Unix mode `>>> 16` and the DOS bits `& 0xff` can be derived).
  // CAUTION: this is an unchecked manual override. JSZipp writes the value as
  // given and does not reconcile it with the entry kind or `unixPermissions`, so
  // a value that disagrees with the directory bit or path can mislead extractors.
  externalAttributes?: number;
}

// Per-entry compression method: "store" (no compression) or "deflate".
export type ZipCompressionMethod = "store" | "deflate";
// "strict-package" is a reader profile for archives crossing a trust boundary
// (uploads, packages, CI artifacts). It does everything "strict" does and adds
// cross-entry checks the default deliberately omits to honour documented
// behaviour: local/central size cross-check, and rejection of duplicate or
// case-/Unicode-normalization-colliding destination paths. On the writer it is
// treated as "strict" per-path safety; duplicate normalized writes are rejected
// for every path mode.
export type ZipPathMode = "strict" | "sanitize" | "unsafe" | "strict-package";

// Progress report passed to an `onProgress` callback during read/write.
export interface ZipProgress {
  // Path of the entry currently being processed, when one applies.
  path?: string;
  // Bytes processed so far in the current phase.
  loaded: number;
  // Total bytes expected for the current phase, when known.
  total?: number;
  // Number of entries written/parsed so far, when applicable.
  entries?: number;
  // Which stage of the operation this report describes.
  phase: "read" | "compress" | "write" | "parse";
}

/**
 * Fully prepared ZIP entry data returned by an optional worker backend.
 *
 * This is intentionally a structural data contract: the main writer still owns
 * ZIP ordering, duplicate-path checks, local headers, central directory records,
 * and output shaping. Backends should only prepare one already-reserved entry.
 */
export interface ZipPreparedEntry {
  /** Normalized path reserved by the writer for this entry. */
  path: string;
  /** Whether the normalized path is a directory entry. */
  isDirectory: boolean;
  /** Modification time used for DOS and optional timestamp extra fields. */
  modifiedAt: Date;
  /** Creation time used when NTFS timestamp extras are enabled. */
  createdAt?: Date;
  /** Last-access time used when NTFS timestamp extras are enabled. */
  lastAccess?: Date;
  /** Per-entry central-directory comment. */
  comment: string;
  /** Caller-supplied raw extra fields, before writer-generated extras. */
  extraField: Uint8Array<ArrayBuffer>;
  /** Uncompressed payload size in bytes. */
  sourceSize: number;
  /** Final stored or raw-DEFLATE payload bytes. */
  compressed: Uint8Array<ArrayBuffer>;
  /** ZIP compression method number: 0 for store, 8 for deflate. */
  method: number;
  /** CRC-32 of the uncompressed payload. */
  crc32: number;
  /** External file attributes written into the central directory. */
  externalAttributes: number;
}

/**
 * Encoder options after JSZipp has applied defaults, excluding the worker
 * backend itself so backends cannot recursively invoke themselves.
 */
export type ZipEncoderRuntimeOptions = Required<Omit<ZipEncoderOptions, "worker">>;

/**
 * Optional async entry-preparation backend used by `ZipWriter.add()` and
 * `ZipTransformStream`.
 *
 * Return a `ZipPreparedEntry` to let the backend supply compressed bytes, or
 * return `undefined` to ask JSZipp to use the normal in-thread preparation path.
 * Implementations should be reusable across writers unless their own
 * documentation says otherwise; JSZipp does not terminate or dispose them.
 * Returned prepared entries are treated as trusted input by the writer.
 */
export interface ZipWorkerBackend {
  /**
   * Prepare one already-reserved entry.
   *
   * `pathInfo` is produced by JSZipp's normal path validation/reservation path.
   * Throw to fail the write; return `undefined` for ordinary fallback.
   */
  prepare(
    input: ZipInputEntry,
    options: ZipEncoderRuntimeOptions,
    pathInfo: { path: string; isDirectory: boolean }
  ): Promise<ZipPreparedEntry | undefined>;
}

export interface ZipEncoderOptions {
  // Default DEFLATE compression level 0..9 for entries that don't set their own.
  // 0 stores without compressing. Defaults to 6.
  level?: number;
  // ZIP64 policy: "auto" emits ZIP64 records only when limits are exceeded,
  // "force" always emits them, "off" rejects archives that would need them.
  zip64?: Zip64Mode;
  // Archive-level comment stored in the End Of Central Directory record.
  comment?: string;
  // Bitmask of `TimestampMode` flags selecting which modification-time fields are
  // written. Defaults to `TimestampMode.Dos | TimestampMode.Unix`.
  timestamps?: TimestampMode;
  // Write-side path policy. Defaults to "unsafe" (only the legacy normalization:
  // backslashes -> "/", leading "/" stripped) to preserve existing behavior.
  // Use "strict" to reject paths the default reader (pathMode: "strict") would
  // refuse to read back (".." segments, absolute, drive-letter), guaranteeing the
  // archive is self-readable; "sanitize" strips those unsafe components instead.
  pathMode?: ZipPathMode;
  // Aborts the operation when signaled; in-flight work throws the abort reason.
  signal?: AbortSignal;
  // Called with read/compress/write progress updates as entries are encoded.
  onProgress?: (progress: ZipProgress) => void;
  /**
   * Optional backend used to prepare/compress async entries off the main thread.
   *
   * Usually created with `createWorkerBackend()` from
   * `web-jszipp/worker-plugin`. Only async `add()` / `ZipTransformStream`
   * writes consult this backend; `writeSync()` remains fully synchronous and
   * local. The caller owns backend lifetime and should terminate reusable
   * worker backends when they are no longer needed. When the backend is backed
   * by one specific `Worker` instance instead of a factory, it cannot be
   * recreated after termination.
   */
  worker?: ZipWorkerBackend;
  // When true, the writer materializes an explicit ZIP entry for every parent
  // directory implied by an entry's path (e.g. adding "a/b/c.txt" also emits the
  // "a/" and "a/b/" directory entries, in order, before the file). Defaults to
  // false, which keeps the historical behavior: only the directory entries you
  // add yourself are written, and a path's implied directories are left to the
  // extractor to recreate. Directory bits already live in each entry's external
  // attributes, so this is purely about emitting the extra standalone records;
  // it adds bytes (one local + one central header per synthesized directory).
  // JSZipp does NOT scan for empty directories — a directory with no entries
  // beneath it has no implied path, so if you need an empty folder to survive
  // extraction you must still add it explicitly (`add({ path: "empty/" })`),
  // regardless of this flag. Recommended only when directory records matter.
  explicitDirectoryEntries?: boolean;
}

// When the writer emits ZIP64 records (see ZipEncoderOptions.zip64).
export type Zip64Mode = "auto" | "force" | "off";

// Bitflags selecting which modification-time fields the writer emits. The legacy
// MS-DOS date/time pair is ALWAYS written; these flags only control the optional
// UTC timestamp extras layered on top. Combine them with bitwise OR, e.g.
// `TimestampMode.Dos | TimestampMode.Unix`. Defaults to `Dos | Unix`.
//   Dos  (1) — no extra timestamp field beyond the mandatory DOS fields.
//   Unix (2) — Extended Timestamp extra (0x5455), whole-second UTC.
//   Ntfs (4) — NTFS extra (0x000a), 100-nanosecond UTC; missing createdAt or
//              lastAccess values default to modifiedAt.
// The named values are kept in 1/2/4 bitflag form (rather than the previous
// "dos+unix" string union) so the writer's hot path tests them with cheap
// bitwise ANDs instead of string comparisons, trimming the minified bundle.
export const TimestampMode = {
  Dos: 1,
  Unix: 2,
  Ntfs: 4
} as const;
// A bitmask built from `TimestampMode` values (so combinations like 3 or 7 are
// valid). Typed as `number` because OR-ing the flags widens to `number`.
export type TimestampMode = number;

// Shape the writer produces from close()/closeSync(), set via `outputAs`.
export type ZipWriterOutput = "stream" | "blob" | "response" | "uint8array" | "arraybuffer";

// Maps a `ZipWriterOutput` to the concrete type close()/closeSync() resolves to.
export type ZipWriterCloseResult<T extends ZipWriterOutput> = T extends "blob"
  ? Blob
  : T extends "response"
    ? Response
    : T extends "uint8array"
      ? Uint8Array_
      : T extends "arraybuffer"
        ? ArrayBuffer
        : ReadableStream<Uint8Array<ArrayBuffer>>;

export interface ZipWriterOptions<T extends ZipWriterOutput = "stream"> extends ZipEncoderOptions {
  // Output shape returned by close()/closeSync(). Defaults to "stream".
  outputAs?: T;
  // Content-Type used when `outputAs` is "response". Defaults to "application/zip".
  mimeType?: string;
}

// A single entry queued for writing via ZipWriter.add() / ZipTransformStream.
export interface ZipInputEntry {
  // Destination path inside the archive (a trailing "/" marks a directory).
  path: string;
  // Entry payload. Strings are UTF-8 encoded; streams/Blobs are read fully.
  data: string | Uint8Array<ArrayBuffer> | ArrayBuffer | Blob | ReadableStream<Uint8Array<ArrayBuffer>>;
  // Compression method override; defaults to deflate (store for incompressible
  // data or when level is 0).
  method?: ZipCompressionMethod;
  // Per-entry DEFLATE level 0..9, overriding the writer's default `level`.
  level?: number;
  // Optional per-entry metadata (timestamps, permissions, comment, extras).
  meta?: ZipEntryMeta;
}

// Entry accepted by ZipWriter.writeSync(): same as ZipInputEntry but limited to
// data that can be read synchronously (no Blob or ReadableStream).
export interface ZipSyncInputEntry extends Omit<ZipInputEntry, "data"> {
  data: string | Uint8Array<ArrayBuffer> | ArrayBuffer;
}

// A forward-only entry yielded by readZipStream(). Size/crc fields may be null
// until the payload has been read. Each payload helper consumes the entry once.
export interface ZipStreamEntry extends ZipEntryMeta {
  // Entry path inside the archive (trailing "/" denotes a directory).
  readonly path: string;
  // Uncompressed size in bytes, or null when not yet known from the header.
  readonly size: number | null;
  // Compressed size in bytes, or null when not yet known from the header.
  readonly compressedSize: number | null;
  // CRC-32 of the uncompressed data, or null when not yet known.
  readonly crc32: number | null;
  // Whether this entry is a directory.
  readonly isDirectory: boolean;
  // The raw `externalAttributes` (inherited from ZipEntryMeta) carry Unix file
  // attributes in the high 16 bits (`externalAttributes >>> 16`) and DOS
  // attributes in the low byte (`externalAttributes & 0xff`).
  // Streams the decompressed payload. Consumes the entry.
  stream(): ReadableStream<Uint8Array<ArrayBuffer>>;
  // Reads the full payload and decodes it as UTF-8 text. Consumes the entry.
  text(): Promise<string>;
  // Reads the full payload as bytes. Consumes the entry.
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  // Reads the full payload as an ArrayBuffer. Consumes the entry.
  arrayBuffer(): Promise<ArrayBuffer>;
  // Discards this entry's payload without decoding it. Consumes the entry.
  skip(): Promise<void>;
}

// Random-access reader returned by openZip(): entries can be read in any order
// and re-read until close().
export interface ZipRandomAccessReader {
  // Archive-level comment from the End Of Central Directory record, if any.
  readonly comment?: string;
  // All entries in central-directory order.
  readonly entries: readonly ZipRandomAccessEntry[];
  // Looks up an entry by exact path (then by normalized path). undefined if none.
  get(path: string): ZipRandomAccessEntry | undefined;
  // Releases the reader; entry payload helpers throw after this.
  close(): Promise<void>;
}

// An entry from a random-access reader. Unlike a stream entry, its payload
// helpers are reusable until the reader is closed.
export interface ZipRandomAccessEntry extends ZipEntryMeta {
  // Entry path inside the archive (trailing "/" denotes a directory).
  readonly path: string;
  // Uncompressed size in bytes.
  readonly size: number;
  // Compressed size in bytes.
  readonly compressedSize: number;
  // CRC-32 of the uncompressed data.
  readonly crc32: number;
  // Whether this entry is a directory.
  readonly isDirectory: boolean;
  // The raw `externalAttributes` (inherited from ZipEntryMeta) carry Unix file
  // attributes in the high 16 bits (`externalAttributes >>> 16`) and DOS
  // attributes in the low byte (`externalAttributes & 0xff`).
  // Streams the decompressed payload (reusable).
  stream(): ReadableStream<Uint8Array<ArrayBuffer>>;
  // Reads the full payload and decodes it as UTF-8 text (reusable).
  text(): Promise<string>;
  // Reads the full payload as bytes (reusable).
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  // Reads the full payload as an ArrayBuffer (reusable).
  arrayBuffer(): Promise<ArrayBuffer>;
}

type FilenameEncoding = "cp437" | StandardFilenameEncoding;

// Options for openZip() / readZipStream().
export interface ZipReadOptions {
  // Filename decoder for entries not flagged UTF-8: a known encoding label, or a
  // custom TextDecoder-like object. Defaults to "utf-8".
  filenameEncoding?: FilenameEncoding | ITextDecoder;
  // Read-side path policy applied to each entry name. Defaults to "strict".
  pathMode?: ZipPathMode;
  // Anti-zip-bomb caps for untrusted archives. maxArchiveSize bounds the input
  // archive byte length; maxEntrySize bounds each entry's decompressed size and
  // is enforced *during* inflate (bounded reading), so a header that lies about
  // its uncompressed size cannot expand past the cap.
  maxArchiveSize?: number;
  maxEntrySize?: number;
  // Aborts the operation when signaled; in-flight work throws the abort reason.
  signal?: AbortSignal;
  // Called with read/parse progress updates.
  onProgress?: (progress: ZipProgress) => void;
}

interface CentralEntry {
  path: string;
  isDirectory: boolean;
  modifiedAt: Date;
  createdAt?: Date;
  lastAccess?: Date;
  comment: string;
  extraField: Uint8Array<ArrayBuffer>;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  externalAttributes: number;
}

interface ParsedZip {
  comment: string;
  entries: (CentralEntry & { compressed: Uint8Array<ArrayBuffer> })[];
}

interface ITextDecoder {
  encoding: string;
  fatal: boolean;
  ignoreBOM: boolean;
  decode(bytes: Uint8Array<ArrayBuffer>): string;
}

const textEncoder = new TextEncoder(); // utf-8
const textDecoder = new TextDecoder(); // utf-8
const cp437Decoder = {
  encoding: "cp437",
  fatal: false,
  ignoreBOM: false,
  decode(bytes: Uint8Array<ArrayBuffer>): string {
    let out = "";
    for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : CP437[byte - 0x80];
    return out;
  }
};
let lastFnDecoder: ITextDecoder | null = null;
const emptyBytes = new Uint8Array_(0);
// Repeated DOMException "name" arguments, hoisted so each call site references a
// (minifier-mangled) binding instead of repeating the full string literal.
const ERR_INVALID_STATE = "InvalidStateError";
const ERR_NOT_SUPPORTED = "NotSupportedError";
const ERR_SECURITY = "SecurityError";
const E_CLOSED = "E_CLOSED";
const E_MODE = "E_MODE";
const E_LIMIT = "E_LIMIT";
const E_LEVEL = "E_LEVEL";
const E_ZIP64 = "E_ZIP64";
const E_FIELD = "E_FIELD";
const E_STRUCTURE = "E_STRUCTURE";
const E_BOUNDS = "E_BOUNDS";
const E_PATH = "E_PATH";
const E_TYPE = "E_TYPE";
const E_UNSUPPORTED = "E_UNSUPPORTED";
const E_INFLATE = "E_INFLATE";
const E_CRC = "E_CRC";
const E_TIME = "E_TIME";
const E_PERM = "E_PERM";
const E_ATTR = "E_ATTR";
// Unix mode file-type bits and the default store permissions applied when an
// entry's permission metadata is emitted but no explicit permission was given.
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
// Highest accepted unixPermissions value: three octal digits, 0o000..0o777.
const UNIX_PERM_MAX = 0o777;
// MS-DOS attribute byte: the directory bit is JSZipp-managed, the rest are caller
// supplied via meta.dosAttributes (0x00..0xff minus the directory bit).
const DOS_DIRECTORY = 0x10;
const DOS_ATTR_MAX = 0xff;
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
const ZIP64_LIMIT = 0xffffffff;
const UINT16_LIMIT = 0xffff;
const ZIP64_EXTRA_ID = 0x0001;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const DATA_DESCRIPTOR_FLAG = 0x0008;
// Flag bits a streaming extractor acts on that a listing must agree with; a
// local/central divergence here is a parser-differential, not a cosmetic one.
const SECURITY_FLAGS = ENCRYPTED_FLAG | DATA_DESCRIPTOR_FLAG;
const UNICODE_PATH_EXTRA_ID = 0x7075;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const WINDOW_SIZE = 32768;
const WINDOW_MASK = WINDOW_SIZE - 1;
const HASH_BITS = 16;
const HASH_SIZE = 2 ** HASH_BITS;
const EXTENDED_TIMESTAMP_EXTRA_ID = 0x5455;
const NTFS_EXTRA_ID = 0x000a;
const DEFLATE_BLOCK_TOKENS = 16384;
const LENGTH_BASES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASES = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA_BITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const makeCrcTable = (): Uint32Array<ArrayBuffer> => {
  // Slicing-by-8: table[0] is the standard polynomial table; tables 1..7 are
  // derived so crc32 can consume 8 bytes per iteration. Built at runtime so no
  // table data is embedded in the bundle.
  let t: Uint32Array<ArrayBuffer> = new Uint32Array_(2048), i: number, v: number, k: number;
  for (i = 256; i--; t[i] = v)
    for (v = i, k = 8; k--;)
      v = (v >>> 1) ^ ((v & 1) * 0xedb88320);
  for (i = 256; i--;)
    for (v = t[i], k = 0; ++k < 8;)
      t[k * 256 + i] = v = (t[v & 255] ^ (v >>> 8));
  return t;
};
const makeFixedLiteralCodes = (): Int32Array<ArrayBuffer> => {
  const a = new Int32Array_(288), p = (s: number, k: number, c: number, l: number) => {
    for (let b = 1 << l - 1, m; k--; ++s)
      for (a[s] = c | l << 16, m = k && b; m && !((c ^= m) & m); m >>= 1);
  };
  return p(0,144,12,8), p(144,112,19,9), p(256,24,0,7), p(280,8,3,8), a;
};
// CRC is shared by both the writer (header CRCs) and the reader (inflateEntry
// integrity check), so it stays eagerly built — a reader-only bundle needs it.
const crcTable = makeCrcTable();

// --- DEFLATE compressor tables & scratch (lazily initialized) ---------------
// Everything below is used only by deflateRaw()/tokenize()/emitBlock() and the
// Huffman builders. Building it at module-evaluation time made the whole
// compressor an unconditional side effect, so a bundler could never tree-shake
// it out of a reader-only entry. Declaring the bindings here (uninitialized)
// and populating them on the first deflateRaw() call keeps the hot path
// identical (tables are still built exactly once, before any compression) while
// letting `usedExports`/`sideEffects:false` drop the entire compressor from any
// entry that never imports a writer API.
//
// O(1) symbol lookup tables. LENGTH_SYM: length 3..258 -> symbol 257..285.
let LENGTH_SYM!: Uint16Array_;
// DISTANCE_SYM: distance 1..32768 -> symbol 0..29.
let DISTANCE_SYM!: Uint16Array_;
// Fixed Huffman literal/length code lengths, used to price the "fixed" block.
let FIXED_LITERAL_LENGTHS!: Uint8Array_;
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
let FIXED_DISTANCE_CODES!: Int32Array_;
let fixedLiteralCodes!: Int32Array_;

// Reusable LZ77 scratch (head 256 KB, previous 128 KB are input-independent and
// reused across calls; the token block is carved from one backing allocation).
// Safe to reuse because deflateRaw()/tokenize() run fully synchronously.
let LZ77_HEAD!: Int32Array_;
let LZ77_PREVIOUS!: Int32Array_;
let lz77TokenBlock = new Uint16Array_(0);

// Reused per-block symbol-frequency counters (cleared per emitted block).
let LITERAL_FREQUENCIES!: Uint32Array_;
let DISTANCE_FREQUENCIES!: Uint32Array_;
let CODE_LENGTH_FREQUENCIES!: Uint32Array_;

// Reused bit-writer working buffer (finish() returns an exact-size slice()).
let deflateOutBuffer = new Uint8Array_(0);

// Reused scratch for makeCanonicalCodes() and makeHuffmanCodeLengths(); see the
// original sizing rationale (16/286/30/19/572 cover every DEFLATE alphabet).
let CANON_NEXT!: Int32Array_;
let CANON_CODES_PRIMARY!: Int32Array_;
let CANON_CODES_DISTANCE!: Int32Array_;
let HUFF_LENGTHS_LITERAL!: Int32Array_;
let HUFF_LENGTHS_DISTANCE!: Int32Array_;
let HUFF_LENGTHS_CODELEN!: Int32Array_;
let HUFF_HEAP!: Int32Array_;
let HUFF_PARENT!: Int32Array_;
let HUFF_WEIGHTS!: Int32Array_;

// Reused scratch for the dynamic-header code-length RLE.
let HUFF_COMBINED!: Int32Array_;
let CL_TOKEN_SYMBOL!: Int32Array_;
let CL_TOKEN_EXTRA!: Int32Array_;
let CL_TOKEN_EXTRABITS!: Int32Array_;

// Reused 4-byte LEN/NLEN header for stored blocks.
let STORED_LEN_HEADER!: Uint8Array_;

// Reused per-entry block boundary lists.
let LZ77_BLOCK_TOKEN_END!: number[];
let LZ77_BLOCK_INPUT_END!: number[];

let deflateTablesReady = false;
// Build the compressor tables/scratch exactly once, lazily, on the first
// deflateRaw() call. No-op on every subsequent call (hot path unchanged).
const ensureDeflateTables = (): void => {
  if (deflateTablesReady) return;
  deflateTablesReady = true;

  fixedLiteralCodes = makeFixedLiteralCodes();

  LENGTH_SYM = new Uint16Array_(MAX_MATCH + 1);
  for (let i = 0; i < LENGTH_BASES.length; i++) {
    const base = LENGTH_BASES[i];
    const limit = base + (1 << LENGTH_EXTRA_BITS[i]) - 1;
    for (let length = base; length <= limit && length <= MAX_MATCH; length++) LENGTH_SYM[length] = 257 + i;
  }
  DISTANCE_SYM = new Uint16Array_(WINDOW_SIZE + 1);
  for (let i = 0; i < DISTANCE_BASES.length; i++) {
    const base = DISTANCE_BASES[i];
    const limit = base + (1 << DISTANCE_EXTRA_BITS[i]) - 1;
    for (let distance = base; distance <= limit && distance <= WINDOW_SIZE; distance++) DISTANCE_SYM[distance] = i;
  }
  FIXED_LITERAL_LENGTHS = new Uint8Array_(288);
  FIXED_LITERAL_LENGTHS.fill(8, 0, 144);
  FIXED_LITERAL_LENGTHS.fill(9, 144, 256);
  FIXED_LITERAL_LENGTHS.fill(7, 256, 280);
  FIXED_LITERAL_LENGTHS.fill(8, 280, 288);
  FIXED_DISTANCE_CODES = Int32Array_.from({ length: 30 }, (_, s) =>
  s >> 4 | s >> 2 & 2 | s & 4 | s << 2 & 8 | s << 4 & 16 | 0x50000);

  LZ77_HEAD = new Int32Array_(HASH_SIZE);
  LZ77_PREVIOUS = new Int32Array_(WINDOW_SIZE);

  LITERAL_FREQUENCIES = new Uint32Array_(286);
  DISTANCE_FREQUENCIES = new Uint32Array_(30);
  CODE_LENGTH_FREQUENCIES = new Uint32Array_(19);

  CANON_NEXT = new Int32Array_(16);
  CANON_CODES_PRIMARY = new Int32Array_(286);
  CANON_CODES_DISTANCE = new Int32Array_(30);

  HUFF_LENGTHS_LITERAL = new Int32Array_(286);
  HUFF_LENGTHS_DISTANCE = new Int32Array_(30);
  HUFF_LENGTHS_CODELEN = new Int32Array_(19);
  HUFF_HEAP = new Int32Array_(286);
  HUFF_PARENT = new Int32Array_(572);
  HUFF_WEIGHTS = new Int32Array_(572);

  HUFF_COMBINED = new Int32Array_(286 + 30);
  CL_TOKEN_SYMBOL = new Int32Array_(286 + 30);
  CL_TOKEN_EXTRA = new Int32Array_(286 + 30);
  CL_TOKEN_EXTRABITS = new Int32Array_(286 + 30);

  STORED_LEN_HEADER = new Uint8Array_(4);

  LZ77_BLOCK_TOKEN_END = [];
  LZ77_BLOCK_INPUT_END = [];
};

// A WHATWG TransformStream whose writable side accepts ZipInputEntry objects and
// whose readable side emits the encoded ZIP byte stream. Use it to pipe entries
// straight into a destination (Response body, file, socket) without buffering the
// whole archive.
export class ZipTransformStream extends TransformStream_<ZipInputEntry, Uint8Array<ArrayBuffer>> {
  // `options` configures compression, ZIP64, timestamps, path policy, etc.
  constructor(options: ZipEncoderOptions = {}) {
    const encoder = new ZipEncoderState(options);
    super({
      async transform(entry, controller) {
        const chunks = await encoder.encodeEntry(entry);
        for (const chunk of chunks) controller.enqueue(chunk);
      },
      flush(controller) {
        for (const chunk of encoder.close()) controller.enqueue(chunk);
      }
    });
  }
}

// Builds a ZIP archive incrementally. Drive it either asynchronously
// (add()/close()) or synchronously (writeSync()/closeSync()) — never both. The
// type parameter T tracks the configured `outputAs` so close() is typed precisely.
export class ZipWriter<T extends ZipWriterOutput = "stream"> {
  // The live archive byte stream. Useful with `outputAs: "stream"`; for other
  // output shapes prefer the value returned by close()/closeSync().
  readonly output: ReadableStream<Uint8Array<ArrayBuffer>>;
  private readonly encoder: ZipEncoderState;
  private readonly outputAs: ZipWriterOutput;
  private readonly mimeType: string;
  private controller?: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  private closed = false;
  // A writer is used in exactly one mode: streaming (add/close) or synchronous
  // (writeSync/closeSync). Mixing them would route some chunks to the stream and
  // others to the sync buffer, silently dropping entries, so it is rejected.
  private mode: "" | "async" | "sync" = "";
  private collected: Uint8Array<ArrayBuffer>[] = [];

  // `options` mixes encoder options with `outputAs`/`mimeType`.
  constructor(options: ZipWriterOptions<T> = {}) {
    const { outputAs = "stream", mimeType = "application/zip", ...encoderOptions } = options;
    this.encoder = new ZipEncoderState(encoderOptions);
    this.outputAs = outputAs;
    this.mimeType = mimeType;
    this.output = new ReadableStream_<Uint8Array<ArrayBuffer>>({
      start: (controller) => {
        this.controller = controller;
      }
    });
  }

  // Appends one entry, reading any stream/Blob payload to completion. Async mode.
  async add(entry: ZipInputEntry): Promise<void> {
    if (this.closed) throw new DOMException(DEV ? "ZIP writer is already closed" : E_CLOSED, ERR_INVALID_STATE);
    if (this.mode === "sync") throw new DOMException(DEV ? "Cannot mix add() with writeSync(); use one mode per writer" : E_MODE, ERR_INVALID_STATE);
    this.mode = "async";
    const chunks = await this.encoder.encodeEntry(entry);
    for (const chunk of chunks) this.controller?.enqueue(chunk);
  }

  // Finalizes the archive (writes the central directory) and resolves to the
  // configured output shape. The writer cannot be used afterwards.
  async close(): Promise<ZipWriterCloseResult<T>> {
    if (this.closed) throw new DOMException(DEV ? "ZIP writer is already closed" : E_CLOSED, ERR_INVALID_STATE);
    if (this.mode === "sync") throw new DOMException(DEV ? "Use closeSync() to finish a writer driven by writeSync()" : E_MODE, ERR_INVALID_STATE);
    this.closed = true;
    for (const chunk of this.encoder.close()) this.controller?.enqueue(chunk);
    this.controller?.close();

    if (this.outputAs === "blob") {
      return responseAcceptsStream_
        ? new Response(this.output, { headers: { "Content-Type": this.mimeType } }).blob() as Promise<ZipWriterCloseResult<T>>
        : new Blob([await readStream(this.output, this.encoder.signal)], { type: this.mimeType }) as ZipWriterCloseResult<T>;
    }
    if (this.outputAs === "response") {
      const body = responseAcceptsStream_
        ? this.output
        : await readStream(this.output, this.encoder.signal);
      return new Response(body, { headers: { "Content-Type": this.mimeType } }) as ZipWriterCloseResult<T>;
    }
    if (this.outputAs === "uint8array") return readStream(this.output, this.encoder.signal) as Promise<ZipWriterCloseResult<T>>;
    if (this.outputAs === "arraybuffer") {
      const bytes = await readStream(this.output, this.encoder.signal);
      return arrayBufferFromBytes(bytes) as ZipWriterCloseResult<T>;
    }
    return this.output as ZipWriterCloseResult<T>;
  }

  // Synchronous counterpart to add(). Accepts only in-memory data (string,
  // Uint8Array, ArrayBuffer) because Blob and ReadableStream cannot be read
  // synchronously; pass those through add() instead.
  writeSync(entry: ZipSyncInputEntry): void {
    if (this.closed) throw new DOMException(DEV ? "ZIP writer is already closed" : E_CLOSED, ERR_INVALID_STATE);
    if (this.mode === "async") throw new DOMException(DEV ? "Cannot mix writeSync() with add(); use one mode per writer" : E_MODE, ERR_INVALID_STATE);
    this.mode = "sync";
    for (const chunk of this.encoder.encodeEntrySync(entry)) this.collected.push(chunk);
  }

  // Synchronous counterpart to close(). Returns the same shape as close() for the
  // configured outputAs, computed without awaiting.
  closeSync(): ZipWriterCloseResult<T> {
    if (this.closed) throw new DOMException(DEV ? "ZIP writer is already closed" : E_CLOSED, ERR_INVALID_STATE);
    if (this.mode === "async") throw new DOMException(DEV ? "Use close() to finish a writer driven by add()" : E_MODE, ERR_INVALID_STATE);
    this.closed = true;
    for (const chunk of this.encoder.close()) this.collected.push(chunk);
    const bytes: Uint8Array<ArrayBuffer> = concat(this.collected);
    this.collected = [];
    // Keep writer.output consistent with the returned value and not left dangling.
    this.controller?.enqueue(bytes);
    this.controller?.close();

    if (this.outputAs === "blob") return new Blob([bytes], { type: this.mimeType }) as ZipWriterCloseResult<T>;
    if (this.outputAs === "response") return new Response(bytes, { headers: { "Content-Type": this.mimeType } }) as ZipWriterCloseResult<T>;
    if (this.outputAs === "uint8array") return bytes as ZipWriterCloseResult<T>;
    if (this.outputAs === "arraybuffer") return arrayBufferFromBytes(bytes) as ZipWriterCloseResult<T>;
    return this.output as ZipWriterCloseResult<T>;
  }
}

// Basic range checks for caller-supplied reader caps. Both bound untrusted input,
// so a negative, NaN, or non-finite cap is a caller mistake (it would never
// trigger and silently disable the protection) and is rejected up front.
const validateReadOptions = (options: ZipReadOptions): void => {
  validateSizeCap(options.maxArchiveSize, "maxArchiveSize");
  validateSizeCap(options.maxEntrySize, "maxEntrySize");
};

const validateSizeCap = (value: number | undefined, name: string): void => {
  if (value !== undefined && (!isFinite(value) || value < 0)) {
    throw new RangeError(DEV ? `${name} must be a non-negative number` : E_LIMIT);
  }
};

// Reads a ZIP byte stream and yields its entries in central-directory order as
// forward-only `ZipStreamEntry` objects (each payload consumed once). The input
// stream is fully buffered first; on completion or early break it is cancelled.
export async function* readZipStream(zipStream: ReadableStream<Uint8Array<ArrayBuffer>>, options: ZipReadOptions = {}): AsyncIterable<ZipStreamEntry> {
  validateReadOptions(options);
  const bytes = await readStream(zipStream, options.signal, (loaded) => options.onProgress?.({ phase: "read", loaded }));
  if (options.maxArchiveSize !== undefined && bytes.length > options.maxArchiveSize) {
    throw new RangeError(DEV ? `ZIP archive size ${bytes.length} exceeds maxArchiveSize ${options.maxArchiveSize}` : E_LIMIT);
  }
  const { entries } = parseZip(bytes, options);

  try {
    for (const entry of entries) {
      options.signal?.[throwIfAborted_]();
      yield new StreamEntry(entry, options.maxEntrySize);
    }
  } finally {
    await zipStream.cancel().catch(() => undefined);
  }
}

// Opens an in-memory or Blob/File ZIP source and returns a random-access reader
// whose entries can be read in any order and re-read until close().
export const openZip = async (source: Blob | File | Uint8Array<ArrayBuffer> | ArrayBuffer, options: ZipReadOptions = {}): Promise<ZipRandomAccessReader> => {
  validateReadOptions(options);
  options.signal?.[throwIfAborted_]();
  const bytes = source instanceof Uint8Array_
    ? source
    : source instanceof ArrayBuffer
      ? new Uint8Array_(source)
      : new Uint8Array_(await source[arrayBuffer_]());
  if (options.maxArchiveSize !== undefined && bytes.length > options.maxArchiveSize) {
    throw new RangeError(DEV ? `ZIP archive size ${bytes.length} exceeds maxArchiveSize ${options.maxArchiveSize}` : E_LIMIT);
  }
  options.onProgress?.({ phase: "read", loaded: bytes.length, total: bytes.length });
  return new BlobZipReader(source instanceof Blob ? source : undefined, parseZip(bytes, options), options.maxEntrySize);
};

// Default export aggregating the public API for UMD/`import JSZipp from ...`.
// Reader/writer UMD sub-entries import selected named exports from this module;
// their builds disable the full namespace so the object literal does not pin the
// opposite half of the library in the bundle.
const JSZipp = JSZIPP_NAMESPACE_
  ? {
    ZipTransformStream,
    ZipWriter,
    readZipStream,
    openZip,
    TimestampMode
  }
  : undefined as unknown as {
    ZipTransformStream: typeof ZipTransformStream;
    ZipWriter: typeof ZipWriter;
    readZipStream: typeof readZipStream;
    openZip: typeof openZip;
    TimestampMode: typeof TimestampMode;
  };

export default JSZipp;

class ZipEncoderState {
  private readonly options: ZipEncoderRuntimeOptions;
  private readonly worker?: ZipWorkerBackend;
  private readonly central: Uint8Array<ArrayBuffer>[] = [];
  private readonly paths = new Set<string>();
  private offset = 0;
  private entries = 0;
  private centralSize = 0;

  constructor(options: ZipEncoderOptions) {
    const { worker, ...encoderOptions } = options;
    this.worker = worker;
    const level = encoderOptions.level ?? 6;
    if (!isInteger(level) || level < 0 || level > 9) throw new RangeError(DEV ? "level must be an integer from 0 to 9" : E_LEVEL);
    const timestamps = encoderOptions.timestamps ?? (TimestampMode.Dos | TimestampMode.Unix);
    // timestamps is a bitmask of the three TimestampMode flags (Dos|Unix|Ntfs),
    // so any value outside 0..7 (or a non-integer) is a caller mistake that would
    // otherwise be silently masked by the per-flag bitwise tests below.
    if (!isInteger(timestamps) || timestamps < 0 || timestamps > 7) throw new RangeError(DEV ? "timestamps must be a bitmask of TimestampMode flags (0 to 7)" : E_MODE);
    this.options = {
      level,
      zip64: encoderOptions.zip64 ?? "auto",
      comment: encoderOptions.comment ?? "",
      timestamps,
      pathMode: encoderOptions.pathMode ?? "unsafe",
      signal: encoderOptions.signal ?? new AbortController_().signal,
      onProgress: encoderOptions.onProgress ?? (() => undefined),
      explicitDirectoryEntries: encoderOptions.explicitDirectoryEntries ?? false
    };
  }

  get signal(): AbortSignal {
    return this.options.signal;
  }

  async encodeEntry(input: ZipInputEntry): Promise<Uint8Array<ArrayBuffer>[]> {
    this.options.signal[throwIfAborted_]();
    const pathInfo = this.reservePath(input);
    try {
      const prepared = this.worker && await this.worker.prepare(input, this.options, pathInfo);
      if (prepared && (prepared.path !== pathInfo.path || prepared.isDirectory !== pathInfo.isDirectory)) {
        throw new TypeError(DEV ? "worker backend returned an entry for a different path" : E_WORKER);
      }
      return this.commit(prepared || await prepareEntry(input, this.options, pathInfo));
    } catch (error) {
      this.paths.delete(pathInfo.path);
      throw error;
    }
  }

  encodeEntrySync(input: ZipSyncInputEntry): Uint8Array<ArrayBuffer>[] {
    this.options.signal[throwIfAborted_]();
    const pathInfo = this.reservePath(input);
    try {
      return this.commit(prepareEntrySync(input, this.options, pathInfo));
    } catch (error) {
      this.paths.delete(pathInfo.path);
      throw error;
    }
  }

  private reservePath(input: ZipInputEntry | ZipSyncInputEntry): { path: string; isDirectory: boolean } {
    const pathInfo = preparePath(input, this.options);
    if (this.paths.has(pathInfo.path)) {
      throw new DOMException(DEV ? `Duplicate ZIP entry path: ${pathInfo.path}` : E_PATH, ERR_SECURITY);
    }
    this.paths.add(pathInfo.path);
    return pathInfo;
  }

  private commit(prepared: ZipPreparedEntry): Uint8Array<ArrayBuffer>[] {
    const locals: Uint8Array<ArrayBuffer>[] = [];
    // With explicitDirectoryEntries on, emit a standalone entry for each parent
    // directory implied by this entry's path that has not been written yet,
    // before the entry itself, so directories precede their contents. Each
    // synthesized directory is reserved in `paths` to keep duplicate detection
    // consistent with explicitly-added directory entries.
    if (this.options.explicitDirectoryEntries) {
      for (const dirPath of this.missingParentDirectories(prepared.path)) {
        this.paths.add(dirPath);
        locals.push(this.writePrepared(synthesizeDirectory(dirPath, this.options)));
      }
    }
    locals.push(this.writePrepared(prepared));
    return locals;
  }

  // Appends one prepared entry's local + central records and advances the
  // running offset/count. Shared by the entry and any directories it implies.
  private writePrepared(prepared: ZipPreparedEntry): Uint8Array<ArrayBuffer> {
    const chunks = writeEntry(prepared, this.offset, this.options.zip64, this.options.timestamps);
    this.offset += chunks.local.length;
    this.central.push(chunks.central);
    this.centralSize += chunks.central.length;
    this.entries++;
    this.options.onProgress({ phase: "write", path: prepared.path, loaded: this.offset, entries: this.entries });
    return chunks.local;
  }

  // Parent directory paths implied by `path` ("a/b/c.txt" -> ["a/", "a/b/"];
  // "a/b/" -> ["a/"]) that have not yet been written, in root-to-leaf order.
  private missingParentDirectories(path: string): string[] {
    const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
    const segments = trimmed.split("/");
    const out: string[] = [];
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
      prefix += segments[i] + "/";
      if (!this.paths.has(prefix)) out.push(prefix);
    }
    return out;
  }

  close(): Uint8Array<ArrayBuffer>[] {
    this.options.signal[throwIfAborted_]();
    // centralSize is tracked incrementally in commit() rather than re-summed
    // here, and the EOCD chunks are appended onto the existing central array
    // instead of spreading every central record into a fresh array. close() is
    // terminal (callers guard against a second close), so finalizing the central
    // array in place is safe and avoids an O(entries) copy + transient array on
    // archives with very large entry counts.
    const eocd = writeEndOfCentralDirectory(this.entries, this.centralSize, this.offset, this.options.zip64, this.options.comment);
    for (const chunk of eocd) this.central.push(chunk);
    return this.central;
  }
}

// Shared read implementation for both reader entry shapes. The only differences
// between a streaming entry and a random-access entry are (a) the access guard
// (one-shot consume vs "reader still open") and (b) which public interface they
// satisfy; stream()/text()/bytes()/arrayBuffer() are byte-identical, so they
// live here once instead of being duplicated in each class.
abstract class ZipEntryReader {
  // Public surface common to both reader shapes. Declared and populated once here
  // instead of being duplicated field-for-field in each subclass constructor.
  // `entry` always carries concrete numbers (from the central directory), so the
  // narrower `number` typing satisfies both ZipStreamEntry (number | null) and
  // ZipRandomAccessEntry (number).
  readonly path: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly crc32: number;
  readonly isDirectory: boolean;
  readonly comment?: string;
  readonly extraField?: Uint8Array<ArrayBuffer>;
  readonly modifiedAt?: Date;
  readonly createdAt?: Date;
  readonly lastAccess?: Date;
  readonly externalAttributes?: number;

  constructor(
    protected readonly entry: CentralEntry & { compressed: Uint8Array<ArrayBuffer> },
    protected readonly maxEntrySize?: number
  ) {
    this.path = entry.path;
    this.size = entry.size;
    this.compressedSize = entry.compressedSize;
    this.crc32 = entry.crc32;
    this.isDirectory = entry.isDirectory;
    this.comment = entry.comment || undefined;
    this.extraField = entry.extraField.length ? entry.extraField : undefined;
    this.modifiedAt = entry.modifiedAt;
    this.createdAt = entry.createdAt;
    this.lastAccess = entry.lastAccess;
    this.externalAttributes = entry.externalAttributes;
  }

  protected abstract guard(): void;

  protected read(): Promise<Uint8Array<ArrayBuffer>> {
    return inflateEntry(this.entry, this.maxEntrySize);
  }

  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    this.guard();
    return bytesToStream(this.read());
  }

  async text(): Promise<string> {
    this.guard();
    return textDecoder.decode(await this.read());
  }

  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    this.guard();
    return this.read();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.guard();
    return arrayBufferFromBytes(await this.read());
  }
}

class StreamEntry extends ZipEntryReader implements ZipStreamEntry {
  private consumed = false;

  async skip(): Promise<void> {
    this.guard();
  }

  protected guard(): void {
    if (this.consumed) throw new DOMException(DEV ? "ZIP stream entry payload was already consumed" : E_CLOSED, ERR_INVALID_STATE);
    this.consumed = true;
  }
}

class BlobZipReader implements ZipRandomAccessReader {
  readonly comment?: string;
  readonly entries: readonly ZipRandomAccessEntry[];
  private closed = false;
  private latest = new Map<string, ZipRandomAccessEntry>();

  constructor(private source: Blob | File | undefined, parsed: ParsedZip, private readonly maxEntrySize?: number) {
    this.comment = parsed.comment || undefined;
    const entries = parsed.entries;
    this.entries = entries.map((entry) => new BlobZipEntry(entry, () => {
      if (this.closed) throw new DOMException(DEV ? "ZIP reader is closed" : E_CLOSED, ERR_INVALID_STATE);
    }, this.maxEntrySize));
    for (const entry of this.entries) this.latest.set(entry.path, entry);
  }

  get(path: string): ZipRandomAccessEntry | undefined {
    return this.latest.get(path) ?? this.latest.get(normalizePath(path));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.source = undefined;
    this.latest.clear();
  }
}

class BlobZipEntry extends ZipEntryReader implements ZipRandomAccessEntry {
  constructor(entry: CentralEntry & { compressed: Uint8Array<ArrayBuffer> }, private readonly assertOpen: () => void, maxEntrySize?: number) {
    super(entry, maxEntrySize);
  }

  protected guard(): void {
    this.assertOpen();
  }
}

// Validates the per-entry compression level and resolves the final write path.
// Shared by prepareEntry (async) and prepareEntrySync (sync) to avoid
// duplicating the level check and path normalization in both call sites.
const preparePath = (input: ZipInputEntry | ZipSyncInputEntry, options: ZipEncoderRuntimeOptions): { path: string; isDirectory: boolean } => {
  const level = input.level ?? options.level;
  if (!isInteger(level) || level < 0 || level > 9) throw new RangeError(DEV ? "entry level must be an integer from 0 to 9" : E_LEVEL);
  const path = applyWritePathMode(normalizePath(input.path, input.path.endsWith("/")), options.pathMode);
  return { path, isDirectory: path.endsWith("/") };
};

const prepareEntry = async (input: ZipInputEntry, options: ZipEncoderRuntimeOptions, pathInfo = preparePath(input, options)): Promise<ZipPreparedEntry> => {
  const { path, isDirectory } = pathInfo;
  const source = isDirectory ? emptyBytes : await inputToBytes(input.data, options.signal, (loaded, total) => {
    options.onProgress({ phase: "read", path, loaded, total });
  });
  return buildPreparedEntry(input, options, path, isDirectory, source);
};

const prepareEntrySync = (input: ZipSyncInputEntry, options: ZipEncoderRuntimeOptions, pathInfo = preparePath(input, options)): ZipPreparedEntry => {
  const { path, isDirectory } = pathInfo;
  const source = isDirectory ? emptyBytes : inputToBytesSync(input.data, options.signal);
  return buildPreparedEntry(input, options, path, isDirectory, source);
};

/** @internal */
export const __privatePrepareEntryForWorker = async (
  input: ZipInputEntry,
  options: ZipEncoderRuntimeOptions,
  pathInfo: { path: string; isDirectory: boolean }
): Promise<ZipPreparedEntry> => prepareEntry(input, options, pathInfo);

const buildPreparedEntry = (input: ZipInputEntry | ZipSyncInputEntry, options: ZipEncoderRuntimeOptions, path: string, isDirectory: boolean, source: Uint8Array<ArrayBuffer>): ZipPreparedEntry => {
  const meta = input.meta;
  const modifiedAt = meta?.modifiedAt ?? new Date();
  // When the NTFS timestamp extra is requested, createdAt and lastAccess default
  // to modifiedAt rather than being required: the NTFS field stores all three
  // FILETIMEs together, and falling back to the modification time is the least
  // surprising value when a caller only knows when the entry was modified.
  const ntfs = (options.timestamps & TimestampMode.Ntfs) !== 0;
  const createdAt = meta?.createdAt ?? (ntfs ? modifiedAt : undefined);
  const lastAccess = meta?.lastAccess ?? (ntfs ? modifiedAt : undefined);
  // Reject causally impossible or out-of-range timestamps and permissions before
  // spending any work on compression.
  validateEntryTimes(modifiedAt, createdAt, lastAccess);
  validateUnixPermissions(meta?.unixPermissions, options.timestamps);
  validateDosAttributes(meta?.dosAttributes, options.timestamps, isDirectory);
  const extraField = meta?.extraField ?? emptyBytes;
  const externalAttributes = externalAttributesFor(meta, isDirectory, shouldEmitUnixPermissions(meta, options.timestamps, extraField));

  const level = input.level ?? options.level;
  const requestedMethod = input.method;
  let method = requestedMethod === "store" || level === 0 || isDirectory ? METHOD_STORE : METHOD_DEFLATE;
  let compressed = method === METHOD_DEFLATE && source.length > 0 ? deflateRaw(source, level) : source;
  if (requestedMethod === undefined && method === METHOD_DEFLATE && compressed.length >= source.length) {
    method = METHOD_STORE;
    compressed = source;
  }
  options.onProgress({ phase: "compress", path, loaded: source.length, total: source.length });

  return {
    path,
    isDirectory,
    modifiedAt,
    createdAt,
    lastAccess,
    comment: meta?.comment ?? "",
    extraField,
    sourceSize: source.length,
    compressed,
    method: compressed.length === 0 ? METHOD_STORE : method,
    crc32: crc32(source),
    externalAttributes
  };
};

// Builds a zero-payload directory entry for a synthesized parent directory. It
// runs through buildPreparedEntry with no meta, so it inherits the same
// timestamp/permission/external-attribute handling as an explicitly added
// directory (`add({ path: "a/" })`): write-time mtime, default 0o755 mode when
// Unix permissions are recorded, and the DOS directory bit.
const synthesizeDirectory = (path: string, options: ZipEncoderRuntimeOptions): ZipPreparedEntry =>
  buildPreparedEntry({ path, data: emptyBytes }, options, path, true, emptyBytes);

const writeEntry = (entry: ZipPreparedEntry, localOffset: number, zip64: Zip64Mode, timestamps: TimestampMode): { local: Uint8Array<ArrayBuffer>; central: Uint8Array<ArrayBuffer> } => {
  const pathBytes = textEncoder.encode(entry.path);
  const commentBytes = textEncoder.encode(entry.comment);
  const time = dosDateTime(entry.modifiedAt);
  const needsZip64 = zip64 === "force" || entry.sourceSize > ZIP64_LIMIT || entry.compressed.length > ZIP64_LIMIT || localOffset > ZIP64_LIMIT;
  if (zip64 === "off" && needsZip64) throw new RangeError(DEV ? "ZIP64 is disabled and this archive exceeds standard ZIP limits" : E_ZIP64);
  // The local header has only compressed/uncompressed size slots; the central
  // header also has the local-offset slot. writeEntry() saturates exactly those
  // slots under ZIP64, so each extra carries only the matching saturated fields.
  // The DOS date/time fields are always written; these modes add UTC timestamp
  // extras. A timestamp extra is skipped when the caller already supplied one of
  // the same id in entry.extraField.
  const unixExtra = (timestamps & TimestampMode.Unix) && !hasExtraField(entry.extraField, EXTENDED_TIMESTAMP_EXTRA_ID) ? makeExtendedTimestampExtra(entry.modifiedAt) : emptyBytes;
  let ntfsExtra = emptyBytes;
  if ((timestamps & TimestampMode.Ntfs) && !hasExtraField(entry.extraField, NTFS_EXTRA_ID)) {
    // createdAt and lastAccess are guaranteed here: buildPreparedEntry defaults
    // them to modifiedAt whenever the NTFS flag is set.
    ntfsExtra = makeNtfsTimestampExtra(entry.modifiedAt, entry.createdAt!, entry.lastAccess!);
  }
  const localExtra = concat([entry.extraField, needsZip64 ? makeZip64Extra([entry.sourceSize, entry.compressed.length]) : emptyBytes, unixExtra, ntfsExtra]);
  const centralExtra = concat([entry.extraField, needsZip64 ? makeZip64Extra([entry.sourceSize, entry.compressed.length, localOffset]) : emptyBytes, unixExtra, ntfsExtra]);

  // These lengths are written with writeU16(), which silently truncates above
  // 65535 and would emit a corrupt header; reject instead.
  if (pathBytes.length > UINT16_LIMIT) throw new RangeError(DEV ? "ZIP entry path must fit in 65535 bytes" : E_FIELD);
  if (commentBytes.length > UINT16_LIMIT) throw new RangeError(DEV ? "ZIP entry comment must fit in 65535 bytes" : E_FIELD);
  if (localExtra.length > UINT16_LIMIT || centralExtra.length > UINT16_LIMIT) throw new RangeError(DEV ? "ZIP entry extra field must fit in 65535 bytes" : E_FIELD);

  const local = new Uint8Array_(30 + pathBytes.length + localExtra.length + entry.compressed.length);
  const view = new DataView_(local.buffer);
  writeU32(view, 0, 0x04034b50);
  writeU16(view, 4, needsZip64 ? 45 : 20);
  writeU16(view, 6, UTF8_FLAG);
  writeU16(view, 8, entry.method);
  writeU16(view, 10, time.time);
  writeU16(view, 12, time.date);
  writeU32(view, 14, entry.crc32);
  writeU32(view, 18, needsZip64 ? ZIP64_LIMIT : entry.compressed.length);
  writeU32(view, 22, needsZip64 ? ZIP64_LIMIT : entry.sourceSize);
  writeU16(view, 26, pathBytes.length);
  writeU16(view, 28, localExtra.length);
  local.set(pathBytes, 30);
  local.set(localExtra, 30 + pathBytes.length);
  local.set(entry.compressed, 30 + pathBytes.length + localExtra.length);

  const central = new Uint8Array_(46 + pathBytes.length + centralExtra.length + commentBytes.length);
  const centralView = new DataView_(central.buffer);
  writeU32(centralView, 0, 0x02014b50);
  // "Version made by": low byte = ZIP spec version (4.5), high byte = host OS.
  // When the entry carries Unix mode bits in the high 16 bits of its external
  // attributes, advertise the Unix host (3) so tools like Info-ZIP actually
  // interpret and apply those permissions; otherwise keep the DOS host (0).
  writeU16(centralView, 4, (((entry.externalAttributes >>> 16) !== 0 ? 3 : 0) << 8) | 45);
  writeU16(centralView, 6, needsZip64 ? 45 : 20);
  writeU16(centralView, 8, UTF8_FLAG);
  writeU16(centralView, 10, entry.method);
  writeU16(centralView, 12, time.time);
  writeU16(centralView, 14, time.date);
  writeU32(centralView, 16, entry.crc32);
  writeU32(centralView, 20, needsZip64 ? ZIP64_LIMIT : entry.compressed.length);
  writeU32(centralView, 24, needsZip64 ? ZIP64_LIMIT : entry.sourceSize);
  writeU16(centralView, 28, pathBytes.length);
  writeU16(centralView, 30, centralExtra.length);
  writeU16(centralView, 32, commentBytes.length);
  writeU32(centralView, 38, entry.externalAttributes);
  writeU32(centralView, 42, needsZip64 ? ZIP64_LIMIT : localOffset);
  central.set(pathBytes, 46);
  central.set(centralExtra, 46 + pathBytes.length);
  central.set(commentBytes, 46 + pathBytes.length + centralExtra.length);

  return { local, central };
};

const writeEndOfCentralDirectory = (entries: number, centralSize: number, centralOffset: number, zip64: Zip64Mode, comment: string): Uint8Array<ArrayBuffer>[] => {
  const needsZip64 = zip64 === "force" || entries > UINT16_LIMIT || centralOffset > ZIP64_LIMIT || centralSize > ZIP64_LIMIT;
  if (zip64 === "off" && needsZip64) throw new RangeError(DEV ? "ZIP64 is disabled and this archive exceeds standard ZIP limits" : E_ZIP64);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const commentBytes = textEncoder.encode(comment);
  if (commentBytes.length > UINT16_LIMIT) throw new RangeError(DEV ? "ZIP archive comment must fit in 65535 bytes" : E_FIELD);

  if (needsZip64) {
    const zip64Eocd = new Uint8Array_(56);
    const view = new DataView_(zip64Eocd.buffer);
    writeU32(view, 0, 0x06064b50);
    writeU64(view, 4, 44);
    writeU16(view, 12, 45);
    writeU16(view, 14, 45);
    writeU64(view, 24, entries);
    writeU64(view, 32, entries);
    writeU64(view, 40, centralSize);
    writeU64(view, 48, centralOffset);
    chunks.push(zip64Eocd);

    const locator = new Uint8Array_(20);
    const locatorView = new DataView_(locator.buffer);
    writeU32(locatorView, 0, 0x07064b50);
    writeU64(locatorView, 8, centralOffset + centralSize);
    writeU32(locatorView, 16, 1);
    chunks.push(locator);
  }

  const eocd = new Uint8Array_(22 + commentBytes.length);
  const eocdView = new DataView_(eocd.buffer);
  writeU32(eocdView, 0, 0x06054b50);
  writeU16(eocdView, 8, needsZip64 ? UINT16_LIMIT : entries);
  writeU16(eocdView, 10, needsZip64 ? UINT16_LIMIT : entries);
  writeU32(eocdView, 12, needsZip64 ? ZIP64_LIMIT : centralSize);
  writeU32(eocdView, 16, needsZip64 ? ZIP64_LIMIT : centralOffset);
  writeU16(eocdView, 20, commentBytes.length);
  eocd.set(commentBytes, 22);
  chunks.push(eocd);
  return chunks;
};

const parseZip = (bytes: Uint8Array<ArrayBuffer>, options: ZipReadOptions): ParsedZip => {
  const eocdOffset = findEocd(bytes);
  const view = dataView(bytes);
  const fallbackEncoding: FilenameEncoding | ITextDecoder = options.filenameEncoding ?? "utf-8";
  const fnDecoder: ITextDecoder =
    typeof fallbackEncoding !== "string" ? fallbackEncoding :
      lastFnDecoder?.encoding === fallbackEncoding ? lastFnDecoder :
        lastFnDecoder = (
          fallbackEncoding === "utf-8" ? textDecoder :
            fallbackEncoding === "cp437" ? cp437Decoder :
              new TextDecoder(fallbackEncoding)
        );
  const pathMode = options.pathMode ?? "strict";
  const strictPackage = pathMode === "strict-package";
  const commentLength = readU16(view, eocdOffset + 20);
  const comment = fnDecoder.decode(bytes.subarray(eocdOffset + 22, eocdOffset + 22 + commentLength));
  const { entries, centralOffset, centralSize } = resolveEocd(view, bytes, eocdOffset);

  const result: (CentralEntry & { compressed: Uint8Array<ArrayBuffer> })[] = [];
  const seenLocalOffsets = new Set<number>();
  // strict-package only: reject paths that collide after Unicode (NFC) and case
  // normalization, which catches exact duplicates, case-only, and NFC/NFD twins.
  const collisionKeys = strictPackage ? new Set<string>() : undefined;
  let cursor = centralOffset;
  const end = centralOffset + centralSize;

  for (let index = 0; index < entries && cursor < end; index++) {
    options.signal?.[throwIfAborted_]();
    const entry = readCentralEntry(bytes, cursor, fnDecoder);
    // Two central entries pointing at one local header (a reused/overlapping
    // offset) let a strict reader and a recovering one see different trees.
    if (seenLocalOffsets.has(entry.localOffset)) {
      throw new Error(DEV ? `Two central directory entries reuse local-header offset ${entry.localOffset}` : E_STRUCTURE);
    }
    seenLocalOffsets.add(entry.localOffset);
    // The local header's name must match the central directory's, so a streaming
    // extractor and a listing tool cannot be shown different trees. In
    // strict-package mode the local/central sizes (bit 3 clear) must also agree.
    const centralNameBytes = bytes.subarray(cursor + 46, cursor + 46 + readU16(view, cursor + 28));
    const compressed = readLocalPayload(bytes, entry, centralNameBytes, strictPackage, readU32(view, cursor + 20), readU32(view, cursor + 24));
    const path = applyPathMode(entry.path, pathMode);
    if (collisionKeys) {
      const key = path.normalize("NFC").toLowerCase();
      if (collisionKeys.has(key)) throw new Error(DEV ? `Duplicate or colliding entry path in strict-package mode: ${path}` : E_PATH);
      collisionKeys.add(key);
    }
    result.push({ ...entry, path, isDirectory: path.endsWith("/") || entry.isDirectory, compressed });
    cursor += 46 + readU16(view, cursor + 28) + readU16(view, cursor + 30) + readU16(view, cursor + 32);
    options.onProgress?.({ phase: "parse", loaded: cursor - centralOffset, total: centralSize, entries: index + 1 });
  }

  // The loop stops as soon as *either* the declared entry count is reached or the
  // central-directory window is exhausted. Returning here without cross-checking
  // both would silently accept truncated or over-declared directories, so require
  // that exactly `entries` records were parsed and that they consumed exactly the
  // declared central-directory size.
  if (result.length !== entries) {
    throw new Error(DEV ? `Central directory entry count mismatch: header declared ${entries}, parsed ${result.length}` : E_STRUCTURE);
  }
  if (cursor !== end) {
    throw new Error(DEV ? `Central directory size mismatch: parsed entries end at ${cursor}, expected ${end}` : E_STRUCTURE);
  }

  return { comment, entries: result };
};

const readCentralEntry = (bytes: Uint8Array<ArrayBuffer>, offset: number, fnDecoder: ITextDecoder): CentralEntry => {
  const view = dataView(bytes);
  ensureRange(bytes.length, offset, 46, "central directory entry header");
  if (readU32(view, offset) !== 0x02014b50) throw new Error(DEV ? "Invalid central directory header" : E_STRUCTURE);
  const flags = readU16(view, offset + 8);
  if ((flags & ENCRYPTED_FLAG) !== 0) throw new DOMException(DEV ? "Encrypted ZIP entries are not supported" : E_UNSUPPORTED, ERR_NOT_SUPPORTED);

  const method = readU16(view, offset + 10);
  if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new DOMException(DEV ? `Unsupported ZIP compression method: ${method}` : E_UNSUPPORTED, ERR_NOT_SUPPORTED);

  const pathLength = readU16(view, offset + 28);
  const extraLength = readU16(view, offset + 30);
  const commentLength = readU16(view, offset + 32);
  const pathStart = offset + 46;
  ensureRange(bytes.length, pathStart, pathLength + extraLength + commentLength, "central directory entry fields");
  const extraStart = pathStart + pathLength;
  const commentStart = extraStart + extraLength;
  const extraField = bytes.subarray(extraStart, extraStart + extraLength);
  let compressedSize = readU32(view, offset + 20);
  let size = readU32(view, offset + 24);
  let localOffset = readU32(view, offset + 42);
  const zip64 = parseZip64Extra(extraField);

  if (size === ZIP64_LIMIT) size = requiredZip64(zip64.shift(), "ZIP64 uncompressed size");
  if (compressedSize === ZIP64_LIMIT) compressedSize = requiredZip64(zip64.shift(), "ZIP64 compressed size");
  if (localOffset === ZIP64_LIMIT) localOffset = requiredZip64(zip64.shift(), "ZIP64 local header offset");

  const decoder = (flags & UTF8_FLAG) !== 0 ? textDecoder : fnDecoder;

  const nameBytes = bytes.subarray(pathStart, extraStart);
  // A 0x7075 Unicode Path extra field overrides the header name, but only when
  // its embedded CRC matches the header name bytes; otherwise it is stale and
  // ignored, so we fall back to the header name under the archive's encoding.
  const path = parseUnicodePathExtra(extraField, nameBytes) ?? decoder.decode(nameBytes);
  // Timestamp precedence: when an NTFS extra (0x000a) carries both creation and
  // last-access times, it is authoritative and the DOS/Extended-Timestamp fields
  // are ignored. Otherwise prefer the Extended Timestamp (0x5455) mtime, falling
  // back to the legacy DOS date/time fields.
  const ntfs = parseNtfsTimestampExtra(extraField);
  const ntfsAuthoritative = ntfs !== undefined && ntfs.createdAt !== undefined && ntfs.lastAccess !== undefined;
  const modifiedAt = ntfsAuthoritative && ntfs.modifiedAt !== undefined
    ? ntfs.modifiedAt
    : ntfsAuthoritative
      ? fromDosDateTime(readU16(view, offset + 14), readU16(view, offset + 12))
      : parseExtendedTimestampExtra(extraField) ?? fromDosDateTime(readU16(view, offset + 14), readU16(view, offset + 12));
  return {
    path,
    isDirectory: path.endsWith("/") || (readU32(view, offset + 38) & 0x10) !== 0,
    modifiedAt,
    createdAt: ntfsAuthoritative ? ntfs.createdAt : undefined,
    lastAccess: ntfsAuthoritative ? ntfs.lastAccess : undefined,
    comment: decoder.decode(bytes.subarray(commentStart, commentStart + commentLength)),
    extraField,
    method,
    flags,
    crc32: readU32(view, offset + 16),
    compressedSize,
    size,
    localOffset,
    externalAttributes: readU32(view, offset + 38)
  };
};

const readLocalPayload = (bytes: Uint8Array<ArrayBuffer>, entry: CentralEntry, centralNameBytes: Uint8Array<ArrayBuffer>, strictPackage: boolean, centralRawCompSize: number, centralRawSize: number): Uint8Array<ArrayBuffer> => {
  const view = dataView(bytes);
  const base = entry.localOffset;
  ensureRange(bytes.length, base, 30, "local file header");
  if (readU32(view, base) !== 0x04034b50) throw new Error(DEV ? "Invalid local file header" : E_STRUCTURE);
  const localFlags = readU16(view, base + 6);
  // A listing trusts the central flags while a streaming extractor reads the
  // local ones; if the security-relevant bits disagree, the two views diverge.
  if (((localFlags ^ entry.flags) & SECURITY_FLAGS) !== 0) {
    throw new Error(DEV ? `Local/central flag mismatch for ${entry.path}` : E_STRUCTURE);
  }
  const pathLength = readU16(view, base + 26);
  const extraLength = readU16(view, base + 28);
  ensureRange(bytes.length, base + 30, pathLength, "local file header name");
  // The name a sequential reader sees (local) must equal the listed name (central).
  if (!bytesEqual(bytes.subarray(base + 30, base + 30 + pathLength), centralNameBytes)) {
    throw new Error(DEV ? `Local/central filename mismatch for ${entry.path}` : E_STRUCTURE);
  }
  // strict-package only: with bit 3 clear the local sizes are authoritative and
  // must match the central raw slots (both real, or both the ZIP64 sentinel). The
  // default reader defers size integrity to read time, so this stays opt-in. With
  // bit 3 set the local slots are data-descriptor placeholders, so it is skipped.
  if (strictPackage && ((localFlags | entry.flags) & DATA_DESCRIPTOR_FLAG) === 0 &&
      (readU32(view, base + 18) !== centralRawCompSize || readU32(view, base + 22) !== centralRawSize)) {
    throw new Error(DEV ? `Local/central size mismatch for ${entry.path}` : E_STRUCTURE);
  }
  const start = base + 30 + pathLength + extraLength;
  ensureRange(bytes.length, start, entry.compressedSize, "local file payload");
  return bytes.subarray(start, start + entry.compressedSize);
};

const inflateEntry = async (entry: CentralEntry & { compressed: Uint8Array<ArrayBuffer> }, maxEntrySize?: number): Promise<Uint8Array<ArrayBuffer>> => {
  // Cheap rejection for an honestly-declared oversized entry, before any work.
  if (maxEntrySize !== undefined && entry.size > maxEntrySize) {
    throw new RangeError(DEV ? `Entry ${entry.path} uncompressed size ${entry.size} exceeds maxEntrySize ${maxEntrySize}` : E_LIMIT);
  }
  // For deflate, also pass the cap into inflate so a header that lies about its
  // size cannot expand past the cap during decompression.
  const bytes = entry.method === METHOD_DEFLATE ? await inflateRaw(entry.compressed, entry.size, maxEntrySize) : entry.compressed;
  if (bytes.length !== entry.size) throw new Error(DEV ? `Size mismatch for ${entry.path}` : E_STRUCTURE);
  if (crc32(bytes) !== entry.crc32) throw new Error(DEV ? `CRC32 mismatch for ${entry.path}` : E_CRC);
  return bytes;
};

const inputToBytes = async (input: ZipInputEntry["data"], signal?: AbortSignal, onProgress?: (loaded: number, total?: number) => void): Promise<Uint8Array<ArrayBuffer>> => {
  signal?.[throwIfAborted_]();
  if (typeof input === "string") return textEncoder.encode(input);
  if (input instanceof Uint8Array_) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array_(input);
  if (typeof Blob !== "undefined" && input instanceof Blob) return new Uint8Array_(await input[arrayBuffer_]());
  if (isReadableStream_(input)) return readStream(input, signal, onProgress);
  throw new TypeError(DEV ? "Unsupported ZIP entry data type" : E_TYPE);
};

const inputToBytesSync = (input: ZipSyncInputEntry["data"], signal?: AbortSignal): Uint8Array<ArrayBuffer> => {
  signal?.[throwIfAborted_]();
  if (typeof input === "string") return textEncoder.encode(input);
  if (input instanceof Uint8Array_) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array_(input);
  throw new TypeError(DEV ? "writeSync() supports only string, Uint8Array, or ArrayBuffer data; use add() for Blob or ReadableStream" : E_TYPE);
};

const deflateRaw = (input: Uint8Array<ArrayBuffer>, level: number): Uint8Array<ArrayBuffer> => {
  if (input.length === 0) return emptyBytes;
  ensureDeflateTables();
  const tokens = tokenize(input, level);
  const writer = new DeflateBitWriter(input.length);
  const blockCount = tokens.blockTokenEnd.length;
  let tokenStart = 0;
  let inputStart = 0;
  for (let block = 0; block < blockCount; block++) {
    const tokenEnd = tokens.blockTokenEnd[block];
    const inputEnd = tokens.blockInputEnd[block];
    emitBlock(writer, input, tokens.lengths, tokens.distances, tokenStart, tokenEnd, inputStart, inputEnd, block === blockCount - 1);
    tokenStart = tokenEnd;
    inputStart = inputEnd;
  }
  const compressed = writer.finish();
  if (compressed.length < input.length) return compressed;
  const stored = deflateStoredRaw(input);
  return stored.length < compressed.length ? stored : compressed;
};

interface TokenizedInput {
  lengths: Uint16Array<ArrayBuffer>;
  distances: Uint16Array<ArrayBuffer>;
  blockTokenEnd: number[];
  blockInputEnd: number[];
}

// Single LZ77 pass. Literals are stored as (distance=0, length=byte); matches as
// (distance>0, length=match length). No per-token or per-position allocation.
const tokenize = (input: Uint8Array<ArrayBuffer>, level: number): TokenizedInput => {
  // Reused across calls. head must be reset to -1 ("no position") each run.
  // previous needs no reset: every previous[x & WINDOW_MASK] that is ever read
  // was written when position x was inserted earlier in *this* run (a slot is
  // only read after the position owning it has been inserted), so its prior
  // contents are never observed -- the old per-call fill(-1) was dead work.
  const head = LZ77_HEAD;
  head.fill(-1);
  const previous = LZ77_PREVIOUS;
  // niceLength is the "good enough" match length at which the chain search stops
  // early (and below which lazy matching keeps looking) -- NOT a cap on match
  // length. Matches always extend to MAX_MATCH; capping length here (the old
  // behavior) needlessly truncated long repeats and hurt the ratio on
  // structured text like JSON/CSV.
  const niceLength = [0, 32, 48, 64, 96, 128, 160, 192, 224, MAX_MATCH][level] ?? 128;
  // Chain-search depth per level. The top end is capped near zlib's (4096 at
  // level 9): beyond this, deeper search measurably costs CPU without improving
  // the ratio, since the nice-length early-stop dominates on real data.
  const maxChain = [0, 8, 16, 32, 64, 128, 256, 512, 1024, 4096][level] ?? 128;
  // zlib "good_match": once the greedy match here is already this long, the lazy
  // lookahead almost never improves it, so we skip the second search entirely.
  const goodMatch = [0, 4, 4, 4, 4, 8, 8, 32, 32, 32][level] ?? 8;
  const inputLength = input.length;
  // Two token streams (length/literal and distance) carved from one shared block:
  // [lengths | distances]. Grown only when a larger entry appears, then reused.
  if (lz77TokenBlock.length < inputLength * 2) lz77TokenBlock = new Uint16Array_(inputLength * 2);
  const lengths = lz77TokenBlock.subarray(0, inputLength);
  const distances = lz77TokenBlock.subarray(inputLength, inputLength * 2);
  const blockTokenEnd = LZ77_BLOCK_TOKEN_END;
  blockTokenEnd.length = 0;
  const blockInputEnd = LZ77_BLOCK_INPUT_END;
  blockInputEnd.length = 0;

  let count = 0;
  let position = 0;
  let blockStartToken = 0;

  while (position < inputLength) {
    let packed = insertAndFindMatch(input, position, head, previous, niceLength, maxChain, inputLength);
    let matchLength = packed & 0x1ff;

    // Lazy match: defer to a literal only when a strictly longer match starts at
    // the next byte. Gated by good_match (skip once we already have a long match)
    // and run at quarter chain depth -- the 4-byte hash keeps these chains short
    // and relevant, so a shallow lazy search recaptures nearly all of full
    // lazy-matching's ratio for a tiny fraction of its cost.
    if (level >= 4 && matchLength >= MIN_MATCH && matchLength < goodMatch && position + 1 < inputLength) {
      const next = findMatch(input, position + 1, head[hashBytes(input, position + 1)], previous, niceLength, maxChain >>> 2, inputLength);
      if ((next & 0x1ff) > matchLength) {
        packed = 0;
        matchLength = 0;
      }
    }

    if (matchLength >= MIN_MATCH) {
      lengths[count] = matchLength;
      distances[count] = packed >>> 9;
      count++;
      const end = min(position + matchLength, inputLength - 3);
      for (let next = position + 1; next < end; next++) insertString(input, next, head, previous);
      position += matchLength;
    } else {
      lengths[count] = input[position];
      distances[count] = 0;
      count++;
      position++;
    }

    // Split blocks by token count (like zlib's symbol buffer) rather than input
    // bytes: on compressible data a block then spans much more input, so far
    // fewer dynamic Huffman headers are emitted.
    if (count - blockStartToken >= DEFLATE_BLOCK_TOKENS && position < inputLength) {
      blockTokenEnd.push(count);
      blockInputEnd.push(position);
      blockStartToken = count;
    }
  }

  blockTokenEnd.push(count);
  blockInputEnd.push(inputLength);
  return { lengths, distances, blockTokenEnd, blockInputEnd };
};

// Emit one DEFLATE block, choosing the cheapest of dynamic / fixed / stored by
// exact bit cost. This never compresses worse than a single global choice.
const emitBlock = (
  writer: DeflateBitWriter,
  input: Uint8Array<ArrayBuffer>,
  lengths: Uint16Array_,
  distances: Uint16Array_,
  tokenStart: number,
  tokenEnd: number,
  inputStart: number,
  inputEnd: number,
  final: boolean
): void => {
  const literalFrequencies = LITERAL_FREQUENCIES;
  literalFrequencies.fill(0);
  const distanceFrequencies = DISTANCE_FREQUENCIES;
  distanceFrequencies.fill(0);
  let extraBits = 0;

  for (let k = tokenStart; k < tokenEnd; k++) {
    const distance = distances[k];
    const length = lengths[k];
    if (distance === 0) {
      literalFrequencies[length]++;
    } else {
      const lengthSymbol = LENGTH_SYM[length];
      literalFrequencies[lengthSymbol]++;
      extraBits += LENGTH_EXTRA_BITS[lengthSymbol - 257];
      const distanceSymbol = DISTANCE_SYM[distance];
      distanceFrequencies[distanceSymbol]++;
      extraBits += DISTANCE_EXTRA_BITS[distanceSymbol];
    }
  }
  literalFrequencies[256]++;

  let fixedSymbolBits = 0;
  for (let s = 286; s--; ) fixedSymbolBits += literalFrequencies[s] * FIXED_LITERAL_LENGTHS[s];
  for (let s = 30; s--; ) fixedSymbolBits += distanceFrequencies[s] * 5;

  let dynamicBits = 1 / 0;
  let literalLengths: Int32Array<ArrayBuffer> | undefined;
  let distanceLengths: Int32Array<ArrayBuffer> | undefined;
  let codeLengthLengths: Int32Array<ArrayBuffer> | undefined;
  let lengthTokenCount = 0;
  let literalCount = 0;
  let distanceCount = 0;
  let codeLengthCount = 0;

  const candidateLiteral = makeHuffmanCodeLengths(literalFrequencies, 15, HUFF_LENGTHS_LITERAL);
  const candidateDistance = makeHuffmanCodeLengths(distanceFrequencies, 15, HUFF_LENGTHS_DISTANCE);
  if (candidateLiteral && candidateDistance) {
    literalLengths = candidateLiteral;
    distanceLengths = candidateDistance;

    literalCount = literalLengths.length;
    while (literalCount > 257 && literalLengths[literalCount - 1] === 0) literalCount--;
    distanceCount = distanceLengths.length;
    while (distanceCount > 1 && distanceLengths[distanceCount - 1] === 0) distanceCount--;
    if (distanceCount === 1 && distanceLengths[0] === 0) distanceLengths[0] = 1;

    // literal lengths followed by distance lengths, into one reused buffer
    let combinedCount = 0;
    for (let i = 0; i < literalCount; i++) HUFF_COMBINED[combinedCount++] = literalLengths[i];
    for (let i = 0; i < distanceCount; i++) HUFF_COMBINED[combinedCount++] = distanceLengths[i];
    lengthTokenCount = encodeCodeLengths(HUFF_COMBINED, combinedCount);

    const codeLengthFrequencies = CODE_LENGTH_FREQUENCIES;
    codeLengthFrequencies.fill(0);
    for (let i = lengthTokenCount; i--; ) codeLengthFrequencies[CL_TOKEN_SYMBOL[i]]++;
    const candidateCodeLength = makeHuffmanCodeLengths(codeLengthFrequencies, 7, HUFF_LENGTHS_CODELEN);
    if (candidateCodeLength) {
      codeLengthLengths = candidateCodeLength;
      codeLengthCount = CODE_LENGTH_ORDER.length;
      while (codeLengthCount > 4 && codeLengthLengths[CODE_LENGTH_ORDER[codeLengthCount - 1]] === 0) codeLengthCount--;

      let headerBits = 14 + 3 * codeLengthCount;
      for (let i = lengthTokenCount; i--; ) headerBits += codeLengthLengths[CL_TOKEN_SYMBOL[i]] + CL_TOKEN_EXTRABITS[i];

      let dynamicSymbolBits = 0;
      for (let s = 286; s--;) dynamicSymbolBits += literalFrequencies[s] * literalLengths[s];
      for (let s = 30; s--; ) dynamicSymbolBits += distanceFrequencies[s] * distanceLengths[s];

      dynamicBits = headerBits + dynamicSymbolBits;
    }
  }

  const useDynamic = dynamicBits < fixedSymbolBits;
  const deflateBits = 3 + extraBits + (useDynamic ? dynamicBits : fixedSymbolBits);
  const rawLength = inputEnd - inputStart;
  const pad = (8 - ((writer.pendingBits() + 3) & 7)) & 7;
  // A stored block carries a 16-bit length, so it can only represent up to
  // UINT16_LIMIT bytes; larger spans must use a compressed block (which has no
  // size field). Such spans are always compressible here anyway, so this never
  // costs ratio.
  const storedBits = rawLength <= UINT16_LIMIT ? 3 + pad + 32 + 8 * rawLength : 1 / 0;

  // BFINAL is written once for every block; only BTYPE differs per branch.
  writer.writeBits(final ? 1 : 0, 1);

  if (storedBits <= deflateBits) {
    writer.writeBits(0, 2);
    writer.alignToByte();
    STORED_LEN_HEADER[0] = rawLength & 0xff;
    STORED_LEN_HEADER[1] = (rawLength >>> 8) & 0xff;
    STORED_LEN_HEADER[2] = ~rawLength & 0xff;
    STORED_LEN_HEADER[3] = (~rawLength >>> 8) & 0xff;
    writer.writeBytes(STORED_LEN_HEADER);
    writer.writeBytes(input.subarray(inputStart, inputEnd));
    return;
  }

  if (useDynamic) {
    writer.writeBits(2, 2);
    writer.writeBits(literalCount - 257, 5);
    writer.writeBits(distanceCount - 1, 5);
    writer.writeBits(codeLengthCount - 4, 4);
    for (let i = 0; i < codeLengthCount; i++) writer.writeBits(codeLengthLengths![CODE_LENGTH_ORDER[i]], 3);
    // code-length table shares the primary buffer: it is fully consumed by the
    // loop below before the literal table (also primary) is built.
    const codeLengthCodes = makeCanonicalCodes(codeLengthLengths!, CANON_CODES_PRIMARY);
    for (let i = 0; i < lengthTokenCount; i++) {
      writeHuffmanSymbol(writer, codeLengthCodes, CL_TOKEN_SYMBOL[i]);
      if (CL_TOKEN_EXTRABITS[i]) writer.writeBits(CL_TOKEN_EXTRA[i], CL_TOKEN_EXTRABITS[i]);
    }
    emitTokens(writer, lengths, distances, tokenStart, tokenEnd, makeCanonicalCodes(literalLengths!, CANON_CODES_PRIMARY), makeCanonicalCodes(distanceLengths!, CANON_CODES_DISTANCE));
  } else {
    writer.writeBits(1, 2);
    emitTokens(writer, lengths, distances, tokenStart, tokenEnd, fixedLiteralCodes, FIXED_DISTANCE_CODES);
  }
};

const emitTokens = (
  writer: DeflateBitWriter,
  lengths: Uint16Array_,
  distances: Uint16Array_,
  tokenStart: number,
  tokenEnd: number,
  literalCodes: Int32Array<ArrayBuffer>,
  distanceCodes: Int32Array<ArrayBuffer>
): void => {
  for (let k = tokenStart; k < tokenEnd; k++) {
    const distance = distances[k];
    const length = lengths[k];
    if (distance === 0) {
      writeHuffmanSymbol(writer, literalCodes, length);
    } else {
      const lengthSymbol = LENGTH_SYM[length];
      writeHuffmanSymbol(writer, literalCodes, lengthSymbol);
      const lengthExtra = LENGTH_EXTRA_BITS[lengthSymbol - 257];
      if (lengthExtra) writer.writeBits(length - LENGTH_BASES[lengthSymbol - 257], lengthExtra);
      const distanceSymbol = DISTANCE_SYM[distance];
      writeHuffmanSymbol(writer, distanceCodes, distanceSymbol);
      const distanceExtra = DISTANCE_EXTRA_BITS[distanceSymbol];
      if (distanceExtra) writer.writeBits(distance - DISTANCE_BASES[distanceSymbol], distanceExtra);
    }
  }
  writeHuffmanSymbol(writer, literalCodes, 256);
};

// Min-heap sift-down over node ids in `heap`, ordered by (weight, id). Module
// scope so makeHuffmanCodeLengths allocates no per-call closures.
const huffSiftDown = (heap: Int32Array<ArrayBuffer>, weights: Int32Array<ArrayBuffer>, size: number, p: number): void => {
  const node = heap[p];
  const nodeWeight = weights[node];
  let child;
  for (; (child = p * 2 + 1) < size; p = child) {
    let childNode = heap[child];
    if (child + 1 < size) {
      const right = heap[child + 1];
      if (weights[right] < weights[childNode] || (weights[right] === weights[childNode] && right < childNode)) {
        child++;
        childNode = right;
      }
    }
    if (!(weights[childNode] < nodeWeight || (weights[childNode] === nodeWeight && childNode < node))) break;
    heap[p] = childNode;
  }
  heap[p] = node;
};

const makeHuffmanCodeLengths = (frequencies: Uint32Array<ArrayBuffer>, maxBits: number, out: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> | undefined => {
  // If the optimal tree exceeds DEFLATE's bit-length limit, the lengths are
  // length-limited (see limitHuffmanCodeLengths) instead of bailing to fixed
  // Huffman. The hot path is unchanged for normal blocks -- limiting only runs
  // when a code would exceed maxBits, which at the current 16K block size never
  // happens -- so existing output is byte-identical. This removes the latent
  // large-block ratio cliff (codes >15 bits used to dump the whole block to
  // fixed Huffman), so the block size can now be raised safely if desired.
  const symbolCount = frequencies.length;
  out.fill(0, 0, symbolCount);

  // Shared scratch. Leaf node ids are assigned in symbol order (0,1,2,...), so a
  // leaf's id equals its rank among nonzero symbols -- the depth walk relies on
  // this. Every parent/weights slot used is written before it is read this call,
  // so no clearing is needed beyond `out`.
  const heap = HUFF_HEAP;
  const parent = HUFF_PARENT;
  const weights = HUFF_WEIGHTS;
  let nodeCount = 0;
  let heapSize = 0;

  for (let symbol = 0; symbol < symbolCount; symbol++) {
    const frequency = frequencies[symbol];
    if (frequency === 0) continue;
    heap[heapSize++] = nodeCount;
    weights[nodeCount] = frequency;
    parent[nodeCount] = -1;
    nodeCount++;
  }

  if (heapSize === 0) return out;
  if (heapSize === 1) {
    for (let symbol = 0; symbol < symbolCount; symbol++) if (frequencies[symbol] > 0) { out[symbol] = 1; break; }
    return out;
  }

  // Build the optimal Huffman tree with a binary min-heap (O(k log k)) rather
  // than re-sorting the active set on every merge (O(k^2 log k)). The tree is
  // still built by repeatedly merging the two lowest-weight nodes, so the total
  // symbol cost is unchanged; ties break by node id for deterministic output.
  let size = heapSize;
  for (let i = (size >> 1) - 1; i >= 0; i--) huffSiftDown(heap, weights, size, i);

  while (size > 1) {
    const left = heap[0];
    heap[0] = heap[--size];
    huffSiftDown(heap, weights, size, 0);
    const right = heap[0];
    const next = nodeCount++;
    parent[left] = next;
    parent[right] = next;
    parent[next] = -1;
    weights[next] = weights[left] + weights[right];
    heap[0] = next;
    huffSiftDown(heap, weights, size, 0);
  }

  // Code lengths are leaf depths. Rather than walk each leaf up to the root
  // (O(nonzeroSymbols x treeHeight); height can reach ~n on Fibonacci-like
  // frequencies, the latent O(n^2) corner), propagate depth top-down in one
  // linear pass. Every internal node was created after both its children
  // (next = nodeCount++), so a parent's id always exceeds its children's and
  // the root holds the largest id: a single high-id -> low-id sweep lets each
  // node read its parent's already-computed depth. weights[] is dead once the
  // tree is built, so it doubles as the depth buffer -- no new allocation. The
  // leaves keep ids 0..leafCount-1 in symbol order, so out lines up unchanged
  // and the result is byte-identical to the old leaf->root walk.
  const depth = weights;
  depth[nodeCount - 1] = 0;
  for (let node = nodeCount - 2; node >= 0; node--) depth[node] = depth[parent[node]] + 1;

  let leaf = 0;
  let overLimit = false;
  for (let symbol = 0; symbol < symbolCount; symbol++) {
    if (frequencies[symbol] === 0) continue;
    const d = depth[leaf++];
    out[symbol] = d;
    if (d > maxBits) overLimit = true;
  }
  if (overLimit) limitHuffmanCodeLengths(frequencies, maxBits, out);
  return out;
};

// Optimal length-limited code lengths via count-only package-merge (Larmore &
// Hirschberg). Each nonzero symbol contributes one coin of its frequency at
// every denomination level; the lowest 2n-2 coins of the top level form the
// optimum, and a symbol's length is how many levels select its coin. Coins stay
// weight-sorted and a symbol's coin is identical at every level, so the
// lowest-weight symbols are selected at the most levels -- lengths therefore
// follow from counting selected leaves per level, with no member lists. Cold
// path only (runs solely when an optimal code would exceed maxBits, which never
// happens at the 16K block size). O(maxBits*n): each level is a linear merge of
// the n weight-sorted leaves with the prior level's packages, recorded as a
// per-level leaf/package bitmap (1 = leaf); the top-down pass then counts, at
// each level, how many of the lowest `need` coins are leaves and adds one bit to
// that many lowest-ranked symbols.
const limitHuffmanCodeLengths = (frequencies: Uint32Array<ArrayBuffer>, maxBits: number, out: Int32Array<ArrayBuffer>): void => {
  // Symbols of nonzero leaves, ascending by weight (stable sort -> ties keep
  // symbol order, matching the original). The same pass zeroes `out`.
  const S: number[] = [];
  for (let s = 0; s < frequencies.length; s++) out[s] = 0, frequencies[s] && S.push(s);
  S.sort((a, b) => frequencies[a] - frequencies[b]);
  const n = S.length;
  if (n < 2) {
    if (n) out[S[0]] = 1;
    return;
  }

  // W = leaf weights (read-only); jw starts as the level-0 coin list, sharing W.
  let need = 2 * n - 2,
    i: number, p: number, q: number, m: number, e: number, pw: number,
    w, jw, f, W = jw = S.map((s) => frequencies[s]);

  
  // Bottom-up: store only a leaf/package bitmap per level (1 = leaf). Merging the n
  // leaves with the packages below is linear since both are weight-sorted.
  const isLeaf = [new Uint8Array_(n).fill(1)];
  for (i = maxBits; --i; ) {
    m = jw.length;
    isLeaf.push((f = new Uint8Array_(n + (m--))));   // push the buffer, fill it below
    w = jw;
    jw = [];
    p = q = e = 0;
    for (; p < n || q < m; jw[e++] = pw) {
      pw = q < m ? w[q] + w[q + 1] : 1 / 0;
      if (p < n && W[p] <= pw) (f[e] = 1), (pw = W[p++]);
      else q += 2;
    }
  }

  // Top-down: leaves among the lowest `need` coins are the smallest leaves, met in
  // symbol order — one forward scan both counts them (q) and adds their bit.
  for (i = maxBits; i--; ) {
    f = isLeaf[i];
    m = min(need, f.length);
    for (p = q = 0; p < m; ) f[p++] && out[S[q++]]++;
    need = 2 * (need - q);
  }
};

// Packed canonical codes: each entry is (reversedBits | length << 16). 0 means
// the symbol has no code. Writes into the caller-supplied `out` buffer (one of
// the shared CANON_CODES_* arrays) and reuses CANON_COUNTS/CANON_NEXT as
// working scratch, so the only allocation-free per-block path stays that way.
const makeCanonicalCodes = (
  lengths: Int32Array<ArrayBuffer>,
  out: Int32Array<ArrayBuffer>,
): Int32Array<ArrayBuffer> => {
  const n = lengths.length, next = CANON_NEXT;
  let c = 0, i, l: number, bit: number;

  next.fill(0);

  for (i = n; i--;) {
    if ((l = lengths[i])) {
      next[l]++;
      if (l > c) c = l;
    } else {
      out[i] = 0;
    }
  }

  for (let b = 1, code = 0; b <= c; b++) {
    for (i = next[b], next[b] = code; i--; code ^= bit)
      for (bit = 1 << (b - 1); code & bit; bit >>= 1) code ^= bit;
  }

  for (i = 0; i < n; i++)
    if ((l = lengths[i])) {
      out[i] = (c = next[l]) | (l << 16);
      for (bit = 1 << (l - 1); c & bit; bit >>= 1) c ^= bit;
      next[l] = c ^ bit;
    }

  return out;
};

const writeHuffmanSymbol = (writer: DeflateBitWriter, codes: Int32Array<ArrayBuffer>, symbol: number): void => {
  const code = codes[symbol];
  if (code === 0) writeHuffmanSymbolFail();
  writer.writeBits(code & 0xffff, code >>> 16);
};
const writeHuffmanSymbolFail = (): never => { throw new RangeError(DEV ? "Missing Huffman code" : E_STRUCTURE); }

// Run-length-encodes the combined code-length sequence into the CL_TOKEN_*
// arrays (symbol/extra/extraBits in parallel) and returns the token count.
// Replaces an array of per-token objects; the caller reads back by index.
const encodeCodeLengths = (lengths: Int32Array<ArrayBuffer>, count: number): number => {
  let n = 0;
  let index = 0;

  while (index < count) {
    const length = lengths[index];
    let run = 1;
    while (index + run < count && lengths[index + run] === length) run++;
    index += run; // advance now; `run` is free to consume below

    if (length === 0) {
      while (run >= 11) {
        const repeat = min(run, 138);
        CL_TOKEN_SYMBOL[n] = 18; CL_TOKEN_EXTRA[n] = repeat - 11; CL_TOKEN_EXTRABITS[n] = 7; n++;
        run -= repeat;
      }
      if (run >= 3) {
        CL_TOKEN_SYMBOL[n] = 17; CL_TOKEN_EXTRA[n] = run - 3; CL_TOKEN_EXTRABITS[n] = 3; n++;
        run = 0;
      }
    } else {
      CL_TOKEN_SYMBOL[n] = length; CL_TOKEN_EXTRA[n] = 0; CL_TOKEN_EXTRABITS[n] = 0; n++;
      run--;
      while (run >= 3) {
        const repeat = min(run, 6);
        CL_TOKEN_SYMBOL[n] = 16; CL_TOKEN_EXTRA[n] = repeat - 3; CL_TOKEN_EXTRABITS[n] = 2; n++;
        run -= repeat;
      }
    }
    // shared tail: emit leftover singles as `length` (which is 0 in the zero branch)
    while (run-- > 0) { CL_TOKEN_SYMBOL[n] = length; CL_TOKEN_EXTRA[n] = 0; CL_TOKEN_EXTRABITS[n] = 0; n++; }
  }

  return n;
};

const deflateStoredRaw = (input: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  const blocks = max(1, ceil(input.length / UINT16_LIMIT));
  const out = new Uint8Array_(input.length + blocks * 5);
  let inputOffset = 0;
  let outputOffset = 0;

  do {
    const length = min(UINT16_LIMIT, input.length - inputOffset);
    const final = inputOffset + length >= input.length;
    out[outputOffset++] = final ? 0x01 : 0x00;
    out[outputOffset++] = length & 0xff;
    out[outputOffset++] = length >>> 8;
    out[outputOffset++] = (~length) & 0xff;
    out[outputOffset++] = ((~length) >>> 8) & 0xff;
    out.set(input.subarray(inputOffset, inputOffset + length), outputOffset);
    inputOffset += length;
    outputOffset += length;
  } while (inputOffset < input.length);

  return out;
};

const inflateRaw = async (input: Uint8Array<ArrayBuffer>, size: number, maxBytes?: number): Promise<Uint8Array<ArrayBuffer>> => {
  const StreamCtor = DecompressionStream_;
  if (!StreamCtor) throw new DOMException(DEV ? "DecompressionStream is not available in this runtime" : E_UNSUPPORTED, ERR_NOT_SUPPORTED);
  let decompressor: ReadableStream<Uint8Array<ArrayBuffer>>;
  try {
    const stream = new ReadableStream_<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(input);
        controller.close();
      }
    });
    // Only the construction of the transform can fail for a "feature unsupported"
    // reason; that is the single case that should be reported as NotSupported.
    // Compat builds accept the internal second argument and enforce it inside the
    // pure-JS inflater; native DecompressionStream ignores the extra argument.
    const BoundedStreamCtor = StreamCtor as typeof DecompressionStream & { new(format: string, maxBytes?: number): DecompressionStream };
    decompressor = stream.pipeThrough(new BoundedStreamCtor("deflate-raw", maxBytes)) as ReadableStream<Uint8Array<ArrayBuffer>>;
  } catch (error) {
    throw new DOMException(DEV ? `DecompressionStream does not support deflate-raw: ${error instanceof Error ? error.message : String(error)}` : E_UNSUPPORTED, ERR_NOT_SUPPORTED);
  }
  let output: Uint8Array<ArrayBuffer>;
  try {
    output = await readStream(decompressor, undefined, undefined, maxBytes);
  } catch (error) {
    // Surface the cap breach unchanged; everything else here is the deflate
    // stream rejecting mid-inflate, i.e. corrupt/truncated compressed data —
    // distinct from the runtime lacking deflate-raw support above.
    if (error instanceof RangeError) throw error;
    throw new Error(DEV ? `Corrupt DEFLATE stream: ${error instanceof Error ? error.message : String(error)}` : E_INFLATE);
  }
  if (output.length !== size) throw new Error(DEV ? `Inflated size mismatch: expected ${size}, got ${output.length}` : E_INFLATE);
  return output;
};

class DeflateBitWriter {
  private out: Uint8Array<ArrayBuffer>;
  private offset = 0;
  private bitBuffer = 0;
  private bitCount = 0;

  constructor(inputSize: number) {
    const need = max(64, inputSize + (inputSize >>> 3) + 1024);
    if (deflateOutBuffer.length < need) deflateOutBuffer = new Uint8Array_(need);
    this.out = deflateOutBuffer;
  }

  writeBits(value: number, count: number): void {
    // Hot path: hoist state to locals and do a single capacity check per call
    // instead of a call + bounds check per emitted byte. Output is
    // byte-identical to the per-byte version.
    let buffer = this.bitBuffer | (value << this.bitCount);
    let bits = this.bitCount + count;
    if (bits >= 8) {
      let offset = this.offset;
      let out = this.out;
      if (offset + 4 > out.length) {
        const next = new Uint8Array_(out.length * 2);
        next.set(out);
        this.out = out = deflateOutBuffer = next;
      }
      do {
        out[offset++] = buffer & 0xff;
        buffer >>>= 8;
        bits -= 8;
      } while (bits >= 8);
      this.offset = offset;
    }
    this.bitBuffer = buffer;
    this.bitCount = bits;
  }

  finish(): Uint8Array<ArrayBuffer> {
    if (this.bitCount > 0) this.pushByte();
    return this.out.slice(0, this.offset);
  }

  pendingBits(): number {
    return this.bitCount;
  }

  alignToByte(): void {
    if (this.bitCount > 0) this.pushByte();
  }

  writeBytes(bytes: Uint8Array<ArrayBuffer>): void {
    const required = this.offset + bytes.length;
    if (required > this.out.length) {
      let size = this.out.length;
      do { size *= 2; } while (size < required);
      const next = new Uint8Array_(size);
      next.set(this.out);
      this.out = deflateOutBuffer = next;
    }
    this.out.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  private pushByte(): void {
    if (this.offset === this.out.length) {
      const next = new Uint8Array_(this.out.length * 2);
      next.set(this.out);
      this.out = deflateOutBuffer = next;
    }
    const byte = this.bitBuffer & 0xff;
    this.out[this.offset++] = byte;
    this.bitBuffer = 0;
  }
}

// Insert `position` into the hash chain and find the best match at it.
// Returns a packed result (distance << 9) | length, or 0 when no match.
const insertAndFindMatch = (
  input: Uint8Array<ArrayBuffer>,
  position: number,
  head: Int32Array<ArrayBuffer>,
  previous: Int32Array<ArrayBuffer>,
  niceLength: number,
  maxChain: number,
  inputLength: number
): number => {
  if (position + 4 > inputLength) return 0; // need 4 bytes for the hash
  const hash = hashBytes(input, position);
  const candidate = head[hash];
  previous[position & WINDOW_MASK] = candidate;
  head[hash] = position;
  return findMatch(input, position, candidate, previous, niceLength, maxChain, inputLength);
};

const insertString = (input: Uint8Array<ArrayBuffer>, position: number, head: Int32Array<ArrayBuffer>, previous: Int32Array<ArrayBuffer>): void => {
  const hash = hashBytes(input, position);
  previous[position & WINDOW_MASK] = head[hash];
  head[hash] = position;
};

// Walk the hash chain starting at `candidate`. Allocation-free: the result is
// packed into a single integer so the hot loop never touches the heap.
const findMatch = (
  input: Uint8Array<ArrayBuffer>,
  position: number,
  candidate: number,
  previous: Int32Array<ArrayBuffer>,
  niceLength: number,
  maxChain: number,
  inputLength: number
): number => {
  let end = MAX_MATCH;
  const available = inputLength - position;
  if (available < end) end = available;
  if (end < MIN_MATCH) return 0;

  let bestLength = 0;
  let bestDistance = 0;

  while (candidate >= 0 && candidate < position && position - candidate <= WINDOW_SIZE && maxChain-- > 0) {
    if (
      input[candidate + bestLength] === input[position + bestLength] &&
      input[candidate] === input[position] &&
      input[candidate + 1] === input[position + 1] &&
      input[candidate + 2] === input[position + 2]
    ) {
      let length = MIN_MATCH;
      while (length < end && input[candidate + length] === input[position + length]) length++;
      if (length > bestLength) {
        bestLength = length;
        bestDistance = position - candidate;
        // Stop searching once the match is "good enough" (nice length) or maximal;
        // the match itself is never truncated below its true length.
        if (length >= niceLength || length === end) break;
      }
    }
    candidate = previous[candidate & WINDOW_MASK];
  }

  return bestLength >= MIN_MATCH ? (bestDistance << 9) | bestLength : 0;
};

const hashBytes = (input: Uint8Array<ArrayBuffer>, position: number): number => {
  // 4-byte multiplicative (Fibonacci) hash. The previous 3-byte xor hash put far
  // too many unrelated positions into each chain, so the match search wasted most
  // of its steps on candidates that did not even share 3 bytes. Hashing 4 bytes
  // makes each chain hold mostly real, extendable candidates, so the search finds
  // long matches in a fraction of the steps -- this is what lets us reach (and
  // beat) lazy-matching's ratio at greedy-matching's speed. 3-byte-only matches
  // whose 4th byte differs become unfindable, but those are almost never worth
  // emitting anyway (a far 3-byte match costs about as many bits as 3 literals).
  const v = (input[position] << 24) | (input[position + 1] << 16) | (input[position + 2] << 8) | input[position + 3];
  // >>> 16 takes the top 16 bits of the multiplicative hash for a 64K table. A
  // larger table than the old 32K one spreads the 4-byte keys across more chains,
  // so each hash chain is shorter and the match search does measurably fewer
  // steps -- a few % faster at byte-identical output (it finds the same matches).
  return imul(v, 2654435761) >>> (32 - HASH_BITS);
};

const readStream = async (stream: ReadableStream<Uint8Array<ArrayBuffer>>, signal?: AbortSignal, onProgress?: (loaded: number, total?: number) => void, limit?: number): Promise<Uint8Array<ArrayBuffer>> => {
  const reader = stream.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.[throwIfAborted_]();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      // Bounded reading: stop as soon as the cap is exceeded instead of
      // materializing the whole (potentially hostile) output first.
      if (limit !== undefined && total > limit) throw new RangeError(DEV ? `Stream exceeds limit of ${limit} bytes` : E_LIMIT);
      onProgress?.(total);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  return concat(chunks, total);
};

const bytesToStream = (bytes: Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>): ReadableStream<Uint8Array<ArrayBuffer>> => {
  return new ReadableStream_({
    async start(controller) {
      controller.enqueue(await bytes);
      controller.close();
    }
  });
};

const normalizePath = (path: string, dir = false): string => {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  return dir && !normalized.endsWith("/") ? `${normalized}/` : normalized;
};

const applyPathMode = (path: string, mode: ZipPathMode): string => {
  if (mode === "unsafe") return path;
  const sanitized = sanitizeZipPath(path);
  if ((mode === "strict" || mode === "strict-package") && (isUnsafeZipPath(path) || sanitized !== normalizePath(path, path.endsWith("/")))) {
    throw new DOMException(DEV ? `Unsafe ZIP entry path: ${path}` : E_PATH, ERR_SECURITY);
  }
  if (!sanitized) throw new DOMException(DEV ? `Unsafe ZIP entry path: ${path}` : E_PATH, ERR_SECURITY);
  return sanitized;
};

// Write-side path policy. Input is already legacy-normalized (backslashes -> "/",
// leading "/" stripped). "unsafe" (the default) keeps that legacy behavior so
// existing callers are unaffected; "strict" rejects anything the default reader
// would refuse (".." segments, drive-letter roots); "sanitize" drops those
// unsafe components, guaranteeing the written path round-trips through openZip.
const applyWritePathMode = (path: string, mode: ZipPathMode): string => {
  if (mode === "strict" || mode === "strict-package") {
    if (isUnsafeZipPath(path)) throw new DOMException(DEV ? `Unsafe ZIP entry path: ${path}` : E_PATH, ERR_SECURITY);
    return path;
  }
  if (mode === "sanitize") {
    const sanitized = sanitizeZipPath(path);
    if (!sanitized) throw new DOMException(DEV ? `Unsafe ZIP entry path: ${path}` : E_PATH, ERR_SECURITY);
    return sanitized;
  }
  return path;
};

const isUnsafeZipPath = (path: string): boolean => {
  const normalized = path.replace(/\\/g, "/");
  return path.includes("\\") || path.includes("\u0000") || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.split("/").some((part) => part === "..");
};

const sanitizeZipPath = (path: string): string => {
  const normalized = path.replace(/\\/g, "/").replace(/\u0000/g, "").replace(/^[a-zA-Z]:\/*/, "").replace(/^\/+/, "");
  const isDir = normalized.endsWith("/");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") continue;
    parts.push(part);
  }
  return parts.length ? `${parts.join("/")}${isDir ? "/" : ""}` : "";
};

// Validates an explicit `unixPermissions`: it must be an integer in the
// three-octal-digit range 0o000..0o777 (the standard rwx triplets). Any
// combination within that range is allowed — POSIX does not forbid one — so only
// the type and range are checked. Out-of-range values (e.g. setuid/sticky bits in
// 0o7000, or non-integers) throw before any work is done. Unix permissions are
// only meaningful alongside a Unix-host advertisement, which JSZipp ties to the
// Unix Extended Timestamp; setting them while the Unix timestamp mode is off
// would record a Unix mode the archive does not advertise, so that is rejected.
const validateUnixPermissions = (perms: number | undefined, timestamps: TimestampMode): void => {
  if (perms === undefined) return;
  if (!isInteger(perms) || perms < 0 || perms > UNIX_PERM_MAX) {
    throw new RangeError(DEV ? "meta.unixPermissions must be a 3-digit octal value from 0o000 to 0o777" : E_PERM);
  }
  if ((timestamps & TimestampMode.Unix) === 0) {
    throw new RangeError(DEV ? "meta.unixPermissions requires the Unix timestamp mode (timestamps must include TimestampMode.Unix)" : E_PERM);
  }
};

// Validates an explicit `dosAttributes`: the MS-DOS attribute byte the caller may
// set (0x00..0xff). DOS attributes suit a DOS or NTFS host but would confuse
// Unix-oriented tools, so they are rejected when the Unix timestamp mode is
// active WITHOUT the NTFS flag (dos+unix); they are allowed for dos-only,
// dos+ntfs, and dos+unix+ntfs. The directory bit (0x10) encodes the file/folder
// distinction, so it must agree with the entry's actual kind — a mismatch is
// rejected rather than silently corrected.
const validateDosAttributes = (attrs: number | undefined, timestamps: TimestampMode, isDirectory: boolean): void => {
  if (attrs === undefined) return;
  if (!isInteger(attrs) || attrs < 0 || attrs > DOS_ATTR_MAX) {
    throw new RangeError(DEV ? "meta.dosAttributes must be an integer from 0x00 to 0xff" : E_ATTR);
  }
  if ((timestamps & TimestampMode.Unix) !== 0 && (timestamps & TimestampMode.Ntfs) === 0) {
    throw new RangeError(DEV ? "meta.dosAttributes is not allowed with the Unix timestamp mode unless the NTFS flag is also set" : E_ATTR);
  }
  if (((attrs & DOS_DIRECTORY) !== 0) !== isDirectory) {
    throw new RangeError(DEV ? "meta.dosAttributes directory bit (0x10) must match the entry type (set for directories, clear for files)" : E_ATTR);
  }
};
// `unixPermissions` (already range-checked by validateUnixPermissions) is used
// as-is; when omitted, the default is 0o755 for directories and 0o644 for regular
// files. The file-type bits (S_IFDIR/S_IFREG) are OR-ed in by the caller, so this
// returns only the permission portion.
const unixPermissionsFor = (perms: number | undefined, isDirectory: boolean): number =>
  perms ?? (isDirectory ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE);

// Whether to record Unix store permissions (and advertise the Unix host) for an
// entry. Triggered by an explicit `unixPermissions`, or by the presence of a
// Unix Extended Timestamp (`0x5455`) — either added by the active `timestamps`
// flags or already carried in the caller-supplied extra field.
const shouldEmitUnixPermissions = (meta: ZipEntryMeta | undefined, timestamps: TimestampMode, extraField: Uint8Array<ArrayBuffer>): boolean =>
  meta?.unixPermissions !== undefined
  || (timestamps & TimestampMode.Unix) !== 0
  || hasExtraField(extraField, EXTENDED_TIMESTAMP_EXTRA_ID);

const externalAttributesFor = (meta: ZipEntryMeta | undefined, isDirectory: boolean, emitUnixPermissions: boolean): number => {
  // Raw escape hatch: an explicit external-attributes value wins outright.
  if (meta?.externalAttributes !== undefined) return meta.externalAttributes >>> 0;
  // Low byte: caller-supplied DOS attribute bits OR the directory bit for the
  // entry kind. When dosAttributes is supplied its directory bit is already
  // validated to match isDirectory, so the OR is a no-op there; when it is
  // omitted, the OR supplies the directory bit for directory entries.
  const dosLow = (((meta?.dosAttributes ?? 0) | (isDirectory ? DOS_DIRECTORY : 0)) & 0xff) >>> 0;
  if (!emitUnixPermissions) return dosLow;
  // High 16 bits: a Unix mode synthesized from the store permission bits and the
  // file-type bits implied by the entry kind.
  const mode = (isDirectory ? S_IFDIR : S_IFREG) | unixPermissionsFor(meta?.unixPermissions, isDirectory);
  return (((mode & 0xffff) << 16) | dosLow) >>> 0;
};

// Rejects entries whose timestamps are invalid (not a real Date / NaN), negative
// (before the Unix epoch — the writer's UTC extras cannot represent pre-1970
// times, and the DOS fields start in 1980), or causally impossible (modified or
// last-accessed before creation). The causal checks only apply once `createdAt`
// is present and the compared timestamp is too.
const validateEntryTimes = (modifiedAt: Date, createdAt: Date | undefined, lastAccess: Date | undefined): void => {
  validateTimestamp(modifiedAt, "modifiedAt");
  if (createdAt !== undefined) validateTimestamp(createdAt, "createdAt");
  if (lastAccess !== undefined) validateTimestamp(lastAccess, "lastAccess");
  if (createdAt === undefined) return;
  const created = createdAt.getTime();
  if (modifiedAt.getTime() < created) throw new RangeError(DEV ? "meta.modifiedAt must not be earlier than meta.createdAt" : E_TIME);
  if (lastAccess !== undefined && lastAccess.getTime() < created) throw new RangeError(DEV ? "meta.lastAccess must not be earlier than meta.createdAt" : E_TIME);
};

// A single entry timestamp must be a valid Date with a non-negative epoch value.
const validateTimestamp = (date: Date, name: string): void => {
  const time = date.getTime();
  if (!isFinite(time) || time < 0) throw new RangeError(DEV ? `meta.${name} must be a valid Date on or after 1970-01-01` : E_TIME);
};

const concat = (chunks: Uint8Array<ArrayBuffer>[], knownTotal?: number): Uint8Array<ArrayBuffer> => {
  const total = knownTotal ?? chunks.reduce((sum, item) => sum + item.length, 0);
  const out: Uint8Array<ArrayBuffer> = new Uint8Array_(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const arrayBufferFromBytes = (bytes: Uint8Array<ArrayBuffer>): ArrayBuffer => {
  // When the view already spans its whole buffer (the common case for freshly
  // built outputs from concat()/inflate), hand the buffer over directly. A
  // partial view (e.g. a subarray into a parsed archive) still copies, so we
  // never expose unrelated bytes or alias shared archive memory.
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const crc32 = (b: Uint8Array<ArrayBuffer>): number => {
  const t = crcTable, n = b.length, lim = n - 8;
  let c = -1, i = 0;
  while (i <= lim) {
    c ^= b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
    c = t[1792 + (c & 255)] ^ t[1536 + (c >>> 8 & 255)] ^ t[1280 + (c >>> 16 & 255)] ^
        t[1024 + (c >>> 24)] ^ t[768 + b[i + 4]] ^ t[512 + b[i + 5]] ^ t[256 + b[i + 6]] ^ t[b[i + 7]];
    i += 8;
  }
  for (; i < n; i++) c = t[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
};

// Builds a single ZIP64 extra field carrying `values` as 64-bit integers, in the
// order the spec expects (uncompressed, compressed, local offset). Callers pass
// only the fields whose regular 32-bit header slot is saturated: the local
// header has no offset field, so its extra omits the offset; the central header
// includes it because writeEntry() saturates its offset slot under ZIP64.
const makeZip64Extra = (values: number[]): Uint8Array<ArrayBuffer> => {
  const dataLength = values.length * 8;
  const out = new Uint8Array_(4 + dataLength);
  const view = new DataView_(out.buffer);
  writeU16(view, 0, ZIP64_EXTRA_ID);
  writeU16(view, 2, dataLength);
  for (let i = 0; i < values.length; i++) writeU64(view, 4 + i * 8, values[i]);
  return out;
};

const parseZip64Extra = (extra: Uint8Array<ArrayBuffer>): number[] => {
  const values: number[] = [];
  const view = dataView(extra);
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = readU16(view, offset);
    const length = readU16(view, offset + 2);
    const start = offset + 4;
    if (id === ZIP64_EXTRA_ID) {
      const limit = start + length;
      if (limit > extra.length) break; // declared length runs past the extra data; treat as absent
      for (let pos = start; pos + 8 <= limit; pos += 8) values.push(readU64(view, pos, "ZIP64 extra field value"));
      return values;
    }
    offset = start + length;
  }
  return values;
};

const bytesEqual = (a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): boolean => {
  if (a.length !== b.length) return false;
  for (let i = a.length; i--; ) if (a[i] !== b[i]) return false;
  return true;
};

// Info-ZIP Unicode Path extra (0x7075): version(1) | crc32(4) of the primary
// header name | UTF-8 name. The CRC binds the override to a specific header
// name, so a stale field (header renamed after creation) is ignored instead of
// trusted. Returns the UTF-8 name only when the CRC matches the header bytes.
const parseUnicodePathExtra = (extra: Uint8Array<ArrayBuffer>, nameBytes: Uint8Array<ArrayBuffer>): string | undefined => {
  const view = dataView(extra);
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = readU16(view, offset);
    const length = readU16(view, offset + 2);
    const start = offset + 4;
    const limit = start + length;
    if (limit > extra.length) return undefined;
    if (id === UNICODE_PATH_EXTRA_ID && length >= 5 && extra[start] === 1) {
      if (readU32(view, start + 1) === crc32(nameBytes)) return textDecoder.decode(extra.subarray(start + 5, limit));
      return undefined; // CRC mismatch: stale field, fall back to the header name.
    }
    offset = limit;
  }
  return undefined;
};

const makeExtendedTimestampExtra = (date: Date): Uint8Array<ArrayBuffer> => {
  const seconds = Math.floor(date.getTime() / 1000);
  if (!isFinite(seconds) || seconds < 0 || seconds > ZIP64_LIMIT) return emptyBytes;
  const out = new Uint8Array_(9);
  const view = new DataView_(out.buffer);
  writeU16(view, 0, EXTENDED_TIMESTAMP_EXTRA_ID);
  writeU16(view, 2, 5);
  out[4] = 1; // mtime is present.
  writeU32(view, 5, seconds);
  return out;
};

// NTFS extra field (0x000a): reserved(4) then a 0x0001 attribute carrying
// mtime/atime/ctime as Windows FILETIME values (100-nanosecond ticks since
// 1601-01-01 UTC). A present-day FILETIME exceeds the 2^53 safe integer range,
// so it is split into 32-bit low/high words with exact integer math (no BigInt,
// which the ES2019 target does not allow) and written as two little-endian
// uint32 values. The 0x0001 attribute orders the times mtime, atime, ctime.
const NTFS_EPOCH_OFFSET_MS = 11644473600000; // ms between 1601-01-01 and 1970-01-01
const writeFileTime = (view: DataView_, offset: number, date: Date): void => {
  const epochMs = date.getTime();
  // ticks = (ms since 1601) * 10000, kept exact via base-2^32 decomposition.
  const ms = (isFinite(epochMs) ? epochMs : 0) + NTFS_EPOCH_OFFSET_MS;
  const msHigh = Math.floor(ms / 0x100000000);
  const msLow = ms % 0x100000000;
  const productLow = msLow * 10000; // <= 4.29e13, within safe-integer range
  const ftLow = productLow % 0x100000000;
  const carry = Math.floor(productLow / 0x100000000);
  const ftHigh = msHigh * 10000 + carry; // < 2^32 for any representable Date
  view.setUint32(offset, ftLow >>> 0, true);
  view.setUint32(offset + 4, ftHigh >>> 0, true);
};
const makeNtfsTimestampExtra = (modifiedAt: Date, createdAt: Date, lastAccess: Date): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array_(36);
  const view = new DataView_(out.buffer);
  writeU16(view, 0, NTFS_EXTRA_ID);
  writeU16(view, 2, 32); // reserved(4) + tag(2) + size(2) + 3 * 8
  // bytes 4..7 reserved, left zero
  writeU16(view, 8, 1); // attribute tag 0x0001
  writeU16(view, 10, 24); // mtime + atime + ctime
  writeFileTime(view, 12, modifiedAt);
  writeFileTime(view, 20, lastAccess);
  writeFileTime(view, 28, createdAt);
  return out;
};

// Convert a FILETIME pair back to a Date. The 64-bit tick count is read as a
// float (lo + hi * 2^32); the resulting precision loss is far below one
// millisecond, so the reconstructed Date is exact at millisecond resolution. A
// zero FILETIME means the slot is unset and yields undefined.
const fileTimeToDate = (view: DataView_, offset: number): Date | undefined => {
  const lo = readU32(view, offset);
  const hi = readU32(view, offset + 4);
  if (lo === 0 && hi === 0) return undefined;
  const ticks = hi * 0x100000000 + lo;
  return new Date(ticks / 10000 - NTFS_EPOCH_OFFSET_MS);
};

// Parse the NTFS extra field's 0x0001 attribute. Returns mtime/atime/ctime when
// the attribute is present and large enough to hold all three FILETIMEs; each
// field is undefined when its FILETIME is zero (unset).
const parseNtfsTimestampExtra = (extra: Uint8Array<ArrayBuffer>): { modifiedAt?: Date; lastAccess?: Date; createdAt?: Date } | undefined => {
  const view = dataView(extra);
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = readU16(view, offset);
    const length = readU16(view, offset + 2);
    const start = offset + 4;
    const limit = start + length;
    if (limit > extra.length) return undefined;
    if (id === NTFS_EXTRA_ID) {
      let tagOffset = start + 4; // skip the 4-byte reserved field
      while (tagOffset + 4 <= limit) {
        const tag = readU16(view, tagOffset);
        const size = readU16(view, tagOffset + 2);
        const tagStart = tagOffset + 4;
        if (tag === 1 && size >= 24 && tagStart + 24 <= limit) {
          return {
            modifiedAt: fileTimeToDate(view, tagStart),
            lastAccess: fileTimeToDate(view, tagStart + 8),
            createdAt: fileTimeToDate(view, tagStart + 16)
          };
        }
        tagOffset = tagStart + size;
      }
      return undefined;
    }
    offset = limit;
  }
  return undefined;
};

const parseExtendedTimestampExtra = (extra: Uint8Array<ArrayBuffer>): Date | undefined => {
  const view = dataView(extra);
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = readU16(view, offset);
    const length = readU16(view, offset + 2);
    const start = offset + 4;
    const limit = start + length;
    if (limit > extra.length) return undefined;
    if (id === EXTENDED_TIMESTAMP_EXTRA_ID && length >= 5 && (extra[start] & 1) !== 0) {
      return new Date(readU32(view, start + 1) * 1000);
    }
    offset = limit;
  }
  return undefined;
};

const hasExtraField = (extra: Uint8Array<ArrayBuffer>, fieldId: number): boolean => {
  const view = dataView(extra);
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = readU16(view, offset);
    const length = readU16(view, offset + 2);
    const next = offset + 4 + length;
    if (next > extra.length) return false;
    if (id === fieldId) return true;
    offset = next;
  }
  return false;
};

// Pack a Date into the MS-DOS / FAT timestamp pair.
//   date = 7b (year-1980) | 4b month | 5b day
//   time = 5b hours | 6b minutes | 5b (seconds >> 1)
// ZIP's legacy DOS fields have no timezone. Store local wall-clock fields for
// compatibility with legacy tools; the 0x5455 extra field carries the UTC
// instant for readers that understand it.
// The year field is 7 bits, so it is clamped to 1980..2107; without the upper
// clamp a later year would overflow into the month bits and corrupt the date.
const dosDateTime = (d: Date) => ({
  date: (min(127, max(0, d.getFullYear() - 1980)) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
});

const fromDosDateTime = (date: number, time: number) => new Date(
  ((date >>> 9) & 0x7f) + 1980,
  (((date >>> 5) & 0x0f) || 1) - 1, // month 0 (empty entry) -> January, never -1
  (date & 0x1f) || 1,               // day 0 (empty entry) -> 1st, never roll back
  (time >>> 11) & 0x1f,
  (time >>> 5) & 0x3f,
  (time & 0x1f) << 1,
);

// Coordinates of the central directory that an EOCD record describes, with the
// `anchor` being the offset where the trailing EOCD records begin and thus where
// the central directory must end: the EOCD itself for legacy archives, or the
// Zip64 EOCD record (via the locator) for Zip64 archives. Throws with a precise
// message on structural problems so parseZip can surface them to the caller.
interface EocdLocation {
  entries: number;
  centralOffset: number;
  centralSize: number;
  anchor: number;
}

const resolveEocd = (view: DataView_, bytes: Uint8Array<ArrayBuffer>, eocdOffset: number): EocdLocation => {
  let entries = readU16(view, eocdOffset + 10);
  let centralSize = readU32(view, eocdOffset + 12);
  let centralOffset = readU32(view, eocdOffset + 16);
  let anchor = eocdOffset;

  if (entries === UINT16_LIMIT || centralSize === ZIP64_LIMIT || centralOffset === ZIP64_LIMIT) {
    const locatorOffset = eocdOffset - 20;
    if (locatorOffset < 0 || readU32(view, locatorOffset) !== 0x07064b50) throw new Error(DEV ? "ZIP64 locator is missing" : E_ZIP64);
    const zip64Offset = readU64(view, locatorOffset + 8, "ZIP64 EOCD offset");
    ensureRange(bytes.length, zip64Offset, 56, "ZIP64 EOCD record");
    if (readU32(view, zip64Offset) !== 0x06064b50) throw new Error(DEV ? "ZIP64 EOCD record is invalid" : E_ZIP64);
    entries = readU64(view, zip64Offset + 32, "ZIP64 entry count");
    centralSize = readU64(view, zip64Offset + 40, "ZIP64 central directory size");
    centralOffset = readU64(view, zip64Offset + 48, "ZIP64 central directory offset");
    anchor = zip64Offset;
  }

  ensureRange(bytes.length, centralOffset, centralSize, "central directory");
  return { entries, centralOffset, centralSize, anchor };
};

// Counts the central records an EOCD candidate truly describes, or -1 if it is
// not structurally coherent. A coherent candidate must resolve (Zip64 included),
// its central directory must end exactly where the trailing EOCD/Zip64 records
// begin, and the declared range must parse as exactly the declared number of
// records consuming exactly the declared size. The count is returned (not just a
// boolean) because emptiness is self-consistent at any offset: a fake EOCD in a
// comment can always describe an empty directory anchored to itself, so the only
// robust discriminator is to prefer the candidate backed by real records.
//
// `budget` caps the total central records walked across ALL candidates in one
// findEocd scan (see there). A budget-exhausted walk returns -1 -- identical to
// a structurally-failed walk -- so the only candidate whose result it can change
// is a content-bearing one sitting behind heavy failed walks, i.e. a crafted
// CDH-filled tail. That bounds an otherwise O(candidates * entries) scan.
const coherentEntryCount = (view: DataView_, bytes: Uint8Array<ArrayBuffer>, eocdOffset: number, budget: { n: number }): number => {
  let location: EocdLocation;
  try {
    location = resolveEocd(view, bytes, eocdOffset);
  } catch {
    return -1;
  }
  const { entries, centralOffset, centralSize, anchor } = location;
  if (centralOffset + centralSize !== anchor) return -1;

  const end = centralOffset + centralSize;
  let cursor = centralOffset;
  let count = 0;
  while (count < entries && cursor < end) {
    if (budget.n <= 0) return -1;
    budget.n--;
    if (cursor + 46 > end || readU32(view, cursor) !== 0x02014b50) return -1;
    cursor += 46 + readU16(view, cursor + 28) + readU16(view, cursor + 30) + readU16(view, cursor + 32);
    count++;
  }
  return count === entries && cursor === end ? entries : -1;
};

const findEocd = (bytes: Uint8Array<ArrayBuffer>): number => {
  const view = dataView(bytes);
  const start = bytes.length - 22;
  const min = max(0, start - UINT16_LIMIT);
  // Walk every EOCD signature in the bounded tail region, newest (closest to
  // EOF) first, and select comparatively by content rather than by position.
  // An archive that actually contains records must win over a degenerate empty
  // record, which defeats both a fake EOCD embedded in the comment (an extra
  // signature) and a fake EOCD appended after a complete archive (which pushes
  // the real one off end-of-file): the genuine, content-bearing central
  // directory is still chosen. A coherent-but-empty record is accepted only
  // when nothing carries records (a genuinely empty archive); failing that, the
  // signature nearest EOF is returned so a malformed archive still reaches
  // parseZip's precise error instead of a vague "not found".
  let empty = -1;
  let nearest = -1;
  // Total central records any single legitimate directory can hold (each is >=46
  // bytes). Shared across every candidate so a crafted tail full of EOCD/CDH
  // signatures cannot turn the scan into O(candidates * entries); the genuine
  // candidate is always reached with this intact because real fakes ahead of it
  // (empty or incoherent) walk no records.
  const budget = { n: ((bytes.length / 46) | 0) + 1 };
  for (let j = start; j >= min; j--) {
    if (readU32(view, j) !== 0x06054b50) continue;
    const atEof = j + 22 + readU16(view, j + 20) === bytes.length;
    if (nearest < 0 && atEof) nearest = j;
    const count = coherentEntryCount(view, bytes, j, budget);
    if (count > 0) return j;
    if (count === 0 && atEof && empty < 0) empty = j;
  }
  if (empty >= 0) return empty;
  if (nearest >= 0) return nearest;
  throw new Error(DEV ? "End of central directory not found" : E_STRUCTURE);
};

const dataView = (bytes: Uint8Array<ArrayBuffer>): DataView_ => {
  return new DataView_(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

// Guards an [offset, offset+size) window against the byte length before a
// structured read. Offsets and sizes here come from the archive itself, so a
// malformed or hostile ZIP can point them anywhere; this turns that into a
// controlled error instead of a DataView RangeError or a clamped subarray that
// silently yields wrong bytes. Called only at structural boundaries, not inside
// the read wrappers, so the hot paths stay branch-free.
const ensureRange = (length: number, offset: number, size: number, label: string): void => {
  if (!isSafeInteger(offset) || !isSafeInteger(size) || offset < 0 || size < 0 || offset + size > length) {
    throw new Error(DEV ? `${label} is outside ZIP bounds` : E_BOUNDS);
  }
};

const readU16 = (view: DataView_, offset: number): number => {
  return view.getUint16(offset, true);
};

const readU32 = (view: DataView_, offset: number): number => {
  return view.getUint32(offset, true);
};

const readU64 = (view: DataView_, offset: number, label: string): number => {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  const value = high * 0x100000000 + low;
  if (value > Number.MAX_SAFE_INTEGER) readU64Fail(label);
  return value;
};
const readU64Fail = (label: string): never => { throw new Error(DEV ? `${label} exceeds JavaScript safe integer range` : E_ZIP64); };

const writeU16 = (view: DataView_, offset: number, value: number): void => {
  view.setUint16(offset, value, true);
};

const writeU32 = (view: DataView_, offset: number, value: number): void => {
  view.setUint32(offset, value >>> 0, true);
};

const writeU64 = (view: DataView_, offset: number, value: number): void => {
  if (!isSafeInteger(value) || value < 0) failU64();
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, (value / 0x100000000) >>> 0, true);
};
const failU64 = (): never => { throw new Error(DEV ? "ZIP64 value must be a safe non-negative integer" : E_ZIP64); };

const requiredZip64 = (value: number | undefined, label: string): number => {
  if (value === undefined) requiredZip64Fail(label);
  return value as number;
};
const requiredZip64Fail = (label: string): never => { throw new Error(DEV ? `${label} is missing` : E_ZIP64); };

const CP437 = [..."ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "];
