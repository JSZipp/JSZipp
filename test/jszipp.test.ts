import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import JSZipp, { __privatePrepareEntryForWorker, ZipTransformStream, ZipWriter, openZip, readZipStream, TimestampMode, type ZipReadOptions, type ZipStreamEntry } from "../src/index";
import { createWorkerBackend } from "../src/worker-plugin";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type TestBytes = Uint8Array<ArrayBuffer>;
type ByteArrayInput = number | Iterable<number> | ArrayLike<number> | ArrayBuffer;
type BuildArchiveEntry = { path: string; data: string; meta?: { unixPermissions?: number } };
type ZlibZipEntry = { path: string; data: TestBytes; comment: string; extraField: TestBytes; modifiedAt: Date; unixMode: number };
type DescriptorZipEntry = { path: string; data: TestBytes; method: 0 | 8 };
type LegacyFilenameCase = {
  encoding: NonNullable<ZipReadOptions["filenameEncoding"]>;
  placeholder: string;
  bytes: readonly number[];
  expected: string;
};

const encode = (text: string): TestBytes => encoder.encode(text) as TestBytes;
const byteArray = (bytes: ByteArrayInput): TestBytes => new Uint8Array(bytes as ArrayBuffer) as TestBytes;
const absoluteDate = (value: string): Date => new Date(value);

// The reader no longer exposes a pre-decoded `unixMode`; callers derive it from
// the raw `externalAttributes` (high 16 bits). This mirrors the documented
// one-liner and returns undefined when no Unix mode is recorded.
const umode = (entry?: { externalAttributes?: number }): number | undefined => {
  const mode = (entry?.externalAttributes ?? 0) >>> 16;
  return mode === 0 ? undefined : mode;
};
const pad2 = (value: number): string => String(value).padStart(2, "0");
const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const nodeCrc32 = (bytes: Uint8Array): number => crc32(bytes) >>> 0;
const expectBytesEqual = (actual: Uint8Array | undefined, expected: Uint8Array, label?: string): void => {
  expect(actual, label).toBeDefined();
  expect(
    Buffer.from(actual!.buffer, actual!.byteOffset, actual!.byteLength)
      .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)),
    label
  ).toBe(true);
};

class FakeZipWorker {
  static calls = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;

  terminate(): void {
    this.terminated = true;
  }

  postMessage(request: any): void {
    FakeZipWorker.calls++;
    void (async () => {
      try {
        const prepared = await __privatePrepareEntryForWorker(request.input, {
          ...request.options,
          signal: new AbortController().signal,
          onProgress: () => undefined
        }, request.pathInfo);
        if (!this.terminated) this.onmessage?.({ data: { id: request.id, prepared } } as MessageEvent);
      } catch (error) {
        const err = error as Error;
        if (!this.terminated) this.onmessage?.({ data: { id: request.id, error: { name: err.name, message: err.message } } } as MessageEvent);
      }
    })();
  }
}

class ControlledZipWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;
  private readonly requests = new Map<number, any>();

  terminate(): void {
    this.terminated = true;
    this.requests.clear();
  }

  postMessage(request: any): void {
    this.requests.set(request.id, request);
  }

  pendingIds(): number[] {
    return [...this.requests.keys()];
  }

  async respond(id: number): Promise<void> {
    const request = this.requests.get(id);
    if (!request) throw new Error(`missing queued worker request ${id}`);
    this.requests.delete(id);
    try {
      const prepared = await __privatePrepareEntryForWorker(request.input, {
        ...request.options,
        signal: new AbortController().signal,
        onProgress: () => undefined
      }, request.pathInfo);
      if (!this.terminated) this.onmessage?.({ data: { id: request.id, prepared } } as MessageEvent);
    } catch (error) {
      const err = error as Error;
      if (!this.terminated) this.onmessage?.({ data: { id: request.id, error: { name: err.name, message: err.message } } } as MessageEvent);
    }
  }
}
const writeU16 = (view: DataView, offset: number, value: number): void => view.setUint16(offset, value, true);
const writeU32 = (view: DataView, offset: number, value: number): void => view.setUint32(offset, value >>> 0, true);

const seededRandomBytes = (seed: number, length: number): TestBytes => {
  const bytes = new Uint8Array(length) as TestBytes;
  let state = seed >>> 0;

  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }

  return bytes;
};

const expectedZipTimestamp = (date: Date): { date: number; time: number } => {
  const year = date.getFullYear();
  const dosYear = year < 1980 ? 0 : Math.min(127, year - 1980);
  return {
    date: (dosYear << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  };
};

const dateFromZipTimestamp = (date: number, time: number): Date => {
  const day = date & 0x1f || 1;
  const month = (date >>> 5) & 0x0f || 1;
  const year = ((date >>> 9) & 0x7f) + 1980;
  return new Date(year, month - 1, day, (time >>> 11) & 0x1f, (time >>> 5) & 0x3f, (time & 0x1f) * 2);
};

const collect = async (stream: ReadableStream<TestBytes>): Promise<TestBytes> => {
  const reader = stream.getReader();
  const chunks: TestBytes[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total) as TestBytes;
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const streamOf = (...chunks: string[]): ReadableStream<TestBytes> =>
  new ReadableStream<TestBytes>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(encode(chunk));
      controller.close();
    }
  });

const byteStreamOf = (bytes: Uint8Array, chunkSize = 17): ReadableStream<TestBytes> =>
  new ReadableStream<TestBytes>({
    start: (controller) => {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(byteArray(bytes.subarray(offset, offset + chunkSize)));
      }
      controller.close();
    }
  });

const hasSignature = (bytes: Uint8Array, signature: number): boolean => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 4; offset++) {
    if (view.getUint32(offset, true) === signature) return true;
  }
  return false;
};

const setInternalEntryCount = (writer: ZipWriter<"uint8array"> | ZipWriter, entries: number): void => {
  (writer as unknown as { encoder: { entries: number } }).encoder.entries = entries;
};

const setInternalOffset = (writer: ZipWriter, offset: number): void => {
  (writer as unknown as { encoder: { offset: number } }).encoder.offset = offset;
};

const findSignature = (bytes: Uint8Array, signature: number): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 4; offset++) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  return -1;
};

const findSignatureFromEnd = (bytes: Uint8Array, signature: number): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 4; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  return -1;
};

const eocdOffset = (bytes: Uint8Array): number => findSignature(bytes, 0x06054b50);

const buildArchive = (entries: BuildArchiveEntry[], options = {}): TestBytes => {
  const writer = new ZipWriter({ outputAs: "uint8array", ...options });
  for (const entry of entries) writer.writeSync({ path: entry.path, data: entry.data, meta: entry.meta });
  return writer.closeSync() as TestBytes;
};

const patchAllAscii = (bytes: Uint8Array, from: string, to: string): TestBytes => {
  return patchAllBytes(bytes, encode(from), encode(to));
};

const patchAllBytes = (bytes: Uint8Array, fromBytes: Uint8Array, toBytes: Uint8Array): TestBytes => {
  if (fromBytes.length !== toBytes.length) throw new Error("replacement must preserve byte length");
  const patched = new Uint8Array(bytes) as TestBytes;
  let replacements = 0;
  for (let offset = 0; offset <= patched.length - fromBytes.length; offset++) {
    if (fromBytes.every((byte, index) => patched[offset + index] === byte)) {
      patched.set(toBytes, offset);
      replacements++;
      offset += fromBytes.length - 1;
    }
  }
  if (replacements === 0) throw new Error("pattern not found");
  return patched;
};

const centralDirectoryOffset = (bytes: Uint8Array): number => {
  const offset = findSignature(bytes, 0x02014b50);
  if (offset < 0) throw new Error("central directory header not found");
  return offset;
};

const centralLocalHeaderOffsets = (bytes: Uint8Array): number[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets: number[] = [];
  let offset = centralDirectoryOffset(bytes);

  while (offset <= bytes.length - 46 && view.getUint32(offset, true) === 0x02014b50) {
    offsets.push(view.getUint32(offset + 42, true));
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }

  return offsets;
};

const localHeaderOffset = (bytes: Uint8Array): number => {
  const offset = findSignature(bytes, 0x04034b50);
  if (offset < 0) throw new Error("local file header not found");
  return offset;
};

const realEndOfCentralDirectoryOffset = (bytes: Uint8Array): number => {
  const offset = findSignatureFromEnd(bytes, 0x06054b50);
  if (offset < 0) throw new Error("end of central directory not found");
  return offset;
};

const buildStoredArchive = (
  entries: { path: string; data: string | TestBytes | ArrayBuffer; meta?: { extraField?: TestBytes } }[],
  options: Record<string, unknown> = {}
): TestBytes => {
  const writer = new ZipWriter({ outputAs: "uint8array", level: 0, zip64: "off", ...options });
  for (const entry of entries) writer.writeSync(entry);
  return writer.closeSync() as TestBytes;
};

const buildDuplicateStoredArchive = (entries: { path: string; data: string }[]): TestBytes => {
  const out: number[] = [];
  const central: { path: TestBytes; data: TestBytes; crc32: number; localOffset: number }[] = [];

  for (const entry of entries) {
    const path = encode(entry.path);
    const data = encode(entry.data);
    const localOffset = out.length;
    const crc = nodeCrc32(data);
    const local = new Uint8Array(30) as TestBytes;
    const view = new DataView(local.buffer);

    writeU32(view, 0, 0x04034b50);
    writeU16(view, 4, 20);
    writeU16(view, 8, 0);
    writeU32(view, 14, crc);
    writeU32(view, 18, data.length);
    writeU32(view, 22, data.length);
    writeU16(view, 26, path.length);
    out.push(...local, ...path, ...data);
    central.push({ path, data, crc32: crc, localOffset });
  }

  const centralOffset = out.length;
  for (const entry of central) {
    const header = new Uint8Array(46) as TestBytes;
    const view = new DataView(header.buffer);

    writeU32(view, 0, 0x02014b50);
    writeU16(view, 4, 20);
    writeU16(view, 6, 20);
    writeU16(view, 10, 0);
    writeU32(view, 16, entry.crc32);
    writeU32(view, 20, entry.data.length);
    writeU32(view, 24, entry.data.length);
    writeU16(view, 28, entry.path.length);
    writeU32(view, 42, entry.localOffset);
    out.push(...header, ...entry.path);
  }

  const centralSize = out.length - centralOffset;
  const eocd = new Uint8Array(22) as TestBytes;
  const view = new DataView(eocd.buffer);
  writeU32(view, 0, 0x06054b50);
  writeU16(view, 8, entries.length);
  writeU16(view, 10, entries.length);
  writeU32(view, 12, centralSize);
  writeU32(view, 16, centralOffset);
  out.push(...eocd);

  return byteArray(out);
};

const buildDeflatedArchive = async (
  entries: { path: string; data: string | TestBytes; level?: number; method?: "store" | "deflate" }[],
  options: Record<string, unknown> = {}
): Promise<TestBytes> => {
  const writer = new ZipWriter({ outputAs: "uint8array", level: 6, ...options });
  for (const entry of entries) await writer.add(entry);
  return byteArray(await writer.close());
};

const firstRawPayload = (bytes: Uint8Array): TestBytes => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = localHeaderOffset(bytes);
  const nameLength = view.getUint16(local + 26, true);
  const extraLength = view.getUint16(local + 28, true);
  const compressedSize = view.getUint32(local + 18, true);
  const start = local + 30 + nameLength + extraLength;
  return byteArray(bytes.subarray(start, start + compressedSize));
};

const firstBlockType = (rawPayload: Uint8Array): number => (rawPayload[0] >>> 1) & 0x3;

const rawZipTimestamp = (bytes: Uint8Array): { localDate: number; localTime: number; centralDate: number; centralTime: number } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = centralDirectoryOffset(bytes);
  return {
    localTime: view.getUint16(10, true),
    localDate: view.getUint16(12, true),
    centralTime: view.getUint16(centralOffset + 12, true),
    centralDate: view.getUint16(centralOffset + 14, true)
  };
};

const rawZipTimestampsByPath = (bytes: Uint8Array): Map<string, { localDate: number; localTime: number; centralDate: number; centralTime: number }> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timestamps = new Map<string, { localDate: number; localTime: number; centralDate: number; centralTime: number }>();
  let offset = centralDirectoryOffset(bytes);

  while (offset <= bytes.length - 46 && view.getUint32(offset, true) === 0x02014b50) {
    const pathLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const pathStart = offset + 46;
    const path = decoder.decode(bytes.subarray(pathStart, pathStart + pathLength));

    timestamps.set(path, {
      localTime: view.getUint16(localOffset + 10, true),
      localDate: view.getUint16(localOffset + 12, true),
      centralTime: view.getUint16(offset + 12, true),
      centralDate: view.getUint16(offset + 14, true)
    });

    offset = pathStart + pathLength + extraLength + commentLength;
  }

  return timestamps;
};

const rawZipExtrasByPath = (bytes: Uint8Array): Map<string, { localExtra: TestBytes; centralExtra: TestBytes }> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extras = new Map<string, { localExtra: TestBytes; centralExtra: TestBytes }>();
  let offset = centralDirectoryOffset(bytes);

  while (offset <= bytes.length - 46 && view.getUint32(offset, true) === 0x02014b50) {
    const pathLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const pathStart = offset + 46;
    const centralExtraStart = pathStart + pathLength;
    const path = decoder.decode(bytes.subarray(pathStart, pathStart + pathLength));
    const localPathLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localExtraStart = localOffset + 30 + localPathLength;

    extras.set(path, {
      localExtra: byteArray(bytes.subarray(localExtraStart, localExtraStart + localExtraLength)),
      centralExtra: byteArray(bytes.subarray(centralExtraStart, centralExtraStart + extraLength))
    });

    offset = pathStart + pathLength + extraLength + commentLength;
  }

  return extras;
};

const extraFieldPayload = (extra: Uint8Array, id: number): TestBytes | undefined => {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const fieldId = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const start = offset + 4;
    const end = start + length;
    if (end > extra.length) return undefined;
    if (fieldId === id) return byteArray(extra.subarray(start, end));
    offset = end;
  }
  return undefined;
};

const countExtraFields = (extra: Uint8Array, id: number): number => {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  let count = 0;
  while (offset + 4 <= extra.length) {
    const fieldId = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const end = offset + 4 + length;
    if (end > extra.length) break;
    if (fieldId === id) count++;
    offset = end;
  }
  return count;
};

const extendedTimestampSeconds = (extra: Uint8Array): number | undefined => {
  const payload = extraFieldPayload(extra, 0x5455);
  if (!payload || payload.length < 5 || (payload[0] & 1) === 0) return undefined;
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(1, true);
};

const expectExtendedTimestampExtra = (extra: Uint8Array, date: Date, label: string): void => {
  const payload = extraFieldPayload(extra, 0x5455);
  const expectedSeconds = Math.floor(date.getTime() / 1000);
  const expectedPayload = new Uint8Array(5) as TestBytes;
  const expectedView = new DataView(expectedPayload.buffer);
  expectedPayload[0] = 1;
  expectedView.setUint32(1, expectedSeconds, true);

  expect(payload, label).toBeDefined();
  expectBytesEqual(payload, expectedPayload, label);
  expect(extendedTimestampSeconds(extra), label).toBe(expectedSeconds);
};

const expectNoExtendedTimestampExtra = (extra: Uint8Array, label: string): void => {
  expect(extraFieldPayload(extra, 0x5455), label).toBeUndefined();
  expect(extendedTimestampSeconds(extra), label).toBeUndefined();
};

// NTFS extra field (0x000a) test helpers. The 0x0001 attribute holds three
// 64-bit Windows FILETIME values (100-ns ticks since 1601-01-01 UTC) in the
// order mtime, atime, ctime.
const NTFS_EPOCH_OFFSET_MS = 11_644_473_600_000;
const writeFileTime = (view: DataView, offset: number, date: Date): void => {
  const ms = date.getTime() + NTFS_EPOCH_OFFSET_MS;
  const msHigh = Math.floor(ms / 0x100000000);
  const msLow = ms % 0x100000000;
  const productLow = msLow * 10000;
  const ftLow = productLow % 0x100000000;
  const carry = Math.floor(productLow / 0x100000000);
  view.setUint32(offset, ftLow >>> 0, true);
  view.setUint32(offset + 4, (msHigh * 10000 + carry) >>> 0, true);
};
const fileTimeToDate = (view: DataView, offset: number): Date | undefined => {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  if (lo === 0 && hi === 0) return undefined;
  return new Date((hi * 0x100000000 + lo) / 10000 - NTFS_EPOCH_OFFSET_MS);
};
// Decode the mtime/atime/ctime from an NTFS extra. extraFieldPayload strips the
// outer id+size header, so the payload is reserved(4) + tag(2) + size(2) + 3*8.
const ntfsTimestamps = (extra: Uint8Array): { modifiedAt?: Date; lastAccess?: Date; createdAt?: Date } | undefined => {
  const payload = extraFieldPayload(extra, 0x000a);
  if (!payload || payload.length < 32) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    modifiedAt: fileTimeToDate(view, 8),
    lastAccess: fileTimeToDate(view, 16),
    createdAt: fileTimeToDate(view, 24)
  };
};
const makeUnixTimestampExtra = (date: Date): TestBytes => {
  const out = new Uint8Array(9) as TestBytes;
  const view = new DataView(out.buffer);
  writeU16(view, 0, 0x5455);
  writeU16(view, 2, 5);
  out[4] = 1; // mtime present
  writeU32(view, 5, Math.floor(date.getTime() / 1000));
  return out;
};
// Build a raw NTFS extra; an omitted slot is left zero (treated as "unset").
const makeNtfsExtra = (modifiedAt?: Date, lastAccess?: Date, createdAt?: Date): TestBytes => {
  const out = new Uint8Array(36) as TestBytes;
  const view = new DataView(out.buffer);
  writeU16(view, 0, 0x000a);
  writeU16(view, 2, 32);
  writeU16(view, 8, 1); // attribute tag 0x0001
  writeU16(view, 10, 24);
  if (modifiedAt) writeFileTime(view, 12, modifiedAt);
  if (lastAccess) writeFileTime(view, 20, lastAccess);
  if (createdAt) writeFileTime(view, 28, createdAt);
  return out;
};

const centralEntryMetadata = (bytes: Uint8Array, expectedPath: string): { method: number; compressedSize: number; size: number } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = centralDirectoryOffset(bytes);

  while (offset <= bytes.length - 46 && view.getUint32(offset, true) === 0x02014b50) {
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const pathLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const pathStart = offset + 46;
    const path = decoder.decode(bytes.subarray(pathStart, pathStart + pathLength));

    if (path === expectedPath) return { method, compressedSize, size };
    offset = pathStart + pathLength + extraLength + commentLength;
  }

  throw new Error(`central directory entry not found: ${expectedPath}`);
};

const concatBytes = (chunks: Uint8Array[]): TestBytes => {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(length) as TestBytes;
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
};

const buildNodeDeflatedZip = (entries: ZlibZipEntry[], archiveComment: string): TestBytes => {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBytes = encode(entry.path);
    const commentBytes = encode(entry.comment);
    const compressed = byteArray(deflateRawSync(entry.data));
    const { date, time } = expectedZipTimestamp(entry.modifiedAt);
    const externalAttributes = (entry.unixMode << 16) >>> 0;
    const crc = nodeCrc32(entry.data);

    const local = new Uint8Array(30 + pathBytes.length + entry.extraField.length) as TestBytes;
    const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0800);
    writeU16(localView, 8, 8);
    writeU16(localView, 10, time);
    writeU16(localView, 12, date);
    writeU32(localView, 14, crc);
    writeU32(localView, 18, compressed.length);
    writeU32(localView, 22, entry.data.length);
    writeU16(localView, 26, pathBytes.length);
    writeU16(localView, 28, entry.extraField.length);
    local.set(pathBytes, 30);
    local.set(entry.extraField, 30 + pathBytes.length);

    const central = new Uint8Array(46 + pathBytes.length + entry.extraField.length + commentBytes.length) as TestBytes;
    const centralView = new DataView(central.buffer, central.byteOffset, central.byteLength);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, (3 << 8) | 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x0800);
    writeU16(centralView, 10, 8);
    writeU16(centralView, 12, time);
    writeU16(centralView, 14, date);
    writeU32(centralView, 16, crc);
    writeU32(centralView, 20, compressed.length);
    writeU32(centralView, 24, entry.data.length);
    writeU16(centralView, 28, pathBytes.length);
    writeU16(centralView, 30, entry.extraField.length);
    writeU16(centralView, 32, commentBytes.length);
    writeU32(centralView, 38, externalAttributes);
    writeU32(centralView, 42, offset);
    central.set(pathBytes, 46);
    central.set(entry.extraField, 46 + pathBytes.length);
    central.set(commentBytes, 46 + pathBytes.length + entry.extraField.length);

    localChunks.push(local, compressed);
    centralChunks.push(central);
    offset += local.length + compressed.length;
  }

  const centralDirectory = concatBytes(centralChunks);
  const commentBytes = encode(archiveComment);
  const eocd = new Uint8Array(22 + commentBytes.length) as TestBytes;
  const eocdView = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
  writeU32(eocdView, 0, 0x06054b50);
  writeU16(eocdView, 8, entries.length);
  writeU16(eocdView, 10, entries.length);
  writeU32(eocdView, 12, centralDirectory.length);
  writeU32(eocdView, 16, offset);
  writeU16(eocdView, 20, commentBytes.length);
  eocd.set(commentBytes, 22);

  return concatBytes([...localChunks, centralDirectory, eocd]);
};

const buildDataDescriptorZip = (entries: DescriptorZipEntry[], archiveComment = ""): TestBytes => {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBytes = encode(entry.path);
    const compressed = entry.method === 8 ? byteArray(deflateRawSync(entry.data)) : entry.data;
    const crc = nodeCrc32(entry.data);

    const local = new Uint8Array(30 + pathBytes.length) as TestBytes;
    const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0008);
    writeU16(localView, 8, entry.method);
    writeU32(localView, 14, 0);
    writeU32(localView, 18, 0);
    writeU32(localView, 22, 0);
    writeU16(localView, 26, pathBytes.length);
    local.set(pathBytes, 30);

    const descriptor = new Uint8Array(16) as TestBytes;
    const descriptorView = new DataView(descriptor.buffer, descriptor.byteOffset, descriptor.byteLength);
    writeU32(descriptorView, 0, 0x08074b50);
    writeU32(descriptorView, 4, crc);
    writeU32(descriptorView, 8, compressed.length);
    writeU32(descriptorView, 12, entry.data.length);

    const central = new Uint8Array(46 + pathBytes.length) as TestBytes;
    const centralView = new DataView(central.buffer, central.byteOffset, central.byteLength);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x0008);
    writeU16(centralView, 10, entry.method);
    writeU32(centralView, 16, crc);
    writeU32(centralView, 20, compressed.length);
    writeU32(centralView, 24, entry.data.length);
    writeU16(centralView, 28, pathBytes.length);
    writeU32(centralView, 42, offset);
    central.set(pathBytes, 46);

    localChunks.push(local, compressed, descriptor);
    centralChunks.push(central);
    offset += local.length + compressed.length + descriptor.length;
  }

  const centralDirectory = concatBytes(centralChunks);
  const commentBytes = encode(archiveComment);
  const eocd = new Uint8Array(22 + commentBytes.length) as TestBytes;
  const eocdView = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
  writeU32(eocdView, 0, 0x06054b50);
  writeU16(eocdView, 8, entries.length);
  writeU16(eocdView, 10, entries.length);
  writeU32(eocdView, 12, centralDirectory.length);
  writeU32(eocdView, 16, offset);
  writeU16(eocdView, 20, commentBytes.length);
  eocd.set(commentBytes, 22);

  return concatBytes([...localChunks, centralDirectory, eocd]);
};

describe("ZipWriter", () => {
  it.concurrent("exposes JSZipp as the default namespace", () => {
    expect(JSZipp.ZipWriter).toBe(ZipWriter);
    expect(JSZipp.ZipTransformStream).toBe(ZipTransformStream);
    expect(JSZipp.openZip).toBe(openZip);
    expect(JSZipp.readZipStream).toBe(readZipStream);
  });

  it("worker backend produces byte-identical async archives through the normal ZipWriter", async () => {
    const originalWorker = (globalThis as any).Worker;
    (globalThis as any).Worker = FakeZipWorker;
    FakeZipWorker.calls = 0;
    const backend = createWorkerBackend({ workerSource: () => new FakeZipWorker() as unknown as Worker, fallback: false, minSize: 0 });
    try {
      const modifiedAt = absoluteDate("2025-01-02T03:04:06Z");
      const entries = [
        { path: "plain.txt", data: "plain text", level: 0 },
        { path: "deflated.txt", data: "deflate me ".repeat(1000), level: 6, meta: { modifiedAt, unixPermissions: 0o644 } }
      ];
      const base = new ZipWriter({ outputAs: "uint8array", zip64: "off", comment: "same" });
      for (const entry of entries) await base.add(entry);
      const baseArchive = await base.close();

      const worker = new ZipWriter({ outputAs: "uint8array", zip64: "off", comment: "same", worker: backend });

      for (const entry of entries) await worker.add(entry);

      expectBytesEqual(await worker.close(), baseArchive);
      expect(FakeZipWorker.calls).toBe(entries.length);
    } finally {
      backend.terminate();
      if (originalWorker === undefined) delete (globalThis as any).Worker;
      else (globalThis as any).Worker = originalWorker;
    }
  });

  it("worker backend keeps synchronous methods local and compatible", () => {
    const originalWorker = (globalThis as any).Worker;
    (globalThis as any).Worker = FakeZipWorker;
    FakeZipWorker.calls = 0;
    const backend = createWorkerBackend({ workerSource: () => new FakeZipWorker() as unknown as Worker, fallback: false, minSize: 0 });
    try {
      const writer = new ZipWriter({ outputAs: "uint8array", worker: backend });
      writer.writeSync({ path: "sync.txt", data: "sync text" });
      const archive = writer.closeSync();

      expect(archive).toBeInstanceOf(Uint8Array);
      expect(FakeZipWorker.calls).toBe(0);
    } finally {
      backend.terminate();
      if (originalWorker === undefined) delete (globalThis as any).Worker;
      else (globalThis as any).Worker = originalWorker;
    }
  });

  it("worker backend still accepts the deprecated worker alias", async () => {
    const originalWorker = (globalThis as any).Worker;
    (globalThis as any).Worker = FakeZipWorker;
    FakeZipWorker.calls = 0;
    const backend = createWorkerBackend({ worker: () => new FakeZipWorker() as unknown as Worker, fallback: false, minSize: 0 });
    try {
      const writer = new ZipWriter({ outputAs: "uint8array", worker: backend });
      await writer.add({ path: "alias.txt", data: "alias".repeat(1000) });
      await writer.close();

      expect(FakeZipWorker.calls).toBe(1);
    } finally {
      backend.terminate();
      if (originalWorker === undefined) delete (globalThis as any).Worker;
      else (globalThis as any).Worker = originalWorker;
    }
  });

  it("worker backend can be reused across writers until the caller terminates it", async () => {
    const originalWorker = (globalThis as any).Worker;
    (globalThis as any).Worker = FakeZipWorker;
    FakeZipWorker.calls = 0;
    const backend = createWorkerBackend({ workerSource: () => new FakeZipWorker() as unknown as Worker, fallback: false, minSize: 0 });
    try {
      const first = new ZipWriter({ outputAs: "uint8array", worker: backend });
      await first.add({ path: "a.txt", data: "aaa".repeat(1000) });
      expect(await (await openZip(await first.close())).get("a.txt")?.text()).toBe("aaa".repeat(1000));

      const second = new ZipWriter({ outputAs: "uint8array", worker: backend });
      await second.add({ path: "b.txt", data: "bbb".repeat(1000) });
      expect(await (await openZip(await second.close())).get("b.txt")?.text()).toBe("bbb".repeat(1000));

      expect(FakeZipWorker.calls).toBe(2);
    } finally {
      backend.terminate();
      if (originalWorker === undefined) delete (globalThis as any).Worker;
      else (globalThis as any).Worker = originalWorker;
    }
  });

  it("worker backend falls back locally unless fallback is disabled", async () => {
    const originalWorker = (globalThis as any).Worker;
    delete (globalThis as any).Worker;
    const fallbackBackend = createWorkerBackend({ workerSource: () => new FakeZipWorker() as unknown as Worker, minSize: 0 });
    const requiredBackend = createWorkerBackend({ workerSource: () => new FakeZipWorker() as unknown as Worker, fallback: false, minSize: 0 });
    try {
      const fallback = new ZipWriter({ outputAs: "uint8array", worker: fallbackBackend });
      await fallback.add({ path: "fallback.txt", data: "fallback" });
      expect(await (await openZip(await fallback.close())).get("fallback.txt")?.text()).toBe("fallback");

      const required = new ZipWriter({ outputAs: "uint8array", worker: requiredBackend });
      await expect(required.add({ path: "required.txt", data: "required" })).rejects.toThrow(DOMException);
    } finally {
      fallbackBackend.terminate();
      requiredBackend.terminate();
      if (originalWorker !== undefined) (globalThis as any).Worker = originalWorker;
    }
  });

  it("worker backend measures string minSize in UTF-8 bytes", async () => {
    const originalWorker = (globalThis as any).Worker;
    (globalThis as any).Worker = FakeZipWorker;
    FakeZipWorker.calls = 0;
    const backend = createWorkerBackend({ workerSource: () => new FakeZipWorker() as unknown as Worker, fallback: false, minSize: 4 });
    try {
      const writer = new ZipWriter({ outputAs: "uint8array", worker: backend });
      await writer.add({ path: "utf8.txt", data: "éé" });
      await writer.close();

      expect(FakeZipWorker.calls).toBe(1);
    } finally {
      backend.terminate();
      if (originalWorker === undefined) delete (globalThis as any).Worker;
      else (globalThis as any).Worker = originalWorker;
    }
  });

  it("worker abort rejects only the aborted request and leaves sibling writes alive", async () => {
    const originalWorker = (globalThis as any).Worker;
    (globalThis as any).Worker = ControlledZipWorker;
    const controlled = new ControlledZipWorker();
    const backend = createWorkerBackend({ workerSource: () => controlled as unknown as Worker, fallback: false, minSize: 0 });
    try {
      const firstController = new AbortController();
      const first = new ZipWriter({ outputAs: "uint8array", worker: backend, signal: firstController.signal });
      const second = new ZipWriter({ outputAs: "uint8array", worker: backend });

      const firstAdd = first.add({ path: "first.txt", data: "a".repeat(5000) });
      const secondAdd = second.add({ path: "second.txt", data: "b".repeat(5000) });

      expect(controlled.pendingIds()).toEqual([1, 2]);

      firstController.abort(new DOMException("aborted first request", "AbortError"));
      await expect(firstAdd).rejects.toThrow(/aborted/i);

      await controlled.respond(2);
      await secondAdd;

      const secondArchive = await second.close();
      expect(await (await openZip(secondArchive)).get("second.txt")?.text()).toBe("b".repeat(5000));
    } finally {
      backend.terminate();
      if (originalWorker === undefined) delete (globalThis as any).Worker;
      else (globalThis as any).Worker = originalWorker;
    }
  });

  it.concurrent("writes a ZIP archive with stored entries when level is 0", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off" });

    await writer.add({ path: "plain.txt", data: "stored content" });
    const stream = await writer.close();

    expect(stream).toBeInstanceOf(ReadableStream);
    const reader = await openZip(new Blob([await collect(stream)]));
    expect(reader.entries).toHaveLength(1);
    expect(reader.get("plain.txt")?.compressedSize).toBe("stored content".length);
    expect(await reader.get("plain.txt")?.text()).toBe("stored content");
  });

  it.concurrent("defaults ZIP64 to auto and only emits ZIP64 records when required", async () => {
    const autoWriter = new ZipWriter({ level: 0, outputAs: "uint8array" });
    await autoWriter.add({ path: "small.txt", data: "small" });
    const autoArchive = await autoWriter.close();

    expect(hasSignature(autoArchive, 0x06064b50)).toBe(false);
    expect(hasSignature(autoArchive, 0x07064b50)).toBe(false);
    expect(await (await openZip(autoArchive)).get("small.txt")?.text()).toBe("small");

    const forcedWriter = new ZipWriter({ level: 0, zip64: "force", outputAs: "uint8array" });
    await forcedWriter.add({ path: "small.txt", data: "small" });
    const forcedArchive = await forcedWriter.close();

    expect(hasSignature(forcedArchive, 0x06064b50)).toBe(true);
    expect(hasSignature(forcedArchive, 0x07064b50)).toBe(true);
  });

  it.concurrent("reads forced ZIP64 archives with comments, custom extras, and metadata", async () => {
    const modifiedAt = absoluteDate("2023-11-12T13:14:16Z");
    const customExtra = byteArray([0x55, 0xaa, 0x03, 0x00, 0x01, 0x02, 0x03]);
    const writer = new ZipWriter({
      level: 0,
      zip64: "force",
      outputAs: "uint8array",
      comment: "zip64 archive comment"
    });

    await writer.add({
      path: "meta/file.txt",
      data: "zip64 payload",
      meta: {
        comment: "zip64 entry comment",
        extraField: customExtra,
        modifiedAt,
        unixPermissions: 0o644
      }
    });
    const archive = await writer.close();

    expect(hasSignature(archive, 0x06064b50)).toBe(true);
    expect(hasSignature(archive, 0x07064b50)).toBe(true);

    const reader = await openZip(archive);
    const entry = reader.get("meta/file.txt")!;
    expect(reader.comment).toBe("zip64 archive comment");
    expect(entry.comment).toBe("zip64 entry comment");
    expectBytesEqual(entry.extraField?.slice(0, customExtra.length), customExtra);
    expectBytesEqual(entry.extraField?.slice(customExtra.length, customExtra.length + 4), byteArray([0x01, 0x00, 0x18, 0x00]));
    expect(umode(entry)).toBe(0o100644);
    expect(entry.modifiedAt?.getUTCFullYear()).toBe(2023);
    expect(await entry.text()).toBe("zip64 payload");
  });

  it.concurrent("auto emits ZIP64 when standard entry-count limits are exceeded", async () => {
    const autoWriter = new ZipWriter({ level: 0, outputAs: "uint8array" });
    setInternalEntryCount(autoWriter, 0x10000);

    const autoArchive = await autoWriter.close();
    expect(hasSignature(autoArchive, 0x06064b50)).toBe(true);
    expect(hasSignature(autoArchive, 0x07064b50)).toBe(true);

    const disabledWriter = new ZipWriter({ level: 0, zip64: "off" });
    setInternalEntryCount(disabledWriter, 0x10000);

    await expect(disabledWriter.close()).rejects.toThrow(RangeError);
  });

  it.concurrent("rejects entries that need ZIP64 offsets when ZIP64 is disabled without allocating large archives", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off" });
    setInternalOffset(writer, 0x100000000);

    await expect(writer.add({ path: "too-far.txt", data: "small" })).rejects.toThrow(RangeError);
  });

  it.concurrent("writes compressed entries and preserves metadata", async () => {
    const modifiedAt = absoluteDate("2024-04-05T06:07:08Z");
    const extraField = byteArray([0x99, 0x99, 0x02, 0x00, 0xaa, 0xbb]);
    const repeated = "compressible-".repeat(1024);
    const writer = new ZipWriter({ level: 6, outputAs: "blob" });

    await writer.add({
      path: "docs/readme.txt",
      data: repeated,
      meta: { comment: "file comment", modifiedAt, extraField }
    });
    const archive = await writer.close();

    expect(archive).toBeInstanceOf(Blob);
    const reader = await openZip(archive);
    const entry = reader.get("docs/readme.txt");

    expect(entry?.comment).toBe("file comment");
    expect(entry?.modifiedAt?.getUTCFullYear()).toBe(2024);
    expectBytesEqual(entry?.extraField?.slice(0, extraField.length), extraField);
    expect(entry?.compressedSize).toBeLessThan(repeated.length);
    expect(await entry?.text()).toBe(repeated);
  });

  it.concurrent("round-trips generated dummy files with metadata and content hashes", async () => {
    const files = Array.from({ length: 7 }, (_, index) => {
      const binary = index % 2 === 1;
      const size = 128 + index * 37;
      const bytes = seededRandomBytes(0x5eed0000 + index, size);
      const data = binary ? bytes : decoder.decode(bytes.map((byte) => 32 + (byte % 95)));
      const contentBytes = typeof data === "string" ? encode(data) : data;

      return {
        path: binary ? `random/file-${index}.bin` : `random/file-${index}.txt`,
        data,
        hash: sha256Hex(contentBytes),
        crc32: nodeCrc32(contentBytes),
        expectedUnixMode: binary ? 0o100600 : 0o100644,
        meta: {
          comment: `dummy file ${index}`,
          extraField: byteArray([0xca, 0xfe, 0x02, 0x00, index, size & 0xff]),
          modifiedAt: absoluteDate(`2024-06-${pad2(index + 1)}T12:34:${pad2(10 + index * 2)}Z`),
          unixPermissions: binary ? 0o600 : 0o644
        }
      };
    });
    const writer = new ZipWriter({ level: 6, outputAs: "uint8array", comment: "generated dummy files" });

    for (const file of files) {
      await writer.add({ path: file.path, data: file.data, meta: file.meta });
    }

    const archive = await writer.close();
    const reader = await openZip(archive);

    expect(reader.comment).toBe("generated dummy files");
    expect(reader.entries).toHaveLength(7);

    for (const file of files) {
      const entry = reader.get(file.path);
      expect(entry).toBeDefined();
      expect(entry?.comment).toBe(file.meta.comment);
      expectBytesEqual(entry?.extraField?.slice(0, file.meta.extraField.length), file.meta.extraField, file.path);
      expect(entry?.modifiedAt?.toISOString()).toBe(file.meta.modifiedAt.toISOString());
      expect(umode(entry)).toBe(file.expectedUnixMode);
      expect(entry?.size).toBeGreaterThan(100);
      expect(entry?.size).toBeLessThan(400);

      const bytes = await entry!.bytes();
      expect(sha256Hex(bytes)).toBe(file.hash);
      expect(entry?.crc32).toBe(file.crc32);
    }
  });

  it.concurrent("concurrently writes and reads independent archives with interleaved dummy files", async () => {
    const files = Array.from({ length: 9 }, (_, index) => {
      const number = index + 1;
      const data = seededRandomBytes(0xc0de0000 + number, 2048 + number * 257);
      return {
        path: `d${number}.bin`,
        data,
        hash: sha256Hex(data)
      };
    });
    const groups = [
      [files[0], files[3], files[6]],
      [files[1], files[4], files[7]],
      [files[2], files[5], files[8]]
    ];
    const writers = groups.map((_, index) => new ZipWriter({ level: 6, comment: `zip${index + 1}` }));
    const addPromises = groups.flatMap((group, zipIndex) =>
      group.map((file) => writers[zipIndex].add({ path: file.path, data: file.data }))
    );

    await Promise.all(addPromises);

    const archives = await Promise.all(writers.map(async (writer) => collect(await writer.close())));
    const readers = await Promise.all(archives.map((archive) => openZip(new Blob([archive]))));

    await Promise.all(
      readers.flatMap((reader, zipIndex) => {
        expect(reader.comment).toBe(`zip${zipIndex + 1}`);
        expect(reader.entries.map((entry) => entry.path).sort()).toEqual(groups[zipIndex].map((file) => file.path).sort());

        return groups[zipIndex].map(async (file) => {
          const entry = reader.get(file.path);
          expect(entry).toBeDefined();
          expect(entry?.size).toBe(file.data.length);
          expect(sha256Hex(await entry!.bytes())).toBe(file.hash);
        });
      })
    );
  });

  it.concurrent("reads generated dummy files compressed by Node zlib", async () => {
    const files = Array.from({ length: 7 }, (_, index): ZlibZipEntry => {
      const binary = index % 2 === 0;
      const size = 131 + index * 31;
      const randomBytes = seededRandomBytes(0xc0ffee00 + index, size);
      const data = binary ? randomBytes : encode(decoder.decode(randomBytes.map((byte) => 32 + (byte % 95))));

      return {
        path: binary ? `node-zlib/file-${index}.bin` : `node-zlib/file-${index}.txt`,
        data,
        comment: `node zlib file ${index}`,
        extraField: byteArray([0xb0, 0x7a, 0x02, 0x00, index, size & 0xff]),
        modifiedAt: absoluteDate(`2025-07-${pad2(index + 1)}T08:09:${pad2(12 + index * 2)}Z`),
        unixMode: binary ? 0o100600 : 0o100644
      };
    });
    const reader = await openZip(buildNodeDeflatedZip(files, "node zlib generated files"));

    expect(reader.comment).toBe("node zlib generated files");
    expect(reader.entries).toHaveLength(7);

    for (const file of files) {
      const entry = reader.get(file.path);
      const bytes = await entry!.bytes();

      expect(entry).toBeDefined();
      expect(entry?.comment).toBe(file.comment);
      expectBytesEqual(entry?.extraField, file.extraField, file.path);
      expect(entry?.modifiedAt?.toISOString()).toBe(file.modifiedAt.toISOString());
      expect(umode(entry)).toBe(file.unixMode);
      expect(entry?.size).toBeGreaterThan(100);
      expect(entry?.size).toBeLessThan(400);
      expect(sha256Hex(bytes)).toBe(sha256Hex(file.data));
      expect(entry?.crc32).toBe(nodeCrc32(file.data));
    }
  });

  it.concurrent("decompresses representative ZIP variants through random-access and stream readers", async () => {
    const repeatedText = encode("alpha beta gamma\n".repeat(256));
    const binary = seededRandomBytes(0xdecafbad, 4096);
    const empty = byteArray([]);
    const storedArchive = buildStoredArchive([
      { path: "stored/empty.txt", data: empty },
      { path: "stored/binary.bin", data: binary },
      { path: "stored/directory/", data: "" }
    ], { comment: "stored archive" });

    const deflatedArchive = await buildDeflatedArchive([
      { path: "deflate/repeated.txt", data: repeatedText, method: "deflate", level: 9 },
      { path: "deflate/binary.bin", data: binary, method: "deflate", level: 6 }
    ], { comment: "deflated archive" });

    const zip64Writer = new ZipWriter({ outputAs: "uint8array", zip64: "force", level: 6, comment: "zip64 archive" });
    await zip64Writer.add({ path: "zip64/text.txt", data: repeatedText, method: "deflate" });
    await zip64Writer.add({ path: "zip64/stored.bin", data: binary, method: "store" });

    const zlibArchive = buildNodeDeflatedZip([
      {
        path: "zlib/unicode-名.txt",
        data: encode("zlib payload\n".repeat(128)),
        comment: "zlib entry comment",
        extraField: byteArray([0xca, 0xfe, 0x02, 0x00, 0x01, 0x02]),
        modifiedAt: absoluteDate("2026-01-02T03:04:06Z"),
        unixMode: 0o100644
      }
    ], "node-zlib archive");

    const descriptorArchive = buildDataDescriptorZip([
      { path: "descriptor/deflated.txt", data: repeatedText, method: 8 },
      { path: "descriptor/stored.bin", data: binary, method: 0 }
    ], "descriptor archive");

    const cases = [
      {
        name: "stored",
        archive: storedArchive,
        comment: "stored archive",
        expected: new Map([
          ["stored/empty.txt", empty],
          ["stored/binary.bin", binary],
          ["stored/directory/", empty]
        ])
      },
      {
        name: "deflated",
        archive: deflatedArchive,
        comment: "deflated archive",
        expected: new Map([
          ["deflate/repeated.txt", repeatedText],
          ["deflate/binary.bin", binary]
        ])
      },
      {
        name: "zip64",
        archive: await zip64Writer.close(),
        comment: "zip64 archive",
        expected: new Map([
          ["zip64/text.txt", repeatedText],
          ["zip64/stored.bin", binary]
        ])
      },
      {
        name: "node-zlib",
        archive: zlibArchive,
        comment: "node-zlib archive",
        expected: new Map([
          ["zlib/unicode-名.txt", encode("zlib payload\n".repeat(128))]
        ])
      },
      {
        name: "data-descriptor",
        archive: descriptorArchive,
        comment: "descriptor archive",
        expected: new Map([
          ["descriptor/deflated.txt", repeatedText],
          ["descriptor/stored.bin", binary]
        ])
      }
    ];

    for (const item of cases) {
      const reader = await openZip(item.archive);
      const streamed = new Map<string, TestBytes>();

      expect(reader.comment, item.name).toBe(item.comment);
      expect(reader.entries.map((entry) => entry.path), item.name).toEqual([...item.expected.keys()]);

      for (const [path, expected] of item.expected) {
        const entry = reader.get(path);

        expect(entry, `${item.name}:${path}`).toBeDefined();
        expectBytesEqual(await entry!.bytes(), expected, `${item.name}:${path}`);
        expect(entry!.crc32, `${item.name}:${path}`).toBe(nodeCrc32(expected));
        expect(entry!.isDirectory, `${item.name}:${path}`).toBe(path.endsWith("/"));
      }

      for await (const entry of readZipStream(byteStreamOf(item.archive, 11))) {
        streamed.set(entry.path, await entry.bytes());
      }

      expect([...streamed.keys()], item.name).toEqual([...item.expected.keys()]);
      for (const [path, expected] of item.expected) {
        expectBytesEqual(streamed.get(path), expected, `${item.name}:${path}`);
      }
    }
  }, 15_000);

  it.concurrent("encodes ZIP DOS timestamps at field boundaries and decodes zero date fields safely", async () => {
    const cases = [
      { path: "min.txt", modifiedAt: absoluteDate("1980-01-01T00:00:00Z") },
      { path: "leap.txt", modifiedAt: absoluteDate("2024-02-29T08:07:06Z") },
      { path: "odd-second.txt", modifiedAt: absoluteDate("2024-12-31T23:59:59Z") },
      { path: "pre-1980.txt", modifiedAt: absoluteDate("1979-12-31T23:59:58Z") },
      { path: "max.txt", modifiedAt: absoluteDate("2107-12-31T23:59:58Z") }
    ];

    for (const item of cases) {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await writer.add({ path: item.path, data: item.path, meta: { modifiedAt: item.modifiedAt } });
      const archive = await writer.close();
      const raw = rawZipTimestamp(archive);
      const extras = rawZipExtrasByPath(archive).get(item.path);
      const expected = expectedZipTimestamp(item.modifiedAt);
      const canUseExtendedTimestamp = item.modifiedAt.getTime() >= 0 && Math.floor(item.modifiedAt.getTime() / 1000) <= 0xffffffff;

      expect(extras).toBeDefined();
      expect(raw.localDate).toBe(expected.date);
      expect(raw.centralDate).toBe(expected.date);
      expect(raw.localTime).toBe(expected.time);
      expect(raw.centralTime).toBe(expected.time);
      if (canUseExtendedTimestamp) {
        expectExtendedTimestampExtra(extras!.localExtra, item.modifiedAt, `${item.path} local 0x5455`);
        expectExtendedTimestampExtra(extras!.centralExtra, item.modifiedAt, `${item.path} central 0x5455`);
      } else {
        expectNoExtendedTimestampExtra(extras!.localExtra, `${item.path} local 0x5455`);
        expectNoExtendedTimestampExtra(extras!.centralExtra, `${item.path} central 0x5455`);
      }

      const entry = (await openZip(archive)).get(item.path)!;
      expect(entry.modifiedAt?.toISOString()).toBe(canUseExtendedTimestamp
        ? item.modifiedAt.toISOString()
        : dateFromZipTimestamp(raw.centralDate, raw.centralTime).toISOString());
    }

    const zeroWriter = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
    await zeroWriter.add({
      path: "zero.txt",
      data: "zero",
      meta: { extraField: byteArray([0x55, 0x54, 0x00, 0x00]) }
    });
    const zeroArchive = byteArray(await zeroWriter.close());
    const zeroView = new DataView(zeroArchive.buffer, zeroArchive.byteOffset, zeroArchive.byteLength);
    const zeroTime = 0x6daf;
    const zeroCentralOffset = centralDirectoryOffset(zeroArchive);
    zeroView.setUint16(10, zeroTime, true);
    zeroView.setUint16(12, 0, true);
    zeroView.setUint16(zeroCentralOffset + 12, zeroTime, true);
    zeroView.setUint16(zeroCentralOffset + 14, 0, true);

    const zeroEntry = (await openZip(zeroArchive)).get("zero.txt")!;
    expect(zeroEntry.modifiedAt?.getFullYear()).toBe(1980);
    expect(zeroEntry.modifiedAt?.getMonth()).toBe(0);
    expect(zeroEntry.modifiedAt?.getDate()).toBe(1);
    expect(zeroEntry.modifiedAt?.getHours()).toBe(13);
    expect(zeroEntry.modifiedAt?.getMinutes()).toBe(45);
    expect(zeroEntry.modifiedAt?.getSeconds()).toBe(30);
  });

  it.concurrent("encodes compression dates from absolute timestamps across GMT-12 through GMT+14", async () => {
    const offsetSuffix = (offsetHours: number): string => {
      if (offsetHours === 0) return "Z";
      const sign = offsetHours < 0 ? "-" : "+";
      return `${sign}${pad2(Math.abs(offsetHours))}:00`;
    };
    const offsetLabel = (offsetHours: number): string =>
      offsetHours < 0 ? `gmt-minus-${Math.abs(offsetHours)}` : `gmt-plus-${offsetHours}`;
    const cases = Array.from({ length: 27 }, (_, index) => {
      const offsetHours = index - 12;
      return {
        path: `tz/${offsetLabel(offsetHours)}.txt`,
        modifiedAt: absoluteDate(`2026-05-31T12:00:00${offsetSuffix(offsetHours)}`),
        offsetHours
      };
    });
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });

    for (let index = 1; index < cases.length; index++) {
      expect(cases[index - 1].modifiedAt.getTime() - cases[index].modifiedAt.getTime()).toBe(60 * 60 * 1000);
    }

    for (const item of cases) {
      await writer.add({ path: item.path, data: String(item.offsetHours), meta: { modifiedAt: item.modifiedAt } });
    }

    const archive = await writer.close();
    const rawByPath = rawZipTimestampsByPath(archive);
    const reader = await openZip(archive);

    for (const item of cases) {
      const expected = expectedZipTimestamp(item.modifiedAt);
      const raw = rawByPath.get(item.path);
      expect(raw).toBeDefined();
      expect(raw?.localDate).toBe(expected.date);
      expect(raw?.centralDate).toBe(expected.date);
      expect(raw?.localTime).toBe(expected.time);
      expect(raw?.centralTime).toBe(expected.time);
      expect(reader.get(item.path)?.modifiedAt?.toISOString()).toBe(item.modifiedAt.toISOString());
    }
  });

  it.concurrent("writes legacy DOS fields and Extended Timestamp extras for the same modifiedAt", async () => {
    const modifiedAt = absoluteDate("2026-06-02T03:00:01Z");
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });

    await writer.add({ path: "mtime.txt", data: "x", meta: { modifiedAt } });

    const archive = await writer.close();
    const raw = rawZipTimestamp(archive);
    const extras = rawZipExtrasByPath(archive).get("mtime.txt");
    const expectedDos = expectedZipTimestamp(modifiedAt);

    expect(extras).toBeDefined();
    expect(raw.localDate).toBe(expectedDos.date);
    expect(raw.centralDate).toBe(expectedDos.date);
    expect(raw.localTime).toBe(expectedDos.time);
    expect(raw.centralTime).toBe(expectedDos.time);
    expectExtendedTimestampExtra(extras!.localExtra, modifiedAt, "local 0x5455");
    expectExtendedTimestampExtra(extras!.centralExtra, modifiedAt, "central 0x5455");

    const entry = (await openZip(archive)).get("mtime.txt")!;
    expect(entry.modifiedAt?.toISOString()).toBe("2026-06-02T03:00:01.000Z");
  });

  it.concurrent("prefers Extended Timestamp mtime over conflicting legacy DOS fields", async () => {
    const modifiedAt = absoluteDate("2026-06-02T03:00:01Z");
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });

    await writer.add({ path: "mtime.txt", data: "x", meta: { modifiedAt } });

    const archive = byteArray(await writer.close());
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const centralOffset = centralDirectoryOffset(archive);
    const conflictingDos = expectedZipTimestamp(absoluteDate("1999-12-31T23:58:56Z"));

    view.setUint16(10, conflictingDos.time, true);
    view.setUint16(12, conflictingDos.date, true);
    view.setUint16(centralOffset + 12, conflictingDos.time, true);
    view.setUint16(centralOffset + 14, conflictingDos.date, true);

    const raw = rawZipTimestamp(archive);
    const extras = rawZipExtrasByPath(archive).get("mtime.txt");
    expect(raw.localDate).toBe(conflictingDos.date);
    expect(raw.centralDate).toBe(conflictingDos.date);
    expect(raw.localTime).toBe(conflictingDos.time);
    expect(raw.centralTime).toBe(conflictingDos.time);
    expect(extras).toBeDefined();
    expectExtendedTimestampExtra(extras!.localExtra, modifiedAt, "local 0x5455");
    expectExtendedTimestampExtra(extras!.centralExtra, modifiedAt, "central 0x5455");

    const entry = (await openZip(archive)).get("mtime.txt")!;
    expect(entry.modifiedAt?.toISOString()).toBe("2026-06-02T03:00:01.000Z");
  });

  it.concurrent("accounts for DOS timestamp two-second precision while preserving Extended Timestamp mtime", async () => {
    const cases = [
      {
        path: "mtime-33.txt",
        modifiedAt: absoluteDate("2026-06-02T01:14:33Z"),
        expectedDosSecond: 32,
        expectedDifferenceMs: 1_000
      },
      {
        path: "mtime-34.txt",
        modifiedAt: absoluteDate("2026-06-02T01:14:34Z"),
        expectedDosSecond: 34,
        expectedDifferenceMs: 0
      },
      {
        path: "mtime-35.txt",
        modifiedAt: absoluteDate("2026-06-02T01:14:35Z"),
        expectedDosSecond: 34,
        expectedDifferenceMs: 1_000
      },
      {
        path: "mtime-36.txt",
        modifiedAt: absoluteDate("2026-06-02T01:14:36Z"),
        expectedDosSecond: 36,
        expectedDifferenceMs: 0
      },
      {
        path: "mtime-59.txt",
        modifiedAt: absoluteDate("2026-06-02T01:14:59Z"),
        expectedDosSecond: 58,
        expectedDifferenceMs: 1_000
      },
      {
        path: "mtime-60.txt",
        modifiedAt: absoluteDate("2026-06-02T01:15:00Z"),
        expectedDosSecond: 0,
        expectedDifferenceMs: 0
      },
      {
        path: "mtime-61.txt",
        modifiedAt: absoluteDate("2026-06-02T01:15:01Z"),
        expectedDosSecond: 0,
        expectedDifferenceMs: 1_000
      },
      {
        path: "mtime-62.txt",
        modifiedAt: absoluteDate("2026-06-02T01:15:02Z"),
        expectedDosSecond: 2,
        expectedDifferenceMs: 0
      }
    ];

    for (const item of cases) {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });

      await writer.add({ path: item.path, data: "x", meta: { modifiedAt: item.modifiedAt } });

      const archive = await writer.close();
      const raw = rawZipTimestamp(archive);
      const extras = rawZipExtrasByPath(archive).get(item.path);
      const decodedDos = dateFromZipTimestamp(raw.centralDate, raw.centralTime);

      expect(extras).toBeDefined();
      expectExtendedTimestampExtra(extras!.localExtra, item.modifiedAt, `${item.path} local 0x5455`);
      expectExtendedTimestampExtra(extras!.centralExtra, item.modifiedAt, `${item.path} central 0x5455`);

      // ZIP's legacy DOS time stores seconds divided by two, so odd seconds are
      // rounded down in both the local and central headers. A timestamp ending in
      // :35 is therefore represented as :34 in the DOS fields, while the 0x5455
      // Extended Timestamp extra keeps the exact whole Unix second. Even seconds
      // round-trip exactly in the DOS fields.
      expect(decodedDos.getSeconds()).toBe(item.expectedDosSecond);
      expect(item.modifiedAt.getTime() - decodedDos.getTime()).toBe(item.expectedDifferenceMs);

      const entry = (await openZip(archive)).get(item.path)!;
      expect(entry.modifiedAt?.toISOString()).toBe(item.modifiedAt.toISOString());
    }
  });

  it.concurrent("can omit automatic Extended Timestamp extras to reduce per-entry metadata", async () => {
    const modifiedAt = absoluteDate("2026-06-02T01:14:35Z");
    const defaultWriter = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
    const compactWriter = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos });

    await defaultWriter.add({ path: "mtime.txt", data: "x", meta: { modifiedAt } });
    await compactWriter.add({ path: "mtime.txt", data: "x", meta: { modifiedAt } });

    const defaultArchive = await defaultWriter.close();
    const compactArchive = await compactWriter.close();
    const defaultExtras = rawZipExtrasByPath(defaultArchive).get("mtime.txt");
    const compactExtras = rawZipExtrasByPath(compactArchive).get("mtime.txt");
    const compactRaw = rawZipTimestamp(compactArchive);
    const expected = expectedZipTimestamp(modifiedAt);

    expect(defaultExtras).toBeDefined();
    expect(compactExtras).toBeDefined();
    expectExtendedTimestampExtra(defaultExtras!.localExtra, modifiedAt, "default local 0x5455");
    expectExtendedTimestampExtra(defaultExtras!.centralExtra, modifiedAt, "default central 0x5455");
    expectNoExtendedTimestampExtra(compactExtras!.localExtra, "compact local 0x5455");
    expectNoExtendedTimestampExtra(compactExtras!.centralExtra, "compact central 0x5455");
    expect(defaultArchive.length - compactArchive.length).toBe(18);
    expect(compactRaw.localDate).toBe(expected.date);
    expect(compactRaw.localTime).toBe(expected.time);
    expect(compactRaw.centralDate).toBe(expected.date);
    expect(compactRaw.centralTime).toBe(expected.time);
  });

  it.concurrent("encodes DOS timestamps as local time and preserves fflate #219 UTC mtime in the extra field", async () => {
    const modifiedAt = new Date(504932400000); // 1986-01-01T03:00:00.000Z
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });

    await writer.add({
      path: "fflate-219.txt",
      data: "x",
      meta: { modifiedAt }
    });

    const archive = await writer.close();
    const raw = rawZipTimestamp(archive);
    const expected = expectedZipTimestamp(modifiedAt);

    expect(modifiedAt.toISOString()).toBe("1986-01-01T03:00:00.000Z");
    expect(raw.localDate).toBe(expected.date);
    expect(raw.centralDate).toBe(expected.date);
    expect(raw.localTime).toBe(expected.time);
    expect(raw.centralTime).toBe(expected.time);

    const entry = (await openZip(archive)).get("fflate-219.txt")!;
    expect(entry.modifiedAt?.toISOString()).toBe("1986-01-01T03:00:00.000Z");
  });

  it.concurrent("accepts Blob, Uint8Array, directory, and ReadableStream payloads", async () => {
    const writer = new ZipWriter({ level: 6, outputAs: "blob" });

    await writer.add({ path: "blob.txt", data: new Blob(["blob data"]) });
    await writer.add({ path: "bytes.txt", data: encode("byte data") });
    await writer.add({ path: "empty/", data: "" });
    await writer.add({ path: "stream.txt", data: streamOf("stream ", "data") });
    const archive = await writer.close();

    const reader = await openZip(archive);

    expect(await reader.get("blob.txt")?.text()).toBe("blob data");
    expect(await reader.get("bytes.txt")?.text()).toBe("byte data");
    expect(reader.get("empty/")?.isDirectory).toBe(true);
    expect(await reader.get("stream.txt")?.text()).toBe("stream data");
  });

  it.concurrent("returns a Response wrapper when outputAs is response", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "response" });

    await writer.add({ path: "response.txt", data: "response body" });
    const response = await writer.close();

    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toBe("application/zip");

    const reader = await openZip(await response.blob());
    expect(await reader.get("response.txt")?.text()).toBe("response body");
  });

  it.concurrent("returns a Blob with the configured MIME type when outputAs is blob", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "blob", mimeType: "application/x-zip-compressed" });

    await writer.add({ path: "blob-mime.txt", data: "blob body" });
    const blob = await writer.close();

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/x-zip-compressed");
    expect(await (await openZip(blob)).get("blob-mime.txt")?.text()).toBe("blob body");
  });

  it.concurrent("returns Uint8Array and ArrayBuffer outputs", async () => {
    const bytesWriter = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
    await bytesWriter.add({ path: "bytes-output.txt", data: "byte output" });
    const bytes = await bytesWriter.close();

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(await (await openZip(bytes)).get("bytes-output.txt")?.text()).toBe("byte output");

    const bufferWriter = new ZipWriter({ level: 0, zip64: "off", outputAs: "arraybuffer" });
    await bufferWriter.add({ path: "buffer-output.txt", data: "buffer output" });
    const buffer = await bufferWriter.close();

    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(await (await openZip(buffer)).get("buffer-output.txt")?.text()).toBe("buffer output");
  });

  it.concurrent("supports synchronous writing for in-memory entries and output modes", async () => {
    const bytesWriter = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
    bytesWriter.writeSync({ path: "sync-string.txt", data: "sync text" });
    bytesWriter.writeSync({ path: "sync-bytes.bin", data: byteArray([7, 8, 9]) });
    const bytes = bytesWriter.closeSync();

    expect(bytes).toBeInstanceOf(Uint8Array);
    const bytesReader = await openZip(bytes);
    expect(await bytesReader.get("sync-string.txt")?.text()).toBe("sync text");
    expectBytesEqual(await bytesReader.get("sync-bytes.bin")!.bytes(), byteArray([7, 8, 9]));

    const blobWriter = new ZipWriter({ level: 0, zip64: "off", outputAs: "blob" });
    blobWriter.writeSync({ path: "sync-blob.txt", data: "blob body" });
    const blob = blobWriter.closeSync();
    expect(blob).toBeInstanceOf(Blob);
    expect(await (await openZip(blob)).get("sync-blob.txt")?.text()).toBe("blob body");

    const responseWriter = new ZipWriter({ level: 0, zip64: "off", outputAs: "response", mimeType: "application/custom-zip" });
    responseWriter.writeSync({ path: "sync-response.txt", data: "response body" });
    const response = responseWriter.closeSync();
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toBe("application/custom-zip");
    expect(await (await openZip(await response.arrayBuffer())).get("sync-response.txt")?.text()).toBe("response body");
  });

  it.concurrent("keeps asynchronous and synchronous writer modes separate", async () => {
    const asyncWriter = new ZipWriter({ level: 0 });
    await asyncWriter.add({ path: "async.txt", data: "async" });
    expect(() => asyncWriter.writeSync({ path: "sync.txt", data: "sync" })).toThrow(DOMException);
    expect(() => asyncWriter.closeSync()).toThrow(DOMException);
    await asyncWriter.close();

    const syncWriter = new ZipWriter({ level: 0 });
    syncWriter.writeSync({ path: "sync.txt", data: "sync" });
    await expect(syncWriter.add({ path: "async.txt", data: "async" })).rejects.toThrow(DOMException);
    await expect(syncWriter.close()).rejects.toThrow(DOMException);
  });

  it.concurrent("allows entry-level compression method overrides", async () => {
    const repeated = "compress-me-".repeat(512);
    const writer = new ZipWriter({ level: 6, outputAs: "blob" });

    await writer.add({ path: "stored.txt", data: repeated, method: "store" });
    await writer.add({ path: "deflated.txt", data: repeated, method: "deflate" });
    const archive = await writer.close();
    const reader = await openZip(archive);

    expect(reader.get("stored.txt")?.compressedSize).toBe(repeated.length);
    expect(reader.get("deflated.txt")?.compressedSize).toBeLessThan(repeated.length);
  });

  it.concurrent("stores incompressible entries automatically when DEFLATE would expand them", async () => {
    const data = seededRandomBytes(0x12345678, 4096);
    const writer = new ZipWriter({ level: 6, zip64: "off", outputAs: "uint8array" });

    writer.writeSync({ path: "random.bin", data });
    const archive = writer.closeSync();
    const metadata = centralEntryMetadata(archive, "random.bin");

    expect(metadata.method).toBe(0);
    expect(metadata.compressedSize).toBe(data.length);
    expect(metadata.size).toBe(data.length);
    expectBytesEqual(await (await openZip(archive)).get("random.bin")!.bytes(), data);
  });

  it.concurrent("honors explicit deflate even when storing would be smaller", async () => {
    const data = seededRandomBytes(0x87654321, 4096);
    const writer = new ZipWriter({ level: 6, zip64: "off", outputAs: "uint8array" });

    writer.writeSync({ path: "random.bin", data, method: "deflate" });
    const archive = writer.closeSync();
    const metadata = centralEntryMetadata(archive, "random.bin");

    expect(metadata.method).toBe(8);
    expect(metadata.compressedSize).toBeGreaterThan(data.length);
    expectBytesEqual(await (await openZip(archive)).get("random.bin")!.bytes(), data);
  });

  it.concurrent("honors per-entry compression levels", async () => {
    let text = "";
    for (let index = 0; index < 2000; index++) {
      text += `row-${index % 97}-${"abc".repeat(index % 13)}-${index}\n`;
    }
    const writer = new ZipWriter({ level: 6, outputAs: "blob" });

    await writer.add({ path: "fast.txt", data: text, level: 1 });
    await writer.add({ path: "small.txt", data: text, level: 9 });
    const reader = await openZip(await writer.close());

    expect(reader.get("fast.txt")?.compressedSize).toBeGreaterThan(reader.get("small.txt")!.compressedSize);
    expect(await reader.get("fast.txt")?.text()).toBe(text);
    expect(await reader.get("small.txt")?.text()).toBe(text);
  });

  it.concurrent("falls back to DEFLATE stored blocks for incompressible entries", async () => {
    const data = new Uint8Array(4096) as TestBytes;
    let state = 0x12345678;
    for (let index = 0; index < data.length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      data[index] = state & 0xff;
    }
    const writer = new ZipWriter({ level: 9, outputAs: "uint8array" });

    await writer.add({ path: "incompressible.bin", data, method: "deflate" });
    const archive = await writer.close();
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const methodOffset = 8;
    const compressedSizeOffset = 18;
    const compressedSize = view.getUint32(compressedSizeOffset, true);

    expect(view.getUint16(methodOffset, true)).toBe(8);
    expect(compressedSize).toBe(data.length + 5);
    expectBytesEqual(await (await openZip(archive)).get("incompressible.bin")!.bytes(), data);
  });

  it.concurrent("writes archive comments, ArrayBuffer input entries, directories, and external attributes", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "blob", comment: "archive comment" });
    const data = encode("buffer input").buffer;

    await writer.add({ path: "bin/input.txt", data, meta: { unixPermissions: 0o755 } });
    await writer.add({ path: "tools/", data: "", meta: { unixPermissions: 0o755 } });
    const archive = await writer.close();
    const bytes = await archive.arrayBuffer();
    const view = new DataView(bytes);
    const commentLength = view.getUint16(bytes.byteLength - "archive comment".length - 2, true);

    expect(commentLength).toBe("archive comment".length);

    const reader = await openZip(archive);
    const file = reader.get("bin/input.txt");
    const directory = reader.get("tools/");
    expect(reader.comment).toBe("archive comment");
    expect(await file?.text()).toBe("buffer input");
    expect(file?.externalAttributes).toBe((0o100755 << 16) >>> 0);
    expect(umode(file)).toBe(0o100755);
    expect(directory?.isDirectory).toBe(true);
    expect(directory?.externalAttributes).toBe(((0o040755 << 16) | 0x10) >>> 0);
    expect(umode(directory)).toBe(0o040755);
  });

  it.concurrent("reports progress and honors abort signals", async () => {
    const progress: string[] = [];
    const writer = new ZipWriter({
      level: 0,
      zip64: "off",
      outputAs: "blob",
      onProgress: (event) => {
        progress.push(event.phase);
      }
    });

    await writer.add({ path: "progress.txt", data: streamOf("pro", "gress") });
    await writer.close();
    expect(progress).toContain("read");
    expect(progress).toContain("write");

    const controller = new AbortController();
    controller.abort();
    const aborted = new ZipWriter({ signal: controller.signal });
    await expect(aborted.add({ path: "abort.txt", data: "abort" })).rejects.toThrow();
  });

  it.concurrent("supports custom response MIME type", async () => {
    const writer = new ZipWriter({ outputAs: "response", mimeType: "application/x-zip-compressed" });

    await writer.add({ path: "mime.txt", data: "mime" });
    const response = await writer.close();

    expect(response.headers.get("Content-Type")).toBe("application/x-zip-compressed");
  });

  it.concurrent("rejects add and close after the writer is closed", async () => {
    const writer = new ZipWriter({ outputAs: "blob" });

    await writer.add({ path: "closed.txt", data: "closed" });
    await writer.close();

    await expect(writer.add({ path: "late.txt", data: "late" })).rejects.toThrow(DOMException);
    await expect(writer.close()).rejects.toThrow(DOMException);
  });

  describe("field validation", () => {
    it.concurrent("rejects an entry path longer than 65535 bytes instead of truncating it", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await expect(writer.add({ path: "a".repeat(70000), data: "x" })).rejects.toThrow(RangeError);
    });

    it.concurrent("rejects an entry comment longer than 65535 bytes", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await expect(writer.add({ path: "f.txt", data: "x", meta: { comment: "c".repeat(70000) } })).rejects.toThrow(RangeError);
    });
  });

  describe("ZIP64 extra fields", () => {
    it.concurrent("omits the local-header offset from the local ZIP64 extra but keeps it in central", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "force", outputAs: "uint8array" });
      await writer.add({ path: "z.txt", data: "payload" });
      const archive = await writer.close();
      const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
      const localHeader = findSignature(archive, 0x04034b50);
      const central = findSignature(archive, 0x02014b50);

      expect(view.getUint16(localHeader + 28, true)).toBe(29);
      expect(view.getUint16(central + 30, true)).toBe(37);
      expect(await (await openZip(archive)).get("z.txt")?.text()).toBe("payload");
    });
  });

  describe("timestamp edge cases", () => {
    it.concurrent("clamps a year past 2107 to 2107 rather than corrupting the month/day", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await writer.add({ path: "future.txt", data: "x", meta: { modifiedAt: absoluteDate("2200-06-15T10:00:00Z") } });
      const archive = await writer.close();
      const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
      const date = view.getUint16(12, true);

      expect((date >>> 9) & 0x7f).toBe(127);
      expect((date >>> 5) & 0x0f).toBe(6);
      expect(date & 0x1f).toBe(15);
      const entry = (await openZip(archive)).get("future.txt")!;
      expect(entry.modifiedAt?.getFullYear()).toBe(2107);
    });

    it.concurrent("encodes the same timestamp fields for the same fixed instant", async () => {
      const instant = Date.UTC(2024, 5, 1, 12, 0, 0);
      const a = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await a.add({ path: "f.txt", data: "x", meta: { modifiedAt: new Date(instant) } });
      const b = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await b.add({ path: "f.txt", data: "x", meta: { modifiedAt: new Date(instant) } });

      expect(Array.from(await a.close())).toEqual(Array.from(await b.close()));
    });
  });

  describe("path policy", () => {
    it.concurrent("default ('unsafe') keeps legacy behavior and can produce self-incompatible archives", async () => {
      const bytes = buildArchive([{ path: "../evil.txt", data: "x" }]);

      await expect(openZip(bytes)).rejects.toThrow(/unsafe zip entry path/i);
      const reader = await openZip(bytes, { pathMode: "unsafe" });
      expect(reader.entries[0].path).toBe("../evil.txt");
    });

    it.concurrent("strict writer rejects unsafe paths", () => {
      const writer = new ZipWriter({ outputAs: "uint8array", pathMode: "strict" });
      expect(() => writer.writeSync({ path: "../evil.txt", data: "x" })).toThrow(/unsafe zip entry path/i);
    });

    it.concurrent("strict-package writer applies strict per-path safety and round-trips through strict-package read", async () => {
      const reject = new ZipWriter({ outputAs: "uint8array", pathMode: "strict-package" });
      expect(() => reject.writeSync({ path: "../evil.txt", data: "x" })).toThrow(/unsafe zip entry path/i);

      const writer = new ZipWriter({ outputAs: "uint8array", pathMode: "strict-package" });
      await writer.add({ path: "pkg/a.txt", data: "one" });
      await writer.add({ path: "pkg/b.txt", data: "two" });
      const archive = byteArray(await writer.close());
      const reader = await openZip(archive, { pathMode: "strict-package" });
      expect(reader.entries.map((entry) => entry.path)).toEqual(["pkg/a.txt", "pkg/b.txt"]);
      expect(await reader.get("pkg/b.txt")?.text()).toBe("two");
    });

    it.concurrent("sanitize writer produces a strict-readable archive", async () => {
      const bytes = buildArchive([{ path: "../../evil.txt", data: "x" }], { pathMode: "sanitize" });
      const reader = await openZip(bytes);
      expect(reader.entries[0].path).toBe("evil.txt");
      expect(await reader.get("evil.txt")?.text()).toBe("x");
    });
  });

  describe("central directory metadata", () => {
    const versionMadeBy = (bytes: Uint8Array): number => {
      const central = findSignature(bytes, 0x02014b50);
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(central + 4, true);
    };

    it.concurrent("advertises the Unix host (3) when Unix mode bits are present", () => {
      const bytes = buildArchive([{ path: "run.sh", data: "#!/bin/sh\n", meta: { unixPermissions: 0o755 } }]);
      expect(versionMadeBy(bytes) >>> 8).toBe(3);
      expect(versionMadeBy(bytes) & 0xff).toBe(45);
    });

    it.concurrent("keeps the DOS host (0) when no Unix metadata is written", () => {
      // No explicit permission option and a DOS-only timestamps mode, so no Unix
      // store permission is synthesized and the DOS host (0) is kept.
      const bytes = buildArchive([{ path: "a.txt", data: "hello" }], { timestamps: TimestampMode.Dos });
      expect(versionMadeBy(bytes) >>> 8).toBe(0);
    });

    it.concurrent("advertises the Unix host (3) once a unix timestamp is added (default mode)", () => {
      // The default Dos | Unix mode writes an Extended Timestamp (0x5455), which
      // triggers default Unix store permissions and the Unix host (3).
      const bytes = buildArchive([{ path: "a.txt", data: "hello" }]);
      expect(versionMadeBy(bytes) >>> 8).toBe(3);
    });
  });

  describe("unix store permissions", () => {
    it.concurrent("synthesizes default permissions when a unix timestamp is written", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Unix });
      await writer.add({ path: "file.txt", data: "hi" });
      await writer.add({ path: "dir/", data: "" });
      const reader = await openZip(await writer.close());
      // Regular file -> 0o644, directory -> 0o755, both with the right type bits.
      expect(umode(reader.get("file.txt"))).toBe(0o100644);
      expect(umode(reader.get("dir/"))).toBe(0o040755);
    });

    it.concurrent("does not synthesize permissions in dos-only mode without an explicit option", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos });
      await writer.add({ path: "file.txt", data: "hi" });
      const reader = await openZip(await writer.close());
      expect(umode(reader.get("file.txt"))).toBeUndefined();
      expect(reader.get("file.txt")?.externalAttributes).toBe(0);
    });

    it.concurrent("honors an explicit unixPermissions option and advertises the Unix host", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Unix });
      await writer.add({ path: "secret.txt", data: "x", meta: { unixPermissions: 0o600 } });
      const bytes = await writer.close();
      const reader = await openZip(bytes);
      expect(umode(reader.get("secret.txt"))).toBe(0o100600);
      const central = findSignature(bytes, 0x02014b50);
      expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(central + 4, true) >>> 8).toBe(3);
    });

    it.concurrent("records an explicit 0o755 on a regular file without complaint", async () => {
      // No validation: any permission combination is accepted as-is.
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Unix });
      await writer.add({ path: "bin/run", data: "#!/bin/sh\n", meta: { unixPermissions: 0o755 } });
      const reader = await openZip(await writer.close());
      expect(umode(reader.get("bin/run"))).toBe(0o100755);
    });

    it.concurrent("accepts an unusual permission on a directory as-is", async () => {
      // 0o644 on a directory is unusual but not rejected — POSIX places no
      // constraint on which mode-bit combinations are meaningful.
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await writer.add({ path: "dir/", data: "", meta: { unixPermissions: 0o644 } });
      const reader = await openZip(await writer.close());
      expect(umode(reader.get("dir/"))).toBe(0o040644);
    });

    it.concurrent("accepts the boundary permissions 0o000 and 0o777", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Unix });
      await writer.add({ path: "none", data: "x", meta: { unixPermissions: 0o000 } });
      await writer.add({ path: "all", data: "x", meta: { unixPermissions: 0o777 } });
      const reader = await openZip(await writer.close());
      expect(umode(reader.get("none"))).toBe(0o100000);
      expect(umode(reader.get("all"))).toBe(0o100777);
    });

    it.concurrent("rejects permissions above the 3-digit octal range", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await expect(writer.add({ path: "f", data: "x", meta: { unixPermissions: 0o1000 } })).rejects.toThrow(RangeError);
    });

    it.concurrent("rejects setuid/setgid/sticky bits (0o7000)", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await expect(writer.add({ path: "f", data: "x", meta: { unixPermissions: 0o4755 } })).rejects.toThrow(RangeError);
    });

    it.concurrent("rejects negative or non-integer permissions", async () => {
      const w1 = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await expect(w1.add({ path: "f", data: "x", meta: { unixPermissions: -1 } })).rejects.toThrow(RangeError);
      const w2 = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await expect(w2.add({ path: "f", data: "x", meta: { unixPermissions: 0o644 + 0.5 } })).rejects.toThrow(RangeError);
    });

    it.concurrent("lets an explicit externalAttributes value override permission synthesis", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Unix });
      await writer.add({ path: "f", data: "x", meta: { externalAttributes: 0 } });
      const bytes = await writer.close();
      const central = findSignature(bytes, 0x02014b50);
      expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(central + 4, true) >>> 8).toBe(0);
    });
  });

  describe("entry timestamp ordering", () => {
    const created = new Date("2024-06-01T00:00:00Z");
    const earlier = new Date("2024-05-01T00:00:00Z");
    const later = new Date("2024-07-01T00:00:00Z");

    it.concurrent("rejects modifiedAt earlier than createdAt", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await expect(writer.add({ path: "f", data: "x", meta: { createdAt: created, modifiedAt: earlier } })).rejects.toThrow(RangeError);
    });

    it.concurrent("rejects lastAccess earlier than createdAt", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await expect(writer.add({ path: "f", data: "x", meta: { createdAt: created, modifiedAt: later, lastAccess: earlier } })).rejects.toThrow(RangeError);
    });

    it.concurrent("accepts timestamps at or after createdAt", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
      await writer.add({ path: "f", data: "x", meta: { createdAt: created, modifiedAt: created, lastAccess: later } });
      const reader = await openZip(await writer.close());
      expect(reader.get("f")?.createdAt?.toISOString()).toBe(created.toISOString());
    });
  });
});

describe("ZipTransformStream", () => {
  it.concurrent("works as a WHATWG TransformStream", async () => {
    const transform = new ZipTransformStream({ level: 0, zip64: "off" });
    const archivePromise = collect(transform.readable);
    const writer = transform.writable.getWriter();

    await writer.write({ path: "a.txt", data: "A" });
    await writer.write({ path: "b.txt", data: "B" });
    await writer.close();

    const reader = await openZip(new Blob([await archivePromise]));
    expect(reader.entries.map((entry) => entry.path)).toEqual(["a.txt", "b.txt"]);
    expect(await reader.get("a.txt")?.text()).toBe("A");
    expect(await reader.get("b.txt")?.text()).toBe("B");
  });

  it.concurrent("validates compression level", () => {
    expect(() => new ZipTransformStream({ level: -1 })).toThrow(RangeError);
    expect(() => new ZipTransformStream({ level: 10 })).toThrow(RangeError);
  });

  it.concurrent("rejects duplicate paths", async () => {
    const transform = new ZipTransformStream({ level: 0, zip64: "off" });
    const drain = collect(transform.readable).catch(() => byteArray([]));
    const writer = transform.writable.getWriter();

    await writer.write({ path: "dup.txt", data: "first" });
    await expect(writer.write({ path: "dup.txt", data: "second" })).rejects.toThrow(/duplicate zip entry path/i);
    await drain;
  });
});

describe("openZip", () => {
  it.concurrent("preserves duplicate paths from foreign archives in entries and returns latest from get", async () => {
    const archive = buildDuplicateStoredArchive([
      { path: "dup.txt", data: "first" },
      { path: "dup.txt", data: "second" }
    ]);

    const reader = await openZip(archive);
    expect(reader.entries.map((entry) => entry.path)).toEqual(["dup.txt", "dup.txt"]);
    expect(await reader.entries[0].text()).toBe("first");
    expect(await reader.get("dup.txt")?.text()).toBe("second");
  });

  it.concurrent("accepts ArrayBuffer input and exposes byte helpers", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "arraybuffer" });

    await writer.add({ path: "raw.bin", data: byteArray([1, 2, 3]) });
    const archive = await writer.close();

    const reader = await openZip(archive);
    const entry = reader.get("raw.bin")!;
    expectBytesEqual(await entry.bytes(), byteArray([1, 2, 3]));
    expectBytesEqual(byteArray(await entry.arrayBuffer()), byteArray([1, 2, 3]));
  });

  it.concurrent("finds the real EOCD when archive comments contain EOCD-like bytes", async () => {
    const writer = new ZipWriter({
      level: 0,
      zip64: "off",
      outputAs: "uint8array",
      comment: "prefix PK\u0005\u0006 suffix"
    });

    await writer.add({ path: "comment.txt", data: "comment payload", meta: { comment: "entry comment" } });
    const reader = await openZip(await writer.close());

    expect(reader.comment).toBe("prefix PK\u0005\u0006 suffix");
    expect(reader.get("comment.txt")?.comment).toBe("entry comment");
    expect(await reader.get("comment.txt")?.text()).toBe("comment payload");
  });

  it.concurrent("rejects unsafe paths by default and can sanitize them explicitly", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
    await writer.add({ path: "xx/evil.txt", data: "blocked" });
    const archive = await writer.close();
    const patched = byteArray(archive);
    const from = encode("xx/evil.txt");
    const to = encode("../evil.txt");

    for (let i = 0; i <= patched.length - from.length; i++) {
      if (from.every((byte, index) => patched[i + index] === byte)) patched.set(to, i);
    }

    await expect(openZip(patched)).rejects.toThrow(DOMException);
    const reader = await openZip(patched, { pathMode: "sanitize" });
    expect(reader.entries[0].path).toBe("evil.txt");
    expect(await reader.get("evil.txt")?.text()).toBe("blocked");

    const unsafe = await openZip(patched, { pathMode: "unsafe" });
    expect(unsafe.entries[0].path).toBe("../evil.txt");
    expect(await unsafe.get("../evil.txt")?.text()).toBe("blocked");
  });

  it.concurrent("sanitizes absolute, drive-letter, backslash, and dot path components when requested", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
    await writer.add({ path: "aa/root.txt", data: "absolute" });
    await writer.add({ path: "cc/app.txt", data: "drive" });
    await writer.add({ path: "bb/dir.txt", data: "backslash" });
    await writer.add({ path: "dd/./x.txt", data: "dot" });
    let archive = await writer.close();

    archive = patchAllAscii(archive, "aa/root.txt", "/a/root.txt");
    archive = patchAllAscii(archive, "cc/app.txt", "C:/app.txt");
    archive = patchAllAscii(archive, "bb/dir.txt", "bb\\dir.txt");

    await expect(openZip(archive)).rejects.toThrow(DOMException);

    const reader = await openZip(archive, { pathMode: "sanitize" });
    expect(reader.entries.map((entry) => entry.path)).toEqual(["a/root.txt", "app.txt", "bb/dir.txt", "dd/x.txt"]);
    expect(await reader.get("a/root.txt")?.text()).toBe("absolute");
    expect(await reader.get("app.txt")?.text()).toBe("drive");
    expect(await reader.get("bb/dir.txt")?.text()).toBe("backslash");
    expect(await reader.get("dd/x.txt")?.text()).toBe("dot");
  });

  it.concurrent("decodes legacy filenames with CP437 and TextDecoder fallbacks", async () => {
    const cases = [
      { encoding: "cp437", placeholder: "cafe.txt", bytes: [0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74], expected: "caf\u00e9.txt" },
      { encoding: "cp866", placeholder: "a.txt", bytes: [0xef, 0x2e, 0x74, 0x78, 0x74], expected: "\u044f.txt" },
      { encoding: "shift_jis", placeholder: "aa.txt", bytes: [0x82, 0xa0, 0x2e, 0x74, 0x78, 0x74], expected: "\u3042.txt" },
      { encoding: "windows-1252", placeholder: "cafe.txt", bytes: [0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74], expected: "caf\u00e9.txt" },
      { encoding: "gbk", placeholder: "aa.txt", bytes: [0xd6, 0xd0, 0x2e, 0x74, 0x78, 0x74], expected: "\u4e2d.txt" },
      { encoding: "big5", placeholder: "aa.txt", bytes: [0xa4, 0xa4, 0x2e, 0x74, 0x78, 0x74], expected: "\u4e2d.txt" },
      { encoding: "euc-kr", placeholder: "aa.txt", bytes: [0xb0, 0xa1, 0x2e, 0x74, 0x78, 0x74], expected: "\uac00.txt" }
    ] satisfies readonly LegacyFilenameCase[];

    for (const item of cases) {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await writer.add({ path: item.placeholder, data: item.encoding });
      const archive = patchAllBytes(await writer.close(), encode(item.placeholder), byteArray(item.bytes));
      new DataView(archive.buffer, archive.byteOffset, archive.byteLength).setUint16(6, 0, true);
      new DataView(archive.buffer, archive.byteOffset, archive.byteLength).setUint16(centralDirectoryOffset(archive) + 8, 0, true);

      const reader = await openZip(archive, { filenameEncoding: item.encoding });
      expect(reader.entries[0].path).toBe(item.expected);
      expect(await reader.get(item.expected)?.text()).toBe(item.encoding);
    }
  });

  it.concurrent("returns independent streams for random-access entries", async () => {
    const writer = new ZipWriter({ level: 6, outputAs: "blob" });

    await writer.add({ path: "multi.txt", data: "multi-use stream" });
    const archive = await writer.close();

    const reader = await openZip(archive);
    const entry = reader.get("multi.txt");

    expect(decoder.decode(await collect(entry!.stream()))).toBe("multi-use stream");
    expect(decoder.decode(await collect(entry!.stream()))).toBe("multi-use stream");
    expect(await entry?.text()).toBe("multi-use stream");
  });

  it.concurrent("rejects entry access after close", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "blob" });

    await writer.add({ path: "closed.txt", data: "closed" });
    const archive = await writer.close();

    const reader = await openZip(archive);
    const entry = reader.get("closed.txt")!;
    await reader.close();

    expect(reader.get("closed.txt")).toBeUndefined();
    expect(() => entry.stream()).toThrow(DOMException);
    await expect(entry.text()).rejects.toThrow(DOMException);
  });

  it.concurrent("rejects encrypted and unsupported compression method central-directory entries", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
    await writer.add({ path: "plain.txt", data: "plain" });
    const archive = await writer.close();
    const centralOffset = centralDirectoryOffset(archive);

    const encrypted = byteArray(archive);
    new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength).setUint16(centralOffset + 8, 0x0001, true);
    await expect(openZip(encrypted)).rejects.toThrow(DOMException);

    const unsupported = byteArray(archive);
    new DataView(unsupported.buffer, unsupported.byteOffset, unsupported.byteLength).setUint16(centralOffset + 10, 99, true);
    await expect(openZip(unsupported)).rejects.toThrow(DOMException);
  });

  describe("central directory consistency", () => {
    it.concurrent("rejects an EOCD entry count that overstates the directory", async () => {
      const bytes = buildArchive([{ path: "a.txt", data: "hello" }]);
      const eocd = eocdOffset(bytes);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      view.setUint16(eocd + 10, view.getUint16(eocd + 10, true) + 1, true);
      await expect(openZip(bytes)).rejects.toThrow(/entry count mismatch/i);
    });

    it.concurrent("rejects an EOCD central-directory size that does not match the entries", async () => {
      const bytes = buildArchive([{ path: "a.txt", data: "hello" }]);
      const eocd = eocdOffset(bytes);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      view.setUint32(eocd + 12, view.getUint32(eocd + 12, true) + 4, true);
      await expect(openZip(bytes)).rejects.toThrow(/size mismatch/i);
    });

    it.concurrent("still reads a well-formed archive", async () => {
      const reader = await openZip(buildArchive([{ path: "a.txt", data: "hello" }]));
      expect(await reader.get("a.txt")?.text()).toBe("hello");
    });
  });

  describe("bounds hardening", () => {
    it.concurrent("rejects a central-directory offset pointing outside the archive", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await writer.add({ path: "ok.txt", data: "ok" });
      const archive = byteArray(await writer.close());
      const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
      const eocd = findSignature(archive, 0x06054b50);

      view.setUint32(eocd + 16, 0x7fffffff, true);
      await expect(openZip(archive)).rejects.toThrow(/outside ZIP bounds/);
    });

    it.concurrent("rejects a local payload range that runs past the archive", async () => {
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
      await writer.add({ path: "ok.txt", data: "hello" });
      const archive = byteArray(await writer.close());
      const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
      const central = findSignature(archive, 0x02014b50);

      view.setUint32(central + 20, 0x7fffffff, true);
      await expect(openZip(archive)).rejects.toThrow(/outside ZIP bounds/);
    });
  });

  describe("decompression safeguards", () => {
    it.concurrent("reports a corrupt deflate stream distinctly (not as unsupported runtime)", async () => {
      const bytes = buildArchive([{ path: "big.txt", data: "a".repeat(2000) }]);
      const local = findSignature(bytes, 0x04034b50);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const nameLen = view.getUint16(local + 26, true);
      const extraLen = view.getUint16(local + 28, true);
      const payloadStart = local + 30 + nameLen + extraLen;
      const central = findSignature(bytes, 0x02014b50);
      for (let i = payloadStart; i < central; i++) bytes[i] = 0xff;

      const reader = await openZip(bytes);
      const entry = reader.get("big.txt")!;
      const error = await entry.bytes().then(() => null, (e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toMatch(/corrupt deflate stream/i);
      expect(error!.message).not.toMatch(/does not support/i);
    });

    it.concurrent("rejects an entry whose decompressed size exceeds maxEntrySize", async () => {
      const bytes = buildArchive([{ path: "big.txt", data: "a".repeat(100_000) }]);
      const reader = await openZip(bytes, { maxEntrySize: 1000 });
      await expect(reader.get("big.txt")!.bytes()).rejects.toThrow(/maxEntrySize/i);
    });

    it.concurrent("reads normally when within maxEntrySize", async () => {
      const bytes = buildArchive([{ path: "big.txt", data: "a".repeat(100_000) }]);
      const reader = await openZip(bytes, { maxEntrySize: 1_000_000 });
      expect((await reader.get("big.txt")!.bytes()).length).toBe(100_000);
    });

    it.concurrent("rejects an archive larger than maxArchiveSize", async () => {
      const bytes = buildArchive([{ path: "a.txt", data: "hello" }]);
      await expect(openZip(bytes, { maxArchiveSize: 1 })).rejects.toThrow(/maxArchiveSize/i);
    });
  });

  describe("byte access", () => {
    it.concurrent("round-trips arraybuffer output exactly", async () => {
      const writer = new ZipWriter({ level: 6, outputAs: "arraybuffer" });
      await writer.add({ path: "data.txt", data: "round trip me".repeat(50) });
      const archive = await writer.close();

      expect(archive).toBeInstanceOf(ArrayBuffer);
      const entry = (await openZip(archive)).get("data.txt")!;
      expect(decoder.decode(await entry.bytes())).toBe("round trip me".repeat(50));
    });
  });
});

describe("readZipStream", () => {
  it.concurrent("iterates entries and exposes single-use text tokens", async () => {
    const writer = new ZipWriter({ level: 6 });

    await writer.add({ path: "one.txt", data: "one" });
    await writer.add({ path: "two.txt", data: "two" });
    const stream = await writer.close();

    const seen: string[] = [];
    for await (const entry of readZipStream(stream)) {
      seen.push(`${entry.path}:${await entry.text()}`);
      await expect(entry.text()).rejects.toThrow(DOMException);
    }

    expect(seen).toEqual(["one.txt:one", "two.txt:two"]);
  });

  it.concurrent("supports explicit skip tokens", async () => {
    const writer = new ZipWriter({ level: 6 });

    await writer.add({ path: "skip.txt", data: "skip me" });
    const stream = await writer.close();

    for await (const entry of readZipStream(stream)) {
      await entry.skip();
      expect(() => entry.stream()).toThrow(DOMException);
    }
  });

  it.concurrent("exposes single-use byte helpers for stream entries", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off" });

    await writer.add({ path: "bytes.bin", data: byteArray([4, 5, 6]) });
    const stream = await writer.close();

    for await (const entry of readZipStream(stream)) {
      expectBytesEqual(await entry.bytes(), byteArray([4, 5, 6]));
      await expect(entry.arrayBuffer()).rejects.toThrow(DOMException);
    }
  });

  it.concurrent("exposes parsed external attributes and derived unix modes on stream entries", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off" });

    await writer.add({ path: "bin/run.sh", data: "#!/bin/sh\n", meta: { unixPermissions: 0o755 } });
    const stream = await writer.close();

    for await (const entry of readZipStream(stream)) {
      expect(entry.externalAttributes).toBe((0o100755 << 16) >>> 0);
      expect(umode(entry)).toBe(0o100755);
      await entry.skip();
    }
  });

  it.concurrent("exposes parsed comments, extra fields, dates, and directories on stream entries", async () => {
    const modifiedAt = absoluteDate("2022-02-03T04:05:06Z");
    const extraField = byteArray([0x10, 0x20, 0x02, 0x00, 0xaa, 0xbb]);
    const writer = new ZipWriter({ level: 0, zip64: "off" });

    await writer.add({ path: "docs/note.txt", data: "note", meta: { comment: "note comment", extraField, modifiedAt } });
    await writer.add({ path: "docs/empty/", data: "", meta: { comment: "dir comment" } });
    const stream = await writer.close();

    const entries: ZipStreamEntry[] = [];
    for await (const entry of readZipStream(stream)) entries.push(entry);

    expect(entries.map((entry) => entry.path)).toEqual(["docs/note.txt", "docs/empty/"]);
    expect(entries[0].comment).toBe("note comment");
    expectBytesEqual(entries[0].extraField?.slice(0, extraField.length), extraField);
    expect(entries[0].modifiedAt?.toISOString()).toBe("2022-02-03T04:05:06.000Z");
    expect(await entries[0].text()).toBe("note");
    expect(entries[1].isDirectory).toBe(true);
    expect(entries[1].comment).toBe("dir comment");
    await entries[1].skip();
  });
});

// These tests complement the broader public API suite above. They use public
// APIs plus the same byte-patching style as the existing tests to drive internal
// branches that are otherwise difficult to reach.

describe("DEFLATE block selection", () => {
  it.concurrent("emits a fixed-Huffman block when fixed codes are cheaper than a dynamic header", async () => {
    const archive = await buildDeflatedArchive([{ path: "fixed.txt", data: "abababababababab", method: "deflate", level: 6 }]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);

    expect(view.getUint16(localHeaderOffset(archive) + 8, true)).toBe(8);
    expect(firstBlockType(firstRawPayload(archive))).toBe(1);
    expect(await (await openZip(archive)).get("fixed.txt")!.text()).toBe("abababababababab");
  });

  it.concurrent("splits a large entry into multiple DEFLATE blocks and toggles the final-block flag", async () => {
    let text = "";
    for (let index = 0; index < 40000; index++) {
      text += `line-${index}-${(Math.imul(index, 2654435761) >>> 0).toString(16)}\n`;
    }

    const archive = await buildDeflatedArchive([{ path: "big.txt", data: text, level: 6 }]);
    const entry = (await openZip(archive)).get("big.txt")!;

    expect(new DataView(archive.buffer, archive.byteOffset, archive.byteLength).getUint16(localHeaderOffset(archive) + 8, true)).toBe(8);
    expect(entry.compressedSize).toBeLessThan(text.length);
    expect(await entry.text()).toBe(text);
  });

  it.concurrent("emits multiple stored sub-blocks for incompressible input larger than 65535 bytes", async () => {
    const length = 200_000;
    const data = new Uint8Array(length) as TestBytes;
    let state = 0x12345678 >>> 0;

    for (let index = 0; index < length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      data[index] = state & 0xff;
    }

    const archive = await buildDeflatedArchive([{ path: "rnd.bin", data, method: "deflate", level: 9 }]);
    const blocks = Math.ceil(length / 0xffff);
    const entry = (await openZip(archive)).get("rnd.bin")!;

    expect(entry.compressedSize).toBe(length + blocks * 5);
    expectBytesEqual(await entry.bytes(), data);
  });
});

describe("writer validation and output completeness", () => {
  it.concurrent("rejects an oversized extra field and an oversized archive comment", async () => {
    const extraWriter = new ZipWriter({ outputAs: "uint8array" });
    await expect(extraWriter.add({ path: "f.txt", data: "x", meta: { extraField: new Uint8Array(70000) as TestBytes } }))
      .rejects.toThrow(/extra field must fit in 65535/i);

    const commentWriter = new ZipWriter({ outputAs: "uint8array", comment: "c".repeat(70000) });
    await commentWriter.add({ path: "f.txt", data: "x" });
    await expect(commentWriter.close()).rejects.toThrow(/archive comment must fit in 65535/i);
  });

  it.concurrent("rejects an invalid per-entry level for both add() and writeSync()", async () => {
    const asyncWriter = new ZipWriter({ outputAs: "uint8array" });
    await expect(asyncWriter.add({ path: "f.txt", data: "x", level: 99 })).rejects.toThrow(RangeError);

    const syncWriter = new ZipWriter({ outputAs: "uint8array" });
    expect(() => syncWriter.writeSync({ path: "f.txt", data: "x", level: 99 })).toThrow(RangeError);
  });

  it.concurrent("rejects unsupported data types", async () => {
    const asyncWriter = new ZipWriter({ outputAs: "uint8array" });
    await expect(asyncWriter.add({ path: "f.txt", data: 12345 as unknown as string })).rejects.toThrow(TypeError);

    const syncWriter = new ZipWriter({ outputAs: "uint8array" });
    expect(() => syncWriter.writeSync({ path: "f.txt", data: new Blob(["hi"]) as unknown as string })).toThrow(TypeError);
  });

  it.concurrent("supports closeSync with arraybuffer output and with the default stream output", async () => {
    const bufferWriter = new ZipWriter({ outputAs: "arraybuffer", level: 0, zip64: "off" });
    bufferWriter.writeSync({ path: "a.txt", data: "hi" });
    const buffer = bufferWriter.closeSync();
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(await (await openZip(buffer)).get("a.txt")!.text()).toBe("hi");

    const streamWriter = new ZipWriter({ level: 0, zip64: "off" });
    streamWriter.writeSync({ path: "a.txt", data: "hi" });
    const stream = streamWriter.closeSync();
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it.concurrent("strict writer accepts a safe path and sanitize rejects a path that sanitizes to empty", async () => {
    const strict = new ZipWriter({ outputAs: "uint8array", pathMode: "strict" });
    await strict.add({ path: "safe/file.txt", data: "ok" });
    expect(await (await openZip(byteArray(await strict.close()))).get("safe/file.txt")!.text()).toBe("ok");

    const sanitize = new ZipWriter({ outputAs: "uint8array", pathMode: "sanitize" });
    await expect(sanitize.add({ path: "../../", data: "" })).rejects.toThrow(/unsafe zip entry path/i);
  });

  it.concurrent("rejects duplicate paths while writing", async () => {
    const asyncWriter = new ZipWriter({ outputAs: "uint8array" });
    await asyncWriter.add({ path: "dup.txt", data: "first" });
    await expect(asyncWriter.add({ path: "dup.txt", data: "second" })).rejects.toThrow(/duplicate zip entry path/i);

    const syncWriter = new ZipWriter({ outputAs: "uint8array" });
    syncWriter.writeSync({ path: "dup.txt", data: "first" });
    expect(() => syncWriter.writeSync({ path: "dup.txt", data: "second" })).toThrow(/duplicate zip entry path/i);
  });
});

describe("reader structural validation gaps", () => {
  it.concurrent("rejects input with no end-of-central-directory record", async () => {
    await expect(openZip(encode("this is definitely not a zip archive"))).rejects.toThrow(/end of central directory not found/i);
  });

  it.concurrent("rejects a corrupt central-directory header signature", async () => {
    const bytes = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(centralDirectoryOffset(bytes), 0xdeadbeef, true);
    await expect(openZip(bytes)).rejects.toThrow(/invalid central directory header/i);
  });

  it.concurrent("rejects a corrupt local file header signature", async () => {
    const bytes = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(localHeaderOffset(bytes), 0xdeadbeef, true);
    await expect(openZip(bytes)).rejects.toThrow(/invalid local file header/i);
  });
});

describe("eager local-payload resolution", () => {
  it.concurrent("rejects the whole archive at open if any entry's local header is corrupt, regardless of position", async () => {
    for (const target of ["first", "last"] as const) {
      const bytes = buildStoredArchive([{ path: "a.txt", data: "A" }, { path: "b.txt", data: "B" }, { path: "c.txt", data: "C" }]);
      const offsets = centralLocalHeaderOffsets(bytes);
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(target === "first" ? offsets[0] : offsets[offsets.length - 1], 0xdeadbeef, true);

      await expect(openZip(bytes)).rejects.toThrow(/invalid local file header/i);
    }
  });

  it.concurrent("readZipStream throws as iteration begins, before yielding any entry", async () => {
    const bytes = buildStoredArchive([{ path: "a.txt", data: "A" }, { path: "b.txt", data: "B" }]);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(centralLocalHeaderOffsets(bytes)[0], 0xdeadbeef, true);
    const stream = new ReadableStream<TestBytes>({
      start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      }
    });

    let yielded = 0;
    await expect((async () => {
      for await (const entry of readZipStream(stream)) {
        yielded++;
        await entry.skip();
      }
    })()).rejects.toThrow(/invalid local file header/i);
    expect(yielded).toBe(0);
  });

  it.concurrent("a fully consistent central directory does not mask a corrupt local header", async () => {
    const bytes = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(centralLocalHeaderOffsets(bytes)[0], 0xdeadbeef, true);
    const error = await openZip(bytes).then(() => null, (e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/invalid local file header/i);
    expect(error!.message).not.toMatch(/central directory/i);
  });

  it.concurrent("validates the local header of a zero-payload directory entry too", async () => {
    const bytes = buildStoredArchive([{ path: "dir/", data: "" }]);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(centralLocalHeaderOffsets(bytes)[0], 0xdeadbeef, true);
    await expect(openZip(bytes)).rejects.toThrow(/invalid local file header/i);
  });

  it.concurrent("resolves the payload from the local header's field lengths", async () => {
    const writer = new ZipWriter({ outputAs: "uint8array", level: 0, zip64: "force" });
    await writer.add({ path: "z.txt", data: "payload-data" });
    const bytes = byteArray(await writer.close());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const local = localHeaderOffset(bytes);
    const central = centralDirectoryOffset(bytes);

    expect(view.getUint16(local + 28, true)).not.toBe(view.getUint16(central + 30, true));
    expect(await (await openZip(bytes)).get("z.txt")!.text()).toBe("payload-data");
  });

  it.concurrent("draws the eager/lazy line: signature and bounds at open, CRC at read", async () => {
    const badSig = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    new DataView(badSig.buffer, badSig.byteOffset, badSig.byteLength).setUint32(centralLocalHeaderOffsets(badSig)[0], 0xdeadbeef, true);
    await expect(openZip(badSig)).rejects.toThrow(/invalid local file header/i);

    const badRange = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    new DataView(badRange.buffer, badRange.byteOffset, badRange.byteLength).setUint32(centralDirectoryOffset(badRange) + 20, 0x7fffffff, true);
    await expect(openZip(badRange)).rejects.toThrow(/outside zip bounds/i);

    const badCrc = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    const view = new DataView(badCrc.buffer, badCrc.byteOffset, badCrc.byteLength);
    const central = centralDirectoryOffset(badCrc);
    view.setUint32(central + 16, view.getUint32(central + 16, true) ^ 0xffffffff, true);

    const reader = await openZip(badCrc);
    expect(reader.entries).toHaveLength(1);
    await expect(reader.get("a.txt")!.bytes()).rejects.toThrow(/crc32 mismatch/i);
  });
});

describe("reader integrity checks", () => {
  it.concurrent("rejects a CRC32 mismatch", async () => {
    const bytes = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const central = centralDirectoryOffset(bytes);
    view.setUint32(central + 16, view.getUint32(central + 16, true) ^ 0xffffffff, true);

    const reader = await openZip(bytes);
    await expect(reader.get("a.txt")!.bytes()).rejects.toThrow(/crc32 mismatch/i);
  });

  it.concurrent("rejects a stored entry whose declared size disagrees with its bytes", async () => {
    const bytes = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(centralDirectoryOffset(bytes) + 24, 3, true);

    const reader = await openZip(bytes);
    await expect(reader.get("a.txt")!.bytes()).rejects.toThrow(/size mismatch/i);
  });

  it.concurrent("rejects a deflate entry whose inflated length disagrees with the header", async () => {
    const archive = await buildDeflatedArchive([{ path: "d.txt", data: "compress me ".repeat(50), level: 6 }]);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const central = centralDirectoryOffset(archive);
    view.setUint32(central + 24, view.getUint32(central + 24, true) + 1, true);

    const reader = await openZip(archive);
    await expect(reader.get("d.txt")!.bytes()).rejects.toThrow(/inflated size mismatch/i);
  });
});

describe("ZIP64 parse errors", () => {
  it.concurrent("rejects a saturated 32-bit size with no ZIP64 extra to supply it", async () => {
    const bytes = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(centralDirectoryOffset(bytes) + 24, 0xffffffff, true);
    await expect(openZip(bytes)).rejects.toThrow(/zip64 uncompressed size is missing/i);
  });

  it.concurrent("rejects a ZIP64-signalling EOCD with no locator", async () => {
    const bytes = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(realEndOfCentralDirectoryOffset(bytes) + 10, 0xffff, true);
    await expect(openZip(bytes)).rejects.toThrow(/zip64 locator is missing/i);
  });

  it.concurrent("rejects a corrupt ZIP64 EOCD record behind a valid locator", async () => {
    const writer = new ZipWriter({ outputAs: "uint8array", level: 0, zip64: "force" });
    await writer.add({ path: "z.txt", data: "payload" });
    const archive = byteArray(await writer.close());

    new DataView(archive.buffer, archive.byteOffset, archive.byteLength).setUint32(findSignature(archive, 0x06064b50), 0xdeadbeef, true);
    await expect(openZip(archive)).rejects.toThrow(/zip64 eocd record is invalid/i);
  });

  it.concurrent("treats a ZIP64 extra whose declared length overruns the field as absent", async () => {
    const writer = new ZipWriter({ outputAs: "uint8array", level: 0, zip64: "force" });
    await writer.add({ path: "z.txt", data: "payload" });
    const archive = byteArray(await writer.close());
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const central = centralDirectoryOffset(archive);
    const extraStart = central + 46 + view.getUint16(central + 28, true);

    expect(view.getUint16(extraStart, true)).toBe(0x0001);
    view.setUint16(extraStart + 2, 0xffff, true);
    await expect(openZip(archive)).rejects.toThrow(/zip64 uncompressed size is missing/i);
  });
});

describe("size caps", () => {
  it.concurrent("enforces maxEntrySize during inflation even when the header understates the size", async () => {
    const archive = await buildDeflatedArchive([{ path: "z.txt", data: "a".repeat(50_000), level: 6 }]);
    new DataView(archive.buffer, archive.byteOffset, archive.byteLength).setUint32(centralDirectoryOffset(archive) + 24, 100, true);

    const reader = await openZip(archive, { maxEntrySize: 1000 });
    await expect(reader.get("z.txt")!.bytes()).rejects.toThrow(/exceeds limit|exceeds maxEntrySize/i);
  });

  it.concurrent("rejects an oversized archive in readZipStream", async () => {
    const bytes = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    const stream = new ReadableStream<TestBytes>({
      start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      }
    });

    await expect((async () => {
      for await (const entry of readZipStream(stream, { maxArchiveSize: 1 })) await entry.skip();
    })()).rejects.toThrow(/maxarchivesize/i);
  });
});

describe("reader misc branches", () => {
  it.concurrent("throws immediately for an already-aborted signal", async () => {
    const bytes = buildStoredArchive([{ path: "a.txt", data: "hello" }]);
    const controller = new AbortController();
    controller.abort();

    await expect(openZip(bytes, { signal: controller.signal })).rejects.toThrow();
  });

  it.concurrent("get() falls back to the normalized path", async () => {
    const reader = await openZip(buildStoredArchive([{ path: "dir/sub/f.txt", data: "v" }]));
    expect(await reader.get("dir\\sub\\f.txt")!.text()).toBe("v");
  });

  it.concurrent("accepts a custom TextDecoder-shaped object as filenameEncoding", async () => {
    const bytes = buildStoredArchive([{ path: "x.txt", data: "v" }]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(6, 0, true);
    view.setUint16(centralDirectoryOffset(bytes) + 8, 0, true);

    const customDecoder = {
      encoding: "x-custom",
      fatal: false,
      ignoreBOM: false,
      decode: (): string => "RENAMED"
    } satisfies TextDecoder;

    const reader = await openZip(bytes, { filenameEncoding: customDecoder });
    expect(reader.entries[0].path).toBe("RENAMED");
  });
});

describe("timestamps modes (DOS / UNIX / NTFS)", () => {
  const modifiedAt = absoluteDate("2026-06-02T01:14:35.000Z");
  const createdAt = absoluteDate("2020-01-15T08:00:00.000Z");
  const lastAccess = absoluteDate("2026-06-03T12:30:00.000Z");

  it.concurrent("default mode (dos+unix) writes the 0x5455 extra but no NTFS extra", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
    await writer.add({ path: "u.txt", data: "x", meta: { modifiedAt } });
    const archive = await writer.close();
    const extras = rawZipExtrasByPath(archive).get("u.txt");

    expect(extras).toBeDefined();
    expectExtendedTimestampExtra(extras!.localExtra, modifiedAt, "default local 0x5455");
    expectExtendedTimestampExtra(extras!.centralExtra, modifiedAt, "default central 0x5455");
    expect(extraFieldPayload(extras!.localExtra, 0x000a), "default local NTFS").toBeUndefined();
    expect(extraFieldPayload(extras!.centralExtra, 0x000a), "default central NTFS").toBeUndefined();

    const entry = (await openZip(archive)).get("u.txt")!;
    expect(entry.modifiedAt?.toISOString()).toBe(modifiedAt.toISOString());
    expect(entry.createdAt).toBeUndefined();
    expect(entry.lastAccess).toBeUndefined();
  });

  it.concurrent("dos mode writes neither the 0x5455 nor the NTFS extra", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos });
    await writer.add({ path: "d.txt", data: "x", meta: { modifiedAt } });
    const archive = await writer.close();
    const extras = rawZipExtrasByPath(archive).get("d.txt");

    expect(extras).toBeDefined();
    expectNoExtendedTimestampExtra(extras!.localExtra, "dos local 0x5455");
    expectNoExtendedTimestampExtra(extras!.centralExtra, "dos central 0x5455");
    expect(extraFieldPayload(extras!.localExtra, 0x000a), "dos local NTFS").toBeUndefined();
    expect(extraFieldPayload(extras!.centralExtra, 0x000a), "dos central NTFS").toBeUndefined();
  });

  it.concurrent("dos+ntfs writes the NTFS extra (and no 0x5455) and round-trips mtime/ctime/atime", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
    await writer.add({ path: "ntfs.txt", data: "x", meta: { modifiedAt, createdAt, lastAccess } });
    const archive = await writer.close();
    const extras = rawZipExtrasByPath(archive).get("ntfs.txt");

    expect(extras).toBeDefined();
    expectNoExtendedTimestampExtra(extras!.localExtra, "dos+ntfs local 0x5455");
    expectNoExtendedTimestampExtra(extras!.centralExtra, "dos+ntfs central 0x5455");
    for (const [where, extra] of [["local", extras!.localExtra], ["central", extras!.centralExtra]] as const) {
      const ts = ntfsTimestamps(extra);
      expect(ts, `${where} NTFS`).toBeDefined();
      expect(ts!.modifiedAt?.toISOString(), `${where} NTFS mtime`).toBe(modifiedAt.toISOString());
      expect(ts!.lastAccess?.toISOString(), `${where} NTFS atime`).toBe(lastAccess.toISOString());
      expect(ts!.createdAt?.toISOString(), `${where} NTFS ctime`).toBe(createdAt.toISOString());
    }

    // The mandatory DOS fields are still written.
    const raw = rawZipTimestamp(archive);
    const expectedDos = expectedZipTimestamp(modifiedAt);
    expect(raw.centralDate).toBe(expectedDos.date);
    expect(raw.centralTime).toBe(expectedDos.time);

    const entry = (await openZip(archive)).get("ntfs.txt")!;
    expect(entry.modifiedAt?.toISOString()).toBe(modifiedAt.toISOString());
    expect(entry.createdAt?.toISOString()).toBe(createdAt.toISOString());
    expect(entry.lastAccess?.toISOString()).toBe(lastAccess.toISOString());
  });

  it.concurrent("dos+unix+ntfs writes both the 0x5455 and NTFS extras", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Unix | TimestampMode.Ntfs });
    await writer.add({ path: "both.txt", data: "x", meta: { modifiedAt, createdAt, lastAccess } });
    const archive = await writer.close();
    const extras = rawZipExtrasByPath(archive).get("both.txt");

    expect(extras).toBeDefined();
    expectExtendedTimestampExtra(extras!.localExtra, modifiedAt, "both local 0x5455");
    expectExtendedTimestampExtra(extras!.centralExtra, modifiedAt, "both central 0x5455");
    expect(ntfsTimestamps(extras!.localExtra), "both local NTFS").toBeDefined();
    expect(ntfsTimestamps(extras!.centralExtra), "both central NTFS").toBeDefined();
  });

  describe("ntfs modes default createdAt and lastAccess to modifiedAt", () => {
    for (const { label, mode } of [
      { label: "dos+ntfs", mode: TimestampMode.Dos | TimestampMode.Ntfs },
      { label: "dos+unix+ntfs", mode: TimestampMode.Dos | TimestampMode.Unix | TimestampMode.Ntfs }
    ] as const) {
      it.concurrent(`${label} defaults both createdAt and lastAccess to modifiedAt when neither is given`, async () => {
        const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: mode });
        await writer.add({ path: "x.txt", data: "x", meta: { modifiedAt } });
        const entry = (await openZip(await writer.close())).get("x.txt")!;
        expect(entry.createdAt?.toISOString()).toBe(modifiedAt.toISOString());
        expect(entry.lastAccess?.toISOString()).toBe(modifiedAt.toISOString());
      });

      it.concurrent(`${label} defaults only lastAccess when createdAt is provided`, async () => {
        const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: mode });
        await writer.add({ path: "x.txt", data: "x", meta: { modifiedAt, createdAt } });
        const entry = (await openZip(await writer.close())).get("x.txt")!;
        expect(entry.createdAt?.toISOString()).toBe(createdAt.toISOString());
        expect(entry.lastAccess?.toISOString()).toBe(modifiedAt.toISOString());
      });

      it.concurrent(`${label} defaults only createdAt when lastAccess is provided`, async () => {
        const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: mode });
        await writer.add({ path: "x.txt", data: "x", meta: { modifiedAt, lastAccess } });
        const entry = (await openZip(await writer.close())).get("x.txt")!;
        expect(entry.createdAt?.toISOString()).toBe(modifiedAt.toISOString());
        expect(entry.lastAccess?.toISOString()).toBe(lastAccess.toISOString());
      });
    }
  });

  describe("reader timestamp precedence", () => {
    it.concurrent("prefers the UNIX 0x5455 mtime over the DOS fields when no NTFS extra is present", async () => {
      // An odd second is rounded down by the 2-second DOS field, so the exact
      // second can only come from the 0x5455 extra. Reading it back exactly
      // proves UNIX was chosen over DOS.
      const oddSecond = absoluteDate("2026-06-02T01:14:35.000Z");
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Unix });
      await writer.add({ path: "p.txt", data: "x", meta: { modifiedAt: oddSecond } });
      const entry = (await openZip(await writer.close())).get("p.txt")!;
      expect(entry.modifiedAt?.toISOString()).toBe(oddSecond.toISOString());
    });

    it.concurrent("prefers NTFS over UNIX and DOS when createdAt and lastAccess are both present", async () => {
      // Inject a conflicting 0x5455 (different instant) via meta.extraField, so
      // the archive carries a UNIX time that disagrees with the NTFS mtime. The
      // reader must report the NTFS values, not the UNIX one.
      const conflictingUnix = absoluteDate("1999-12-31T00:00:00.000Z");
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
      await writer.add({
        path: "conflict.txt",
        data: "x",
        meta: { modifiedAt, createdAt, lastAccess, extraField: makeUnixTimestampExtra(conflictingUnix) }
      });
      const archive = await writer.close();

      // Sanity: both the conflicting UNIX time and the NTFS times are in the bytes.
      const extras = rawZipExtrasByPath(archive).get("conflict.txt")!;
      expect(extendedTimestampSeconds(extras.centralExtra)).toBe(Math.floor(conflictingUnix.getTime() / 1000));
      expect(ntfsTimestamps(extras.centralExtra)?.modifiedAt?.toISOString()).toBe(modifiedAt.toISOString());

      const entry = (await openZip(archive)).get("conflict.txt")!;
      expect(entry.modifiedAt?.toISOString()).toBe(modifiedAt.toISOString());
      expect(entry.createdAt?.toISOString()).toBe(createdAt.toISOString());
      expect(entry.lastAccess?.toISOString()).toBe(lastAccess.toISOString());
      expect(entry.modifiedAt?.toISOString()).not.toBe(conflictingUnix.toISOString());
    });

    it.concurrent("ignores a partial NTFS extra (missing createdAt/lastAccess) and falls back to UNIX", async () => {
      // A 0x000a field that carries only mtime is not authoritative; the reader
      // should fall through to the 0x5455 mtime and leave created/access unset.
      const unixModified = absoluteDate("2026-06-02T01:14:35.000Z");
      const partialNtfsMtime = absoluteDate("1990-01-01T00:00:00.000Z");
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Unix });
      await writer.add({
        path: "partial.txt",
        data: "x",
        meta: { modifiedAt: unixModified, extraField: makeNtfsExtra(partialNtfsMtime) }
      });
      const archive = await writer.close();

      // Sanity: the NTFS field carries only mtime.
      const extras = rawZipExtrasByPath(archive).get("partial.txt")!;
      const ts = ntfsTimestamps(extras.centralExtra)!;
      expect(ts.modifiedAt?.toISOString()).toBe(partialNtfsMtime.toISOString());
      expect(ts.lastAccess).toBeUndefined();
      expect(ts.createdAt).toBeUndefined();

      const entry = (await openZip(archive)).get("partial.txt")!;
      expect(entry.modifiedAt?.toISOString()).toBe(unixModified.toISOString());
      expect(entry.createdAt).toBeUndefined();
      expect(entry.lastAccess).toBeUndefined();
    });

    it.concurrent("falls back to the DOS fields when neither NTFS nor UNIX is present", async () => {
      const evenSecond = absoluteDate("2026-06-02T01:14:34.000Z");
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos });
      await writer.add({ path: "donly.txt", data: "x", meta: { modifiedAt: evenSecond } });
      const archive = await writer.close();

      const entry = (await openZip(archive)).get("donly.txt")!;
      const raw = rawZipTimestamp(archive);
      const decodedDos = dateFromZipTimestamp(raw.centralDate, raw.centralTime);
      expect(entry.modifiedAt?.getTime()).toBe(decodedDos.getTime());
      expect(entry.createdAt).toBeUndefined();
      expect(entry.lastAccess).toBeUndefined();
    });
  });

  describe("caller-supplied timestamp extras are not duplicated", () => {
    it.concurrent("keeps a caller-supplied 0x5455 and does not append its own under a unix mode", async () => {
      // The caller's Extended Timestamp differs from modifiedAt, so if the writer
      // wrongly added its own there would be two 0x5455 fields and the first
      // (caller's) value would not be the only one present.
      const callerUnix = absoluteDate("1999-12-31T00:00:00.000Z");
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Unix });
      await writer.add({
        path: "dedupe-unix.txt",
        data: "x",
        meta: { modifiedAt, extraField: makeUnixTimestampExtra(callerUnix) }
      });
      const archive = await writer.close();
      const extras = rawZipExtrasByPath(archive).get("dedupe-unix.txt")!;

      expect(countExtraFields(extras.localExtra, 0x5455), "local 0x5455 count").toBe(1);
      expect(countExtraFields(extras.centralExtra, 0x5455), "central 0x5455 count").toBe(1);
      expect(extendedTimestampSeconds(extras.localExtra)).toBe(Math.floor(callerUnix.getTime() / 1000));
      expect(extendedTimestampSeconds(extras.centralExtra)).toBe(Math.floor(callerUnix.getTime() / 1000));
    });

    it.concurrent("keeps a caller-supplied 0x000a and does not append its own (nor require createdAt/lastAccess) under an ntfs mode", async () => {
      // Supplying the NTFS extra also suppresses the createdAt/lastAccess
      // requirement, since the writer skips building its own field entirely.
      const callerModified = absoluteDate("2001-02-03T04:05:06.000Z");
      const callerAccess = absoluteDate("2002-03-04T05:06:07.000Z");
      const callerCreated = absoluteDate("2000-01-01T00:00:00.000Z");
      const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
      await writer.add({
        path: "dedupe-ntfs.txt",
        data: "x",
        meta: { modifiedAt, extraField: makeNtfsExtra(callerModified, callerAccess, callerCreated) }
      });
      const archive = await writer.close();
      const extras = rawZipExtrasByPath(archive).get("dedupe-ntfs.txt")!;

      expect(countExtraFields(extras.localExtra, 0x000a), "local 0x000a count").toBe(1);
      expect(countExtraFields(extras.centralExtra, 0x000a), "central 0x000a count").toBe(1);
      const ts = ntfsTimestamps(extras.centralExtra)!;
      expect(ts.modifiedAt?.toISOString()).toBe(callerModified.toISOString());
      expect(ts.lastAccess?.toISOString()).toBe(callerAccess.toISOString());
      expect(ts.createdAt?.toISOString()).toBe(callerCreated.toISOString());

      // And the reader honours the caller's NTFS values.
      const entry = (await openZip(archive)).get("dedupe-ntfs.txt")!;
      expect(entry.modifiedAt?.toISOString()).toBe(callerModified.toISOString());
      expect(entry.createdAt?.toISOString()).toBe(callerCreated.toISOString());
      expect(entry.lastAccess?.toISOString()).toBe(callerAccess.toISOString());
    });
  });
});

describe("unixPermissions require the unix timestamp mode", () => {
  it.concurrent("rejects unixPermissions when the Unix flag is absent (DOS-only or NTFS-only)", async () => {
    const dosOnly = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos });
    await expect(dosOnly.add({ path: "f", data: "x", meta: { unixPermissions: 0o644 } })).rejects.toThrow(RangeError);
    const ntfsNoUnix = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
    await expect(ntfsNoUnix.add({ path: "f", data: "x", meta: { unixPermissions: 0o644 } })).rejects.toThrow(RangeError);
  });
});

describe("dos attributes", () => {
  it.concurrent("records dos attributes in the low byte under an NTFS mode", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
    await writer.add({ path: "f.txt", data: "x", meta: { dosAttributes: 0x21 } });
    const reader = await openZip(await writer.close());
    expect(reader.get("f.txt")!.externalAttributes! & 0xff).toBe(0x21);
  });

  it.concurrent("records dos attributes in plain DOS-only mode", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos });
    await writer.add({ path: "f.txt", data: "x", meta: { dosAttributes: 0x21 } });
    const ea = (await openZip(await writer.close())).get("f.txt")!.externalAttributes!;
    expect(ea & 0xff).toBe(0x21);
    expect(ea >>> 16).toBe(0); // no unix mode in DOS-only mode
  });

  it.concurrent("preserves a caller directory bit that matches a directory entry", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
    await writer.add({ path: "d/", data: "", meta: { dosAttributes: 0x10 | 0x20 } });
    const low = (await openZip(await writer.close())).get("d/")!.externalAttributes! & 0xff;
    expect(low & 0x10).toBe(0x10); // directory bit (required to match the entry)
    expect(low & 0x20).toBe(0x20); // caller-supplied archive bit preserved
  });

  it.concurrent("carries both the unix mode and dos attributes when unix+ntfs are set", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Unix | TimestampMode.Ntfs });
    await writer.add({ path: "f.txt", data: "x", meta: { unixPermissions: 0o640, dosAttributes: 0x01 } });
    const ea = (await openZip(await writer.close())).get("f.txt")!.externalAttributes!;
    expect(ea >>> 16).toBe(0o100640); // unix mode in the high 16 bits
    expect(ea & 0xff).toBe(0x01); // dos attributes in the low byte
  });

  it.concurrent("does not flip version-made-by to a unix host on its own", async () => {
    // NTFS-only (no unix mode) -> external-attrs high 16 == 0 -> DOS host (0).
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
    await writer.add({ path: "f.txt", data: "x", meta: { dosAttributes: 0x21 } });
    const bytes = await writer.close();
    const central = findSignature(bytes, 0x02014b50);
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(central + 4, true) >>> 8).toBe(0);
  });

  it.concurrent("rejects dos attributes when the Unix flag is set without the NTFS flag", async () => {
    const unixOnly = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Unix });
    await expect(unixOnly.add({ path: "f", data: "x", meta: { dosAttributes: 0x01 } })).rejects.toThrow(RangeError);
  });

  it.concurrent("rejects a directory bit that conflicts with the entry type", async () => {
    // File entry with the directory bit set -> conflict.
    const w1 = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
    await expect(w1.add({ path: "f", data: "x", meta: { dosAttributes: 0x10 } })).rejects.toThrow(RangeError);
    // Directory entry without the directory bit -> conflict.
    const w2 = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
    await expect(w2.add({ path: "d/", data: "", meta: { dosAttributes: 0x20 } })).rejects.toThrow(RangeError);
  });

  it.concurrent("rejects out-of-range values", async () => {
    const w1 = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
    await expect(w1.add({ path: "f", data: "x", meta: { dosAttributes: 0x100 } })).rejects.toThrow(RangeError);
    const w2 = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", timestamps: TimestampMode.Dos | TimestampMode.Ntfs });
    await expect(w2.add({ path: "f", data: "x", meta: { dosAttributes: -1 } })).rejects.toThrow(RangeError);
  });
});

describe("public option range validation", () => {
  it.concurrent("rejects a timestamps bitmask outside 0..7", () => {
    expect(() => new ZipWriter({ timestamps: 8 })).toThrow(RangeError);
    expect(() => new ZipWriter({ timestamps: -1 })).toThrow(RangeError);
    expect(() => new ZipWriter({ timestamps: 1.5 })).toThrow(RangeError);
  });

  it.concurrent("rejects negative or invalid entry timestamps", async () => {
    const w1 = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
    await expect(w1.add({ path: "f", data: "x", meta: { modifiedAt: new Date("1969-01-01T00:00:00Z") } })).rejects.toThrow(RangeError);
    const w2 = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
    await expect(w2.add({ path: "f", data: "x", meta: { modifiedAt: new Date("not a date") } })).rejects.toThrow(RangeError);
  });

  it.concurrent("rejects negative reader size caps", async () => {
    const bytes = buildArchive([{ path: "a.txt", data: "x" }]);
    await expect(openZip(bytes, { maxArchiveSize: -1 })).rejects.toThrow(RangeError);
    await expect(openZip(bytes, { maxEntrySize: -5 })).rejects.toThrow(RangeError);
  });
});

describe("explicitDirectoryEntries", () => {
  it.concurrent("is off by default: implied parent directories are not materialized", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array" });
    await writer.add({ path: "a/b/c.txt", data: "x" });
    const reader = await openZip(await writer.close());
    expect(reader.entries.map((e) => e.path)).toEqual(["a/b/c.txt"]);
  });

  it.concurrent("synthesizes implied parent directories, in order, when enabled", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", explicitDirectoryEntries: true });
    await writer.add({ path: "a/b/c.txt", data: "x" });
    const reader = await openZip(await writer.close());
    expect(reader.entries.map((e) => e.path)).toEqual(["a/", "a/b/", "a/b/c.txt"]);
    expect(reader.get("a/")!.isDirectory).toBe(true);
    expect(reader.get("a/b/")!.isDirectory).toBe(true);
  });

  it.concurrent("does not duplicate directories shared across files or added explicitly", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", explicitDirectoryEntries: true });
    await writer.add({ path: "a/", data: "" });
    await writer.add({ path: "a/b/c.txt", data: "x" });
    await writer.add({ path: "a/b/d.txt", data: "y" });
    const reader = await openZip(await writer.close());
    expect(reader.entries.map((e) => e.path)).toEqual(["a/", "a/b/", "a/b/c.txt", "a/b/d.txt"]);
  });

  it.concurrent("does not invent a truly empty folder; that must still be added manually", async () => {
    const writer = new ZipWriter({ level: 0, zip64: "off", outputAs: "uint8array", explicitDirectoryEntries: true });
    await writer.add({ path: "top.txt", data: "x" });
    const reader = await openZip(await writer.close());
    expect(reader.entries.map((e) => e.path)).toEqual(["top.txt"]);
  });
});
