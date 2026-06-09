// Writer-only entry: pulls in ZipWriter + ZipTransformStream and, transitively,
// the DEFLATE compressor. The ZIP reader (openZip/readZipStream/parseZip/inflate)
// is never referenced from here, so usedExports + sideEffects:false drop it.
// Keep this entry named-export-only so it does not create an aggregate default
// object that would pin both exports together.
import { ZipWriter, ZipTransformStream } from "./index";

export { ZipWriter, ZipTransformStream };
