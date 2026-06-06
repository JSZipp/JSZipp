import { describe, expect, it } from "vitest";
import { constants, deflateRawSync, inflateRawSync } from "node:zlib";
import { inflateRawDynamic, ReadableStream_, DecompressionStream_ } from "../src/polyfill-compat";

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const deflate = (d: Uint8Array, level?: number, strategy?: number) =>
  new Uint8Array(deflateRawSync(d, {
    ...(level !== undefined ? { level } : undefined),
    ...(strategy !== undefined ? { strategy } : undefined),
  })) as Uint8Array<ArrayBuffer>;

// Drives the exact pipeline the library uses: a ReadableStream of the compressed
// bytes piped through a DecompressionStream, output fully read. `splits` lets the
// tests verify the polyfill's chunk collection / concat path too.
const pipeline = async (DS: typeof DecompressionStream, def: Uint8Array<ArrayBuffer>, splits?: number[]) => {
  const src = new ReadableStream_<Uint8Array<ArrayBuffer>>({
    start(c) {
      if (!splits) c.enqueue(def);
      else {
        let off = 0;
        for (const n of splits) { c.enqueue(def.subarray(off, off + n) as Uint8Array<ArrayBuffer>); off += n; }
        if (off < def.length) c.enqueue(def.subarray(off) as Uint8Array<ArrayBuffer>);
      }
      c.close();
    }
  });
  const reader = (src.pipeThrough(new DS("deflate-raw")) as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
};

const storedBlock = (payload: Uint8Array, final = true): Uint8Array<ArrayBuffer> => {
  if (payload.length > 0xffff) throw new Error("storedBlock payload too large");
  const out = new Uint8Array(5 + payload.length);
  out[0] = final ? 0x01 : 0x00; // BFINAL + BTYPE=00, already byte-aligned.
  out[1] = payload.length & 0xff;
  out[2] = payload.length >>> 8;
  const nlen = (~payload.length) & 0xffff;
  out[3] = nlen & 0xff;
  out[4] = nlen >>> 8;
  out.set(payload, 5);
  return out as Uint8Array<ArrayBuffer>;
};

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out as Uint8Array<ArrayBuffer>;
};

describe("inflateRawDynamic (DecompressionStream deflate-raw polyfill core)", () => {
  const cases: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["single byte", Uint8Array.of(65)],
    ["two bytes", Uint8Array.of(65, 66)],
    ["small literal-only text", new TextEncoder().encode("abcdef")],
    ["repetitive (RLE / dist-1)", new Uint8Array(50000).fill(0x61)],
    ["pattern (overlapping matches)", Uint8Array.from({ length: 40000 }, (_, i) => "ABCD".charCodeAt(i % 4))],
    ["max-distance window", Uint8Array.from({ length: 80000 }, (_, i) => i & 0x3f)],
    ["large mixed multi-block", Uint8Array.from({ length: 300000 }, (_, i) => (i % 251) ^ ((i >> 7) & 0xff))],
  ];
  for (const [name, data] of cases) {
    it(name, () => {
      for (const lvl of [0, 1, 6, 9]) expect(eq(inflateRawDynamic(deflate(data, lvl)), data)).toBe(true);
    });
  }

  it("fixed-Huffman blocks round-trip", () => {
    const d = new TextEncoder().encode("fixed huffman ".repeat(5000)) as Uint8Array<ArrayBuffer>;
    expect(eq(inflateRawDynamic(deflate(d, 6, constants.Z_FIXED)), d)).toBe(true);
  });

  it("stored blocks round-trip at LEN boundary values", () => {
    for (const n of [0, 1, 2, 255, 256, 32768, 65535]) {
      const d = Uint8Array.from({ length: n }, (_, i) => (i * 17 + 3) & 0xff);
      expect(eq(inflateRawDynamic(storedBlock(d)), d)).toBe(true);
    }
  });

  it("concatenated stored blocks round-trip across block boundaries", () => {
    const a = Uint8Array.from({ length: 65535 }, (_, i) => i & 0xff);
    const b = Uint8Array.from({ length: 17 }, (_, i) => 255 - i);
    expect(eq(inflateRawDynamic(concat(storedBlock(a, false), storedBlock(b, true))), concat(a, b))).toBe(true);
  });

  it("grows output far beyond initial 4x compressed-size estimate", () => {
    const d = new Uint8Array(1024 * 1024).fill(0x20);
    expect(eq(inflateRawDynamic(deflate(d, 9)), d)).toBe(true);
  });

  it("enforces maxBytes before growing past the limit", () => {
    const d = new Uint8Array(1024 * 1024).fill(0x20);
    expect(() => inflateRawDynamic(deflate(d, 9), 1024)).toThrow(RangeError);
  });

  it("scratch reuse does not leak state between different block types", () => {
    const dynamic = new TextEncoder().encode("dynamic ".repeat(7000)) as Uint8Array<ArrayBuffer>;
    const fixed = new TextEncoder().encode("fixed ".repeat(7000)) as Uint8Array<ArrayBuffer>;
    const stored = Uint8Array.from({ length: 1234 }, (_, i) => i & 0xff);

    expect(eq(inflateRawDynamic(deflate(dynamic, 6)), dynamic)).toBe(true);
    expect(eq(inflateRawDynamic(deflate(fixed, 6, constants.Z_FIXED)), fixed)).toBe(true);
    expect(eq(inflateRawDynamic(storedBlock(stored)), stored)).toBe(true);
    expect(eq(inflateRawDynamic(deflate(dynamic, 9)), dynamic)).toBe(true);
  });

  it("periodic byte pattern round-trips at stored and compressed levels", () => {
    // This generator is periodic modulo 256, so level 9 compresses it heavily;
    // level 0 still covers zlib stored-block output.
    const d = Uint8Array.from({ length: 70000 }, (_, i) => (i * 1103515245 + 12345) & 0xff);
    expect(eq(inflateRawDynamic(deflate(d, 0)), d)).toBe(true);
    expect(eq(inflateRawDynamic(deflate(d, 9)), d)).toBe(true);
  });

  it("fuzz: 200 random buffers vs zlib, all levels", () => {
    let seed = 0x12345678;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 0; t < 200; t++) {
      const n = Math.floor(rnd() * 5000);
      const d = new Uint8Array(n);
      for (let i = 0; i < n; i++) d[i] = rnd() < 0.5 ? (d[i - 1] | 0) : Math.floor(rnd() * 256);
      expect(eq(inflateRawDynamic(deflate(d, Math.floor(rnd() * 10))), d)).toBe(true);
    }
  });

  it("truncated stream throws (does not run away)", () => {
    const full = deflate(new Uint8Array(10000).fill(7), 9);
    expect(() => inflateRawDynamic(full.subarray(0, full.length >> 1) as Uint8Array<ArrayBuffer>)).toThrow();
  });

  it("truncated stored block throws", () => {
    const full = storedBlock(new Uint8Array(1024).fill(1));
    expect(() => inflateRawDynamic(full.subarray(0, full.length - 100) as Uint8Array<ArrayBuffer>)).toThrow();
  });

  it("reserved block type throws", () => {
    // BFINAL=1 and BTYPE=3 is reserved by RFC 1951 and must be rejected.
    expect(() => inflateRawDynamic(Uint8Array.of(0x07) as Uint8Array<ArrayBuffer>)).toThrow();
  });

  it("stored block rejects LEN/NLEN mismatch", () => {
    const corrupt = storedBlock(Uint8Array.of(1, 2, 3));
    corrupt[3] ^= 0x01;
    expect(() => inflateRawDynamic(corrupt)).toThrow();
  });

  it("bit flips in compressed payload match zlib behavior", () => {
    const d = new TextEncoder().encode("checksumless raw deflate corruption probe ".repeat(2000)) as Uint8Array<ArrayBuffer>;
    const compressed = deflate(d, 9);
    for (const pos of [0, compressed.length >> 1, compressed.length - 1]) {
      const corrupt = compressed.slice() as Uint8Array<ArrayBuffer>;
      corrupt[pos] ^= 0x40;

      // Raw DEFLATE has no checksum, and flips in unused final-byte padding may
      // legitimately decode to the original bytes. Use zlib as the oracle: if
      // zlib accepts the corrupted stream, the polyfill should produce the same
      // bytes; if zlib rejects it, the polyfill should reject it too.
      let expected: Uint8Array<ArrayBuffer> | undefined;
      try {
        expected = new Uint8Array(inflateRawSync(corrupt)) as Uint8Array<ArrayBuffer>;
      } catch {
        expect(() => inflateRawDynamic(corrupt)).toThrow();
        continue;
      }
      expect(eq(inflateRawDynamic(corrupt), expected)).toBe(true);
    }
  });

});

describe("DecompressionStream polyfill pipeline (as the library drives it)", () => {
  const data = new TextEncoder().encode("The quick brown fox. ".repeat(2000)) as Uint8Array<ArrayBuffer>;

  it("ponyfill ReadableStream -> polyfill DecompressionStream round-trips", async () => {
    // In compat builds DecompressionStream_ is always the polyfill (a ponyfill
    // ReadableStream cannot pipeThrough a native DecompressionStream), so this is
    // the exact pipeline old browsers run.
    expect(DecompressionStream_).not.toBe(globalThis.DecompressionStream);
    expect(eq(await pipeline(DecompressionStream_!, deflate(data, 6)), data)).toBe(true);
  });

  it("accepts compressed input split across many chunks", async () => {
    const compressed = deflate(data, 6);
    expect(eq(await pipeline(DecompressionStream_!, compressed, [1, 2, 3, 5, 8, 13, 21]), data)).toBe(true);
  });

  it("empty compressed input is rejected during flush", async () => {
    await expect(pipeline(DecompressionStream_!, new Uint8Array(0) as Uint8Array<ArrayBuffer>)).rejects.toThrow();
  });

  it("propagates inflater errors through the readable side", async () => {
    const compressed = deflate(data, 6);
    await expect(pipeline(DecompressionStream_!, compressed.subarray(0, 3) as Uint8Array<ArrayBuffer>)).rejects.toThrow();
  });

  it("rejects unsupported formats", () => {
    expect(() => new DecompressionStream_!("gzip" as "deflate-raw")).toThrow(TypeError);
  });
});
