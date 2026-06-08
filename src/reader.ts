// Reader-only entry: pulls in openZip + readZipStream. No writer API is
// referenced, so the DEFLATE compressor and its (now lazily-initialized) tables
// are tree-shaken out entirely. Keep this entry named-export-only so it does not
// create an aggregate default object that would pin both exports together.
import { openZip, readZipStream } from "./index";

export { openZip, readZipStream };
