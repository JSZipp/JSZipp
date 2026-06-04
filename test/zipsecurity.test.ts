import { describe, expect, it } from "vitest";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { openZip, ZipWriter } from "../src/index";

type TestBytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ZlibValidatedEntry = {
  path: string;
  data: TestBytes;
  crc32: number;
  compressedSize: number;
  size: number;
};

/**
 * These helpers intentionally hand-build ZIP records instead of using ZipWriter.
 * The regressions in this file depend on malformed or adversarial archive
 * layouts that a normal writer should never emit: fake EOCD signatures inside
 * comments, appended fake EOCD records, and unsafe path byte sequences. Building
 * the bytes directly keeps each test focused on reader behavior.
 */
const pushU16 = (out: number[], value: number): void => {
  out.push(value & 0xff, (value >>> 8) & 0xff);
};

const pushU32 = (out: number[], value: number): void => {
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
};

const pushBytes = (out: number[], bytes: Uint8Array | number[]): void => {
  for (const byte of bytes) out.push(byte);
};

// Builds a minimal, fully valid single-entry archive (stored "hi") whose entry
// path is exactly `entryPath`. We use this for path-security tests because the
// reader must defend itself even when an archive was not produced by our writer.
// If the test used ZipWriter, writer-side normalization could hide a reader bug.
const buildStoredSingleEntryZip = (entryPath: string): TestBytes => {
  const data = encoder.encode("hi");
  const name = encoder.encode(entryPath);
  const crc = crc32(data) >>> 0;
  const out: number[] = [];

  pushU32(out, 0x04034b50);
  pushU16(out, 20);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU32(out, crc);
  pushU32(out, data.length);
  pushU32(out, data.length);
  pushU16(out, name.length);
  pushU16(out, 0);
  pushBytes(out, name);
  pushBytes(out, data);

  const cdOffset = out.length;
  pushU32(out, 0x02014b50);
  pushU16(out, 20);
  pushU16(out, 20);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU32(out, crc);
  pushU32(out, data.length);
  pushU32(out, data.length);
  pushU16(out, name.length);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU32(out, 0);
  pushU32(out, 0);
  pushBytes(out, name);
  const cdSize = out.length - cdOffset;

  pushU32(out, 0x06054b50);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, 1);
  pushU16(out, 1);
  pushU32(out, cdSize);
  pushU32(out, cdOffset);
  pushU16(out, 0);

  return new Uint8Array(out) as TestBytes;
};

/**
 * Builds a structurally valid archive containing one real entry, `real.txt`.
 * The real EOCD record has an archive comment that begins with another EOCD:
 *
 *   [local header + compressed "hi"]
 *   [central directory: one record for real.txt]
 *   [real EOCD: declares one entry, comment = fake EOCD + "trail"]
 *
 * Buggy situation:
 * A naive reader scans backward for EOCD signatures and accepts the first
 * EOCD-shaped byte sequence whose comment length reaches EOF. Since the fake
 * EOCD lives later in the file than the real EOCD, that reader picks the fake
 * empty central directory and returns no entries, even though zlib can validate
 * and inflate the real `real.txt` entry.
 */
const buildArchiveWithFakeEocdInComment = (): TestBytes => {
  const data = encoder.encode("hi");
  const compressed = new Uint8Array(deflateRawSync(data)) as TestBytes;
  const name = encoder.encode("real.txt");
  const crc = crc32(data) >>> 0;
  const out: number[] = [];

  const localOffset = out.length;
  pushU32(out, 0x04034b50);
  pushU16(out, 20);
  pushU16(out, 0);
  pushU16(out, 8);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU32(out, crc);
  pushU32(out, compressed.length);
  pushU32(out, data.length);
  pushU16(out, name.length);
  pushU16(out, 0);
  pushBytes(out, name);
  pushBytes(out, compressed);

  const cdOffset = out.length;
  pushU32(out, 0x02014b50);
  pushU16(out, 20);
  pushU16(out, 20);
  pushU16(out, 0);
  pushU16(out, 8);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU32(out, crc);
  pushU32(out, compressed.length);
  pushU32(out, data.length);
  pushU16(out, name.length);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU32(out, 0);
  pushU32(out, localOffset);
  pushBytes(out, name);
  const cdSize = out.length - cdOffset;

  // This fake EOCD is just data in the real archive comment. It is crafted to
  // look self-contained: its own comment length points to EOF, so a scanner that
  // checks only "does this EOCD end at EOF?" will accept it before the real EOCD.
  const trail = encoder.encode("trail");
  const fake: number[] = [];
  pushU32(fake, 0x06054b50);
  pushU16(fake, 0);
  pushU16(fake, 0);
  pushU16(fake, 0);
  pushU16(fake, 0);
  pushU32(fake, 0);
  pushU32(fake, 0);
  pushU16(fake, trail.length);
  pushBytes(fake, trail);

  pushU32(out, 0x06054b50);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, 1);
  pushU16(out, 1);
  pushU32(out, cdSize);
  pushU32(out, cdOffset);
  pushU16(out, fake.length);
  pushBytes(out, fake);

  return new Uint8Array(out) as TestBytes;
};

const findStructurallyValidEocd = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(0, bytes.length - 22 - 0xffff);

  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;

    const cdSize = view.getUint32(offset + 12, true);
    const cdOffset = view.getUint32(offset + 16, true);
    const commentLength = view.getUint16(offset + 20, true);

    if (offset + 22 + commentLength === bytes.length && cdOffset + cdSize === offset) return offset;
  }

  throw new Error("structurally valid end of central directory not found");
};

// Independent validation for the first EOCD test. It parses the archive shape
// the way a structure-aware ZIP reader should: the selected EOCD must point to a
// central directory that ends exactly where the EOCD begins. Node's zlib is used
// only to verify the deflated payload bytes; the production reader is not used.
const parseZipWithZlib = (bytes: Uint8Array): { comment: string; entries: ZlibValidatedEntry[] } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findStructurallyValidEocd(bytes);
  const entryCount = view.getUint16(eocd + 10, true);
  const commentLength = view.getUint16(eocd + 20, true);
  const entries: ZlibValidatedEntry[] = [];
  let offset = view.getUint32(eocd + 16, true);

  for (let index = 0; index < entryCount; index++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);

    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const pathLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const pathStart = offset + 46;
    const path = decoder.decode(bytes.subarray(pathStart, pathStart + pathLength));

    expect(method).toBe(8);
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);

    const localPathLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const compressedStart = localOffset + 30 + localPathLength + localExtraLength;
    const compressed = bytes.subarray(compressedStart, compressedStart + compressedSize);
    const data = new Uint8Array(inflateRawSync(compressed)) as TestBytes;

    expect(data.length).toBe(size);
    expect(crc32(data) >>> 0).toBe(crc);

    entries.push({ path, data, crc32: crc, compressedSize, size });
    offset = pathStart + pathLength + extraLength + entryCommentLength;
  }

  return {
    comment: decoder.decode(bytes.subarray(eocd + 22, eocd + 22 + commentLength)),
    entries
  };
};

describe("ZIP reader EOCD forgery regressions", () => {
  it("selects the real EOCD when an archive comment starts with a fake EOCD", async () => {
    const bytes = buildArchiveWithFakeEocdInComment();
    const zlibValidated = parseZipWithZlib(bytes);

    expect(zlibValidated.entries).toHaveLength(1);
    expect(zlibValidated.entries[0]).toMatchObject({
      path: "real.txt",
      size: 2,
      crc32: crc32(encoder.encode("hi")) >>> 0
    });
    expect(decoder.decode(zlibValidated.entries[0].data)).toBe("hi");

    const reader = await openZip(bytes);

    // The fake EOCD's archive comment is "trail". If this regresses, the reader
    // will report `comment === "trail"`, `entries === []`, and no `real.txt`.
    // Correct behavior chooses the real EOCD because its central directory
    // describes actual records that end at that EOCD.
    expect(reader.comment).not.toBe("trail");
    expect(reader.entries.map((entry) => entry.path)).toEqual(["real.txt"]);
    expect(reader.get("real.txt")).not.toBeUndefined();
  });

  it("does not let a fake legacy EOCD preempt real Zip64 records", async () => {
    // Zip64 archives use a legacy EOCD as a compatibility shim. Its count/size
    // fields may be 0xFFFF / 0xFFFFFFFF sentinels, and the real values live in
    // the Zip64 EOCD reached via the Zip64 locator.
    //
    // Buggy situation:
    // A reader that accepts a fake non-Zip64 legacy EOCD inside the real archive
    // comment can skip Zip64 handling completely and conclude that the archive
    // has zero entries. The real Zip64 records must win.
    const writer = new ZipWriter({ outputAs: "uint8array", level: 0, zip64: "force" });
    await writer.add({ path: "real.txt", data: "hi" });
    const base = new Uint8Array(await writer.close()) as TestBytes;
    const baseView = new DataView(base.buffer, base.byteOffset, base.byteLength);
    let legacy = -1;

    for (let offset = base.length - 22; offset >= 0; offset--) {
      if (baseView.getUint32(offset, true) === 0x06054b50) {
        legacy = offset;
        break;
      }
    }

    // Plant a fake legacy EOCD into the real legacy EOCD's comment. The fake has
    // no Zip64 sentinels and declares zero entries, so it is attractive to a
    // simplistic parser that does not preserve the Zip64 locator relationship.
    const trail = [...encoder.encode("trail")];
    const fake: number[] = [];
    pushU32(fake, 0x06054b50);
    pushU16(fake, 0);
    pushU16(fake, 0);
    pushU16(fake, 0);
    pushU16(fake, 0);
    pushU32(fake, 0);
    pushU32(fake, 0);
    pushU16(fake, trail.length);
    pushBytes(fake, trail);

    const head = base.slice(0, legacy + 22);
    const archive = new Uint8Array(head.length + fake.length) as TestBytes;
    archive.set(head, 0);
    archive.set(fake, head.length);
    new DataView(archive.buffer).setUint16(legacy + 20, fake.length, true);

    const reader = await openZip(archive);
    expect(reader.entries.map((entry) => entry.path)).toEqual(["real.txt"]);
  });

  it("rejects a fake EOCD that anchors an empty central directory to itself", async () => {
    // This is stricter than the first fake-comment case. The fake EOCD does not
    // merely end at EOF; it also claims that its central directory has size zero
    // and starts at the fake EOCD's own offset.
    //
    // Buggy situation:
    // A parser with a simple adjacency check accepts the fake because
    // `centralDirectoryOffset + 0 === fakeEocdOffset`. The empty central
    // directory walk then trivially succeeds, and the real file is hidden.
    const data = encoder.encode("hi");
    const name = encoder.encode("real.txt");
    const crc = crc32(data) >>> 0;
    const out: number[] = [];

    pushU32(out, 0x04034b50);
    pushU16(out, 20);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU32(out, crc);
    pushU32(out, data.length);
    pushU32(out, data.length);
    pushU16(out, name.length);
    pushU16(out, 0);
    pushBytes(out, name);
    pushBytes(out, data);

    const cdOffset = out.length;
    pushU32(out, 0x02014b50);
    pushU16(out, 20);
    pushU16(out, 20);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU32(out, crc);
    pushU32(out, data.length);
    pushU32(out, data.length);
    pushU16(out, name.length);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU32(out, 0);
    pushU32(out, 0);
    pushBytes(out, name);
    const cdSize = out.length - cdOffset;

    // The fake EOCD starts at the first byte of the real EOCD comment. Its
    // central-directory offset is deliberately set to that same position.
    const realEocdOffset = out.length;
    const fakeOffset = realEocdOffset + 22;
    const trail = encoder.encode("trail");
    const fake: number[] = [];
    pushU32(fake, 0x06054b50);
    pushU16(fake, 0);
    pushU16(fake, 0);
    pushU16(fake, 0);
    pushU16(fake, 0);
    pushU32(fake, 0);
    pushU32(fake, fakeOffset);
    pushU16(fake, trail.length);
    pushBytes(fake, trail);

    pushU32(out, 0x06054b50);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 1);
    pushU16(out, 1);
    pushU32(out, cdSize);
    pushU32(out, cdOffset);
    pushU16(out, fake.length);
    pushBytes(out, fake);

    const reader = await openZip(new Uint8Array(out) as TestBytes);
    expect(reader.entries.map((entry) => entry.path)).toEqual(["real.txt"]);
  });

  it("does not let trailing appended bytes erase a complete archive's entries", async () => {
    // A complete ZIP can have arbitrary bytes appended by accident or by an
    // attacker. Here the appended bytes are a fake EOCD that declares an empty
    // central directory and a one-byte comment.
    //
    // Buggy situation:
    // A reader that treats the last EOCD-shaped record as authoritative chooses
    // the appended fake record, replacing the real archive contents with
    // `entries === []` and `comment === "X"`.
    const base = buildStoredSingleEntryZip("real.txt");
    const trail = [...encoder.encode("X")];
    const fake: number[] = [];

    pushU32(fake, 0x06054b50);
    pushU16(fake, 0);
    pushU16(fake, 0);
    pushU16(fake, 0);
    pushU16(fake, 0);
    pushU32(fake, 0);
    pushU32(fake, 0);
    pushU16(fake, trail.length);
    pushBytes(fake, trail);

    const archive = new Uint8Array(base.length + fake.length) as TestBytes;
    archive.set(base, 0);
    archive.set(fake, base.length);

    const reader = await openZip(archive);
    expect(reader.entries.map((entry) => entry.path)).toEqual(["real.txt"]);
  });
});

describe("ZIP reader strict path validation regressions", () => {
  // jszipp returns in-memory entry paths; it does not write files to disk.
  // These are still reader-level defenses because many consumers will pass
  // returned paths to an extractor. The default strict mode should reject names
  // that are dangerous for naive filesystem extraction.

  it("rejects a Windows drive-relative path", async () => {
    // Buggy behavior: `C:evil` was accepted because the old drive-letter check
    // only matched paths with a slash after the colon. A naive Windows extractor
    // can still resolve this relative to the current directory on drive C,
    // outside the intended extraction root.
    await expect(openZip(buildStoredSingleEntryZip("C:evil"))).rejects.toThrow(/unsafe zip entry path/i);
  });

  it("rejects an embedded NUL byte in a path", async () => {
    // Buggy behavior: paths containing NUL bytes were accepted. Some filesystem
    // boundaries can treat NUL as a terminator, so `evil\0.txt` may be observed
    // downstream as just `evil`. Rejecting it in strict mode prevents a mismatch
    // between the path the ZIP reader displays and the path an extractor writes.
    await expect(openZip(buildStoredSingleEntryZip("evil\u0000.txt"))).rejects.toThrow(/unsafe zip entry path/i);
  });
});
