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

type AbortListener =
  | ((event: Event) => void)
  | { handleEvent(event: Event): void };

// Minimal AbortSignal polyfill. It is NOT a subclass of native AbortSignal
// because Chrome 61 has no base class to extend. The throwIfAborted method is
// defined under the SAME private key the library indexes with
// ([throwIfAborted_]); on Chrome 61 these poly signals are the only ones in play
// (the user cannot construct a native signal), and on Firefox 58 the native
// AbortController is used instead and its signals get the key via
// installPolyfills. `reason` may be undefined, hence the DOMException default.
//
// The worker backend also needs the tiny EventTarget subset below so it can
// subscribe to "abort" and cancel in-flight worker requests without assuming the
// full platform AbortSignal shape exists.
class AbortSignalPoly {
  aborted = false;
  reason: unknown = undefined;
  private readonly abortListeners = new Set<AbortListener>();
  [throwIfAborted_](this: AbortSignal & { reason?: unknown }): void {
    if (this.aborted) throw this.reason ?? new DOMException("signal is aborted without reason", "AbortError");
  }
  addEventListener(type: string, listener: AbortListener | null): void {
    if (type !== "abort" || !listener) return;
    this.abortListeners.add(listener);
  }
  removeEventListener(type: string, listener: AbortListener | null): void {
    if (type !== "abort" || !listener) return;
    this.abortListeners.delete(listener);
  }
  dispatchAbort(): void {
    const event = { type: "abort", target: this } as unknown as Event;
    for (const listener of [...this.abortListeners]) {
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    }
    this.abortListeners.clear();
  }
}

class AbortControllerPoly {
  readonly signal: AbortSignalPoly = new AbortSignalPoly();
  abort(reason?: unknown): void {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason ?? new DOMException("signal is aborted without reason", "AbortError");
    this.signal.dispatchAbort();
  }
}

// Prefer the platform class when present (Firefox 58 has it); fall back to the poly
// only where the global is missing (Chrome 61). Read through `glob`, not bare
// `globalThis` (which itself does not exist on Chrome 61 / Firefox 58).
export const AbortController_ = (glob.AbortController ?? (AbortControllerPoly as unknown)) as typeof AbortController;

// Re-exported so the symbol-key install runs at load on this build too (it patches
// the native Blob.prototype, and the native AbortSignal.prototype on Firefox 58).
export const installPolyfills = installShared;
