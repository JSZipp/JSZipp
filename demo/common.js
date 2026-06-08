/**
 * Capability bucket detector, no userAgent sniffing.
 *
 * Returns:
 *   "modern"      ~= default JSZipp build (Chrome 80+ / Firefox 113+ class)
 *   "cr86ff68"    ~= browser-legacy/cr86ff68 (Chrome 86 / Firefox 68 class)
 *   "cr61ff58"    ~= browser-legacy/cr61ff58 (Chrome 61 / Firefox 58 class)
 *   "unsupported" ~= too old / missing required APIs
 *
 * Important: without userAgent, this detects the JSZipp build family a runtime
 * can support, not an exact browser version string.
 */
function getBrowserCapabilityBucket() {

  function hasBlobArrayBuffer() {
    return typeof Blob === "function" &&
      Blob.prototype &&
      typeof Blob.prototype.arrayBuffer === "function";
  }

  var hasPromise = typeof Promise === "function";
  var hasSymbol = typeof Symbol === "function";
  var hasMapSet = typeof Map === "function" && typeof Set === "function";
  var hasURL = typeof URL === "function" && typeof URLSearchParams === "function";
  var hasTextCodec = typeof TextEncoder === "function" && typeof TextDecoder === "function";
  var hasBlob = typeof Blob === "function";
  var hasFileReader = typeof FileReader === "function";
  var hasFetch = typeof fetch === "function";
  var hasWebAssembly = typeof WebAssembly === "object";

  var supportsCr61Ff58 =
    hasPromise &&
    hasSymbol &&
    hasMapSet &&
    hasURL &&
    hasTextCodec &&
    hasBlob &&
    hasFileReader &&
    hasFetch &&
    hasWebAssembly &&
    typeof Array.from === "function" &&
    typeof Object.assign === "function";

  if (!supportsCr61Ff58) {
    return "unsupported";
  }

  // The CR86FF68 build still needs the runtime features that are NOT polyfilled
  // there (`globalThis` and AbortController).
  var supportsCr86Ff68 =
    typeof globalThis === "object" &&
    typeof AbortController === "function";

  if (!supportsCr86Ff68) {
    return "cr61ff58";
  }

  // The modern build refuses to polyfill the native stream/decompression path.
  // `DecompressionStream("deflate-raw")` is the true floor, and the modern
  // bundle also expects native stream classes plus Blob#arrayBuffer().
  var supportsModern =
    typeof ReadableStream === "function" &&
    typeof TransformStream === "function" &&
    typeof WritableStream === "function" &&
    typeof DecompressionStream === "function" &&
    hasBlobArrayBuffer();

  return supportsModern ? "modern" : "cr86ff68";
}
