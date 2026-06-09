import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { openZip, ZipWriter } from "../src/index";
import { inflateRawSync } from "node:zlib";

type TestBytes = Uint8Array<ArrayBuffer>;

// The original repro was beitou.jpg (229 KB) inside fflate-issue-113-reproduce.zip.
// This fixture is a 16 KB synthetic reduction — the practical MINIMUM — that
// reproduces the SAME encoder bug deterministically, distilled from analysing what
// beitou.jpg's byte structure does to the encoder.
//
// Root cause: DeflateBitWriter.pushByte() reset bitBuffer but not bitCount.
// pushByte() is reached via alignToByte(), which runs ONLY in emitBlock()'s
// stored-block branch. After writeBits(BFINAL,1)+writeBits(0,2), bitCount is
// (pendingBefore + 3) mod 8 — for the first block that is 3 (> 0) — so pushByte()
// runs and, without the fix, leaves bitCount stuck at 3 instead of 0. The encoder
// then believes 3 bits are pending in an (actually empty, byte-aligned) buffer,
// so the FOLLOWING block's bits are emitted 3 bits too late.
//
// Why this exact two-block layout — every condition is necessary:
//   block 1: a NON-FINAL block emitted STORED (so alignToByte/pushByte runs and
//            leaves the stale bitCount). To force the stored branch the block
//            must be incompressible enough that stored <= dynamic/fixed. Plain
//            random bytes are NOT enough: their entropy dips just under 8
//            bits/symbol, so dynamic Huffman edges out stored and the stored
//            branch never runs. PERFECTLY uniform data (every byte value exactly
//            64 times across 16384 bytes = exactly 8 bits/symbol) makes Huffman
//            unable to beat 8 bits, so stored wins by the whole dynamic-header
//            margin — reliably.
//   block 2: a Huffman (fixed/dynamic) block right after it. This is what makes
//            the misalignment CATASTROPHIC: the 3-bit shift corrupts this block's
//            BFINAL/BTYPE/header bits into garbage, so the decoder rejects it with
//            "invalid block type" / "Corrupt DEFLATE stream". If block 2 were also
//            stored, the 3-bit-shifted bytes would still parse as a valid stored
//            block and the output would be coincidentally correct — which is why
//            an all-incompressible input does NOT catch this bug. A short,
//            compressible ASCII tail guarantees the Huffman branch.
//
// Practical minimum size: blocks split only every DEFLATE_BLOCK_TOKENS (16384)
// tokens, so a NON-FINAL stored block must be a full 16384-token block, and a
// stored block is all-literal incompressible data — i.e. exactly 16384 bytes.
// That 16384-byte incompressible block (which by definition cannot be shrunk by
// the zip either) is the floor; the trailing Huffman block adds only ~48 bytes.
const fixtureUrl = new URL(
  "./zips/fflate-issue-113-deflate-regression.zip",
  import.meta.url
);

const ENTRY_NAME = "stored-then-dynamic.bin";
const ENTRY_SIZE = 16432;

const readFixture = async (): Promise<TestBytes> => {
  const bytes = await readFile(fixtureUrl);
  return new Uint8Array(bytes) as TestBytes;
};

// Pull the single entry's raw DEFLATE payload straight out of the archive bytes
// so it can be handed to an independent inflater (Node's zlib).
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
  throw new Error("Could not locate local file header / payload in archive");
};

describe("fflate issue #113 — DEFLATE encoder corruption for poorly-compressible data", () => {
  it("deflates 2-block incompressible data correctly at all compression levels", async () => {
    const reader = await openZip(await readFixture());
    const entry = reader.entries.find((e) => e.path.endsWith(ENTRY_NAME));
    expect(entry, `${ENTRY_NAME} should exist in fixture`).toBeDefined();

    const originalData = await entry!.bytes();
    expect(originalData.length).toBe(ENTRY_SIZE);

    // All levels: a non-final stored block is the trigger, and which blocks get
    // stored varies by level, so exercise the whole range. The input is tiny, so
    // this stays fast.
    for (let level = 0; level <= 9; level++) {
      const writer = new ZipWriter({ outputAs: "uint8array", level });
      writer.writeSync({ path: "out.bin", data: originalData, method: "deflate" });
      const archive = writer.closeSync();

      // (1) JSZipp's own inflater must round-trip it.
      const back = await openZip(archive);
      const out = back.get("out.bin");
      expect(out, `entry should exist for level ${level}`).toBeDefined();
      const readBack = await out!.bytes();
      expect(readBack.length, `size should match for level ${level}`).toBe(
        originalData.length
      );
      expect(
        Buffer.from(readBack).equals(Buffer.from(originalData)),
        `data should round-trip for level ${level}`
      ).toBe(true);

      // (2) Node's reference zlib must accept the same raw DEFLATE payload.
      const payload = extractDeflatePayload(archive, out!.compressedSize);
      const inflated = inflateRawSync(payload);
      expect(inflated.length, `zlib inflated size for level ${level}`).toBe(
        originalData.length
      );
      expect(
        inflated.equals(Buffer.from(originalData)),
        `zlib inflated data for level ${level}`
      ).toBe(true);

      await back.close();
    }

    await reader.close();
  });
});
