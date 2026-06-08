import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const detectorSource = readFileSync(new URL("../demo/common.js", import.meta.url), "utf8");

const detectBucket = (overrides: Record<string, unknown>) => {
  const context = vm.createContext({
    Promise,
    Symbol,
    Map,
    Set,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    ...overrides
  });
  vm.runInContext(detectorSource, context, { filename: "demo/common.js" });
  return (context.getBrowserCapabilityBucket as () => string)();
};

describe("getBrowserCapabilityBucket", () => {
  it("maps the documented modern floor to the modern bucket", () => {
    function BlobLike() {}
    BlobLike.prototype.arrayBuffer = function () {};
    expect(detectBucket({
      Promise,
      Symbol,
      Map,
      Set,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      fetch: function fetch() {},
      WebAssembly: {},
      Blob: BlobLike,
      FileReader: function FileReader() {},
      AbortController: function AbortController() {},
      ReadableStream: function ReadableStream() {},
      TransformStream: function TransformStream() {},
      WritableStream: function WritableStream() {},
      DecompressionStream: function DecompressionStream() {},
      globalThis: {}
    })).toBe("modern");
  });

  it("maps the documented Chrome 86 / Firefox 68 floor to cr86ff68", () => {
    function BlobLike() {}
    expect(detectBucket({
      Promise,
      Symbol,
      Map,
      Set,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      fetch: function fetch() {},
      WebAssembly: {},
      Blob: BlobLike,
      FileReader: function FileReader() {},
      AbortController: function AbortController() {},
      DecompressionStream: undefined,
      ReadableStream: undefined,
      TransformStream: undefined,
      WritableStream: undefined,
      globalThis: {}
    })).toBe("cr86ff68");
  });

  it("does not require Promise.finally for the documented Chrome 61 floor", () => {
    function BlobLike() {}
    const PromiseLike = function PromiseLike(this: unknown, executor: (resolve: () => void) => void) {
      executor(() => undefined);
    } as unknown as PromiseConstructor;
    //@ts-ignore
    PromiseLike.prototype = {};
    expect(detectBucket({
      Promise: PromiseLike,
      Symbol,
      Map,
      Set,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      fetch: function fetch() {},
      WebAssembly: {},
      Blob: BlobLike,
      FileReader: function FileReader() {},
      AbortController: undefined,
      DecompressionStream: undefined,
      ReadableStream: undefined,
      TransformStream: undefined,
      WritableStream: undefined,
      globalThis: undefined
    })).toBe("cr61ff58");
  });
});
