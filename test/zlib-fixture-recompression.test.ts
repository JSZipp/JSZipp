import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import { ZipWriter, openZip } from "../src/index";

// --- Test-performance tuning (does not affect what is verified) -------------
// The rewrite step re-compresses every entry with JSZipp's pure-JS, synchronous
// deflate. Its CPU cost is dominated by `level` (chain-search depth: 8 at level
// 1 vs 256 at level 6, plus lazy matching only above level 3). This suite never
// asserts the *rewritten* compressedSize -- only data, crc32, size, and metadata
// round-trip -- so the compression ratio is invisible to every assertion. Level
// 1 still exercises the full deflate -> inflate path while cutting compressor
// time substantially. Lowering this is purely a speed change, not a coverage one.
const RECOMPRESSION_LEVEL = 1;

// Per-entry reads (entry.bytes()) inflate via DecompressionStream, which Node
// backs with the libuv threadpool, so they genuinely run off the main thread and
// can overlap across fixtures. The old limit of 1 serialized everything and
// defeated the it.concurrent declarations below. Bounded concurrency overlaps
// those inflates while keeping peak memory in check (each in-flight fixture holds
// several full copies of its decompressed entries). The synchronous deflate and
// the zlib reference parse still run on the main thread, so the ceiling tracks
// the default threadpool size (4); to scale past it, also raise UV_THREADPOOL_SIZE
// (via vitest config / CI env, since it must be set before the process starts).
const FIXTURE_CONCURRENCY = Math.max(2, Math.min(4, availableParallelism()));

// Per-operation timing is diagnostic instrumentation, not part of the test. Each
// fixture otherwise emits ~10 synchronous process.stdout.write calls, which add
// up and can block under a pipe. Keep the capability, but off by default; opt in
// with LOG_FIXTURE_TIMING=1 when investigating performance.
const LOG_TIMING = process.env.LOG_FIXTURE_TIMING === "1";

type TestBytes = Uint8Array<ArrayBuffer>;
type ByteArrayInput = number | Iterable<number> | ArrayLike<number> | ArrayBuffer;
type ZlibParsedZipEntry = {
  path: string;
  data: TestBytes;
  size: number;
  compressedSize: number;
  crc32: number;
  isDirectory: boolean;
  comment?: string;
  extraField?: TestBytes;
  modifiedAt: Date;
  externalAttributes: number;
  unixMode?: number;
};
type ZlibParsedZip = { comment?: string; entries: ZlibParsedZipEntry[] };

const decoder = new TextDecoder();
const UINT16_LIMIT = 0xffff;
const EXTENDED_TIMESTAMP_EXTRA_ID = 0x5455;
const fixtureZipDir = new URL("../test-compression/zips/", import.meta.url);

const byteArray = (bytes: ByteArrayInput): TestBytes => new Uint8Array(bytes as ArrayBuffer) as TestBytes;
const nodeCrc32 = (bytes: Uint8Array): number => crc32(bytes) >>> 0;

const expectBytesEqual = (actual: Uint8Array | undefined, expected: Uint8Array, label: string): void => {
  expect(actual, label).toBeDefined();
  expect(
    Buffer.from(actual!.buffer, actual!.byteOffset, actual!.byteLength)
      .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)),
    label
  ).toBe(true);
};

const expectOptionalBytesEqual = (actual: Uint8Array | undefined, expected: Uint8Array | undefined, label: string): void => {
  if (expected === undefined) {
    expect(actual, label).toBeUndefined();
    return;
  }

  expectBytesEqual(actual, expected, label);
};

const unixModeFromExternalAttributes = (externalAttributes: number): number | undefined => {
  const mode = externalAttributes >>> 16;
  return mode === 0 ? undefined : mode;
};

const dateFromZipTimestamp = (date: number, time: number): Date => {
  const day = date & 0x1f || 1;
  const month = (date >>> 5) & 0x0f || 1;
  const year = ((date >>> 9) & 0x7f) + 1980;
  return new Date(year, month - 1, day, (time >>> 11) & 0x1f, (time >>> 5) & 0x3f, (time & 0x1f) * 2);
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

const realEocdOffset = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(0, bytes.length - 22 - UINT16_LIMIT);

  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }

  return -1;
};

const stripZip64ExtraField = (extraField: TestBytes | undefined): TestBytes | undefined => {
  if (!extraField?.length) return undefined;

  const chunks: TestBytes[] = [];
  const view = new DataView(extraField.buffer, extraField.byteOffset, extraField.byteLength);
  let offset = 0;

  while (offset + 4 <= extraField.length) {
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    const next = offset + 4 + size;

    if (next > extraField.length) return extraField;
    if (id !== 0x0001) chunks.push(byteArray(extraField.subarray(offset, next)));
    offset = next;
  }

  if (offset !== extraField.length) return extraField;
  if (chunks.length === 0) return undefined;
  return concatBytes(chunks);
};

const hasExtraField = (extraField: TestBytes | undefined, fieldId: number): boolean => {
  if (!extraField?.length) return false;

  const view = new DataView(extraField.buffer, extraField.byteOffset, extraField.byteLength);
  let offset = 0;
  while (offset + 4 <= extraField.length) {
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    const next = offset + 4 + size;

    if (next > extraField.length) return false;
    if (id === fieldId) return true;
    offset = next;
  }

  return false;
};

const makeExtendedTimestampExtra = (date: Date): TestBytes | undefined => {
  const seconds = Math.floor(date.getTime() / 1000);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 0xffffffff) return undefined;

  const out = new Uint8Array(9) as TestBytes;
  const view = new DataView(out.buffer);
  view.setUint16(0, EXTENDED_TIMESTAMP_EXTRA_ID, true);
  view.setUint16(2, 5, true);
  out[4] = 1;
  view.setUint32(5, seconds, true);
  return out;
};

const parseExtendedTimestampExtra = (extraField: TestBytes | undefined): Date | undefined => {
  if (!extraField?.length) return undefined;

  const view = new DataView(extraField.buffer, extraField.byteOffset, extraField.byteLength);
  let offset = 0;
  while (offset + 4 <= extraField.length) {
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    const start = offset + 4;
    const next = start + size;

    if (next > extraField.length) return undefined;
    if (id === EXTENDED_TIMESTAMP_EXTRA_ID && size >= 5 && (extraField[start] & 1) !== 0) {
      return new Date(view.getUint32(start + 1, true) * 1000);
    }
    offset = next;
  }

  return undefined;
};

const expectedRewriteExtraField = (extraField: TestBytes | undefined, modifiedAt: Date): TestBytes | undefined => {
  const stripped = stripZip64ExtraField(extraField);
  if (hasExtraField(stripped, EXTENDED_TIMESTAMP_EXTRA_ID)) return stripped;

  const timestamp = makeExtendedTimestampExtra(modifiedAt);
  if (!timestamp) return stripped;
  return stripped ? concatBytes([stripped, timestamp]) : timestamp;
};

const listZipFixturePaths = (dir = fileURLToPath(fixtureZipDir)): string[] => {
  const paths: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      paths.push(...listZipFixturePaths(fullPath));
    } else {
      paths.push(fullPath);
    }
  }

  return paths.sort();
};

const createAsyncLimiter = (limit: number) => {
  let active = 0;
  const queue: Array<() => void> = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }

    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
};

const timeOperation = async <T>(zipPath: string, operation: string, task: () => T | Promise<T>): Promise<T> => {
  if (!LOG_TIMING) return task();

  const start = performance.now();

  try {
    return await task();
  } finally {
    const elapsedMs = performance.now() - start;
    process.stdout.write(`[fixture recompression] ${basename(zipPath)} ${operation}: ${elapsedMs.toFixed(1)}ms\n`);
  }
};

const parseZipWithZlib = (bytes: Uint8Array): ZlibParsedZip => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = realEocdOffset(bytes);
  if (eocd < 0) throw new Error("end of central directory not found");

  const entryCount = view.getUint16(eocd + 10, true);
  const commentLength = view.getUint16(eocd + 20, true);
  const comment = decoder.decode(bytes.subarray(eocd + 22, eocd + 22 + commentLength)) || undefined;
  const entries: ZlibParsedZipEntry[] = [];
  let offset = view.getUint32(eocd + 16, true);

  for (let index = 0; index < entryCount; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error(`central directory entry ${index} is invalid`);

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const pathLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const pathStart = offset + 46;
    const extraStart = pathStart + pathLength;
    const commentStart = extraStart + extraLength;
    const path = decoder.decode(bytes.subarray(pathStart, pathStart + pathLength));
    const extraField = extraLength === 0 ? undefined : byteArray(bytes.subarray(extraStart, extraStart + extraLength));
    const entryComment = decoder.decode(bytes.subarray(commentStart, commentStart + entryCommentLength)) || undefined;

    expect(flags & 0x0001).toBe(0);
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);

    const localPathLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const compressedStart = localOffset + 30 + localPathLength + localExtraLength;
    const compressed = bytes.subarray(compressedStart, compressedStart + compressedSize);
    let data: TestBytes;

    if (method === 0) {
      data = byteArray(compressed);
    } else if (method === 8) {
      try {
        data = byteArray(inflateRawSync(compressed));
      } catch (error) {
        throw new Error(`failed to inflate ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      throw new Error(`unsupported compression method ${method} for ${path}`);
    }

    expect(data.length).toBe(size);
    expect(nodeCrc32(data)).toBe(crc);

    entries.push({
      path,
      data,
      size,
      compressedSize,
      crc32: crc,
      isDirectory: path.endsWith("/"),
      comment: entryComment,
      extraField,
      modifiedAt: parseExtendedTimestampExtra(extraField) ?? dateFromZipTimestamp(view.getUint16(offset + 14, true), view.getUint16(offset + 12, true)),
      externalAttributes,
      unixMode: unixModeFromExternalAttributes(externalAttributes)
    });

    offset = commentStart + entryCommentLength;
  }

  return { comment, entries };
};

const verifyZlibValidatedFixtureZip = async (zipPath: string): Promise<void> => {
  const totalStart = LOG_TIMING ? performance.now() : 0;

  try {
    expect(extname(zipPath).toLowerCase()).toBe(".zip");

    const sourceBytes = await timeOperation(zipPath, "read fixture", () => byteArray(readFileSync(zipPath)));
    const expected = await timeOperation(zipPath, "parse fixture with zlib", () => parseZipWithZlib(sourceBytes));
    const reader = await timeOperation(zipPath, "open fixture with JSZipp", () => openZip(sourceBytes));

    expect(reader.comment).toBe(expected.comment);
    expect(reader.entries).toHaveLength(expected.entries.length);

    const rewritten = new ZipWriter({ level: RECOMPRESSION_LEVEL, outputAs: "uint8array", comment: reader.comment });

    const entries = await timeOperation(zipPath, "read JSZipp entries", () => Promise.all(expected.entries.map(async (expectedEntry) => {
      const entry = reader.get(expectedEntry.path);

      expect(entry, basename(zipPath)).toBeDefined();
      expect(entry?.path).toBe(expectedEntry.path);
      expect(entry?.size).toBe(expectedEntry.size);
      expect(entry?.compressedSize).toBe(expectedEntry.compressedSize);
      expect(entry?.crc32).toBe(expectedEntry.crc32);
      expect(entry?.isDirectory).toBe(expectedEntry.isDirectory);
      expect(entry?.comment).toBe(expectedEntry.comment);
      expectOptionalBytesEqual(entry?.extraField, expectedEntry.extraField, expectedEntry.path);
      expect(entry?.modifiedAt?.toISOString()).toBe(expectedEntry.modifiedAt.toISOString());
      expect(entry?.externalAttributes).toBe(expectedEntry.externalAttributes);
      expect(unixModeFromExternalAttributes(entry?.externalAttributes ?? 0)).toBe(expectedEntry.unixMode);

      const data = await entry!.bytes();
      expectBytesEqual(data, expectedEntry.data, expectedEntry.path);

      const rewriteExtraField = stripZip64ExtraField(entry!.extraField);

      return { data, entry: entry!, expectedEntry, rewriteExtraField };
    })));

    await timeOperation(zipPath, "rewrite entries", async () => {
      for (const { data, entry, expectedEntry, rewriteExtraField } of entries) {
        await rewritten.add({
          path: entry.path,
          data: expectedEntry.isDirectory ? "" : data,
          method: expectedEntry.compressedSize > expectedEntry.size * 0.9 ? "store" : undefined,
          meta: {
            comment: entry.comment,
            extraField: rewriteExtraField,
            modifiedAt: entry.modifiedAt,
            externalAttributes: entry.externalAttributes
          }
        });
      }
    });

    const rewrittenBytes = await timeOperation(zipPath, "close rewritten ZIP", () => rewritten.close());
    const verifiedRewrite = await timeOperation(zipPath, "parse rewritten ZIP with zlib", () => parseZipWithZlib(rewrittenBytes));
    const verifiedEntriesByPath = new Map(verifiedRewrite.entries.map((entry) => [entry.path, entry]));

    await timeOperation(zipPath, "verify rewritten entries", () => {
      expect(verifiedRewrite.comment).toBe(expected.comment);
      expect(verifiedRewrite.entries).toHaveLength(expected.entries.length);

      for (const expectedEntry of expected.entries) {
        const actual = verifiedEntriesByPath.get(expectedEntry.path);

        expect(actual, basename(zipPath)).toBeDefined();
        expectBytesEqual(actual?.data, expectedEntry.data, expectedEntry.path);

        expect(actual?.size).toBe(expectedEntry.size);
        expect(actual?.crc32).toBe(expectedEntry.crc32);
        expect(actual?.isDirectory).toBe(expectedEntry.isDirectory);
        expect(actual?.comment).toBe(expectedEntry.comment);
        expect(actual?.modifiedAt.toISOString()).toBe(expectedEntry.modifiedAt.toISOString());
        expect(actual?.externalAttributes).toBe(expectedEntry.externalAttributes);
        expect(unixModeFromExternalAttributes(actual?.externalAttributes ?? 0)).toBe(expectedEntry.unixMode);

        const expectedExtraField = expectedRewriteExtraField(expectedEntry.extraField, expectedEntry.modifiedAt);

        expectOptionalBytesEqual(actual?.extraField, expectedExtraField, expectedEntry.path);
      }
    });
  } finally {
    if (LOG_TIMING) {
      process.stdout.write(`[fixture recompression] ${basename(zipPath)} total: ${(performance.now() - totalStart).toFixed(1)}ms\n`);
    }
  }
};

describe.concurrent("zlib-validated fixture ZIP recompression", () => {
  if (!existsSync(fileURLToPath(fixtureZipDir))) {
    it.skip("discovers fixture ZIPs - no zips folder", () => { });
    return;
  }
  const zipPaths = listZipFixturePaths();
  if (zipPaths.length === 0) {
    it.skip("discovers fixture ZIPs - no zip under zips folder", () => { });
    return;
  }

  const limitFixtureZipVerification = createAsyncLimiter(FIXTURE_CONCURRENCY);
  const fixtureZipTestTimeoutMs = 15_000;

  for (const zipPath of zipPaths) {
    if (extname(zipPath).toLowerCase() !== ".zip") continue;
    it.concurrent(`matches and recompresses ${basename(zipPath)}`, async () => {
      await limitFixtureZipVerification(() => verifyZlibValidatedFixtureZip(zipPath));
    }, fixtureZipTestTimeoutMs);
  }
});
