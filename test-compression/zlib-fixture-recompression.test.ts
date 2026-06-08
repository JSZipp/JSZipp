import { describe, expect, it, vi } from "vitest";
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
// can overlap across fixtures. To keep per-test durations accurate, let Vitest's
// own concurrent scheduler enforce the cap instead of adding an external queue
// around `it.concurrent`, whose wait time would be charged to whichever fixture
// happened to be blocked behind the limiter. The synchronous deflate and the zlib
// reference parse still run on the main thread, so the ceiling tracks the default
// threadpool size (4); to scale past it, also raise UV_THREADPOOL_SIZE (via
// vitest config / CI env, since it must be set before the process starts).
const FIXTURE_CONCURRENCY = Math.max(2, Math.min(4, availableParallelism()));

// Per-operation timing is diagnostic instrumentation, not part of the test. Each
// fixture otherwise emits ~10 synchronous process.stdout.write calls, which add
// up and can block under a pipe. Keep the capability, but off by default; opt in
// with LOG_FIXTURE_TIMING=1 when investigating performance.
const LOG_TIMING = process.env.LOG_FIXTURE_TIMING === "1";

// Fast fixture sampling is on by default. Set FIXTURE_FAST_SAMPLING=0 to force
// exhaustive per-entry detail checks on large archives.
const FAST_FIXTURE_SAMPLING = process.env.FIXTURE_FAST_SAMPLING !== "0";

type TestBytes = Uint8Array<ArrayBuffer>;
type ZlibParsedZipEntry = {
  path: string;
  data?: TestBytes;
  size: number;
  compressedSize: number;
  crc32: number;
  isDirectory: boolean;
  comment?: string;
  extraField?: TestBytes;
  modifiedAt?: Date;
  externalAttributes?: number;
  unixMode?: number;
};
type ZlibDetailedParsedZipEntry = ZlibParsedZipEntry & {
  data: TestBytes;
  modifiedAt: Date;
  externalAttributes: number;
};
type ZlibParsedZip = {
  comment?: string;
  entries: ZlibParsedZipEntry[];
};
type RewriteExpectation = {
  expectedRewrittenExtraField?: TestBytes;
};
type ParseZipOptions = {
  // When true, detailed entries retain inflated/stored data for later byte-wise
  // comparison. When false, detailed entries are still inflated and validated by
  // size + CRC, but the inflated buffers are immediately released.
  retainData?: boolean;
};

const decoder = new TextDecoder();
const UINT16_LIMIT = 0xffff;
const ZIP64_EXTRA_ID = 0x0001;
const EXTENDED_TIMESTAMP_EXTRA_ID = 0x5455;
const fixtureZipDir = new URL("../test-compression/zips/", import.meta.url);
const EMPTY_BYTES = new Uint8Array(0) as TestBytes;
const DETAILED_CHECK_WINDOW = 36;
const DETAILED_CHECK_THRESHOLD = 108;

vi.setConfig({ maxConcurrency: FIXTURE_CONCURRENCY });

const byteArray = (bytes: Uint8Array<ArrayBuffer>): TestBytes => bytes as TestBytes;
const copyBytes = (bytes: Uint8Array): TestBytes => new Uint8Array(bytes) as TestBytes;
const nodeCrc32 = (bytes: Uint8Array<ArrayBuffer>): number => crc32(bytes) >>> 0;

const expectBytesEqual = (actual: Uint8Array<ArrayBuffer> | undefined, expected: Uint8Array<ArrayBuffer>, label: string): void => {
  expect(actual, label).toBeDefined();

  if (actual!.byteLength !== expected.byteLength) {
    expect(actual!.byteLength, `${label} byte length`).toBe(expected.byteLength);
    return;
  }

  if (expected.byteLength === 0) return;

  expect(
    Buffer.from(actual!.buffer, actual!.byteOffset, actual!.byteLength)
      .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)),
    label
  ).toBe(true);
};

const expectOptionalBytesEqual = (
  actual: Uint8Array<ArrayBuffer> | undefined,
  expected: Uint8Array<ArrayBuffer> | undefined,
  label: string
): void => {
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

const isDetailedParsedZipEntry = (entry: ZlibParsedZipEntry): entry is ZlibDetailedParsedZipEntry => {
  return entry.data !== undefined && entry.modifiedAt !== undefined && entry.externalAttributes !== undefined;
};

const dateFromZipTimestamp = (date: number, time: number): Date => {
  const day = date & 0x1f || 1;
  const month = (date >>> 5) & 0x0f || 1;
  const year = ((date >>> 9) & 0x7f) + 1980;
  return new Date(year, month - 1, day, (time >>> 11) & 0x1f, (time >>> 5) & 0x3f, (time & 0x1f) * 2);
};

const concatBytes = (chunks: Uint8Array<ArrayBuffer>[]): TestBytes => {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(length) as TestBytes;
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
};

const allIndexes = (count: number): Set<number> => {
  const indexes = new Set<number>();

  for (let index = 0; index < count; index++) indexes.add(index);

  return indexes;
};

const detailCheckIndexes = (count: number): Set<number> => {
  if (!FAST_FIXTURE_SAMPLING || count <= DETAILED_CHECK_THRESHOLD) {
    return allIndexes(count);
  }

  const indexes = new Set<number>();
  const middleStart = Math.max(0, Math.floor((count - DETAILED_CHECK_WINDOW) / 2));
  const tailStart = Math.max(0, count - DETAILED_CHECK_WINDOW);

  for (let index = 0; index < DETAILED_CHECK_WINDOW; index++) {
    indexes.add(index);
    indexes.add(middleStart + index);
    indexes.add(tailStart + index);
  }

  return indexes;
};

const realEocdOffset = (bytes: Uint8Array<ArrayBuffer>): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(0, bytes.length - 22 - UINT16_LIMIT);

  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;

    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }

  return -1;
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

const hasZip64ExtraField = (extraField: TestBytes | undefined): boolean => {
  return hasExtraField(extraField, ZIP64_EXTRA_ID);
};

const stripZip64ExtraField = (extraField: TestBytes | undefined): TestBytes | undefined => {
  if (!extraField?.length) return undefined;

  // Fast path: most extra fields do not contain Zip64. Preserve the existing
  // byte view and avoid allocating/copying.
  if (!hasZip64ExtraField(extraField)) return extraField;

  const view = new DataView(extraField.buffer, extraField.byteOffset, extraField.byteLength);
  let outputLength = 0;
  let offset = 0;

  while (offset + 4 <= extraField.length) {
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    const next = offset + 4 + size;

    if (next > extraField.length) return extraField;
    if (id !== ZIP64_EXTRA_ID) outputLength += next - offset;

    offset = next;
  }

  if (offset !== extraField.length) return extraField;
  if (outputLength === 0) return undefined;

  const out = new Uint8Array(outputLength) as TestBytes;
  let writeOffset = 0;
  offset = 0;

  while (offset + 4 <= extraField.length) {
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    const next = offset + 4 + size;

    if (id !== ZIP64_EXTRA_ID) {
      out.set(extraField.subarray(offset, next), writeOffset);
      writeOffset += next - offset;
    }

    offset = next;
  }

  return out;
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

const parseZipWithZlib = (
  bytes: Uint8Array<ArrayBuffer>,
  options: ParseZipOptions = {}
): ZlibParsedZip => {
  const retainData = options.retainData ?? true;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = realEocdOffset(bytes);

  if (eocd < 0) throw new Error("end of central directory not found");

  const entryCount = view.getUint16(eocd + 10, true);
  const detailIndexes = detailCheckIndexes(entryCount);
  const commentLength = view.getUint16(eocd + 20, true);
  const comment = decoder.decode(bytes.subarray(eocd + 22, eocd + 22 + commentLength)) || undefined;
  const entries = new Array<ZlibParsedZipEntry>(entryCount);
  let offset = view.getUint32(eocd + 16, true);

  for (let index = 0; index < entryCount; index++) {
    const shouldCheckDetail = detailIndexes.has(index);

    if (offset + 46 > bytes.length) {
      throw new Error(`central directory entry ${index} exceeds archive bounds`);
    }

    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`central directory entry ${index} is invalid`);
    }

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
    const nextCentralOffset = commentStart + entryCommentLength;

    if (nextCentralOffset > bytes.length) {
      throw new Error(`central directory entry ${index} exceeds archive bounds`);
    }

    const path = decoder.decode(bytes.subarray(pathStart, pathStart + pathLength));
    const isDirectory = pathLength !== 0 && bytes[pathStart + pathLength - 1] === 0x2f;
    const extraField = shouldCheckDetail && extraLength !== 0
      ? copyBytes(bytes.subarray(extraStart, extraStart + extraLength))
      : undefined;
    const entryComment = shouldCheckDetail
      ? decoder.decode(bytes.subarray(commentStart, commentStart + entryCommentLength)) || undefined
      : undefined;

    if ((flags & 0x0001) !== 0) throw new Error(`encrypted entry ${path}`);
    if (localOffset + 30 > bytes.length) throw new Error(`local header for ${path} exceeds archive bounds`);
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`local header for ${path} is invalid`);

    let data: TestBytes | undefined;

    if (shouldCheckDetail) {
      const localPathLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const compressedStart = localOffset + 30 + localPathLength + localExtraLength;
      const compressedEnd = compressedStart + compressedSize;

      if (compressedEnd > bytes.length) {
        throw new Error(`compressed data for ${path} exceeds archive bounds`);
      }

      const compressed = bytes.subarray(compressedStart, compressedEnd);
      let validatedData: TestBytes;

      if (method === 0) {
        validatedData = compressedSize === 0 ? EMPTY_BYTES : byteArray(compressed);
      } else if (method === 8) {
        try {
          validatedData = size === 0 ? EMPTY_BYTES : byteArray(inflateRawSync(compressed));
        } catch (error) {
          throw new Error(`failed to inflate ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        throw new Error(`unsupported compression method ${method} for ${path}`);
      }

      if (validatedData.length !== size) throw new Error(`size mismatch for ${path}`);
      if (nodeCrc32(validatedData) !== crc) throw new Error(`crc mismatch for ${path}`);

      // For rewritten archives, validation by inflate + size + CRC is enough.
      // Avoid retaining large buffers when no later byte-wise comparison needs them.
      data = retainData ? validatedData : undefined;
    }

    entries[index] = {
      path,
      data,
      size,
      compressedSize,
      crc32: crc,
      isDirectory,
      comment: entryComment,
      extraField,
      modifiedAt: shouldCheckDetail
        ? parseExtendedTimestampExtra(extraField) ?? dateFromZipTimestamp(view.getUint16(offset + 14, true), view.getUint16(offset + 12, true))
        : undefined,
      externalAttributes: shouldCheckDetail ? externalAttributes : undefined,
      unixMode: shouldCheckDetail ? unixModeFromExternalAttributes(externalAttributes) : undefined
    };

    offset = nextCentralOffset;
  }

  return { comment, entries };
};

const verifyZlibValidatedFixtureZip = async (zipPath: string): Promise<void> => {
  const totalStart = LOG_TIMING ? performance.now() : 0;

  try {
    expect(extname(zipPath).toLowerCase()).toBe(".zip");

    const sourceBytes = await timeOperation(zipPath, "read fixture", () => byteArray(readFileSync(zipPath)));
    const expected = await timeOperation(zipPath, "parse fixture with zlib", () => parseZipWithZlib(sourceBytes, { retainData: true }));
    const reader = await timeOperation(zipPath, "open fixture with JSZipp", () => openZip(sourceBytes));
    const detailIndexes = detailCheckIndexes(expected.entries.length);

    expect(reader.comment).toBe(expected.comment);
    expect(reader.entries).toHaveLength(expected.entries.length);

    const rewritten = new ZipWriter({
      level: RECOMPRESSION_LEVEL,
      outputAs: "uint8array",
      comment: reader.comment
    });
    const rewriteExpectations = new Array<RewriteExpectation>(expected.entries.length);

    await timeOperation(zipPath, "read and rewrite JSZipp entries", async () => {
      for (let index = 0; index < expected.entries.length; index++) {
        const expectedEntry = expected.entries[index];
        const entry = reader.get(expectedEntry.path);
        const shouldCheckDetail = detailIndexes.has(index);

        expect(entry, basename(zipPath)).toBeDefined();
        if (!entry) continue;

        if (shouldCheckDetail) {
          expect(isDetailedParsedZipEntry(expectedEntry), `${expectedEntry.path} should include detailed fixture metadata`).toBe(true);

          const detailedExpectedEntry = expectedEntry as ZlibDetailedParsedZipEntry;

          expect(entry.path).toBe(expectedEntry.path);
          expect(entry.size).toBe(expectedEntry.size);
          expect(entry.compressedSize).toBe(expectedEntry.compressedSize);
          expect(entry.crc32).toBe(expectedEntry.crc32);
          expect(entry.isDirectory).toBe(expectedEntry.isDirectory);
          expect(entry.comment).toBe(expectedEntry.comment);
          expectOptionalBytesEqual(entry.extraField, detailedExpectedEntry.extraField, expectedEntry.path);
          expect(entry.modifiedAt?.toISOString()).toBe(detailedExpectedEntry.modifiedAt.toISOString());
          expect(entry.externalAttributes).toBe(detailedExpectedEntry.externalAttributes);
          expect(unixModeFromExternalAttributes(entry.externalAttributes ?? 0)).toBe(detailedExpectedEntry.unixMode);
        }

        const data = expectedEntry.size === 0 ? EMPTY_BYTES : await entry.bytes();

        if (shouldCheckDetail) {
          const detailedExpectedEntry = expectedEntry as ZlibDetailedParsedZipEntry;

          expectBytesEqual(data, detailedExpectedEntry.data, expectedEntry.path);

          // The rewritten archive is later validated by independent inflate + CRC
          // + size checks. Release this potentially large expected buffer early.
          detailedExpectedEntry.data = EMPTY_BYTES;
        }

        const rewriteExtraField = stripZip64ExtraField(entry.extraField);
        rewriteExpectations[index] = {
          expectedRewrittenExtraField: shouldCheckDetail && isDetailedParsedZipEntry(expectedEntry)
            ? expectedRewriteExtraField(expectedEntry.extraField, expectedEntry.modifiedAt)
            : undefined
        };

        rewritten.writeSync({
          path: entry.path,
          data: expectedEntry.isDirectory ? "" : data,
          method: expectedEntry.size === 0 || expectedEntry.compressedSize > expectedEntry.size * 0.9 ? "store" : undefined,
          meta: {
            comment: entry.comment,
            extraField: rewriteExtraField,
            modifiedAt: entry.modifiedAt,
            externalAttributes: entry.externalAttributes
          }
        });
      }
    });

    const rewrittenBytes = await timeOperation(zipPath, "close rewritten ZIP", () => rewritten.closeSync() as TestBytes);
    const verifiedRewrite = await timeOperation(zipPath, "parse rewritten ZIP with zlib", () =>
      parseZipWithZlib(rewrittenBytes, { retainData: false })
    );

    await timeOperation(zipPath, "verify rewritten entries", () => {
      expect(verifiedRewrite.comment).toBe(expected.comment);
      expect(verifiedRewrite.entries).toHaveLength(expected.entries.length);

      for (const index of detailIndexes) {
        const expectedEntry = expected.entries[index];
        const actual = verifiedRewrite.entries[index];
        const expectedRewritten = rewriteExpectations[index];

        expect(actual, basename(zipPath)).toBeDefined();
        expect(expectedRewritten, basename(zipPath)).toBeDefined();
        expect(isDetailedParsedZipEntry(expectedEntry), `${expectedEntry.path} should include detailed rewritten expectations`).toBe(true);

        if (!actual || !expectedRewritten) continue;

        const detailedExpectedEntry = expectedEntry as ZlibDetailedParsedZipEntry;

        expect(actual.path).toBe(expectedEntry.path);
        expect(actual.size).toBe(expectedEntry.size);
        expect(actual.crc32).toBe(expectedEntry.crc32);
        expect(actual.isDirectory).toBe(expectedEntry.isDirectory);
        expect(actual.comment).toBe(expectedEntry.comment);
        expect(actual.modifiedAt?.toISOString()).toBe(detailedExpectedEntry.modifiedAt.toISOString());
        expect(actual.externalAttributes).toBe(detailedExpectedEntry.externalAttributes);
        expect(unixModeFromExternalAttributes(actual.externalAttributes ?? 0)).toBe(detailedExpectedEntry.unixMode);
        expectOptionalBytesEqual(actual.extraField, expectedRewritten.expectedRewrittenExtraField, expectedEntry.path);
      }
    });
  } finally {
    if (LOG_TIMING) {
      process.stdout.write(`[fixture recompression] ${basename(zipPath)} total: ${(performance.now() - totalStart).toFixed(1)}ms\n`);
    }
  }
};

const fixtureTimeoutMs = (zipPath: string): number => {
  return basename(zipPath) === "yauzl-issue-108-ffff.zip" ? 30_000 : 15_000;
};

describe("zlib-validated fixture ZIP recompression", () => {
  if (!existsSync(fileURLToPath(fixtureZipDir))) {
    it.skip("discovers fixture ZIPs - no zips folder", () => { });
    return;
  }

  const zipPaths = listZipFixturePaths().filter((zipPath) => extname(zipPath).toLowerCase() === ".zip");

  if (zipPaths.length === 0) {
    it.skip("discovers fixture ZIPs - no zip under zips folder", () => { });
    return;
  }

  for (const zipPath of zipPaths) {
    it(`matches and recompresses ${basename(zipPath)}`, async () => {
      await verifyZlibValidatedFixtureZip(zipPath);
    }, fixtureTimeoutMs(zipPath));
  }
});
