// Reader-only UMD entry: pulls in openZip + readZipStream. No writer API is
// referenced, so the DEFLATE compressor and its (now lazily-initialized) tables
// are tree-shaken out entirely.
import { openZip, readZipStream } from "./index";

export { openZip, readZipStream };
export default { openZip, readZipStream };
