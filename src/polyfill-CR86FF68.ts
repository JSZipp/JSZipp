// Polyfill seam for the CR86FF68 build (minimum: Chrome 86 / Firefox 68).
// AbortController/AbortSignal exist on both, so the native AbortController is used
// directly; everything else (streams, the DecompressionStream seam, the private
// member keys, and the symbol-keyed installPolyfills) comes from the shared compat
// module. This build targets the WEAKER engine of the pair: Firefox 68 lacks
// TransformStream, Blob.arrayBuffer, and throwIfAborted, so Chrome 86 carries the
// shims too (installPolyfills reuses the native methods Chrome 86 does have).
export {
  TransformStream_, ReadableStream_, WritableStream_, DecompressionStream_,
  isReadableStream_, responseAcceptsStream_, arrayBuffer_, throwIfAborted_, installPolyfills,
} from "./polyfill-compat";

export const AbortController_ = AbortController;
