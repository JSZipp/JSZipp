// Writer-only UMD entry: pulls in ZipWriter + ZipTransformStream and, transitively,
// the DEFLATE compressor. The ZIP reader (openZip/readZipStream/parseZip/inflate)
// is never referenced from here, so usedExports + sideEffects:false drop it.
import { ZipWriter, ZipTransformStream } from "./index";

export { ZipWriter, ZipTransformStream };
export default { ZipWriter, ZipTransformStream };
