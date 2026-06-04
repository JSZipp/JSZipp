// Native passthrough: the seam used by the modern build and by typechecking.
// Every binding is the platform global, so the modern bundle carries zero
// polyfill bytes and stays dependency-free. The build aliases "./polyfill" to a
// compat module for the CR61FF58 / CR86FF68 targets.
export const AbortController_ = AbortController;
export const TransformStream_ = TransformStream;
export const ReadableStream_ = ReadableStream;
export const WritableStream_ = WritableStream;
// Preserves the original line-20 behaviour exactly: optional, read off globalThis
// so the module still loads where DecompressionStream is undeclared.
export const DecompressionStream_ = globalThis.DecompressionStream as typeof DecompressionStream | undefined;
export const isReadableStream_ = (x: unknown): x is ReadableStream => x instanceof ReadableStream;
export const installPolyfills = (): void => undefined;
