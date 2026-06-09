import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";
import * as yauzl from "yauzl";
import * as yazl from "yazl";
import { openZip, TimestampMode, ZipWriter, type ZipRandomAccessEntry } from "../src/index";

const encoder = new TextEncoder();
type TestBytes = Uint8Array<ArrayBuffer>;

type InteropEntry = {
  path: string;
  data: TestBytes;
  mtime: Date;
  mode: number;
  compress: boolean;
  compressionLevel?: number;
  fileComment?: string;
  isDirectory?: boolean;
};

type ParsedZipEntry = {
  path: string;
  isDirectory: boolean;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  versionMadeBy: number;
  versionNeededToExtract: number;
  dosTime: number;
  dosDate: number;
  internalAttributes: number;
  externalAttributes: number;
  localHeaderOffset: number;
  comment: string;
  localExtraField: TestBytes;
  centralExtraField: TestBytes;
  compressedPayload: TestBytes;
  payload: TestBytes;
};

type RestoredEntry = {
  path: string;
  isDirectory: boolean;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  externalAttributes: number;
  comment: string;
  extraField: TestBytes;
  modifiedAt: number;
  payload: TestBytes;
};

type YauzlRawHeaderEntry = {
  path: string;
  versionMadeBy: number;
  versionNeededToExtract: number;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc32: number;
  compressedSize: number;
  size: number;
  internalAttributes: number;
  externalAttributes: number;
  localHeaderOffset: number;
  fileNameLength: number;
  fileCommentLength: number;
};

type ParsedLocalHeaderEntry = {
  path: string;
  localHeaderOffset: number;
  versionNeededToExtract: number;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc32: number;
  compressedSize: number;
  size: number;
  fileNameLength: number;
  extraField: TestBytes;
};

const entries: InteropEntry[] = [
  {
    path: "stored/hello.txt",
    data: bytes("same stored payload\n"),
    mtime: new Date(2024, 2, 4, 5, 6, 8),
    mode: 0o100640,
    compress: false,
    fileComment: "stored file"
  },
  {
    path: "deflated/repeated.txt",
    data: bytes("abc123 ".repeat(80)),
    mtime: new Date(2024, 3, 5, 6, 7, 10),
    mode: 0o100755,
    compress: true,
    compressionLevel: 9,
    fileComment: "deflated file"
  },
  {
    path: "bin/randomish.bin",
    data: seededBytes(0x5eed, 257),
    mtime: new Date(2024, 4, 6, 7, 8, 12),
    mode: 0o100600,
    compress: true,
    compressionLevel: 1
  },
  {
    path: "empty-dir/",
    data: new Uint8Array(0) as TestBytes,
    mtime: new Date(2024, 5, 7, 8, 9, 14),
    mode: 0o40750,
    compress: false,
    isDirectory: true
  }
];

const archiveComment = "interop archive";

describe("JSZipp interop with yazl and yauzl", () => {
  it("compresses the same input as yazl with matching shared ZIP metadata and restorable payloads", async () => {
    const jszippArchive = buildJSZippArchive(entries);
    const yazlArchive = await buildYazlArchive(entries);

    expect(parseEocdComment(jszippArchive)).toBe(archiveComment);
    expect(parseEocdComment(yazlArchive)).toBe(archiveComment);
    expect(comparableParsedEntries(parseCentralDirectory(jszippArchive))).toEqual(comparableParsedEntries(parseCentralDirectory(yazlArchive)));
  });

  it("compresses with JSZipp and restores content plus shared metadata through yauzl", async () => {
    const restored = await readWithYauzl(buildJSZippArchive(entries));

    expect(comparableRestoredEntries(restored)).toEqual(expectedRestoredEntries(entries));
    for (const entry of restored) {
      expectBytes(entry.payload, entries.find((expected) => expected.path === entry.path)!.data);
    }
  });

  it("decompresses a yazl archive with JSZipp and restores content plus shared metadata", async () => {
    const archive = await buildYazlArchive(entries);
    const restored = await readWithJSZipp(archive);

    expect(comparableRestoredEntries(restored)).toEqual(expectedRestoredEntries(entries));
    for (const entry of restored) {
      expectBytes(entry.payload, entries.find((expected) => expected.path === entry.path)!.data);
    }
  });

  it("decompresses the same input as yauzl with matching shared metadata and payload bytes", async () => {
    const archive = await buildYazlArchive(entries);
    const [jszippEntries, yauzlEntries] = await Promise.all([readWithJSZipp(archive), readWithYauzl(archive)]);

    expect(comparableRestoredEntries(jszippEntries)).toEqual(comparableRestoredEntries(yauzlEntries));
    for (const jszippEntry of jszippEntries) {
      const yauzlEntry = yauzlEntries.find((entry) => entry.path === jszippEntry.path);
      expect(yauzlEntry).toBeDefined();
      expectBytes(jszippEntry.payload, yauzlEntry!.payload);
    }
  });

  describe("JSZipp compression raw central-directory consistency", () => {
    it("matches yauzl's raw central-directory fields for JSZipp output", async () => {
      const archive = buildJSZippArchive(entries);
      const parsed = centralHeaderRawFields(parseCentralDirectory(archive));
      const yauzlParsed = await readYauzlRawHeaderFields(archive);

      expect(yauzlParsed).toEqual(parsed);
    });

    it("central-directory offsets point to local headers with matching duplicated fields", () => {
      const archive = buildJSZippArchive(entries);
      const centralEntries = parseCentralDirectory(archive);
      const localEntries = centralEntries.map((entry) => parseLocalHeader(archive, entry.localHeaderOffset));

      expect(localEntries.map(localHeaderTallyFields)).toEqual(centralEntries.map(centralHeaderTallyFields));
    });
  });

  describe("known non-equivalent fields", () => {
    it.skip("gap: JSZipp and yazl do not produce byte-identical deflated payload streams", async () => {
      const jszippArchive = buildJSZippArchive(entries);
      const yazlArchive = await buildYazlArchive(entries);
      const jszippPayloads = compressedPayloadsByPath(parseCentralDirectory(jszippArchive));
      const yazlPayloads = compressedPayloadsByPath(parseCentralDirectory(yazlArchive));

      expect(jszippPayloads).toEqual(yazlPayloads);
    });

    it.skip("gap: JSZipp and yazl central headers use different creator ZIP spec versions", async () => {
      const jszippArchive = buildJSZippArchive(entries);
      const yazlArchive = await buildYazlArchive(entries);
      const jszippProvenance = centralHeaderProvenance(parseCentralDirectory(jszippArchive));
      const yazlProvenance = centralHeaderProvenance(parseCentralDirectory(yazlArchive));

      console.log({
        jszipp: jszippProvenance,
        yazl: yazlProvenance
      });
      expect(jszippProvenance).toEqual(yazlProvenance);
    });

    it.skip("gap: JSZipp reader does not expose yauzl's raw central-directory header fields", async () => {
      const archive = await buildYazlArchive(entries);
      const yauzlHeaderFields = await readYauzlRawHeaderFields(archive);
      const reader = await openZip(archive);
      try {
        const jszippHeaderFields = reader.entries.map((entry) => {
          const raw = entry as unknown as YauzlRawHeaderEntry;
          return {
            path: entry.path,
            versionMadeBy: raw.versionMadeBy,
            versionNeededToExtract: raw.versionNeededToExtract,
            flags: raw.flags,
            internalAttributes: raw.internalAttributes,
            localHeaderOffset: raw.localHeaderOffset,
            fileNameLength: raw.fileNameLength,
            fileCommentLength: raw.fileCommentLength
          };
        });

        expect(jszippHeaderFields).toEqual(yauzlHeaderFields);
      } finally {
        await reader.close();
      }
    });

    it.skip("gap: yazl cannot encode JSZipp's NTFS createdAt and lastAccess timestamp metadata", async () => {
      const timestampEntries = entries.map((entry) => ({
        ...entry,
        createdAt: new Date(entry.mtime.getTime() - 2000),
        lastAccess: new Date(entry.mtime.getTime() + 2000)
      }));
      const writer = new ZipWriter({ outputAs: "uint8array", comment: archiveComment, timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
      for (const entry of timestampEntries) {
        writer.writeSync({
          path: entry.path,
          data: entry.data,
          method: entry.compress ? "deflate" : "store",
          level: entry.compressionLevel,
          meta: {
            modifiedAt: entry.mtime,
            createdAt: entry.createdAt,
            lastAccess: entry.lastAccess,
            externalAttributes: (entry.mode << 16) >>> 0,
            comment: entry.fileComment
          }
        });
      }

      const jszippArchive = writer.closeSync() as TestBytes;
      const yazlArchive = await buildYazlArchive(timestampEntries);

      expect(extraFieldsByPath(parseCentralDirectory(jszippArchive))).toEqual(extraFieldsByPath(parseCentralDirectory(yazlArchive)));
    });
  });
});

function bytes(text: string): TestBytes {
  return encoder.encode(text) as TestBytes;
}

function seededBytes(seed: number, length: number): TestBytes {
  const out = new Uint8Array(length) as TestBytes;
  let state = seed >>> 0;
  for (let index = 0; index < out.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

function buildJSZippArchive(input: InteropEntry[]): TestBytes {
  const writer = new ZipWriter({ outputAs: "uint8array", comment: archiveComment, timestamps: TimestampMode.Dos });
  for (const entry of input) {
    writer.writeSync({
      path: entry.path,
      data: entry.data,
      method: entry.compress ? "deflate" : "store",
      level: entry.compressionLevel,
      meta: {
        modifiedAt: entry.mtime,
        externalAttributes: (entry.mode << 16) >>> 0,
        comment: entry.fileComment
      }
    });
  }
  return writer.closeSync() as TestBytes;
}

async function buildYazlArchive(input: InteropEntry[]): Promise<TestBytes> {
  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<TestBytes>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks)) as TestBytes));
    zip.on("error", reject);
  });

  for (const entry of input) {
    const options = {
      mtime: entry.mtime,
      mode: entry.mode,
      compress: entry.compress,
      compressionLevel: entry.compressionLevel,
      forceDosTimestamp: true,
      fileComment: entry.fileComment
    };
    if (entry.isDirectory) {
      zip.addEmptyDirectory(entry.path, {
        mtime: entry.mtime,
        mode: entry.mode,
        forceDosTimestamp: true
      });
    } else {
      zip.addBuffer(Buffer.from(entry.data), entry.path, options);
    }
  }
  zip.end({ comment: archiveComment, forceZip64Format: false });

  return done;
}

function parseCentralDirectory(archive: Uint8Array): ParsedZipEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();
  const entriesOut: ParsedZipEntry[] = [];
  let offset = findSignature(archive, 0x02014b50);

  while (offset >= 0 && offset <= archive.length - 46 && view.getUint32(offset, true) === 0x02014b50) {
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const versionMadeBy = view.getUint16(offset + 4, true);
    const versionNeededToExtract = view.getUint16(offset + 6, true);
    const dosTime = view.getUint16(offset + 12, true);
    const dosDate = view.getUint16(offset + 14, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const pathLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const internalAttributes = view.getUint16(offset + 36, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const pathStart = offset + 46;
    const extraStart = pathStart + pathLength;
    const commentStart = extraStart + extraLength;
    const path = decoder.decode(archive.subarray(pathStart, extraStart));
    const comment = decoder.decode(archive.subarray(commentStart, commentStart + commentLength));
    const localPathLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const payloadStart = localOffset + 30 + localPathLength + localExtraLength;
    const compressedPayload = archive.subarray(payloadStart, payloadStart + compressedSize) as TestBytes;

    entriesOut.push({
      path,
      isDirectory: path.endsWith("/"),
      method,
      flags,
      crc32,
      compressedSize,
      size,
      versionMadeBy,
      versionNeededToExtract,
      dosTime,
      dosDate,
      internalAttributes,
      externalAttributes,
      localHeaderOffset: localOffset,
      comment,
      localExtraField: archive.subarray(localOffset + 30 + localPathLength, payloadStart) as TestBytes,
      centralExtraField: archive.subarray(extraStart, commentStart) as TestBytes,
      compressedPayload,
      payload: inflatePayload(method, compressedPayload)
    });

    offset = commentStart + commentLength;
  }

  return entriesOut;
}

function comparableParsedEntries(parsed: ParsedZipEntry[]): object[] {
  return parsed.map((entry) => ({
    path: entry.path,
    isDirectory: entry.isDirectory,
    method: entry.method,
    flags: entry.flags,
    crc32: entry.crc32,
    size: entry.size,
    dosTime: entry.dosTime,
    dosDate: entry.dosDate,
    externalAttributes: entry.externalAttributes,
    comment: entry.comment,
    localExtraField: hex(entry.localExtraField),
    centralExtraField: hex(entry.centralExtraField),
    payload: hex(entry.payload),
    storedCompressedPayload: entry.method === 0 ? hex(entry.compressedPayload) : undefined
  }));
}

function compressedPayloadsByPath(parsed: ParsedZipEntry[]): Record<string, string> {
  return Object.fromEntries(parsed.filter((entry) => entry.method === 8).map((entry) => [entry.path, hex(entry.compressedPayload)]));
}

function centralHeaderProvenance(parsed: ParsedZipEntry[]): object[] {
  return parsed.map((entry) => ({
    path: entry.path,
    versionMadeBy: entry.versionMadeBy,
    versionNeededToExtract: entry.versionNeededToExtract,
    internalAttributes: entry.internalAttributes,
    localHeaderOffset: entry.localHeaderOffset
  }));
}

function centralHeaderRawFields(parsed: ParsedZipEntry[]): YauzlRawHeaderEntry[] {
  return parsed.map((entry) => ({
    path: entry.path,
    versionMadeBy: entry.versionMadeBy,
    versionNeededToExtract: entry.versionNeededToExtract,
    flags: entry.flags,
    method: entry.method,
    dosTime: entry.dosTime,
    dosDate: entry.dosDate,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    size: entry.size,
    internalAttributes: entry.internalAttributes,
    externalAttributes: entry.externalAttributes,
    localHeaderOffset: entry.localHeaderOffset,
    fileNameLength: new TextEncoder().encode(entry.path).length,
    fileCommentLength: new TextEncoder().encode(entry.comment).length
  }));
}

function parseLocalHeader(archive: Uint8Array, offset: number): ParsedLocalHeaderEntry {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  if (view.getUint32(offset, true) !== 0x04034b50) {
    throw new Error(`local file header not found at offset ${offset}`);
  }

  const fileNameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const pathStart = offset + 30;
  const extraStart = pathStart + fileNameLength;
  return {
    path: new TextDecoder().decode(archive.subarray(pathStart, extraStart)),
    localHeaderOffset: offset,
    versionNeededToExtract: view.getUint16(offset + 4, true),
    flags: view.getUint16(offset + 6, true),
    method: view.getUint16(offset + 8, true),
    dosTime: view.getUint16(offset + 10, true),
    dosDate: view.getUint16(offset + 12, true),
    crc32: view.getUint32(offset + 14, true),
    compressedSize: view.getUint32(offset + 18, true),
    size: view.getUint32(offset + 22, true),
    fileNameLength,
    extraField: archive.subarray(extraStart, extraStart + extraLength) as TestBytes
  };
}

function centralHeaderTallyFields(entry: ParsedZipEntry): object {
  return {
    path: entry.path,
    localHeaderOffset: entry.localHeaderOffset,
    versionNeededToExtract: entry.versionNeededToExtract,
    flags: entry.flags,
    method: entry.method,
    dosTime: entry.dosTime,
    dosDate: entry.dosDate,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    size: entry.size,
    fileNameLength: new TextEncoder().encode(entry.path).length,
    localExtraField: hex(entry.localExtraField)
  };
}

function localHeaderTallyFields(entry: ParsedLocalHeaderEntry): object {
  return {
    path: entry.path,
    localHeaderOffset: entry.localHeaderOffset,
    versionNeededToExtract: entry.versionNeededToExtract,
    flags: entry.flags,
    method: entry.method,
    dosTime: entry.dosTime,
    dosDate: entry.dosDate,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    size: entry.size,
    fileNameLength: entry.fileNameLength,
    localExtraField: hex(entry.extraField)
  };
}

function extraFieldsByPath(parsed: ParsedZipEntry[]): Record<string, string> {
  return Object.fromEntries(parsed.map((entry) => [entry.path, hex(entry.centralExtraField)]));
}

async function readYauzlRawHeaderFields(archive: Uint8Array): Promise<YauzlRawHeaderEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(archive), { lazyEntries: true, validateEntrySizes: true }, (openError, zipfile) => {
      if (openError) return reject(openError);
      if (!zipfile) return reject(new Error("yauzl did not return a zipfile"));

      const out: YauzlRawHeaderEntry[] = [];
      zipfile.on("error", reject);
      zipfile.on("end", () => {
        zipfile.close();
        resolve(out);
      });
      zipfile.on("entry", (entry: yauzl.Entry) => {
        out.push({
          path: entry.fileName,
          versionMadeBy: entry.versionMadeBy,
          versionNeededToExtract: entry.versionNeededToExtract,
          flags: entry.generalPurposeBitFlag,
          method: entry.compressionMethod,
          dosTime: entry.lastModFileTime,
          dosDate: entry.lastModFileDate,
          crc32: entry.crc32,
          compressedSize: entry.compressedSize,
          size: entry.uncompressedSize,
          internalAttributes: entry.internalFileAttributes,
          externalAttributes: entry.externalFileAttributes >>> 0,
          localHeaderOffset: entry.relativeOffsetOfLocalHeader,
          fileNameLength: entry.fileNameLength,
          fileCommentLength: entry.fileCommentLength
        });
        zipfile.readEntry();
      });
      zipfile.readEntry();
    });
  });
}

async function readWithYauzl(archive: Uint8Array): Promise<RestoredEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(archive), { lazyEntries: true, validateEntrySizes: true }, (openError, zipfile) => {
      if (openError) return reject(openError);
      if (!zipfile) return reject(new Error("yauzl did not return a zipfile"));

      const out: RestoredEntry[] = [];
      zipfile.on("error", reject);
      zipfile.on("end", () => {
        zipfile.close();
        resolve(out);
      });
      zipfile.on("entry", (entry: yauzl.Entry) => {
        const finish = (payload: TestBytes): void => {
          out.push({
            path: entry.fileName,
            isDirectory: entry.fileName.endsWith("/"),
            method: entry.compressionMethod,
            crc32: entry.crc32,
            compressedSize: entry.compressedSize,
            size: entry.uncompressedSize,
            externalAttributes: entry.externalFileAttributes >>> 0,
            comment: entry.comment,
            extraField: concatExtraFields(entry.extraFields),
            modifiedAt: dosTimestampMs(entry.lastModFileDate, entry.lastModFileTime),
            payload
          });
          zipfile.readEntry();
        };

        if (entry.fileName.endsWith("/")) {
          finish(new Uint8Array(0) as TestBytes);
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          collectNodeStream(stream).then(finish, reject);
        });
      });
      zipfile.readEntry();
    });
  });
}

async function readWithJSZipp(archive: Uint8Array): Promise<RestoredEntry[]> {
  const methods = new Map(parseCentralDirectory(archive).map((entry) => [entry.path, entry.method]));
  const reader = await openZip(new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength) as TestBytes);
  try {
    return await Promise.all(reader.entries.map(async (entry) => restoredFromJSZippEntry(entry, methods.get(entry.path) ?? 0)));
  } finally {
    await reader.close();
  }
}

async function restoredFromJSZippEntry(entry: ZipRandomAccessEntry, method: number): Promise<RestoredEntry> {
  return {
    path: entry.path,
    isDirectory: entry.isDirectory,
    method,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    size: entry.size,
    externalAttributes: entry.externalAttributes ?? 0,
    comment: entry.comment ?? "",
    extraField: entry.extraField ?? (new Uint8Array(0) as TestBytes),
    modifiedAt: entry.modifiedAt?.getTime() ?? 0,
    payload: await entry.bytes()
  };
}

function comparableRestoredEntries(restored: RestoredEntry[]): object[] {
  return restored.map((entry) => ({
    path: entry.path,
    isDirectory: entry.isDirectory,
    method: entry.method,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    size: entry.size,
    externalAttributes: entry.externalAttributes,
    comment: entry.comment,
    extraField: hex(entry.extraField),
    modifiedAt: entry.modifiedAt
  }));
}

function expectedRestoredEntries(input: InteropEntry[]): object[] {
  return input.map((entry) => ({
    path: entry.path,
    isDirectory: entry.path.endsWith("/"),
    method: entry.compress && !entry.isDirectory ? 8 : 0,
    crc32: expect.any(Number),
    compressedSize: expect.any(Number),
    size: entry.data.length,
    externalAttributes: (entry.mode << 16) >>> 0,
    comment: entry.fileComment ?? "",
    extraField: "",
    modifiedAt: dosTimestampMs(...dosDateTime(entry.mtime))
  }));
}

function collectNodeStream(stream: NodeJS.ReadableStream): Promise<TestBytes> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks)) as TestBytes));
  });
}

function concatExtraFields(extraFields: yauzl.Entry["extraFields"]): TestBytes {
  const chunks = extraFields.map((field) => {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(field.id, 0);
    header.writeUInt16LE(field.data.length, 2);
    return Buffer.concat([header, field.data]);
  });
  return new Uint8Array(Buffer.concat(chunks)) as TestBytes;
}

function inflatePayload(method: number, payload: Uint8Array): TestBytes {
  if (method === 0) return new Uint8Array(payload) as TestBytes;
  if (method === 8) return new Uint8Array(inflateRawSync(payload)) as TestBytes;
  throw new Error(`unsupported compression method in test archive: ${method}`);
}

function parseEocdComment(archive: Uint8Array): string {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const offset = findSignatureFromEnd(archive, 0x06054b50);
  const commentLength = view.getUint16(offset + 20, true);
  return new TextDecoder().decode(archive.subarray(offset + 22, offset + 22 + commentLength));
}

function findSignature(archive: Uint8Array, signature: number): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let offset = 0; offset <= archive.length - 4; offset++) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  return -1;
}

function findSignatureFromEnd(archive: Uint8Array, signature: number): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let offset = archive.length - 4; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  throw new Error(`signature ${signature.toString(16)} not found`);
}

function dosDateTime(date: Date): [number, number] {
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  return [dosDate, dosTime];
}

function dosTimestampMs(date: number, time: number): number {
  const day = date & 0x1f || 1;
  const month = (date >>> 5) & 0x0f || 1;
  const year = ((date >>> 9) & 0x7f) + 1980;
  return new Date(year, month - 1, day, (time >>> 11) & 0x1f, (time >>> 5) & 0x3f, (time & 0x1f) * 2).getTime();
}

function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
