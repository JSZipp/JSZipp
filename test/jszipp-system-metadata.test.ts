import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZipWriter } from "../src/index";

type TestBytes = Uint8Array<ArrayBuffer>;

type ExpectedEntry = {
  path: string;
  localHeaderOffset: number;
  createdZipSpec: number;
  createdOs: number;
  extractZipSpec: number;
  extractOs: number;
  flags: number;
  method: 0 | 8;
  lastModTime: string;
  compressedSize: number;
  size: number;
  crc32: string;
  filenameLength: number;
  localExtraLength: number;
  centralExtraLength: number;
  commentLength: number;
  diskStart: number;
  internalAttributes: number;
  externalAttributes: number;
};

type ExpectedArchive = {
  size: number;
  entryCount: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  commentLength: number;
  entries: ExpectedEntry[];
};

type ZipinfoEntry = Pick<ExpectedEntry,
  "path" | "localHeaderOffset" | "extractZipSpec" | "flags" | "method" | "compressedSize" |
  "size" | "crc32" | "filenameLength" | "centralExtraLength" | "commentLength" | "diskStart" |
  "externalAttributes"
> & {
  encrypted: boolean;
  extendedLocalHeader: boolean;
  fileType: "binary" | "text";
  toolMethod: string;
};

type ZipinfoArchive = Pick<ExpectedArchive, "size" | "entryCount" | "centralDirectoryOffset" | "centralDirectorySize"> & {
  entries: ZipinfoEntry[];
};

type ZipdetailsEntry = ExpectedEntry & {
  toolMethod: string;
};

type ZipdetailsArchive = ExpectedArchive & {
  entries: ZipdetailsEntry[];
};

const commandPath = (name: string): string | undefined => {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const zipinfo = commandPath("zipinfo");
const zipdetails = commandPath("zipdetails");
const describeIfZipToolsExist = zipinfo && zipdetails ? describe : describe.skip;

const byteArray = (bytes: ArrayBuffer | Uint8Array): TestBytes =>
  bytes instanceof Uint8Array ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) as TestBytes : new Uint8Array(bytes) as TestBytes;

const seededRandomBytes = (seed: number, length: number): TestBytes => {
  const bytes = new Uint8Array(length) as TestBytes;
  let state = seed >>> 0;

  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }

  return bytes;
};

const methodFromText = (method: string): 0 | 8 => {
  const normalized = method.toLowerCase();
  if (normalized.includes("deflat")) return 8;
  if (normalized.includes("stor") || normalized === "none") return 0;
  throw new Error(`unexpected compression method: ${method}`);
};

const methodName = (method: 0 | 8): string => method === 8 ? "deflated" : "stored";

const hex8 = (value: number): string => value.toString(16).toUpperCase().padStart(8, "0");

const eocdOffset = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(0, bytes.length - 22 - 0xffff);

  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }

  throw new Error("end of central directory not found");
};

const expectedArchive = (bytes: Uint8Array): ExpectedArchive => {
  const decoder = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = eocdOffset(bytes);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralDirectorySize = view.getUint32(eocd + 12, true);
  const centralDirectoryOffset = view.getUint32(eocd + 16, true);
  const entries: ExpectedEntry[] = [];
  let offset = centralDirectoryOffset;

  while (offset <= bytes.length - 46 && view.getUint32(offset, true) === 0x02014b50) {
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const pathLength = view.getUint16(offset + 28, true);
    const centralExtraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const pathStart = offset + 46;
    const path = decoder.decode(bytes.subarray(pathStart, pathStart + pathLength));

    entries.push({
      path,
      localHeaderOffset,
      createdZipSpec: view.getUint8(offset + 4),
      createdOs: view.getUint8(offset + 5),
      extractZipSpec: view.getUint8(offset + 6),
      extractOs: view.getUint8(offset + 7),
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true) as 0 | 8,
      lastModTime: hex8(view.getUint32(offset + 12, true)),
      crc32: hex8(view.getUint32(offset + 16, true)).toLowerCase(),
      compressedSize: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      filenameLength: pathLength,
      localExtraLength: view.getUint16(localHeaderOffset + 28, true),
      centralExtraLength,
      commentLength,
      diskStart: view.getUint16(offset + 34, true),
      internalAttributes: view.getUint16(offset + 36, true),
      externalAttributes: view.getUint32(offset + 38, true)
    });
    offset = pathStart + pathLength + centralExtraLength + commentLength;
  }

  expect(entries).toHaveLength(entryCount);
  return {
    size: bytes.length,
    entryCount,
    centralDirectoryOffset,
    centralDirectorySize,
    commentLength: view.getUint16(eocd + 20, true),
    entries
  };
};

const expectedLocalEntries = (archive: ExpectedArchive, bytes: Uint8Array): ExpectedEntry[] => {
  const decoder = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return archive.entries.map((central) => {
    const offset = central.localHeaderOffset;
    const pathLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const pathStart = offset + 30;
    const path = decoder.decode(bytes.subarray(pathStart, pathStart + pathLength));

    return {
      path,
      localHeaderOffset: offset,
      createdZipSpec: central.createdZipSpec,
      createdOs: central.createdOs,
      extractZipSpec: view.getUint8(offset + 4),
      extractOs: view.getUint8(offset + 5),
      flags: view.getUint16(offset + 6, true),
      method: view.getUint16(offset + 8, true) as 0 | 8,
      lastModTime: hex8(view.getUint32(offset + 10, true)),
      crc32: hex8(view.getUint32(offset + 14, true)).toLowerCase(),
      compressedSize: view.getUint32(offset + 18, true),
      size: view.getUint32(offset + 22, true),
      filenameLength: pathLength,
      localExtraLength: extraLength,
      centralExtraLength: central.centralExtraLength,
      commentLength: central.commentLength,
      diskStart: central.diskStart,
      internalAttributes: central.internalAttributes,
      externalAttributes: central.externalAttributes
    };
  });
};

const parseZipinfo = (output: string): ZipinfoArchive => {
  const archiveSize = Number(/Zip archive file size:\s+(\d+)/.exec(output)?.[1] ?? NaN);
  const entryCount = Number(/central directory contains\s+(\d+)\s+entr(?:y|ies)/.exec(output)?.[1] ?? NaN);
  const centralDirectorySize = Number(/The central directory is\s+(\d+)/.exec(output)?.[1] ?? NaN);
  const centralDirectoryOffset = Number(/offset in bytes from the beginning of the zipfile\s+is\s+(\d+)/.exec(output)?.[1] ?? NaN);
  const entries = output
    .split(/\nCentral directory entry #\d+:\n-+\n/)
    .slice(1)
    .map((block): ZipinfoEntry => {
      const path = /\n\s{2}(.+?)\n\n\s+offset of local header/m.exec(block)?.[1];
      const localHeaderOffset = Number(/offset of local header from start of archive:\s+(\d+)/.exec(block)?.[1] ?? NaN);
      const extractVersionText = /minimum software version required to extract:\s+(\d+)\.(\d+)/.exec(block);
      const toolMethod = /compression method:\s+(.+)/.exec(block)?.[1]?.trim();
      const encrypted = /file security status:\s+(.+)/.exec(block)?.[1]?.trim() === "encrypted";
      const extendedLocalHeader = /extended local header:\s+(.+)/.exec(block)?.[1]?.trim() === "yes";
      const crc = /32-bit CRC value \(hex\):\s+([0-9a-fA-F]{8})/.exec(block)?.[1];
      const compressedSize = Number(/compressed size:\s+(\d+)\s+bytes/.exec(block)?.[1] ?? NaN);
      const size = Number(/uncompressed size:\s+(\d+)\s+bytes/.exec(block)?.[1] ?? NaN);
      const filenameLength = Number(/length of filename:\s+(\d+)\s+characters/.exec(block)?.[1] ?? NaN);
      const centralExtraLength = Number(/length of extra field:\s+(\d+)\s+bytes/.exec(block)?.[1] ?? NaN);
      const commentLength = Number(/length of file comment:\s+(\d+)\s+characters/.exec(block)?.[1] ?? NaN);
      const diskStart = Number(/disk number on which file begins:\s+disk\s+(\d+)/.exec(block)?.[1] ?? NaN) - 1;
      const fileType = /apparent file type:\s+(.+)/.exec(block)?.[1]?.trim() as "binary" | "text" | undefined;
      const externalAttributes = Number.parseInt(/Unix file attributes \(([0-7]+) octal\)/.exec(block)?.[1] ?? "", 8) << 16;

      if (!path || !extractVersionText || !toolMethod || !crc || !fileType || !Number.isFinite(localHeaderOffset) ||
        !Number.isFinite(compressedSize) || !Number.isFinite(size) || !Number.isFinite(filenameLength) ||
        !Number.isFinite(centralExtraLength) || !Number.isFinite(commentLength) || !Number.isFinite(diskStart) ||
        !Number.isFinite(externalAttributes)) {
        throw new Error(`could not parse zipinfo output block:\n${block}`);
      }

      const method = methodFromText(toolMethod);
      return {
        path,
        localHeaderOffset,
        extractZipSpec: Number(extractVersionText[1]) * 10 + Number(extractVersionText[2]),
        flags: (encrypted ? 1 : 0) | (extendedLocalHeader ? 8 : 0) | 0x0800,
        method,
        toolMethod: methodName(method),
        encrypted,
        extendedLocalHeader,
        crc32: crc.toLowerCase(),
        compressedSize,
        size,
        filenameLength,
        centralExtraLength,
        commentLength,
        diskStart,
        externalAttributes,
        fileType
      };
    });

  expect(Number.isFinite(archiveSize)).toBe(true);
  expect(Number.isFinite(centralDirectorySize)).toBe(true);
  expect(Number.isFinite(centralDirectoryOffset)).toBe(true);
  expect(entries).toHaveLength(entryCount);
  return { size: archiveSize, entryCount, centralDirectoryOffset, centralDirectorySize, entries };
};

const parseZipdetailsEntries = (output: string, section: "LOCAL" | "CENTRAL"): ZipdetailsEntry[] => {
  return output
    .split(/(?=^[0-9A-F]{4,}.*(?:LOCAL|CENTRAL|END CENTRAL) HEADER)/m)
    .filter((block) => new RegExp(`^[0-9A-F]{4,}.*${section} HEADER #\\d+`, "m").test(block))
    .filter((block) => /Compression Method/.test(block))
    .filter((block) => section === "LOCAL" ? !/Created Zip Spec/.test(block) : /Created Zip Spec/.test(block))
    .map((block): ZipdetailsEntry => {
      const path = /Filename\s+'([^']+)'/.exec(block)?.[1];
      const method = /Compression Method\s+([0-9A-F]{4})\s+'([^']+)'/.exec(block);
      const crc = /CRC\s+([0-9A-F]{8})/.exec(block)?.[1];
      const compressedSize = Number.parseInt(/Compressed Length\s+([0-9A-F]{8})/.exec(block)?.[1] ?? "", 16);
      const size = Number.parseInt(/Uncompressed Length\s+([0-9A-F]{8})/.exec(block)?.[1] ?? "", 16);
      const filenameLength = Number.parseInt(/Filename Length\s+([0-9A-F]{4})/.exec(block)?.[1] ?? "", 16);
      const localExtraLength = Number.parseInt(/Extra Length\s+([0-9A-F]{4})/.exec(block)?.[1] ?? "", 16);
      const centralExtraLength = section === "CENTRAL" ? localExtraLength : 0;
      const commentLength = section === "CENTRAL" ? Number.parseInt(/Comment Length\s+([0-9A-F]{4})/.exec(block)?.[1] ?? "", 16) : 0;
      const diskStart = section === "CENTRAL" ? Number.parseInt(/Disk Start\s+([0-9A-F]{4})/.exec(block)?.[1] ?? "", 16) : 0;
      const internalAttributes = section === "CENTRAL" ? Number.parseInt(/Int File Attributes\s+([0-9A-F]{4})/.exec(block)?.[1] ?? "", 16) : 0;
      const externalAttributes = section === "CENTRAL" ? Number.parseInt(/Ext File Attributes\s+([0-9A-F]{8})/.exec(block)?.[1] ?? "", 16) : 0;
      const localHeaderOffset = section === "CENTRAL" ? Number.parseInt(/Local Header Offset\s+([0-9A-F]{8})/.exec(block)?.[1] ?? "", 16) : 0;
      const created = section === "CENTRAL" ? /Created Zip Spec\s+([0-9A-F]{2})/.exec(block)?.[1] : undefined;
      const createdOs = section === "CENTRAL" ? /Created OS\s+([0-9A-F]{2})/.exec(block)?.[1] : undefined;
      const extract = /Extract Zip Spec\s+([0-9A-F]{2})/.exec(block)?.[1];
      const extractOs = /Extract OS\s+([0-9A-F]{2})/.exec(block)?.[1];
      const flags = /General Purpose Flag\s+([0-9A-F]{4})/.exec(block)?.[1];
      const lastModTime = /Last Mod Time\s+([0-9A-F]{8})/.exec(block)?.[1];

      if (!path || !method || !crc || !extract || !extractOs || !flags || !lastModTime ||
        !Number.isFinite(compressedSize) || !Number.isFinite(size) || !Number.isFinite(filenameLength) ||
        !Number.isFinite(localExtraLength) || (section === "CENTRAL" && (!created || !createdOs ||
          !Number.isFinite(commentLength) || !Number.isFinite(diskStart) || !Number.isFinite(internalAttributes) ||
          !Number.isFinite(externalAttributes) || !Number.isFinite(localHeaderOffset)))) {
        throw new Error(`could not parse zipdetails ${section} block:\n${block}`);
      }

      return {
        path,
        localHeaderOffset,
        createdZipSpec: created ? Number.parseInt(created, 16) : 0,
        createdOs: createdOs ? Number.parseInt(createdOs, 16) : 0,
        extractZipSpec: Number.parseInt(extract, 16),
        extractOs: Number.parseInt(extractOs, 16),
        flags: Number.parseInt(flags, 16),
        method: Number.parseInt(method[1], 16) as 0 | 8,
        toolMethod: methodName(Number.parseInt(method[1], 16) as 0 | 8),
        lastModTime,
        crc32: crc.toLowerCase(),
        compressedSize,
        size,
        filenameLength,
        localExtraLength,
        centralExtraLength,
        commentLength,
        diskStart,
        internalAttributes,
        externalAttributes
      };
    });
};

const parseZipdetails = (output: string): ZipdetailsArchive => {
  const entriesInDisk = Number.parseInt(/Entries in this disk\s+([0-9A-F]{4})/.exec(output)?.[1] ?? "", 16);
  const entryCount = Number.parseInt(/Total Entries\s+([0-9A-F]{4})/.exec(output)?.[1] ?? "", 16);
  const centralDirectorySize = Number.parseInt(/Size of Central Dir\s+([0-9A-F]{8})/.exec(output)?.[1] ?? "", 16);
  const centralDirectoryOffset = Number.parseInt(/Offset to Central Dir\s+([0-9A-F]{8})/.exec(output)?.[1] ?? "", 16);
  const commentLength = Number.parseInt(/Comment Length\s+([0-9A-F]{4})/.exec(output)?.[1] ?? "", 16);
  const centralEntries = parseZipdetailsEntries(output, "CENTRAL");
  const localEntries = parseZipdetailsEntries(output, "LOCAL");

  expect(entriesInDisk).toBe(entryCount);
  expect(centralEntries).toHaveLength(entryCount);
  expect(localEntries).toHaveLength(entryCount);

  return {
    size: centralDirectoryOffset + centralDirectorySize + 22 + commentLength,
    entryCount,
    centralDirectoryOffset,
    centralDirectorySize,
    commentLength,
    entries: centralEntries.map((entry, index) => ({
      ...entry,
      localExtraLength: localEntries[index].localExtraLength
    }))
  };
};

const runZipTool = (tool: string, args: string[]): string =>
  execFileSync(tool, args, {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C", LC_CTYPE: "C" },
    stdio: ["ignore", "pipe", "pipe"]
  });

const buildArchive = async (
  entries: { path: string; data: string | TestBytes; method: "store" | "deflate" }[]
): Promise<TestBytes> => {
  const writer = new ZipWriter({ outputAs: "uint8array", zip64: "off", level: 6, timestamps: 0 });

  for (const entry of entries) {
    await writer.add(entry);
  }

  return byteArray(await writer.close());
};

const expectedZipinfoArchive = (archive: ExpectedArchive): ZipinfoArchive => ({
  size: archive.size,
  entryCount: archive.entryCount,
  centralDirectoryOffset: archive.centralDirectoryOffset,
  centralDirectorySize: archive.centralDirectorySize,
  entries: archive.entries.map((entry) => ({
    path: entry.path,
    localHeaderOffset: entry.localHeaderOffset,
    extractZipSpec: entry.extractZipSpec,
    flags: entry.flags,
    method: entry.method,
    toolMethod: methodName(entry.method),
    encrypted: (entry.flags & 1) !== 0,
    extendedLocalHeader: (entry.flags & 8) !== 0,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    size: entry.size,
    filenameLength: entry.filenameLength,
    centralExtraLength: entry.centralExtraLength,
    commentLength: entry.commentLength,
    diskStart: entry.diskStart,
    externalAttributes: entry.externalAttributes,
    fileType: (entry.internalAttributes & 1) !== 0 ? "text" : "binary"
  }))
});

const expectedZipdetailsArchive = (archive: ExpectedArchive): ZipdetailsArchive => ({
  ...archive,
  entries: archive.entries.map((entry) => ({ ...entry, toolMethod: methodName(entry.method) }))
});

const assertToolMetadataMatches = async (
  name: string,
  entries: { path: string; data: string | TestBytes; method: "store" | "deflate" }[]
): Promise<void> => {
  const archive = await buildArchive(entries);
  const dir = mkdtempSync(join(tmpdir(), "jszipp-metadata-"));
  const archivePath = join(dir, `${name}.zip`);

  try {
    writeFileSync(archivePath, archive);
    const expected = expectedArchive(archive);
    const zipinfoArchive = parseZipinfo(runZipTool(zipinfo!, ["-v", archivePath]));
    const zipdetailsArchive = parseZipdetails(runZipTool(zipdetails!, ["-v", archivePath]));

    expect(zipinfoArchive, "zipinfo -v").toEqual(expectedZipinfoArchive(expected));
    expect(zipdetailsArchive, "zipdetails -v").toEqual(expectedZipdetailsArchive(expected));
    expect(zipdetailsArchive.entries.map(({ toolMethod: _toolMethod, ...entry }: ZipdetailsEntry) => entry), "central vs local headers")
      .toEqual(expected.entries);
    expect(expectedLocalEntries(expected, archive), "local headers vs central headers").toEqual(expected.entries);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describeIfZipToolsExist("JSZipp system-tool compression metadata", () => {
  it("matches zipinfo and zipdetails for a single stored file", async () => {
    await assertToolMetadataMatches("single-store", [
      { path: "single-stored.txt", data: "stored payload\n", method: "store" }
    ]);
  });

  it("matches zipinfo and zipdetails for a single deflated file", async () => {
    await assertToolMetadataMatches("single-deflate", [
      { path: "single-deflated.txt", data: "deflate me ".repeat(512), method: "deflate" }
    ]);
  });

  it("matches zipinfo and zipdetails for multiple stored files", async () => {
    await assertToolMetadataMatches("multi-store", [
      { path: "stored/a.txt", data: "alpha\n", method: "store" },
      { path: "stored/b.bin", data: seededRandomBytes(0x5a17e, 257), method: "store" },
      { path: "stored/c.txt", data: "gamma\n".repeat(3), method: "store" }
    ]);
  });

  it("matches zipinfo and zipdetails for multiple deflated files", async () => {
    await assertToolMetadataMatches("multi-deflate", [
      { path: "deflated/a.txt", data: "alpha ".repeat(300), method: "deflate" },
      { path: "deflated/b.txt", data: "bravo ".repeat(450), method: "deflate" },
      { path: "deflated/c.bin", data: seededRandomBytes(0xdef1a7e, 128), method: "deflate" }
    ]);
  });
});
