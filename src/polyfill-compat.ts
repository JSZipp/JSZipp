// Shared compat surface for the CR61FF58 and CR86FF68 builds. The only thing
// those two targets differ on is AbortController (Chrome 61 lacks the base
// class; every other target has it), so that one binding is supplied by the
// per-target entry modules and everything else lives here.
//
// This module is bundled ONLY into the compat artifacts. The modern build
// resolves "./polyfill" to polyfill.ts (native passthrough) and never imports
// these classes, so the dependency-free guarantee for the modern bundle is
// preserved.
//
// Web Streams are provided by the hand-written family below instead of
// web-streams-polyfill. The dependency pulled the entire spec (queuing
// strategies, BYOB readers, async-iterator helpers, tee, the full WritableStream
// state machine) into every compat bundle — ~70 KB minified — when the library
// drives only a thin slice of the surface. The implementation here covers
// exactly that slice (see ReadableStreamPoly) and forms a single self-consistent
// family so a polyfill ReadableStream can pipeThrough a polyfill TransformStream
// (DecompressionStreamPoly extends TransformStream_) — the interop the native
// classes refuse across the polyfill boundary, and the reason these are used
// uniformly in compat builds even where a native class exists.

// --- Old-browser primitives ----------------------------------------------------
// `globalThis` itself shipped in Chrome 71 / Firefox 65, so it is ABSENT on the
// CR61FF58 floor (Chrome 61 / Firefox 58) and referencing it bare would throw
// ReferenceError before any feature detection runs. `self` exists in every browser
// context (window + workers) far below that floor; the chain degrades to `window`
// and finally an empty object so feature-detect reads return undefined instead of
// throwing. `typeof x` on an undeclared name is itself safe, and there is no
// eval/Function, so this is CSP-safe. Exported so the per-target entry modules
// (which also read globals like AbortController) share one stand-in.
export const glob: typeof globalThis =
  (typeof globalThis !== "undefined" ? globalThis
    : typeof self !== "undefined" ? self
      : typeof window !== "undefined" ? window
        : {}) as typeof globalThis;

// The async-iteration symbol shipped in Chrome 63 / Firefox 57, so it is undefined
// on Chrome 61. SWC's downleveled async-generator/for-await helpers key iterators
// as `Symbol.asyncIterator || "@@asyncIterator"`; mirroring that exact fallback
// here keeps a polyfill stream async-iterable under the SAME key the downleveled
// `for await` looks up, so iterating one works on Chrome 61 without polluting the
// global Symbol. On modern engines it is the real symbol and native `for await`
// finds it. (Typed as symbol so it is a valid computed member key.)
const ASYNC_ITERATOR = ((typeof Symbol === "function" && Symbol.asyncIterator) || "@@asyncIterator") as symbol;

// --- Web Streams (minimal WHATWG family) ---------------------------------------
// State tags shared by the readable/writable machines: 0 = active, 1 = closed,
// 2 = errored. Kept as integers so the minifier can fold the comparisons.
type ReadResult<T> = { done: boolean; value: T | undefined };
// One shared end-of-stream result. read() results are only ever destructured by
// the library (never stored or mutated), so a frozen singleton is safe and saves
// an allocation on every stream end.
const DONE = { done: true, value: undefined } as ReadResult<never>;

interface ReadableController<T> {
  enqueue(chunk: T): void;
  close(): void;
  error(reason?: unknown): void;
}
// The library's sources only ever implement `start` (sync for the inflate input
// and writer output, async for bytesToStream) plus, on the input passed to
// readZipStream, an implicit `cancel`. No source uses `pull`/highWaterMark, so
// the queue is unbounded and demand-driven reads simply park until a chunk (or
// close/error) arrives — which also makes start ordering irrelevant.
interface UnderlyingSource<T> {
  start?(controller: ReadableController<T>): void | PromiseLike<void>;
  cancel?(reason?: unknown): void | PromiseLike<void>;
}

class ReadableStreamPoly<T> {
  // Head-indexed queue: dequeue reads q[qh] and advances qh instead of shift()ing
  // (which is O(n) and turns a large drain into O(n²)). Consumed slots are nulled
  // so chunks are freed as they are read, and the backing array is dropped once
  // fully drained — so a slow consumer never pins already-read chunks. Pending
  // reads can only accumulate while the queue is empty (read drains it first), so
  // a parked reader always observes close/error directly.
  private q: (T | undefined)[] = [];
  private qh = 0;
  private state: 0 | 1 | 2 = 0;
  private err: unknown;
  private waiters: { res(r: ReadResult<T>): void; rej(e: unknown): void }[] = [];
  private locked = false;
  private srcCancel?: (reason?: unknown) => void | PromiseLike<void>;

  constructor(source: UnderlyingSource<T> = {}) {
    this.srcCancel = source.cancel;
    const controller: ReadableController<T> = {
      enqueue: (chunk) => {
        if (this.state !== 0) throw new TypeError("stream is not readable");
        const w = this.waiters.shift();
        if (w) w.res({ done: false, value: chunk });
        else this.q.push(chunk);
      },
      close: () => {
        if (this.state !== 0) return;
        this.state = 1;
        // Buffered chunks are still delivered before done; a parked reader (queue
        // already empty) resolves to done immediately.
        if (this.q.length === this.qh) this.flushWaiters();
      },
      error: (reason) => {
        if (this.state !== 0) return;
        this.state = 2;
        this.err = reason;
        this.clearQueue();
        const pend = this.waiters;
        this.waiters = [];
        for (const w of pend) w.rej(reason);
      },
    };
    // start runs synchronously (so a TransformStream captures its controller before
    // returning); an async start that rejects errors the stream.
    if (source.start) Promise.resolve(source.start(controller)).catch((e) => controller.error(e));
  }

  private clearQueue(): void { this.q = []; this.qh = 0; }

  private flushWaiters(): void {
    const pend = this.waiters;
    this.waiters = [];
    for (const w of pend) w.res(DONE);
  }

  private pull(): Promise<ReadResult<T>> {
    if (this.q.length > this.qh) {
      const value = this.q[this.qh];
      this.q[this.qh++] = undefined; // free the consumed reference
      if (this.qh === this.q.length) this.clearQueue(); // drained: release backing array
      return Promise.resolve({ done: false, value });
    }
    if (this.state === 2) return Promise.reject(this.err);
    if (this.state === 1) return Promise.resolve(DONE);
    return new Promise((res, rej) => this.waiters.push({ res, rej }));
  }

  private doCancel(reason?: unknown): Promise<void> {
    if (this.state === 0) {
      this.state = 1;
      this.clearQueue();
      this.flushWaiters();
    }
    return Promise.resolve(this.srcCancel?.(reason)).then(() => undefined);
  }

  getReader() {
    if (this.locked) throw new TypeError("stream is already locked to a reader");
    this.locked = true;
    let released = false;
    return {
      read: (): Promise<ReadResult<T>> =>
        released ? Promise.reject(new TypeError("reader has been released")) : this.pull(),
      cancel: (reason?: unknown): Promise<void> =>
        released ? Promise.reject(new TypeError("reader has been released")) : this.doCancel(reason),
      releaseLock: () => { if (!released) { released = true; this.locked = false; } },
    };
  }

  cancel(reason?: unknown): Promise<void> {
    if (this.locked) return Promise.reject(new TypeError("cannot cancel a locked stream"));
    return this.doCancel(reason);
  }

  pipeTo(dest: WritableStreamPoly<T>): Promise<void> {
    const reader = this.getReader();
    const writer = dest.getWriter();
    return (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value as T);
        }
        await writer.close();
      } catch (e) {
        await writer.abort(e).catch(() => undefined);
        await reader.cancel(e).catch(() => undefined);
        throw e;
      } finally {
        reader.releaseLock();
        writer.releaseLock();
      }
    })();
  }

  pipeThrough<O>(transform: { writable: WritableStreamPoly<T>; readable: ReadableStreamPoly<O> }): ReadableStreamPoly<O> {
    // The pipe runs in the background; failures surface on transform.readable via
    // the transformer's error path, so the pipe promise itself is swallowed to
    // avoid an unhandled rejection.
    this.pipeTo(transform.writable).catch(() => undefined);
    return transform.readable;
  }

  [ASYNC_ITERATOR](): AsyncIterableIterator<T> {
    const reader = this.getReader();
    return {
      next: () => reader.read() as Promise<IteratorResult<T>>,
      return: (value?: unknown) =>
        reader.cancel(value).then(() => { reader.releaseLock(); return { done: true, value: undefined } as IteratorResult<T>; }),
      [ASYNC_ITERATOR]() { return this; },
    } as unknown as AsyncIterableIterator<T>;
  }
}

interface UnderlyingSink<T> {
  write?(chunk: T): void | PromiseLike<void>;
  close?(): void | PromiseLike<void>;
  abort?(reason?: unknown): void | PromiseLike<void>;
}

// Only ever the writable half of a TransformStream in this library; never
// constructed directly and never piped to a user sink. Writes are serialized by
// the single sequential awaiter in pipeTo, so no internal write queue is needed.
class WritableStreamPoly<T> {
  private state: 0 | 1 | 2 = 0;
  private err: unknown;
  private locked = false;
  constructor(private sink: UnderlyingSink<T> = {}) {}

  private fail(e: unknown): void { if (this.state === 0) { this.state = 2; this.err = e; } }

  getWriter() {
    if (this.locked) throw new TypeError("stream is already locked to a writer");
    this.locked = true;
    let released = false;
    const guard = () => released && Promise.reject(new TypeError("writer has been released"));
    return {
      write: (chunk: T): Promise<void> => {
        const g = guard(); if (g) return g;
        if (this.state === 2) return Promise.reject(this.err);
        if (this.state !== 0) return Promise.reject(new TypeError("stream is not writable"));
        return Promise.resolve(this.sink.write?.(chunk)).then(() => undefined, (e) => { this.fail(e); throw e; });
      },
      close: (): Promise<void> => {
        const g = guard(); if (g) return g;
        if (this.state === 2) return Promise.reject(this.err);
        if (this.state !== 0) return Promise.resolve();
        return Promise.resolve(this.sink.close?.()).then(
          () => { if (this.state === 0) this.state = 1; },
          (e) => { this.fail(e); throw e; },
        );
      },
      abort: (reason?: unknown): Promise<void> => {
        if (released || this.state !== 0) return Promise.resolve();
        this.state = 2; this.err = reason;
        return Promise.resolve(this.sink.abort?.(reason)).then(() => undefined, () => undefined);
      },
      releaseLock: () => { if (!released) { released = true; this.locked = false; } },
    };
  }
}

interface TransformController<O> {
  enqueue(chunk: O): void;
  error(reason?: unknown): void;
  terminate(): void;
}
interface Transformer<I, O> {
  start?(controller: TransformController<O>): void | PromiseLike<void>;
  transform?(chunk: I, controller: TransformController<O>): void | PromiseLike<void>;
  flush?(controller: TransformController<O>): void | PromiseLike<void>;
}

class TransformStreamPoly<I = unknown, O = unknown> {
  readonly readable: ReadableStreamPoly<O>;
  readonly writable: WritableStreamPoly<I>;

  constructor(transformer: Transformer<I, O> = {}) {
    // Capture the readable's controller synchronously (start runs in the
    // ReadableStreamPoly constructor), then route writes through the transformer
    // into it. A transform/flush rejection errors the readable so a downstream
    // reader observes it; pipeTo's abort path covers an upstream failure.
    let rc!: ReadableController<O>;
    const readable = new ReadableStreamPoly<O>({ start(c) { rc = c; } });
    const controller: TransformController<O> = {
      enqueue: (chunk) => rc.enqueue(chunk),
      error: (reason) => rc.error(reason),
      terminate: () => rc.close(),
    };
    const writable = new WritableStreamPoly<I>({
      write: async (chunk) => {
        try {
          if (transformer.transform) await transformer.transform(chunk, controller);
          else rc.enqueue(chunk as unknown as O);
        } catch (e) { rc.error(e); throw e; }
      },
      close: async () => {
        try { await transformer.flush?.(controller); rc.close(); }
        catch (e) { rc.error(e); throw e; }
      },
      abort: (reason) => { rc.error(reason); },
    });
    this.readable = readable;
    this.writable = writable;
    if (transformer.start) Promise.resolve(transformer.start(controller)).catch((e) => rc.error(e));
  }
}

// Web Streams: TransformStream/WritableStream/pipeThrough are missing on
// Firefox < 102 and Chrome < 67, so the streaming writer (ZipTransformStream),
// the default ReadableStream output, and the deflate-read pipeThrough all need a
// real implementation. These classes provide one without touching globals.
export const TransformStream_ = TransformStreamPoly as unknown as typeof TransformStream;
export const ReadableStream_ = ReadableStreamPoly as unknown as typeof ReadableStream;
// Not used by the library today, but exposed so a future sink-based writer can
// reference WritableStream_ without touching this module. Tree-shaken out unless
// index.ts actually uses it.
export const WritableStream_ = WritableStreamPoly as unknown as typeof WritableStream;

// DecompressionStream_ is defined at the bottom of this module, after the
// DEFLATE polyfill it depends on (native when present, polyfill otherwise).

// Used by the writer to detect a ReadableStream payload. On Firefox 65+ / Chrome
// 43+ the user may pass a native ReadableStream even though we construct ponyfill
// ones internally, so accept both classes.
const NativeReadableStream = glob.ReadableStream as typeof ReadableStream | undefined;
export const isReadableStream_ = (x: unknown): x is ReadableStream =>
  x instanceof ReadableStreamPoly || (NativeReadableStream !== undefined && x instanceof NativeReadableStream);

// False for the compat builds: the writer's output is a polyfilled ReadableStream,
// and the native Response constructor brand-checks for a REAL ReadableStream. A
// poly stream fails that check and is coerced to a USVString — `new Response(poly)`
// silently yields a body of the literal text "[object Object]" rather than the
// archive bytes. So the writer must drain the poly stream to bytes and build the
// Blob/Response from those instead (index.ts gates on this constant). The check
// folds at build time, so the modern build keeps the direct streaming path.
export const responseAcceptsStream_ = false;

// --- Blob.arrayBuffer / AbortSignal.throwIfAborted, via a private member key ----
// Both `Blob.prototype.arrayBuffer()` (Chrome 76 / Firefox 69) and
// `AbortSignal.prototype.throwIfAborted()` (Chrome 100 / Firefox 97) are missing on
// the legacy floors — and the library calls them on USER-supplied objects (openZip
// Blob/File sources, entry payloads, caller-passed abort signals). A subclass can't
// help because those objects are NATIVE instances, not subclass instances. So the
// polyfill must land on the real prototype the user object inherits from.
//
// To do that without changing anything OBSERVABLE on the global, the method is
// installed under a private key. `arrayBuffer_` / `throwIfAborted_` are the keys the
// library indexes with (`blob[arrayBuffer_]()`):
//   * In the MODERN seam (polyfill.ts) they are the native STRING names, so
//     `blob[arrayBuffer_]()` is exactly `blob.arrayBuffer()` and the emitted code is
//     identical to a direct native call — no install needed.
//   * In the COMPAT seam (here) they are a unique Symbol per build. installPolyfills
//     attaches the method on `Blob.prototype` / `AbortSignal.prototype` under that
//     Symbol. Symbol keys are skipped by `for…in` / `Object.keys` / `JSON` and do
//     not shadow the spec method, so the "observable global" is unchanged — a
//     `"arrayBuffer" in Blob.prototype` feature-test still reports the real answer.
// Typed as the native string name so call sites typecheck against the DOM lib; the
// runtime value in this module is a Symbol.
export const arrayBuffer_ = Symbol("jszipp.arrayBuffer") as unknown as "arrayBuffer";
export const throwIfAborted_ = Symbol("jszipp.throwIfAborted") as unknown as "throwIfAborted";

const readBlobBytes = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new glob.FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new DOMException("failed to read Blob", "NotReadableError"));
    reader.readAsArrayBuffer(blob);
  });

// Installs the two methods under the private Symbol keys on the real prototypes, so
// native user objects gain them. Native method is reused as the fast path where the
// engine already has it (e.g. Blob.arrayBuffer on Chrome 86); a fallback is used
// where it does not (Firefox 68, the CR61FF58 floor). Idempotent; runs once at
// module load (via index.ts). On Chrome 61 there is no global AbortSignal base — the
// AbortController poly defines [throwIfAborted_] on its own signal instead, so the
// AbortSignal branch here simply finds nothing to patch and skips.
export const installPolyfills = (): void => {
  const B = glob.Blob;
  if (B) {
    const proto = B.prototype as unknown as Record<PropertyKey, unknown>;
    if (!proto[arrayBuffer_]) {
      proto[arrayBuffer_] = typeof (proto as { arrayBuffer?: unknown }).arrayBuffer === "function"
        ? (proto as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer
        : function (this: Blob): Promise<ArrayBuffer> { return readBlobBytes(this); };
    }
  }
  const S = glob.AbortSignal;
  if (S) {
    const proto = S.prototype as unknown as Record<PropertyKey, unknown>;
    if (!proto[throwIfAborted_]) {
      proto[throwIfAborted_] = typeof (proto as { throwIfAborted?: unknown }).throwIfAborted === "function"
        ? (proto as { throwIfAborted: () => void }).throwIfAborted
        : function (this: AbortSignal & { reason?: unknown }): void {
            if (this.aborted) throw this.reason ?? new DOMException("signal is aborted without reason", "AbortError");
          };
    }
  }
};

// --- DEFLATE (raw) decompression -----------------------------------------------
// A DecompressionStream("deflate-raw") polyfill so the library's single inflateRaw
// code path works unchanged: DecompressionStream_ below resolves to the native
// class when present (Chrome 86 + modern — C++-fast) and to this otherwise
// (Chrome 61 / Firefox 58 / Firefox 68).
//
// The inflater is LUT-based (one bit-reversed lookup table per Huffman tree).
// Scratch tables are module-scoped and reused across calls — inflate runs
// synchronously to completion, so there is no reentrancy — and the fixed Huffman
// tree is built once for the module's lifetime. Unlike a size-aware decoder it
// grows its output (the DecompressionStream contract carries no expected length);
// a truncated/corrupt stream is caught when it reads past the input (bitLen < 0),
// bounding output for malformed data. All of this ships only in the compat
// bundles (the modern build tree-shakes this module out entirely).

// DEFLATE length/distance base values and extra-bit counts (RFC 1951 §3.2.5) plus
// the code-length code order (§3.2.7). Module-scoped so they allocate once.
const I_ORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const I_LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const I_LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const I_DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const I_DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// Reused scratch (lazy-initialised on first inflate). One Uint16Array backs the
// literal/code-length LUT (≤15-bit → 32768), the distance LUT (32768), the sorted
// symbol list (≤320), and the two fixed-tree LUTs (512 + 32).
let I_lLut: Uint16Array | undefined;
let I_dLut: Uint16Array, I_sorted: Uint16Array, I_fixedL: Uint16Array, I_fixedD: Uint16Array;
let I_counts: Int32Array, I_offsets: Int32Array, I_lens: Uint8Array, I_clens: Uint8Array;
let I_fixedReady = false;

// Exported for tests; not referenced by index.ts, so it carries no bundle weight
// beyond the DecompressionStream polyfill that already uses it.
export const inflateRawDynamic = (input: Uint8Array<ArrayBuffer>, maxBytes?: number): Uint8Array<ArrayBuffer> => {
  if (!I_lLut) {
    const table = new Uint16Array(32768 + 32768 + 320 + 512 + 32);
    I_lLut = table.subarray(0, 32768);
    I_dLut = table.subarray(32768, 65536);
    I_sorted = table.subarray(65536, 65536 + 320);
    I_fixedL = table.subarray(65536 + 320, 65536 + 320 + 512);
    I_fixedD = table.subarray(65536 + 320 + 512, 65536 + 320 + 512 + 32);
    const tree = new Int32Array(32);
    I_counts = tree.subarray(0, 16);
    I_offsets = tree.subarray(16, 32);
    I_lens = new Uint8Array(320);
    I_clens = I_lens.subarray(0, 19);
  }

  // Growable output. Real ZIPs are dominated by small entries, so start modest
  // (≥4 KB or 4× input — covers a typical deflate ratio without reallocating) and
  // grow by 2× (which copies ~2× the final size total, vs ~3× for 1.5×, and wins
  // on the rare highly-compressed entry). A small floor also means a held result
  // retains little slack, since the return below is a view over this buffer.
  const initialSize = Math.max(4096, input.length * 4);
  let out = new Uint8Array(maxBytes === undefined ? initialSize : Math.floor(Math.min(initialSize, maxBytes)));
  let outIdx = 0;
  const ensure = (need: number): void => {
    const required = outIdx + need;
    if (maxBytes !== undefined && required > maxBytes) throw new RangeError(`Inflated output exceeds limit of ${maxBytes} bytes`);
    if (required > out.length) {
      let n = out.length;
      if (n === 0) n = 1;
      do { n *= 2; } while (n < required);
      const grown = new Uint8Array(n);
      grown.set(out);
      out = grown;
    }
  };

  const inLen = input.length;
  let bitBuf = 0, bitLen = 0, inIdx = 0;

  const refill = (): void => {
    while (bitLen < 16 && inIdx < inLen) { bitBuf |= input[inIdx++] << bitLen; bitLen += 8; }
  };
  const readBits = (n: number): number => {
    refill();
    // refill() only adds bytes while input remains; if it could not supply n bits
    // the stream is truncated. Failing here stops underflow from propagating a
    // negative bitLen into the block loop (which otherwise spins on empty input).
    if (bitLen < n) throw new Error();
    const r = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n; bitLen -= n;
    return r;
  };

  // Build a canonical-Huffman decode LUT into `lut`; return the active prefix
  // (its length sets the decode mask). Entries are packed (len << 9) | symbol.
  const buildTree = (lens: Uint8Array, lut: Uint16Array): Uint16Array => {
    const counts = I_counts.fill(0);
    let maxBits = 0;
    for (let i = 0; i < lens.length; i++) {
      const l = lens[i];
      if (l > 0) { counts[l]++; if (l > maxBits) maxBits = l; }
    }
    const limit = 1 << maxBits;
    const resLut = lut.subarray(0, limit);
    const offsets = I_offsets;
    let off = 0;
    for (let i = 1; i <= maxBits; i++) { offsets[i] = off; off += counts[i]; }
    const sorted = I_sorted;
    for (let i = 0; i < lens.length; i++) { if (lens[i] > 0) sorted[offsets[lens[i]]++] = i; }
    let rev = 0, sortedIdx = 0;
    for (let len = 1; len <= maxBits; len++) {
      const step = 1 << len;
      const count = counts[len];
      for (let i = 0; i < count; i++) {
        const entry = (len << 9) | sorted[sortedIdx++];
        for (let j = rev; j < limit; j += step) resLut[j] = entry;
        let bit = 1 << (len - 1);
        while (rev & bit) { rev ^= bit; bit >>= 1; }
        rev ^= bit;
      }
    }
    return resLut;
  };

  const decodeSymbol = (lut: Uint16Array): number => {
    refill();
    const entry = lut[bitBuf & (lut.length - 1)];
    const codeLen = entry >>> 9;
    bitBuf >>>= codeLen; bitLen -= codeLen;
    return entry & 0x1ff;
  };

  if (!I_fixedReady) {
    I_fixedReady = true;
    const ls = I_lens.subarray(0, 288);
    ls.fill(8, 0, 144); ls.fill(9, 144, 256); ls.fill(7, 256, 280); ls.fill(8, 280, 288);
    buildTree(ls, I_fixedL);
    buildTree(I_lens.subarray(0, 32).fill(5), I_fixedD);
  }

  let isFinal = 0;
  while (!isFinal) {
    const header = readBits(3);
    isFinal = header & 1;
    const type = header >> 1;

    if (type === 0) {
      // Stored block: byte-align by dropping only the PARTIAL bits of the current
      // byte (refill prefetches whole bytes into bitBuf, so zeroing it would lose
      // stream bytes), then read LEN/NLEN consuming buffered bytes first.
      bitBuf >>>= bitLen & 7;
      bitLen -= bitLen & 7;
      const nextByte = (): number => {
        if (bitLen >= 8) { const b = bitBuf & 0xff; bitBuf >>>= 8; bitLen -= 8; return b; }
        if (inIdx >= inLen) throw new Error(); // truncated before LEN/NLEN
        return input[inIdx++];
      };
      const blockLen = nextByte() | (nextByte() << 8);
      const nlen = nextByte() | (nextByte() << 8);
      // LEN and NLEN must be one's complements (RFC 1951 §3.2.4); the only
      // integrity check raw DEFLATE has for a stored block.
      if (((blockLen ^ nlen) & 0xffff) !== 0xffff) throw new Error();
      ensure(blockLen);
      let copied = 0;
      while (bitLen >= 8 && copied < blockLen) { out[outIdx++] = nextByte(); copied++; }
      const bulk = blockLen - copied;
      if (inIdx + bulk > inLen) throw new Error(); // truncated block body
      out.set(input.subarray(inIdx, inIdx + bulk), outIdx);
      outIdx += bulk; inIdx += bulk;
      continue;
    }

    let lTree: Uint16Array, dTree: Uint16Array;
    if (type === 1) {
      lTree = I_fixedL; dTree = I_fixedD;
    } else if (type === 2) {
      const h = readBits(14);
      const hlit = (h & 0x1f) + 257;
      const hdist = ((h >> 5) & 0x1f) + 1;
      const hclen = ((h >> 10) & 0xf) + 4;
      const clens = I_clens.fill(0);
      for (let i = 0; i < hclen; i++) clens[I_ORD[i]] = readBits(3);
      const clTree = buildTree(clens, I_lLut!);
      const total = hlit + hdist;
      const allLens = I_lens.subarray(0, total).fill(0);
      let i = 0;
      while (i < total) {
        if (bitLen < 0) throw new Error(); // truncated stream
        const s = decodeSymbol(clTree);
        if (s < 16) { allLens[i++] = s; }
        else {
          let rep = 0, val = 0;
          if (s === 16) { rep = 3 + readBits(2); val = allLens[i - 1]; }
          else if (s === 17) { rep = 3 + readBits(3); }
          else { rep = 11 + readBits(7); }
          while (rep--) allLens[i++] = val;
        }
      }
      lTree = buildTree(allLens.subarray(0, hlit), I_lLut!);
      dTree = buildTree(allLens.subarray(hlit), I_dLut);
    } else {
      throw new Error(); // type === 3 is reserved (RFC 1951 §3.2.3)
    }

    for (;;) {
      // A valid stream never over-reads; a truncated/corrupt one drives bitLen
      // negative once the input is exhausted, which terminates the decode.
      if (bitLen < 0) throw new Error();
      const s = decodeSymbol(lTree);
      if (s < 256) {
        ensure(1);
        out[outIdx++] = s;
      } else if (s === 256) {
        break;
      } else {
        const li = s - 257;
        const matchLen = I_LBASE[li] + readBits(I_LEXT[li]);
        const di = decodeSymbol(dTree);
        const dist = I_DBASE[di] + readBits(I_DEXT[di]);
        ensure(matchLen);
        const pos = outIdx - dist;
        if (dist === 1) {
          out.fill(out[pos], outIdx, outIdx + matchLen);
          outIdx += matchLen;
        } else {
          let remaining = matchLen;
          while (remaining > 0) {
            let chunk = outIdx - pos;
            if (remaining < chunk) chunk = remaining;
            out.copyWithin(outIdx, pos, pos + chunk);
            outIdx += chunk;
            remaining -= chunk;
          }
        }
      }
    }
  }
  return out.subarray(0, outIdx) as Uint8Array<ArrayBuffer>;
};

const concatChunks = (chunks: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  if (chunks.length === 1) return chunks[0] as Uint8Array<ArrayBuffer>;
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return merged as Uint8Array<ArrayBuffer>;
};

// DecompressionStream("deflate-raw") polyfill. The library buffers the whole
// input and reads all output, so this collects input chunks and inflates once on
// flush — no need to stream incrementally. Built on the ponyfill TransformStream,
// so ponyfillReadable.pipeThrough(new DecompressionStreamPoly(...)) interoperates.
class DecompressionStreamPoly extends (TransformStreamPoly as unknown as typeof TransformStream)<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>> {
  constructor(format: string, maxBytes?: number) {
    if (format !== "deflate-raw") throw new TypeError(`Unsupported DecompressionStream format: ${format}`);
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    super({
      transform(chunk: Uint8Array<ArrayBuffer>) { chunks.push(chunk); },
      flush(controller) { controller.enqueue(inflateRawDynamic(concatChunks(chunks), maxBytes)); }
    });
  }
}

// Compat builds use the polyfill DecompressionStream UNIFORMLY, even where a
// native one exists. Reason: the seam forces the ponyfill ReadableStream /
// TransformStream everywhere (Firefox 68 lacks the native ones, and
// ZipTransformStream extends TransformStream_), and a ponyfill ReadableStream
// cannot pipeThrough a *native* TransformStream — pipeThrough rejects a readable
// that isn't its own class. Browsers that actually have native DecompressionStream
// (Chrome 80+ / Firefox 113+) are served by the modern build, which uses native
// streams end to end; this path only runs where there is no native one anyway.
export const DecompressionStream_ = DecompressionStreamPoly as unknown as typeof DecompressionStream;
