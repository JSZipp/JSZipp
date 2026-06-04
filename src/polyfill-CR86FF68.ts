// Polyfill seam for the CR86FF68 build (minimum: Chrome 86 / Firefox 68).
// AbortController/AbortSignal exist on both (Chrome 66+, Firefox 57+), so the
// native class is used; everything else (streams, throwIfAborted, the
// DecompressionStream seam) comes from the shared compat module.
//
// Note this build targets the WEAKER of the two browsers: Firefox 68 needs the
// streams ponyfill, so Chrome 86 carries it too even though Chrome 86 alone
// would only need the throwIfAborted shim.
export const AbortController_ = AbortController;
export { TransformStream_, ReadableStream_, WritableStream_, DecompressionStream_, isReadableStream_, installPolyfills } from "./polyfill-compat";
