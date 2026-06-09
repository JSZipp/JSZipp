import { describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import { openZip } from "../src/index";

type TestBytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();

const u16 = (out: number[], value: number): void => {
  out.push(value & 0xff, (value >>> 8) & 0xff);
};

const u32 = (out: number[], value: number): void => {
  out.push(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  );
};

const raw = (out: number[], bytes: Uint8Array | number[]): void => {
  for (const byte of bytes) out.push(byte);
};

interface Zip64SentinelSpec {
  centralCompressedSize?: number;
  centralUncompressedSize?: number;
  centralLocalHeaderOffset?: number;
}

/**
 * Builds a tiny single-file ZIP with normal local-file-header data, but with
 * selected central-directory fields patched to 0xffffffff.
 *
 * This reproduces the yauzl #109 parser condition without needing a real
 * 4 GiB fixture.
 */
const buildZip64SentinelWithoutZip64Extra = (
  spec: Zip64SentinelSpec
): TestBytes => {
  const out: number[] = [];

  const name = enc.encode("hello.txt");
  const data = enc.encode("hello");
  const crc = crc32(data) >>> 0;

  const localHeaderOffset = out.length;

  // Local file header.
  u32(out, 0x04034b50);
  u16(out, 20); // version needed
  u16(out, 0); // flags
  u16(out, 0); // method: store
  u16(out, 0); // time
  u16(out, 0); // date
  u32(out, crc);
  u32(out, data.length);
  u32(out, data.length);
  u16(out, name.length);
  u16(out, 0); // local extra length: intentionally no Zip64 extra
  raw(out, name);
  raw(out, data);

  const centralDirectoryOffset = out.length;

  // Central directory file header.
  u32(out, 0x02014b50);
  u16(out, 20); // version made by
  u16(out, 20); // version needed
  u16(out, 0); // flags
  u16(out, 0); // method: store
  u16(out, 0); // time
  u16(out, 0); // date
  u32(out, crc);

  // These are the fields involved in yauzl #109.
  u32(out, spec.centralCompressedSize ?? data.length);
  u32(out, spec.centralUncompressedSize ?? data.length);

  u16(out, name.length);
  u16(out, 0); // central extra length: intentionally no Zip64 extra
  u16(out, 0); // file comment length
  u16(out, 0); // disk number start
  u16(out, 0); // internal attrs
  u32(out, 0); // external attrs
  u32(out, spec.centralLocalHeaderOffset ?? localHeaderOffset);

  raw(out, name);

  const centralDirectorySize = out.length - centralDirectoryOffset;

  // End of central directory.
  u32(out, 0x06054b50);
  u16(out, 0); // disk number
  u16(out, 0); // central directory disk
  u16(out, 1); // entries on this disk
  u16(out, 1); // total entries
  u32(out, centralDirectorySize);
  u32(out, centralDirectoryOffset);
  u16(out, 0); // archive comment length

  return new Uint8Array(out) as TestBytes;
};

describe("yauzl #109 compatibility — 0xffffffff central-directory sentinels without Zip64 extra", () => {
  it("does not require a Zip64 extra field only because central uncompressedSize is 0xffffffff", async () => {
    const zipBytes = buildZip64SentinelWithoutZip64Extra({
      centralUncompressedSize: 0xffffffff
    });

    const zip = await openZip(zipBytes);

    expect(zip.get("hello.txt")).toBeDefined();
    expect(await zip.get("hello.txt")?.text()).toBe("hello");

    await zip.close();
  });

  it("does not require a Zip64 extra field only because central compressedSize is 0xffffffff", async () => {
    const zipBytes = buildZip64SentinelWithoutZip64Extra({
      centralCompressedSize: 0xffffffff
    });

    const zip = await openZip(zipBytes);

    expect(zip.get("hello.txt")).toBeDefined();
    expect(await zip.get("hello.txt")?.text()).toBe("hello");

    await zip.close();
  });

  it("throws when the central local-header offset is 0xffffffff and the ZIP64 offset is missing", async () => {
    const zipBytes = buildZip64SentinelWithoutZip64Extra({
      centralLocalHeaderOffset: 0xffffffff
    });

    await expect(openZip(zipBytes)).rejects.toThrow(/ZIP64 local header offset is missing/i);
  });
});
