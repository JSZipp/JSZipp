// Polyfill seam for the CR61FF58 build (minimum: Chrome 61 / Firefox 58).
// Chrome 61 has no AbortController/AbortSignal base class at all, so this build
// supplies a minimal hand-written one. Streams, throwIfAborted and the
// DecompressionStream seam come from the shared compat module.
import { installPolyfills as installShared } from "./polyfill-compat";
export { TransformStream_, ReadableStream_, WritableStream_, DecompressionStream_, isReadableStream_ } from "./polyfill-compat";

// Minimal AbortSignal/AbortController. The library only ever does
// `new AbortController().signal` and `signal.throwIfAborted()`; it never
// registers listeners, so this is a poll-based signal (no EventTarget). User
// code that aborts still works because the library polls throwIfAborted() at
// every step. Where a native AbortController exists (Firefox 58) it is used
// unchanged; this class only fills the gap on engines that lack it (Chrome 61).
class AbortSignalPoly {
  aborted = false;
  reason: unknown = undefined;
  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }
}

class AbortControllerPoly {
  readonly signal: AbortSignalPoly = new AbortSignalPoly();
  abort(reason?: unknown): void {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason ?? new DOMException("signal is aborted without reason", "AbortError");
  }
}

// Prefer the platform class when present (Firefox 58 has it); fall back to the
// poly only where the global is missing (Chrome 61).
export const AbortController_ = (globalThis.AbortController ?? (AbortControllerPoly as unknown)) as typeof AbortController;

// Reuse the shared install (it patches AbortSignal.prototype.throwIfAborted on
// Firefox 58, and is a harmless no-op on Chrome 61 where there is no base class
// — the poly signals already carry the method).
export const installPolyfills = installShared;
