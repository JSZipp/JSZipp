import type { ZipEncoderRuntimeOptions, ZipInputEntry, ZipPreparedEntry, ZipWorkerBackend } from "./index";
import {
  DEV,
  E_REQUIRED,
  E_TERMINATED,
  E_UNSUPPORTED,
  E_WORKER,
  ERR_INVALID_STATE,
  ERR_NOT_SUPPORTED,
  installPolyfills_,
  throwIfAborted_
} from "./worker-common";

installPolyfills_();

/**
 * Worker instance or factory used by `createWorkerBackend()`.
 *
 * A factory is recommended so the backend can recreate a worker after aborts,
 * crashes, or termination. This library never creates blob URL workers
 * internally; pass a CSP-appropriate worker URL from your app or extension.
 */
export type ZipWorkerFactory = Worker | (() => Worker);

/**
 * How byte-array inputs are sent to the worker.
 *
 * - `"copy"` keeps caller-owned buffers intact.
 * - `"transfer"` transfers full `ArrayBuffer` / full-span `Uint8Array` inputs
 *   and detaches them.
 * - `"auto"` is conservative: it transfers only a copy that the backend had to
 *   create for a partial `Uint8Array` view, avoiding detaching caller buffers.
 */
export type ZipWorkerTransferMode = "auto" | "copy" | "transfer";

/** Options for `createWorkerBackend()`. */
export interface ZipWorkerBackendOptions {
  /**
   * Worker instance or factory used by this backend.
   *
   * Use a static script URL that satisfies your CSP, for example
   * `() => new Worker(browser.runtime.getURL("jszipp.worker.mjs"), { type: "module" })`
   * in a modern extension page. A factory is preferred because the backend
   * creates workers lazily, can recreate them after `terminate()` or crashes,
   * and can still honor `fallback` if construction fails. With a compat build, use the matching
   * `cr61ff58/jszipp.worker.umd.js` or `cr86ff68/jszipp.worker.umd.js` classic
   * worker script and omit `{ type: "module" }`.
   */
  workerSource: ZipWorkerFactory;
  /**
   * Deprecated alias for `workerSource`.
   *
   * Kept temporarily for compatibility with older callers.
   */
  worker?: ZipWorkerFactory;
  /**
   * Whether to fall back to JSZipp's normal in-thread preparation when the
   * worker path is unavailable or cannot clone an input.
   *
   * Defaults to `true`. Set to `false` when worker usage is required and a
   * failure should reject the write.
   */
  fallback?: boolean;
  /**
   * Byte transfer policy for `ArrayBuffer` and `Uint8Array` inputs.
   *
   * Defaults to `"copy"` so caller-owned buffers are not detached.
   */
  transfer?: ZipWorkerTransferMode;
  /**
   * Minimum known input size, in bytes, required before the backend uses a
   * worker. Smaller entries return `undefined` and use the normal path.
   *
   * Defaults to `32768` (32 KiB) so worker offload stays focused on
   * responsiveness for larger payloads instead of adding `postMessage`
   * overhead to small entries.
   */
  minSize?: number;
}

/**
 * Reusable worker backend returned by `createWorkerBackend()`.
 *
 * The same backend can be passed to multiple `ZipWriter` instances. Writers do
 * not terminate it automatically; call `terminate()` when the backend is no
 * longer needed. Aborting one write rejects only that write; it does not tear
 * down sibling work sharing the backend.
 */
export interface ZipWorkerBackendHandle extends ZipWorkerBackend {
  /** Terminate the current worker instance and reject any in-flight requests. */
  terminate(): void;
}

type PathInfo = { path: string; isDirectory: boolean };
type Pending = {
  signal: AbortSignal;
  resolve: (prepared: ZipPreparedEntry | undefined) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
type WorkerResponse = {
  id: number;
  prepared?: ZipPreparedEntry;
  error?: { name: string; message: string };
};

const workerUnsupported = (): DOMException =>
  new DOMException(DEV ? "JSZipp worker backend cannot prepare this entry" : E_UNSUPPORTED, ERR_NOT_SUPPORTED);

const reviveError = (error: { name: string; message: string }): Error | DOMException => {
  if (error.name === "RangeError") return new RangeError(error.message);
  if (error.name === "TypeError") return new TypeError(error.message);
  if (error.name && error.name !== "Error") return new DOMException(error.message, error.name);
  return new Error(error.message);
};

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted", "AbortError");

const terminatedError = (): DOMException =>
  new DOMException(DEV ? "JSZipp worker backend was terminated" : E_TERMINATED, ERR_INVALID_STATE);

const isReadableStreamInput = (input: ZipInputEntry["data"]): boolean =>
  typeof input === "object" && input !== null && "getReader" in input;

const textEncoder = new TextEncoder();

const inputSize = (input: ZipInputEntry["data"]): number | undefined => {
  if (typeof input === "string") return textEncoder.encode(input).byteLength;
  if (input instanceof ArrayBuffer) return input.byteLength;
  if (input instanceof Uint8Array) return input.byteLength;
  if (typeof Blob !== "undefined" && input instanceof Blob) return input.size;
  return undefined;
};

const serializableOptions = (options: ZipEncoderRuntimeOptions): Omit<ZipEncoderRuntimeOptions, "signal" | "onProgress"> => ({
  level: options.level,
  zip64: options.zip64,
  comment: options.comment,
  timestamps: options.timestamps,
  pathMode: options.pathMode,
  explicitDirectoryEntries: options.explicitDirectoryEntries
});

const cloneForTransfer = (entry: ZipInputEntry, transferMode: ZipWorkerTransferMode, transfer: Transferable[]): ZipInputEntry => {
  const { data } = entry;
  if (data instanceof ArrayBuffer) {
    if (transferMode === "transfer") transfer.push(data);
    return entry;
  }
  if (data instanceof Uint8Array) {
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
      if (transferMode === "transfer") transfer.push(data.buffer);
      return entry;
    }
    if (transferMode === "copy") return entry;
    const copy = new Uint8Array(data);
    transfer.push(copy.buffer);
    return { ...entry, data: copy };
  }
  return entry;
};

class ZipWorkerClient implements ZipWorkerBackendHandle {
  private worker?: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly fallback: boolean;
  private readonly transferMode: ZipWorkerTransferMode;
  private readonly minSize: number;

  constructor(private readonly factory: ZipWorkerFactory, options: ZipWorkerBackendOptions) {
    this.fallback = options.fallback ?? true;
    this.transferMode = options.transfer ?? "copy";
    this.minSize = options.minSize ?? 32 * 1024;
  }

  readonly prepare = async (input: ZipInputEntry, options: ZipEncoderRuntimeOptions, pathInfo: PathInfo): Promise<ZipPreparedEntry | undefined> => {
    options.signal[throwIfAborted_]();
    const size = inputSize(input.data);
    if (pathInfo.isDirectory || isReadableStreamInput(input.data) || (size !== undefined && size < this.minSize)) return undefined;
    if (typeof Worker === "undefined") return this.unsupported();

    const worker = this.getWorker();
    if (!worker) return this.unsupported();

    const id = this.nextId++;
    const transfer: Transferable[] = [];
    const requestInput = cloneForTransfer(input, this.transferMode, transfer);

    return new Promise<ZipPreparedEntry | undefined>((resolve, reject) => {
      const cleanup = (): void => {
        const pending = this.pending.get(id);
        if (pending) pending.signal.removeEventListener("abort", pending.abort);
        this.pending.delete(id);
      };
      const abort = (): void => {
        cleanup();
        reject(abortError(options.signal));
      };
      this.pending.set(id, {
        signal: options.signal,
        resolve: (prepared) => {
          cleanup();
          resolve(prepared);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        abort
      });
      options.signal.addEventListener("abort", abort, { once: true });

      try {
        worker.postMessage({ id, input: requestInput, options: serializableOptions(options), pathInfo }, transfer);
      } catch (error) {
        cleanup();
        if (this.fallback) resolve(undefined);
        else reject(error);
      }
    });
  }

  terminate(): void {
    this.rejectPending(terminatedError());
    this.worker?.terminate();
    this.worker = undefined;
  }

  private unsupported(): Promise<undefined> {
    if (this.fallback) return Promise.resolve(undefined);
    return Promise.reject(workerUnsupported());
  }

  private getWorker(): Worker | undefined {
    if (this.worker) return this.worker;
    try {
      const worker = typeof this.factory === "function" ? this.factory() : this.factory;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const pending = this.pending.get(event.data.id);
        if (!pending) return;
        if (event.data.error) pending.reject(reviveError(event.data.error));
        else pending.resolve(event.data.prepared);
      };
      worker.onerror = (event) => {
        const error = new Error(DEV ? event.message || "JSZipp worker failed" : E_WORKER);
        this.rejectPending(error);
        this.terminate();
      };
      this.worker = worker;
      return worker;
    } catch {
      return undefined;
    }
  }

  private rejectPending(error: unknown): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      request.signal.removeEventListener("abort", request.abort);
      request.reject(error);
    }
  }
}

/**
 * Create a reusable backend for `new ZipWriter({ worker })`.
 *
 * The returned backend prepares eligible async entries in a Web Worker and
 * returns `undefined` for entries that should use JSZipp's normal in-thread
 * preparation path.
 */
export const createWorkerBackend = (options: ZipWorkerBackendOptions): ZipWorkerBackendHandle => {
  const workerSource = options.workerSource ?? options.worker;
  if (!workerSource) throw new TypeError(DEV ? "createWorkerBackend() requires workerSource" : E_REQUIRED);
  return new ZipWorkerClient(workerSource, options);
};

export default {
  createWorkerBackend
};
