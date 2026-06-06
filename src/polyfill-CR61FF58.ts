// Polyfill seam for the CR61FF58 build (minimum: Chrome 61 / Firefox 58).
// Chrome 61 has no AbortController/AbortSignal base class at all, so this build
// supplies a minimal hand-written one. Streams, the DecompressionStream seam, the
// private member keys, and the symbol-keyed installPolyfills come from the shared
// compat module.
import { installPolyfills as installShared, glob, arrayBuffer_, throwIfAborted_ } from "./polyfill-compat";
export {
  TransformStream_, ReadableStream_, WritableStream_, DecompressionStream_,
  isReadableStream_, responseAcceptsStream_,
} from "./polyfill-compat";
export { arrayBuffer_, throwIfAborted_ };

// Minimal poll-based AbortSignal (no EventTarget; the library only polls
// throwIfAborted()). It is NOT a subclass of native AbortSignal because Chrome 61
// has no base class to extend. The throwIfAborted method is defined under the SAME
// private key the library indexes with ([throwIfAborted_]); on Chrome 61 these poly
// signals are the only ones in play (the user cannot construct a native signal),
// and on Firefox 58 the native AbortController is used instead and its signals get
// the key via installPolyfills. `reason` may be undefined, hence the DOMException
// default.
class AbortSignalPoly {
  aborted = false;
  reason: unknown = undefined;
  [throwIfAborted_](this: AbortSignal & { reason?: unknown }): void {
    if (this.aborted) throw this.reason ?? new DOMException("signal is aborted without reason", "AbortError");
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

// Prefer the platform class when present (Firefox 58 has it); fall back to the poly
// only where the global is missing (Chrome 61). Read through `glob`, not bare
// `globalThis` (which itself does not exist on Chrome 61 / Firefox 58).
export const AbortController_ = (glob.AbortController ?? (AbortControllerPoly as unknown)) as typeof AbortController;

// Re-exported so the symbol-key install runs at load on this build too (it patches
// the native Blob.prototype, and the native AbortSignal.prototype on Firefox 58).
export const installPolyfills = installShared;
