// test-compression/deflate-bitbuffer-reset-regression.test.ts
import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { openZip, ZipWriter } from "../src/index";

type TestBytes = Uint8Array<ArrayBuffer>;

const ENTRY = "trigger.bin";

const extractDeflatePayload = (
  archive: TestBytes,
  compressedSize: number
): TestBytes => {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);

  for (let offset = 0; offset <= archive.length - 30; offset++) {
    if (view.getUint32(offset, true) !== 0x04034b50) continue;

    const pathLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + pathLen + extraLen;

    if (dataStart + compressedSize <= archive.length) {
      return archive.slice(dataStart, dataStart + compressedSize) as TestBytes;
    }
  }

  throw new Error("Could not locate local file header / DEFLATE payload");
};

const makeSeed5Input = () => {

  const BLOCK = 16_384;
  const SEED = 5;

  const a = new Uint8Array(64);
  const base = new Uint8Array(65_536);
  let bo = 0;

  const db = (t: number, p: number): void => {
    if (t > 4) {
      if (4 % p === 0) for (let i = 1; i <= p; i++) base[bo++] = a[i];
      return;
    }

    a[t] = a[t - p];
    db(t + 1, p);

    for (let j = a[t - p] + 1; j < 16; j++) {
      a[t] = j;
      db(t + 1, t);
    }
  };

  db(1, 1);

  const k = (SEED * 9973) % (base.length - BLOCK);
  const first = base.subarray(k, k + BLOCK);

  const perm = new Uint8Array(16);
  for (let i = 0; i < 16; i++) perm[i] = i;

  let x = SEED >>> 0;

  for (let i = 15; i > 0; i--) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    const j = (x >>> 0) % (i + 1);
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }

  for (let i = 0; i < BLOCK; i++) first[i] = perm[first[i]];

  const prior = new Set<number>();

  for (let i = 0; i + 3 < BLOCK; i++) {
    prior.add((((first[i] << 24) | (first[i + 1] << 16) | (first[i + 2] << 8) | first[i + 3]) >>> 0));
  }

  const stored: Uint8Array<ArrayBuffer> = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) stored[i] = i;

  x = (SEED * 0x9e3779b1) >>> 0;

  for (let i = BLOCK - 1; i > 0; i--) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    const j = (x >>> 0) % (i + 1);
    const t = stored[i]; stored[i] = stored[j]; stored[j] = t;
  }

  const seen = new Set<number>();

  let p0 = first[BLOCK - 3], p1 = first[BLOCK - 2], p2 = first[BLOCK - 1];

  for (let i = 0; i < BLOCK; i++) {
    const p3 = stored[i];
    const k = (((p0 << 24) | (p1 << 16) | (p2 << 8) | p3) >>> 0);

    if (seen.has(k) || prior.has(k)) {
      throw new Error("stored candidate has an LZ77 match; try another seed");
    }

    seen.add(k);
    p0 = p1; p1 = p2; p2 = p3;
  }

  const tailText = "A";
  const input: Uint8Array<ArrayBuffer> = new Uint8Array(BLOCK + BLOCK + tailText.length * 12);

  input.set(first, 0);
  input.set(stored, BLOCK);

  let o = BLOCK + BLOCK;

  for (let r = 0; r < 12; r++) {
    for (let i = 0; i < tailText.length; i++) input[o++] = tailText.charCodeAt(i);
  }

  return input;
};

describe("DEFLATE bit writer regression — bitBuffer must be cleared after pushByte()", () => {
  it("fails without `this.bitBuffer = 0` after aligning a stored block", async () => {
    const level = 6;

    const input = makeSeed5Input();

    const writer = new ZipWriter({ outputAs: "uint8array", level });
    writer.writeSync({ path: ENTRY, data: input, method: "deflate" });
    const archive = writer.closeSync();

    let zip;
    try {
      zip = await openZip(archive);
      const entry = zip.get(ENTRY);
      if (!entry) {
        expect(entry).toBeDefined();
      } else {
        const payload = extractDeflatePayload(archive, entry!.compressedSize);

        const inflated = inflateRawSync(payload);
        expect(Buffer.from(inflated).equals(Buffer.from(input))).toBe(true);

        const roundTrip = await entry.bytes();
        expect(Buffer.from(roundTrip).equals(Buffer.from(input))).toBe(true);
      }
    } catch (e) {
      throw e;
    } finally {
      await zip?.close();
    }
  });
});
