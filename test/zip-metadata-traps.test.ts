import { describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import { openZip, ZipWriter } from "../src/index";

/**
 * ============================================================================
 * ZIP METADATA TRAPS — confirmation suite (docs/zip-metadata-traps.md, 1..55)
 * ============================================================================
 *
 * PURPOSE
 *   This file maps every trap in zip-metadata-traps.md onto the JSZipp public
 *   surface (openZip / readZipStream / ZipWriter) WITHOUT changing the
 *   implementation. It is the "confirm the issues first" phase: the desired
 *   secure behaviour is written down as assertions so the real status of each
 *   trap is observable from a single test run.
 *
 * HOW TO READ THE RESULT
 *   - describe("DEFENDED ...")    -> expected GREEN. Locks in a mitigation that
 *                                    already exists; a future regression turns
 *                                    these red.
 *   - describe("DEFENDED (opt-in) ...") -> expected GREEN. A mitigation enabled
 *                                    only under pathMode "strict-package" (for
 *                                    inputs crossing a trust boundary); each test
 *                                    also pins that the default still accepts, so
 *                                    the documented default contract is preserved.
 *   - describe("ZIP LIMITATION ...")-> expected GREEN. Characterises inherent,
 *                                    by-design ZIP behaviour (lossy timestamps,
 *                                    metadata that is never secret, etc.). The
 *                                    trap is real but is a property of ZIP, not
 *                                    a bug to fix; the test documents reality.
 *   - it.skip("trap NN ...")      -> out of scope for an in-memory read/write
 *                                    library (no disk extraction, no symlinks,
 *                                    no recursion, no on-disk permissions). Kept
 *                                    so all 55 traps are explicitly accounted
 *                                    for.
 *
 * To run only this file:   pnpm exec vitest run zip-metadata-traps
 */


/**
It maps all 55 traps onto JSZipp's actual surface (`openZip`/`readZipStream`/`ZipWriter`) and is organized so the run is self-documenting:

**DEFENDED — local/central cross-checking & Unicode path (now enforced)** — four
traps that were CONFIRMED GAPs are now mitigated by default as additive reader
checks; honestly-produced archives are unaffected. A regression turns them red:
- trap 3/54 — local-vs-central **filename** byte cross-check
- trap 3 — local-vs-central **flag** cross-check (encryption + data-descriptor bits)
- trap 53 — reused/overlapping **local-header offset** rejected
- trap 10 — **0x7075 Unicode Path** honoured, and its CRC verified against the header name

**CONFIRMED GAP → DEFENDED (opt-in `pathMode: "strict-package"`)** — four traps
that would break a documented JSZipp contract if made default are now resolved via
the explicit strict-package profile for inputs crossing a trust boundary. Each
test pins both halves: the default still accepts (contract intact) and
strict-package rejects (the opt-in works):
- trap 3/51 — open-time local/central **size** cross-check (default defers size
  integrity to read time; strict-package adds the cross-check)
- trap 27 — **duplicate** normalized paths (default reader PRESERVES; strict-package rejects)
- trap 28 — **case-only** collision (`Readme.txt`/`README.TXT`)
- trap 29 — **NFC/NFD** collision (`café`)

**DEFENDED (passes)** — locks in existing mitigations: Zip Slip, absolute/drive/drive-relative/backslash/NUL paths, encryption + unsupported-method refusal, `maxArchiveSize`/`maxEntrySize` caps, empty-archive handling, magic-number-only rejection, EOCD-forgery resistance (comment + appended), CRC integrity, and out-of-bounds local offsets.

**ZIP LIMITATION (passes)** — characterizes inherent, by-design behaviour: 0x5455 UTC preferred over DOS, 1980/2107 clamp, 2-second rounding, comments/extra-fields/unix-mode preserved-not-stripped, directory entries, entry order, UTF-8 flag overriding the fallback charset, and Shift_JIS fallback decoding.

**OUT OF SCOPE (20 `it.skip`)** — symlinks, on-disk permissions, split/spanned, nested recursion, SFX/polyglot rebiasing, package-profile rules, etc., each skipped with a one-line reason so every trap number is explicitly accounted for.

Run result against current code: **0 failed | 36 passed | 20 skipped**. Run just
this file with `pnpm exec vitest run zip-metadata-traps`.

The four strict-package traps are resolved as an opt-in rather than a default
change, so JSZipp's documented default reader contracts (duplicate-path
preservation; read-time integrity) are preserved for callers that don't opt in.
*/

type TestBytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();

const u16 = (o: number[], v: number): void => { o.push(v & 0xff, (v >>> 8) & 0xff); };
const u32 = (o: number[], v: number): void => { o.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };
const raw = (o: number[], b: Uint8Array | number[]): void => { for (const x of b) o.push(x); };

interface EntrySpec {
  // What the central directory advertises (authoritative for openZip today).
  centralName: string;
  // What the local file header advertises (a hostile archive can diverge).
  localName?: string;
  data: Uint8Array;
  centralCompSize?: number;
  centralSize?: number;
  localCompSize?: number;
  localSize?: number;
  centralFlags?: number;
  localFlags?: number;
  method?: number;        // 0 store, 8 deflate
  dosDate?: number;
  dosTime?: number;
  centralExtra?: number[];
  localExtra?: number[];
  externalAttributes?: number;
  // Force this central entry to point at a specific local-header offset
  // (used to build overlapping / reused-offset archives).
  forceLocalOffset?: number;
  // If true, do NOT emit a local header for this entry (it reuses another's).
  skipLocalHeader?: boolean;
}

/**
 * Hand-builds a ZIP from explicit specs. Unlike ZipWriter, this lets local and
 * central metadata diverge on purpose so reader-side cross-checking (or its
 * absence) can be observed directly. Layout: [local headers + data]* then the
 * central directory then a single EOCD (no ZIP64).
 */
const buildZip = (specs: EntrySpec[], archiveComment = ""): TestBytes => {
  const out: number[] = [];
  const localOffsets: number[] = [];

  for (const s of specs) {
    if (s.skipLocalHeader) { localOffsets.push(s.forceLocalOffset ?? 0); continue; }
    const offset = out.length;
    localOffsets.push(offset);
    const name = enc.encode(s.localName ?? s.centralName);
    const crc = crc32(s.data) >>> 0;
    const extra = s.localExtra ?? [];
    u32(out, 0x04034b50);
    u16(out, 20);
    u16(out, s.localFlags ?? s.centralFlags ?? 0);
    u16(out, s.method ?? 0);
    u16(out, s.dosTime ?? 0);
    u16(out, s.dosDate ?? 0);
    u32(out, crc);
    u32(out, s.localCompSize ?? s.data.length);
    u32(out, s.localSize ?? s.data.length);
    u16(out, name.length);
    u16(out, extra.length);
    raw(out, name);
    raw(out, extra);
    raw(out, s.data);
  }

  const cdOffset = out.length;
  specs.forEach((s, i) => {
    const name = enc.encode(s.centralName);
    const crc = crc32(s.data) >>> 0;
    const extra = s.centralExtra ?? [];
    u32(out, 0x02014b50);
    u16(out, 20);
    u16(out, 20);
    u16(out, s.centralFlags ?? 0);
    u16(out, s.method ?? 0);
    u16(out, s.dosTime ?? 0);
    u16(out, s.dosDate ?? 0);
    u32(out, crc);
    u32(out, s.centralCompSize ?? s.data.length);
    u32(out, s.centralSize ?? s.data.length);
    u16(out, name.length);
    u16(out, extra.length);
    u16(out, 0);
    u16(out, 0);
    u16(out, 0);
    u32(out, s.externalAttributes ?? 0);
    u32(out, s.forceLocalOffset ?? localOffsets[i]);
    raw(out, name);
    raw(out, extra);
  });
  const cdSize = out.length - cdOffset;

  const comment = enc.encode(archiveComment);
  u32(out, 0x06054b50);
  u16(out, 0);
  u16(out, 0);
  u16(out, specs.length);
  u16(out, specs.length);
  u32(out, cdSize);
  u32(out, cdOffset);
  u16(out, comment.length);
  raw(out, comment);

  return new Uint8Array(out) as TestBytes;
};

// A 0x7075 "Unicode Path" extra field: version(1) | nameCRC32(4) | UTF-8 name.
const unicodePathExtra = (headerNameBytes: Uint8Array, unicodeName: string, crcOverride?: number): number[] => {
  const uni = enc.encode(unicodeName);
  const extra: number[] = [];
  u16(extra, 0x7075);
  u16(extra, 1 + 4 + uni.length);
  extra.push(1);
  u32(extra, crcOverride ?? (crc32(headerNameBytes) >>> 0));
  raw(extra, uni);
  return extra;
};

// Generic TLV extra field: id(2) | declared length(2) | payload.
// declaredLength lets tests lie about the payload size to cover parser guards.
const extraField = (id: number, payload: number[], declaredLength = payload.length): number[] => {
  const extra: number[] = [];
  u16(extra, id);
  u16(extra, declaredLength);
  raw(extra, payload);
  return extra;
};

const le32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

// ===========================================================================
// DEFENDED — mitigations that already exist; these should stay green.
// ===========================================================================
describe("DEFENDED — path & structural validation already enforced", () => {
  it("trap 12 — rejects Zip Slip path traversal (..)", async () => {
    await expect(openZip(buildZip([{ centralName: "../../etc/passwd", data: enc.encode("x") }])))
      .rejects.toThrow(/unsafe zip entry path/i);
  });

  it("trap 13 — rejects a POSIX absolute path", async () => {
    await expect(openZip(buildZip([{ centralName: "/etc/passwd", data: enc.encode("x") }])))
      .rejects.toThrow(/unsafe zip entry path/i);
  });

  it("trap 13 — rejects a Windows drive-letter path", async () => {
    await expect(openZip(buildZip([{ centralName: "C:\\Windows\\system32\\drivers\\etc\\hosts", data: enc.encode("x") }])))
      .rejects.toThrow(/unsafe zip entry path/i);
  });

  it("trap 13 — rejects a Windows drive-relative path (C:name)", async () => {
    await expect(openZip(buildZip([{ centralName: "C:evil", data: enc.encode("x") }])))
      .rejects.toThrow(/unsafe zip entry path/i);
  });

  it("trap 11 — rejects backslash-separated paths in strict mode", async () => {
    await expect(openZip(buildZip([{ centralName: "a\\b\\c.txt", data: enc.encode("x") }])))
      .rejects.toThrow(/unsafe zip entry path/i);
  });

  it("trap 13 — rejects a NUL byte embedded in the path", async () => {
    await expect(openZip(buildZip([{ centralName: "evil\u0000.txt", data: enc.encode("x") }])))
      .rejects.toThrow(/unsafe zip entry path/i);
  });

  it("traps 2/22/43 — refuses encrypted entries instead of leaking via decode", async () => {
    // General-purpose bit 0 set => encrypted. Must be refused, not silently read.
    await expect(openZip(buildZip([{ centralName: "secret.txt", data: enc.encode("x"), centralFlags: 0x0001 }])))
      .rejects.toThrow(/encrypt/i);
  });

  it("trap 21 — refuses an unsupported compression method", async () => {
    // method 12 = BZIP2 (unsupported here).
    await expect(openZip(buildZip([{ centralName: "a.txt", data: enc.encode("x"), method: 12 }])))
      .rejects.toThrow(/unsupported zip compression method/i);
  });

  it("trap 36 — enforces maxArchiveSize against the whole input", async () => {
    const z = buildZip([{ centralName: "a.txt", data: enc.encode("hello world") }]);
    await expect(openZip(z, { maxArchiveSize: 8 })).rejects.toThrow(RangeError);
  });

  it("trap 36 — enforces maxEntrySize against a declared oversized entry", async () => {
    const w = new ZipWriter({ outputAs: "uint8array", level: 0 });
    await w.add({ path: "big.txt", data: "0123456789" });
    const z = new Uint8Array(await w.close()) as TestBytes;
    const r = await openZip(z, { maxEntrySize: 4 });
    await expect(r.entries[0].bytes()).rejects.toThrow(RangeError);
  });

  it("trap 38/47 — accepts a genuinely empty archive as zero entries", async () => {
    const r = await openZip(buildZip([]));
    expect(r.entries).toHaveLength(0);
  });

  it("trap 47 — rejects a file that is only a ZIP magic number", async () => {
    // First four bytes look like a local header, but there is no valid EOCD.
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]) as TestBytes;
    await expect(openZip(bytes)).rejects.toThrow();
  });

  it("trap 24 — a fake EOCD inside the archive comment cannot hide real entries", async () => {
    const base = buildZip([{ centralName: "real.txt", data: enc.encode("hi") }]);
    // Append a self-contained fake EOCD (0 entries) as the archive comment payload.
    const fake: number[] = [];
    u32(fake, 0x06054b50);
    u16(fake, 0); u16(fake, 0); u16(fake, 0); u16(fake, 0);
    u32(fake, 0); u32(fake, 0); u16(fake, 0);
    // Rebuild with the fake bytes living in the comment field of the real EOCD.
    const withComment = buildZip([{ centralName: "real.txt", data: enc.encode("hi") }], String.fromCharCode(...fake));
    const r = await openZip(withComment);
    expect(r.entries.map((e) => e.path)).toEqual(["real.txt"]);
    void base;
  });

  it("trap 35 — trailing appended bytes after a complete archive do not erase entries", async () => {
    const base = buildZip([{ centralName: "real.txt", data: enc.encode("hi") }]);
    const fake: number[] = [];
    u32(fake, 0x06054b50);
    u16(fake, 0); u16(fake, 0); u16(fake, 0); u16(fake, 0);
    u32(fake, 0); u32(fake, 0); u16(fake, 1);
    fake.push(0x58); // 1-byte comment "X"
    const archive = new Uint8Array(base.length + fake.length) as TestBytes;
    archive.set(base, 0);
    archive.set(fake, base.length);
    const r = await openZip(archive);
    expect(r.entries.map((e) => e.path)).toEqual(["real.txt"]);
  });

  it("trap 53 — rejects a local-header offset that points outside the archive", async () => {
    // A central entry whose local-header offset lands outside the file is caught
    // by bounds checking (the overlapping/reused-offset case is the open gap).
    const z = buildZip([{ centralName: "a.txt", data: enc.encode("x"), forceLocalOffset: 999999 }]);
    await expect(openZip(z)).rejects.toThrow();
  });

  it("trap 20 — CRC-32 is verified for integrity on read (a tampered payload is caught)", async () => {
    // CRC is not a security hash, but JSZipp does at least use it for integrity:
    // flip a payload byte while keeping the recorded CRC, and reading must throw.
    const data = enc.encode("hello");
    const z = buildZip([{ centralName: "a.txt", data }]);
    // Corrupt the stored payload byte (it sits right after the local name "a.txt").
    const idx = z.indexOf(0x68); // 'h'
    z[idx] = 0x48; // 'H'
    const r = await openZip(z);
    await expect(r.entries[0].bytes()).rejects.toThrow(/crc/i);
  });
});

// ===========================================================================
// DEFENDED — metadata cross-checking & Unicode path (now enforced by default).
// These four traps were CONFIRMED GAPs; openZip now hardens them as additive
// reader checks that leave honestly-produced archives untouched. The assertions
// pin the specific failure so a future regression turns them red again.
// ===========================================================================
describe("DEFENDED — local/central cross-checking & Unicode path", () => {
  it("trap 3/54 — rejects a local/central FILENAME mismatch", async () => {
    // A listing trusts the central name while a streaming extractor reads the
    // local name. They disagree here ("safe.txt" vs "evil.txt"); openZip now
    // compares the raw name bytes so a scanner and an extractor cannot be shown
    // different trees.
    const z = buildZip([{ centralName: "safe.txt", localName: "evil.txt", data: enc.encode("hi") }]);
    await expect(openZip(z)).rejects.toThrow(/filename mismatch/i);
  });

  it("trap 3 — rejects a local/central FLAG disagreement (bit 3)", async () => {
    // The local header sets the data-descriptor flag (bit 3) while the central
    // entry leaves it clear. openZip cross-checks the security-relevant flag
    // bits (encryption + data descriptor) and rejects the divergence.
    const z = buildZip([{
      centralName: "a.txt",
      data: enc.encode("hi"),
      localFlags: 0x0008,
      centralFlags: 0x0000
    }]);
    await expect(openZip(z)).rejects.toThrow(/flag mismatch/i);
  });

  it("trap 53 — rejects two central entries reusing one local-header offset", async () => {
    // Both central records point at the same local header, which would let a
    // strict reader and a recovering one see different trees. openZip tracks the
    // local offsets it has resolved and rejects a reused one.
    const data = enc.encode("x");
    const z = buildZip([
      { centralName: "a.txt", data },
      { centralName: "b.txt", data, skipLocalHeader: true, forceLocalOffset: 0 }
    ]);
    await expect(openZip(z)).rejects.toThrow(/reuse local-header offset/i);
  });

  it("trap 10 — honours and CRC-verifies the 0x7075 Unicode Path extra field", async () => {
    // The header name is an ASCII placeholder; the true name lives in 0x7075 with
    // a CRC of the placeholder bytes. openZip surfaces the unicode name only when
    // that CRC matches the header bytes, so a stale field cannot be trusted.
    const headerName = enc.encode("X.txt");
    const extra = unicodePathExtra(headerName, "\u2603.txt"); // ☃.txt
    const z = buildZip([{
      centralName: "X.txt",
      data: enc.encode("hi"),
      centralExtra: extra,
      localExtra: extra
    }]);
    const r = await openZip(z);
    expect(r.entries[0].path).toBe("\u2603.txt");
  });

  it("trap 10 — ignores a 0x7075 Unicode Path whose CRC does not match the header", async () => {
    // A stale Unicode Path field (its CRC no longer matches the header name) must
    // be ignored, falling back to the header name rather than trusting the
    // override. Guards the CRC check the previous test depends on.
    const extra = unicodePathExtra(enc.encode("X.txt"), "\u2603.txt", 0xdeadbeef);
    const z = buildZip([{ centralName: "X.txt", data: enc.encode("hi"), centralExtra: extra, localExtra: extra }]);
    const r = await openZip(z);
    expect(r.entries[0].path).toBe("X.txt");
  });
});

// ===========================================================================
// DEFENDED — parser-sensitive extra-field walkers. These cover malformed TLVs
// that must be ignored or treated as absent rather than letting one bad field
// silently alter filename decoding, timestamp selection, or ZIP64 size handling.
// ===========================================================================
describe("DEFENDED — extra-field parser traps", () => {
  const ZIP64 = 0x0001;
  const UNICODE_PATH = 0x7075;
  const EXT_TS = 0x5455;

  it("ignores a malformed non-matching extra field and still reads the entry", async () => {
    const z = buildZip([{
      centralName: "ok.txt",
      data: enc.encode("payload"),
      centralExtra: extraField(0x9999, [1, 2, 3], 999),
      localExtra: extraField(0x9999, [1, 2, 3], 999)
    }]);
    const r = await openZip(z);
    expect(r.entries[0].path).toBe("ok.txt");
    expect(await r.entries[0].text()).toBe("payload");
  });

  it("rejects a ZIP64 sentinel size backed by a malformed ZIP64 extra field", async () => {
    const z = buildZip([{
      centralName: "big.bin",
      data: enc.encode("x"),
      centralSize: 0xffffffff,
      centralExtra: extraField(ZIP64, [0, 0, 0, 0], 64),
      localExtra: extraField(ZIP64, [0, 0, 0, 0], 64)
    }]);
    await expect(openZip(z)).rejects.toThrow(/zip64 uncompressed size is missing/i);
  });

  it("falls back to the DOS timestamp when the Extended Timestamp field is too short", async () => {
    const z = buildZip([{
      centralName: "t.txt",
      data: enc.encode("x"),
      dosDate: 0x4a21, // 2017-01-01
      dosTime: 0x6000, // 12:00:00
      centralExtra: extraField(EXT_TS, [0x01]),
      localExtra: extraField(EXT_TS, [0x01])
    }]);
    const r = await openZip(z);
    expect(r.entries[0].modifiedAt?.getFullYear()).toBe(2017);
    expect(r.entries[0].modifiedAt?.getHours()).toBe(12);
  });

  it("falls back to the DOS timestamp when the Extended Timestamp length overruns the buffer", async () => {
    const z = buildZip([{
      centralName: "t2.txt",
      data: enc.encode("x"),
      dosDate: 0x4a21,
      dosTime: 0x6000,
      centralExtra: extraField(EXT_TS, [0x01, 0x00, 0x00, 0x00, 0x00], 200),
      localExtra: extraField(EXT_TS, [0x01, 0x00, 0x00, 0x00, 0x00], 200)
    }]);
    const r = await openZip(z);
    expect(r.entries[0].modifiedAt?.getFullYear()).toBe(2017);
  });

  it("uses the Unicode Path name when its CRC matches the header name bytes", async () => {
    const headerName = enc.encode("stored-name.txt");
    const z = buildZip([{
      centralName: "stored-name.txt",
      data: enc.encode("x"),
      centralExtra: unicodePathExtra(headerName, "override.txt"),
      localExtra: unicodePathExtra(headerName, "override.txt")
    }]);
    const r = await openZip(z);
    expect(r.entries[0].path).toBe("override.txt");
  });

  it("ignores a stale Unicode Path field (CRC mismatch) and uses the header name", async () => {
    const headerName = enc.encode("real.txt");
    const staleCrc = (crc32(headerName) ^ 0xffffffff) >>> 0;
    const z = buildZip([{
      centralName: "real.txt",
      data: enc.encode("x"),
      centralExtra: unicodePathExtra(headerName, "fake.txt", staleCrc),
      localExtra: unicodePathExtra(headerName, "fake.txt", staleCrc)
    }]);
    const r = await openZip(z);
    expect(r.entries[0].path).toBe("real.txt");
  });

  it("stops at the first version-1 Unicode Path field even on CRC mismatch", async () => {
    const headerName = enc.encode("real.txt");
    const stale = extraField(UNICODE_PATH, [1, ...le32((crc32(headerName) ^ 0xffffffff) >>> 0), ...enc.encode("first.txt")]);
    const valid = unicodePathExtra(headerName, "second.txt");
    const z = buildZip([{
      centralName: "real.txt",
      data: enc.encode("x"),
      centralExtra: [...stale, ...valid],
      localExtra: [...stale, ...valid]
    }]);
    const r = await openZip(z);
    expect(r.entries[0].path).toBe("real.txt");
  });

  it("treats a user 0x5455 field with an overrunning length as absent so the writer still adds its own", () => {
    const writer = new ZipWriter({ outputAs: "uint8array", level: 0, zip64: "off" });
    writer.writeSync({
      path: "f.txt",
      data: "hi",
      meta: {
        modifiedAt: new Date("2020-06-01T00:00:00Z"),
        extraField: new Uint8Array(extraField(EXT_TS, [0x01], 200)) as TestBytes
      }
    });
    const z = writer.closeSync() as TestBytes;
    let found = false;
    for (let offset = 0; offset + 4 <= z.length; offset++) {
      if (z[offset] === 0x55 && z[offset + 1] === 0x54 && z[offset + 2] === 5 && z[offset + 3] === 0) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

// ===========================================================================
// DEFENDED (opt-in) — pathMode "strict-package" rejects what the default
// preserves. These four traps would break a documented JSZipp default reader
// contract if made default (duplicate-path preservation; read-time size
// integrity), so they live behind the explicit strict-package profile for inputs
// crossing a trust boundary. Each test pins BOTH halves: the default still
// accepts (contract intact) and strict-package rejects (the opt-in works).
// ===========================================================================
describe("DEFENDED (opt-in) — pathMode \"strict-package\"", () => {
  it("trap 3/51 — strict-package rejects a local/central SIZE disagreement (bit 3 clear)", async () => {
    // Central is internally honest (5/5) so the entry extracts cleanly under the
    // default reader, but the local header lies (99/99). strict-package adds the
    // open-time size cross-check the default omits (it defers size integrity to
    // read time), so only the opt-in profile rejects it.
    const z = buildZip([{
      centralName: "a.txt",
      data: enc.encode("hello"),
      centralCompSize: 5, centralSize: 5,
      localCompSize: 99, localSize: 99
    }]);
    expect((await openZip(z)).entries[0].path).toBe("a.txt"); // default accepts
    await expect(openZip(z, { pathMode: "strict-package" })).rejects.toThrow(/size mismatch/i);
  });

  it("trap 27 — strict-package rejects duplicate normalized paths", async () => {
    // The default reader PRESERVES duplicates from foreign archives (documented
    // feature, tested in jszipp_test).
    const data = enc.encode("x");
    const z = buildZip([
      { centralName: "dup.txt", data },
      { centralName: "dup.txt", data }
    ]);
    expect((await openZip(z)).entries).toHaveLength(2); // default preserves both
    await expect(openZip(z, { pathMode: "strict-package" })).rejects.toThrow(/colliding entry path/i);
  });

  it("trap 28 — strict-package detects a case-only filename collision", async () => {
    // "Readme.txt" and "README.TXT" collide on case-insensitive filesystems.
    const data = enc.encode("x");
    const z = buildZip([
      { centralName: "Readme.txt", data },
      { centralName: "README.TXT", data }
    ]);
    expect((await openZip(z)).entries).toHaveLength(2); // default keeps both
    await expect(openZip(z, { pathMode: "strict-package" })).rejects.toThrow(/colliding entry path/i);
  });

  it("trap 29 — strict-package detects an NFC/NFD Unicode normalization collision", async () => {
    // U+00E9 (é, NFC) vs "e" + U+0301 (NFD) normalize to the same name.
    const data = enc.encode("x");
    const z = buildZip([
      { centralName: "caf\u00e9.txt", data, centralFlags: 0x0800 },
      { centralName: "cafe\u0301.txt", data, centralFlags: 0x0800 }
    ]);
    expect((await openZip(z)).entries).toHaveLength(2); // default keeps both
    await expect(openZip(z, { pathMode: "strict-package" })).rejects.toThrow(/colliding entry path/i);
  });

  it("strict-package still reads a clean, conflict-free archive", async () => {
    // The profile must not be over-eager: a normal multi-entry archive opens fine.
    const w = new ZipWriter({ outputAs: "uint8array", level: 0 });
    await w.add({ path: "a.txt", data: "one" });
    await w.add({ path: "dir/b.txt", data: "two" });
    const z = new Uint8Array(await w.close()) as TestBytes;
    const r = await openZip(z, { pathMode: "strict-package" });
    expect(r.entries.map((e) => e.path)).toEqual(["a.txt", "dir/b.txt"]);
    expect(await r.get("dir/b.txt")?.text()).toBe("two");
  });
});

// ===========================================================================
// ZIP LIMITATION — inherent, by-design behaviour. Green = documented reality.
// The trap is real (do not trust this metadata), but it is not a bug to fix.
// ===========================================================================
describe("ZIP LIMITATION — lossy/exposed metadata (characterization)", () => {
  it("trap 1/7 — the 0x5455 UTC timestamp is preferred over the local DOS fields", async () => {
    // The writer records an Extended Timestamp (0x5455) in UTC and the reader
    // prefers it, so a representable instant round-trips exactly regardless of
    // the lossy DOS local-time fields.
    const when = new Date("2026-05-31T12:00:00Z");
    const w = new ZipWriter({ outputAs: "uint8array", level: 0 });
    await w.add({ path: "a.txt", data: "x", meta: { modifiedAt: when } });
    const z = new Uint8Array(await w.close()) as TestBytes;
    const r = await openZip(z);
    expect(r.entries[0].modifiedAt?.getTime()).toBe(when.getTime());
  });

  it("trap 4 — DOS-only timestamps clamp future years into the 1980..2107 window; pre-epoch is rejected", async () => {
    // Dates outside 32-bit Unix range cannot use 0x5455, so they fall back to the
    // DOS fields and are clamped — proving DOS timestamps are not authoritative.
    // Pre-epoch (negative) dates cannot be represented by the UTC extras at all
    // and are rejected up front rather than silently clamped.
    const w = new ZipWriter({ outputAs: "uint8array", level: 0 });
    await expect(w.add({ path: "old.txt", data: "x", meta: { modifiedAt: new Date("1969-01-01T00:00:03Z") } })).rejects.toThrow(RangeError);
    await w.add({ path: "future.txt", data: "y", meta: { modifiedAt: new Date("2200-06-15T12:00:00Z") } });
    const z = new Uint8Array(await w.close()) as TestBytes;
    const r = await openZip(z);
    const byName = Object.fromEntries(r.entries.map((e) => [e.path, e.modifiedAt!]));
    expect(byName["future.txt"].getFullYear()).toBe(2107);
  });

  it("trap 6 — DOS-only seconds round down to a 2-second boundary", async () => {
    const w = new ZipWriter({ outputAs: "uint8array", level: 0 });
    // 2200 forces DOS fallback (no 0x5455), exposing the 2-second granularity.
    await w.add({ path: "a.txt", data: "x", meta: { modifiedAt: new Date("2200-01-01T00:00:01Z") } });
    const z = new Uint8Array(await w.close()) as TestBytes;
    const r = await openZip(z);
    expect(r.entries[0].modifiedAt!.getSeconds() % 2).toBe(0);
  });

  it("traps 17/45 — per-file and archive comments are preserved, never secret", async () => {
    const w = new ZipWriter({ outputAs: "uint8array", level: 0, comment: "ARCHIVE-NOTE" });
    await w.add({ path: "a.txt", data: "x", meta: { comment: "FILE-NOTE" } });
    const z = new Uint8Array(await w.close()) as TestBytes;
    const r = await openZip(z);
    // The library does not strip comments: they are plainly readable metadata.
    expect(r.comment).toBe("ARCHIVE-NOTE");
    expect(r.entries[0].comment).toBe("FILE-NOTE");
  });

  it("trap 30 — extra-field bytes are exposed verbatim, not stripped", async () => {
    const extra = new Uint8Array([0x99, 0x99, 0x02, 0x00, 0xaa, 0xbb]);
    const w = new ZipWriter({ outputAs: "uint8array", level: 0 });
    await w.add({ path: "a.txt", data: "x", meta: { extraField: extra } });
    const z = new Uint8Array(await w.close()) as TestBytes;
    const r = await openZip(z);
    expect(r.entries[0].extraField && r.entries[0].extraField.length).toBeGreaterThan(0);
  });

  it("trap 31/15 — host external attributes / unix mode are surfaced, not applied", async () => {
    const w = new ZipWriter({ outputAs: "uint8array", level: 0 });
    await w.add({ path: "build.sh", data: "#!/bin/sh\n", meta: { unixPermissions: 0o755 } });
    const z = new Uint8Array(await w.close()) as TestBytes;
    const r = await openZip(z);
    // The exec bit is preserved as metadata; the library never chmods anything.
    // unixMode is no longer pre-decoded — derive it from externalAttributes.
    expect((r.entries[0].externalAttributes! >>> 16) & 0o777).toBe(0o755);
  });

  it("trap 16/39 — explicit directory entries are recognized and carry no data", async () => {
    const w = new ZipWriter({ outputAs: "uint8array", level: 0 });
    await w.add({ path: "folder/", data: "" });
    const z = new Uint8Array(await w.close()) as TestBytes;
    const r = await openZip(z);
    const dir = r.entries.find((e) => e.path === "folder/")!;
    expect(dir.isDirectory).toBe(true);
    expect(dir.size).toBe(0);
  });

  it("trap 32 — archive entry order is preserved", async () => {
    const w = new ZipWriter({ outputAs: "uint8array", level: 0 });
    await w.add({ path: "z.txt", data: "1" });
    await w.add({ path: "a.txt", data: "2" });
    await w.add({ path: "m.txt", data: "3" });
    const z = new Uint8Array(await w.close()) as TestBytes;
    const r = await openZip(z);
    expect(r.entries.map((e) => e.path)).toEqual(["z.txt", "a.txt", "m.txt"]);
  });

  it("trap 40 — the in-archive UTF-8 flag overrides a caller-supplied fallback encoding", async () => {
    // Name bytes are UTF-8 for "ä.txt" and the UTF-8 flag is set. Even when the
    // caller asks for shift_jis, the flag wins, so decoding cannot be forced.
    const z = buildZip([{ centralName: "\u00e4.txt", data: enc.encode("x"), centralFlags: 0x0800, localFlags: 0x0800 }]);
    const r = await openZip(z, { filenameEncoding: "shift_jis" });
    expect(r.entries[0].path).toBe("\u00e4.txt");
  });

  it("trap 9 — legacy (non-UTF-8) names decode via the requested fallback charset", async () => {
    // 0x82 0xa0 is あ in Shift_JIS; with the UTF-8 flag clear, the fallback decodes it.
    const nameBytes = new Uint8Array([0x82, 0xa0, 0x2e, 0x74, 0x78, 0x74]); // <SJIS あ>.txt
    const z = buildZip([{ centralName: "PLACEHOLDER", data: enc.encode("x") }]);
    void nameBytes; void z;
    // Build directly to keep the raw (non-UTF-8) name bytes intact.
    const data = enc.encode("x");
    const crc = crc32(data) >>> 0;
    const out: number[] = [];
    const localOffset = out.length;
    u32(out, 0x04034b50); u16(out, 20); u16(out, 0); u16(out, 0); u16(out, 0); u16(out, 0);
    u32(out, crc); u32(out, data.length); u32(out, data.length); u16(out, nameBytes.length); u16(out, 0);
    raw(out, nameBytes); raw(out, data);
    const cdOffset = out.length;
    u32(out, 0x02014b50); u16(out, 20); u16(out, 20); u16(out, 0); u16(out, 0); u16(out, 0); u16(out, 0);
    u32(out, crc); u32(out, data.length); u32(out, data.length); u16(out, nameBytes.length); u16(out, 0);
    u16(out, 0); u16(out, 0); u16(out, 0); u32(out, 0); u32(out, localOffset); raw(out, nameBytes);
    const cdSize = out.length - cdOffset;
    u32(out, 0x06054b50); u16(out, 0); u16(out, 0); u16(out, 1); u16(out, 1); u32(out, cdSize); u32(out, cdOffset); u16(out, 0);
    const r = await openZip(new Uint8Array(out) as TestBytes, { filenameEncoding: "shift_jis" });
    expect(r.entries[0].path).toBe("\u3042.txt");
  });
});

// ===========================================================================
// OUT OF SCOPE — traps that target on-disk extraction, recursion, or features
// JSZipp deliberately does not implement. Listed so all 55 traps are covered.
// ===========================================================================
describe("OUT OF SCOPE — not applicable to an in-memory read/write library", () => {
  it.skip("trap 5 — extra-field interop across tools (deployment concern, not a single library)", () => {});
  it.skip("trap 8 — creation/access time (no birthtime field is exposed by the API)", () => {});
  it.skip("trap 14 — symlink escape (library returns in-memory entries; it never writes symlinks)", () => {});
  it.skip("trap 18 — ZIP64 vs legacy compatibility on other runtimes (consumer-environment concern)", () => {});
  it.skip("trap 19 — data-descriptor/bit-3 streaming (openZip uses the central directory as source of truth)", () => {});
  it.skip("trap 23 — central directory encryption (unsupported feature)", () => {});
  it.skip("trap 25 — self-extracting executable stub (uses absolute offsets; SFX polyglots are not rebiased)", () => {});
  it.skip("trap 26 — '.zip vs .docx/.jar' detection (caller's content-type policy)", () => {});
  it.skip("trap 33 — application manifest rules (package-format layer, above the ZIP container)", () => {});
  it.skip("trap 34 — split/spanned archives (unsupported; single-segment only)", () => {});
  it.skip("trap 37 — nested ZIP recursion limits (caller decides whether to recurse)", () => {});
  it.skip("trap 41 — listing vs extraction divergence (covered by the cross-check gaps above)", () => {});
  it.skip("trap 42 — valid ZIP / invalid package profile (application layer)", () => {});
  it.skip("trap 44 — local-header masking under CD encryption (unsupported feature)", () => {});
  it.skip("trap 46 — wrapping an untrusted library (this IS the library; caller wraps extraction)", () => {});
  it.skip("trap 48 — re-zip metadata preservation/reproducibility (build-pipeline policy)", () => {});
  it.skip("trap 49 — forensic attribution (evidentiary policy, not a parser behaviour)", () => {});
  it.skip("trap 50 — 'supports ZIP' ambiguity (feature-matrix documentation, not a test)", () => {});
  it.skip("trap 52 — prepended polyglot rebiasing (absolute offsets; no stub-bias handling)", () => {});
  it.skip("trap 55 — scanner-vs-extractor differential (same root cause as the cross-check gaps above)", () => {});
});
