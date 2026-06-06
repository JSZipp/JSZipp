// Native passthrough: the seam used by the modern build and by typechecking.
// Every binding is the platform global, so the modern bundle carries zero polyfill
// bytes and stays dependency-free. The build aliases "./polyfill" to a compat
// module for the CR61FF58 / CR86FF68 targets.
export const AbortController_ = AbortController;
export const TransformStream_ = TransformStream;
export const ReadableStream_ = ReadableStream;
export const WritableStream_ = WritableStream;
// Preserves the original behaviour exactly: optional, read off globalThis so the
// module still loads where DecompressionStream is undeclared.
export const DecompressionStream_ = globalThis.DecompressionStream as typeof DecompressionStream | undefined;
export const isReadableStream_ = (x: unknown): x is ReadableStream => x instanceof ReadableStream;
// Whether `new Response(this.output, …)` may be given the writer's output stream
// directly. True here: the modern output is a NATIVE ReadableStream, which the
// Response constructor accepts as a streaming body. (In the compat builds the
// output is a polyfilled stream, which native Response would silently coerce to the
// string "[object Object]" — see polyfill-compat.ts.)
export const responseAcceptsStream_ = true;
// Member keys for the two methods that need polyfilling on old engines. In the
// modern build they are the native STRING names, so `blob[arrayBuffer_]()` is
// exactly `blob.arrayBuffer()` and minifies to the same dot call — the emitted
// code is identical to a direct native call. installPolyfills() is a no-op because
// the methods already exist on the prototypes.
export const arrayBuffer_ = "arrayBuffer" as const;
export const throwIfAborted_ = "throwIfAborted" as const;
export const installPolyfills = (): void => undefined;
