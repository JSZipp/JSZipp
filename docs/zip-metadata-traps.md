# ZIP Metadata Traps: A Comprehensive Engineering Reference

ZIP looks simple, but it is a legacy container format with decades of backward-compatible extensions. A ZIP archive can contain duplicated metadata, optional metadata, platform-specific metadata, encrypted file data with unencrypted metadata, streaming records, ZIP64 records, comments, extra fields, and multiple parser-visible views of the same file tree.

The safest way to think about ZIP is:

```text
ZIP is not just compressed bytes.
ZIP is a structured container with multiple metadata layers.
Different tools may interpret those layers differently.
```

This reference lists the major metadata, interoperability, and security traps that engineers, auditors, build-system maintainers, and forensic analysts should consider when creating, parsing, scanning, or extracting ZIP archives.

---

## ZIP Structure Overview

A typical ZIP archive has a local stream of file records followed by a central index.

```text
[ Local File Header 1  ]  -> Local metadata: name, flags, method, time, sizes*
[ File Data 1          ]  -> Compressed or stored payload
[ Data Descriptor 1    ]  -> Optional trailing CRC/sizes when bit 3 is set

[ Local File Header 2  ]
[ File Data 2          ]
[ Data Descriptor 2    ]

...

========================================================================
[ Central Directory    ]  -> Archive index; one central header per entry
  ├── Central Entry 1  -> Points back to Local Header 1 offset
  ├── Central Entry 2  -> Points back to Local Header 2 offset
  └── Central Entry N  -> Points back to Local Header N offset
========================================================================
[ ZIP64 EOCD Record    ]  -> Optional ZIP64 metadata
[ ZIP64 EOCD Locator   ]  -> Optional ZIP64 pointer
[ EOCD Record          ]  -> End of Central Directory; normally found by
                             scanning backward from the end of the file
[ ZIP Comment          ]  -> Optional; not a safe place for secrets
```

`*` If general purpose bit 3 is set, the local header’s CRC and size fields are not authoritative; the data descriptor and central directory must be used.

---

## 1. The Time Zone and Daylight Saving Trap

**Metadata involved:** DOS date/time fields, Extended Timestamp extra field `0x5455`, NTFS extra field `0x000a`.

**The issue:** Standard ZIP timestamps use MS-DOS-style local date/time fields. They do not reliably encode a UTC instant or the original time zone.

**The trap:** A file compressed at `15:00` in Tokyo may be extracted as `15:00` local time in London. Around daylight-saving transitions, timestamps may appear to shift by exactly one hour depending on the extractor and operating system.

**Practical guidance:** Treat classic ZIP timestamps as local wall-clock metadata, not authoritative UTC timestamps. For reproducible builds or compliance archives, normalize timestamps explicitly or store authoritative timestamps in an external manifest.

---

## 2. Password Protection Leaves Metadata Exposed

**Metadata involved:** central directory, filenames, paths, sizes, timestamps, comments.

**The issue:** Standard ZIP encryption protects file contents, not necessarily the archive listing.

**The trap:** A password-protected ZIP may still reveal filenames, directory layout, uncompressed sizes, modified times, file comments, and archive comments.

**Practical guidance:** Do not assume password-protected ZIP means private metadata. Use central directory encryption only when every consumer supports it, or place the ZIP inside a separate encrypted container.

---

## 3. The Local Header vs. Central Directory Discrepancy Trap

**Metadata involved:** local file header, central directory header.

**The issue:** Each normal ZIP entry has metadata in two places: the local file header near the file data and the central directory header near the end of the archive.

**The trap:** A listing tool may trust the central directory while an extraction tool or streaming scanner reads local headers. If the two disagree, different tools may see different filenames, flags, sizes, offsets, or extra fields.

**Practical guidance:** Secure parsers should cross-check local headers against central directory entries and reject security-relevant mismatches.

### Why Both Headers Exist

For a normal ZIP archive, each file entry usually has both records:

```text
[ Local File Header ] -> immediately before the file's compressed data
[ File Data         ]
[ Data Descriptor   ] -> optional, when general purpose bit 3 is set

...

[ Central Directory File Header ] -> near the end of the archive
[ EOCD / ZIP64 EOCD records     ]
```

The local file header exists so a reader can process file data as it appears in
the byte stream. It contains the filename, compression method, flags, and usually
CRC and sizes unless those are deferred to a data descriptor.

The central directory file header exists as the archive index. Most random-access
ZIP readers list files from the central directory, then use each central entry's
relative local-header offset to seek to the corresponding local file data. The
central entry also carries metadata used for listing and compatibility, such as
file comments, external attributes, timestamps, ZIP64 values, and the local
header offset.

### Extra Fields Are Per Header

ZIP extra fields can appear in both places:

```text
Local File Header extra field
Central Directory extra field
```

They are not automatically shared. If metadata must be visible in both streaming
and indexed contexts, the writer must put the relevant extra field in both
headers. But writers must not blindly copy every extra-field byte sequence
between the two locations: some extra fields have different local-vs-central
payloads.

General guidance:

- Put an extra field in the local header when it is needed to correctly extract
  or interpret the file data while reading the local stream.
- Put an extra field in the central directory when it is needed for listing,
  random access, metadata preservation, or compatibility with normal ZIP
  readers.
- Cross-check fields that are expected to agree, but parse each header's extra
  field according to that header's context.

Timestamp examples:

- Extended Timestamp `0x5455` (`UT`) may contain modification, access, and
  creation times in the local header, while the central-directory copy often
  contains only modification time. JSZipp writes the same compact modification
  time record in both headers when `TimestampMode.Unix` is enabled.
- NTFS extra field `0x000a` can store Windows FILETIME modification, access, and
  creation times. It is commonly written in both headers for compatibility, and
  JSZipp writes it in both headers when `TimestampMode.Ntfs` is enabled.

ZIP64 example:

- ZIP64 extra field `0x0001` stores only the values whose classic 16-bit or
  32-bit header slots are saturated. In a local header, the payload commonly
  contains the 64-bit uncompressed and compressed sizes. In a central directory
  header, it may also contain the relative local-header offset and disk-start
  number, because those fields exist only in the central entry. The field can
  appear in both headers while having different payload lengths.

The safe mental model is that the local header and central directory header are
separate records. Extra fields are scoped to the record that contains them. If a
writer wants metadata visible in both contexts, it must write the appropriate
extra field in both places, while still respecting any local-vs-central layout
rules for that extra field type.

---

## 4. The 1980/2107 DOS Timestamp Boundary Trap

**Metadata involved:** DOS date field, optional timestamp extra fields.

**The issue:** Classic ZIP timestamps inherit the MS-DOS date range. The year field is stored as an offset from 1980.

```text
Earliest classic DOS ZIP date: 1980-01-01
Latest classic DOS ZIP date:   2107-12-31
```

**The trap:** Files older than 1980 or newer than 2107 cannot be represented faithfully in classic ZIP timestamp fields. Writers may clamp, reject, round, or preserve the value only through optional extra fields.

**Practical guidance:** Do not use classic ZIP timestamps as definitive evidence of original creation or modification time.

---

## 5. The Extra Field Compatibility Nightmare

**Metadata involved:** extra fields such as `0x5455`, `0x000a`, ZIP64, `0x7075`, `0x6375`, UID/GID fields, vendor-specific fields.

**The issue:** Extra fields patch ZIP limitations: timestamp precision, UTC timestamps, large sizes, Unicode names, Unix IDs, NTFS metadata, alignment hints, and proprietary metadata.

**The trap:** Support is fragmented. One tool may honor UTC extra fields, another may ignore them and fall back to DOS local time. One tool may preserve permissions; another may discard them.

**Practical guidance:** Test the archive with the exact tools used by producers and consumers. Strip unknown extra fields when publishing archives unless they are intentionally required.

---

## 6. The 2-Second Timestamp Precision Trap

**Metadata involved:** DOS time field.

**The issue:** Classic DOS time stores seconds in 2-second increments.

**The trap:** A file modified at `12:00:01` may become `12:00:00` or `12:00:02`. Build systems and sync tools may mis-detect changes.

**Practical guidance:** Use hashes, not ZIP timestamps, to determine file identity or cache validity.

---

## 7. The Timestamp Multiplicity Trap

**Metadata involved:** DOS modified time, Extended Timestamp `0x5455`, NTFS `0x000a`, platform-specific fields.

**The issue:** A ZIP entry may contain multiple timestamp sources.

**The trap:** Different tools may choose different timestamp sources, causing the same archive to produce different modification, access, or creation times across platforms.

**Practical guidance:** Define which timestamp field is authoritative for the application and ignore the rest unless performing forensic analysis.

---

## 8. The Creation Time Illusion

**Metadata involved:** NTFS extra field `0x000a`, platform-specific timestamp fields.

**The issue:** Classic ZIP metadata primarily stores modification time. Creation time and access time are optional and platform-dependent.

**The trap:** Users may expect ZIP to preserve creation time, but many tools do not write it, many extractors ignore it, and many filesystems do not map it consistently.

**Practical guidance:** Store creation time in a manifest if it matters.

---

## 9. The Filename Encoding Trap

**Metadata involved:** filename field, file comment field, general purpose bit 11, Unicode path extra field `0x7075`, Unicode comment extra field `0x6375`.

**The issue:** Legacy ZIP filenames were historically encoded with IBM Code Page 437 unless UTF-8 is indicated.

**The trap:** Non-ASCII names may become garbled, decode differently, or collide after decoding. Japanese text, accented Latin text, emoji, and decomposed Unicode names are common failure cases.

**Practical guidance:** Prefer UTF-8 filenames with the UTF-8 flag set. Treat filename decoding as security-sensitive.

---

## 10. The UTF-8 Flag vs. Unicode Extra Field Trap

**Metadata involved:** general purpose bit 11, Unicode Path extra field `0x7075`, Unicode Comment extra field `0x6375`.

**The issue:** ZIP can represent Unicode names through the UTF-8 flag or through Unicode extra fields. Unicode extra fields include a CRC-32 of the original primary filename or comment bytes.

**The trap:** If the primary filename changes after archive creation, the Unicode extra field may become stale. A parser that ignores the CRC check may process mismatched metadata.

**Practical guidance:** Verify the embedded CRC in Unicode extra fields. If it does not match the primary name bytes, ignore the Unicode extra field and fall back to the primary header name according to the archive’s encoding rules.

---

## 11. The Path Separator Trap

**Metadata involved:** filename field.

**The issue:** ZIP paths conventionally use `/` as the separator.

**The trap:** Some archives contain Windows-style `\` separators. Some tools treat them as literal characters; others treat them as path separators.

**Practical guidance:** Normalize both `/` and `\` before validating untrusted ZIP paths.

---

## 12. The Zip Slip Path Traversal Trap

**Metadata involved:** filename field, directory entries, symlink entries.

**The issue:** ZIP entries can contain paths such as `../../etc/passwd`.

**The trap:** A naïve extractor may write outside the intended extraction directory.

**Practical guidance:** For every entry, canonicalize the destination path and verify it remains strictly inside the intended extraction root before writing.

---

## 13. The Absolute Path Trap

**Metadata involved:** filename field.

**The issue:** ZIP entries can be crafted to look like absolute paths.

**Examples:**

```text
/etc/passwd
C:\Windows\System32\drivers\etc\hosts
\\server\share\payload
```

**The trap:** A naïve extractor may write to absolute paths rather than the chosen destination directory.

**Practical guidance:** Reject leading slashes, drive letters, UNC paths, and platform-specific absolute path forms.

---

## 14. The Symlink Trap

**Metadata involved:** external file attributes, host OS field, Unix mode bits.

**The issue:** Symlinks are usually represented through host-dependent external attributes.

**The trap:** A ZIP can contain a symlink pointing outside the extraction directory. If later entries write through that symlink, extraction can escape the destination directory.

**Practical guidance:** Reject symlinks in untrusted archives unless they are explicitly required and safely resolved.

---

## 15. The Permissions and Executable-Bit Trap

**Metadata involved:** external file attributes, version-made-by host system.

**The issue:** ZIP permissions are host-dependent and not fully portable.

**The trap:** Executable bits, read-only flags, hidden flags, and Unix modes may be lost, misinterpreted, or unexpectedly applied.

**Practical guidance:** Apply safe permissions explicitly after extraction instead of trusting archive permissions.

---

## 16. The Directory Entry Ambiguity Trap

**Metadata involved:** filename, external attributes, zero-byte entries.

**The issue:** Directories may appear as explicit entries ending in `/`, or may be implied by file paths.

**The trap:** Directory timestamps and permissions may be lost if directories are only implied.

**Practical guidance:** Include explicit directory entries when directory metadata matters, but still validate every directory path.

---

## 17. The Comment Leak Trap

**Metadata involved:** per-file comments, archive comment.

**The issue:** ZIP supports per-file comments and whole-archive comments.

**The trap:** Comments may leak internal project names, usernames, paths, build notes, customer names, or ticket IDs. ZIP comments should not be treated as encrypted secrets.

**Practical guidance:** Strip file comments and archive comments before external sharing.

---

## 18. The File Count and Size Limit Trap

**Metadata involved:** 16-bit entry counts, 32-bit size fields, ZIP64 records and fields.

**The issue:** Original ZIP fields have 4 GiB file-size limits and 65,535-entry count limits. ZIP64 extends these limits.

**The trap:** A ZIP64 archive may work in modern tools but fail in older libraries, firmware updaters, embedded systems, package installers, or runtimes without ZIP64 support.

**Practical guidance:** Avoid ZIP64 when maximum compatibility matters. Require ZIP64 support when handling large artifacts.

---

## 19. The Data Descriptor / Bit 3 Streaming Trap

**Metadata involved:** general purpose bit 3, CRC-32, compressed size, uncompressed size, data descriptor, central directory.

**The issue:** When general purpose bit 3 is set, CRC and sizes may be absent or placeholder values in the local header. The real values appear after compressed data in a data descriptor and in the central directory.

**The trap:** Parsers that expect local-header sizes to be final may reject valid streaming archives. Parsers that blindly trust zero local sizes may miscalculate file boundaries.

**Practical guidance:** Treat bit 3 as a strict streaming mode. If bit 3 is set, parse and validate the data descriptor. If bit 3 is not set, local-header size mismatches are suspicious.

---

## 20. The CRC32 Is Not a Security Hash Trap

**Metadata involved:** CRC-32 field.

**The issue:** ZIP CRC-32 detects accidental corruption.

**The trap:** CRC-32 is not cryptographic authentication. Attackers can modify content and recompute CRC values.

**Practical guidance:** Use cryptographic signatures, authenticated encryption, or external trusted hashes for tamper resistance.

---

## 21. The Compression Method Compatibility Trap

**Metadata involved:** compression method field.

**The issue:** ZIP supports many compression methods beyond Deflate.

**The trap:** A valid ZIP may use BZIP2, LZMA, Zstandard, PPMd, or another method that a target tool does not support.

**Practical guidance:** Use Deflate for broad compatibility unless both writer and reader are controlled.

### Compression Method and General-Purpose Bit Flags

The ZIP local file header and central directory file header both contain two
different 2-byte fields that are easy to confuse:

| Field | Local header offset | Central directory offset | Meaning |
| ----- | ------------------- | ------------------------ | ------- |
| General-purpose bit flags | `0x0006` | `0x0008` | Bitset controlling per-entry options such as encryption, data descriptors, and filename encoding. |
| Compression method | `0x0008` | `0x000a` | Numeric method identifier describing how the entry payload is encoded. |

The repeated `0x0008` values above are offsets, bit masks, or method numbers
depending on context. They are not interchangeable. Always name the field before
interpreting the value.

#### Compression Method Field

The compression method field is a little-endian 16-bit integer. It applies to
one ZIP entry, not necessarily the whole archive. Different entries in the same
archive may use different methods.

Common method values:

| Value | Name | Meaning |
| ----- | ---- | ------- |
| `0x0000` | stored | Entry payload is raw bytes with no compression wrapper. |
| `0x0008` | deflated | Entry payload is a raw DEFLATE stream. |
| `0x0009` | Deflate64 | Entry payload uses Deflate64, not ordinary Deflate. |
| `0x000c` | BZIP2 | Entry payload uses BZIP2. |
| `0x000e` | LZMA | Entry payload uses LZMA. |
| `0x0063` | AES marker | WinZip AES uses method `99`; the real compression method is in AES extra field `0x9901`. |
| `0x005d` | Zstandard | Zstandard in newer ZIP APPNOTE revisions. |

For broad interoperability, the safest profile is usually method `0x0000`
stored or method `0x0008` deflated. ISO/IEC 21320-1 narrows its ZIP profile to
stored and deflated entries.

A method value is a payload-format declaration. If the method is `0x0000`, a
reader returns the entry bytes directly. If the method is `0x0008`, a reader must
inflate the raw DEFLATE stream before returning file bytes. A writer must not
declare method `0x0000` for a payload that is actually a DEFLATE stream.

#### ZIP Stored Entries vs. DEFLATE Stored Blocks

The word "stored" appears at two layers:

| Layer | Marker | Meaning |
| ----- | ------ | ------- |
| ZIP entry | compression method `0x0000` | The entire ZIP entry payload is stored raw. |
| DEFLATE block | DEFLATE block type `00` inside method `0x0008` | One internal DEFLATE block stores bytes uncompressed. |

These are different concepts. A ZIP entry with method `0x0008` may contain one
or more DEFLATE stored blocks, but the entry method must remain `0x0008` because
the payload is still a DEFLATE stream. Declaring it as method `0x0000` would make
readers treat the compressed stream bytes as file bytes.

#### General-Purpose Bit Flags Field

The general-purpose bit flags field is also a little-endian 16-bit integer, but
it is a bitset. Multiple bits may be set at once, and several bits have meanings
that depend on the compression method.

Important bits:

| Bit | Mask | Meaning |
| --- | ---- | ------- |
| 0 | `0x0001` | Entry is encrypted. |
| 1-2 | `0x0002`, `0x0004` | Method-specific options. For Deflate/Deflate64, these historically indicate normal, maximum, fast, or super-fast compression options. |
| 3 | `0x0008` | CRC-32 and sizes are not final in the local header; a data descriptor follows the file data. |
| 6 | `0x0040` | Strong encryption flag in PKWARE extensions. |
| 11 | `0x0800` | Filename and comment bytes are UTF-8. |
| 13 | `0x2000` | Central-directory encryption/local-header masking in related PKWARE extensions. |

For filename decoding, bit 11 is especially important. If `0x0800` is set,
filename and comment bytes are UTF-8. If it is not set, tools commonly fall back
to CP437 or a caller-selected legacy encoding.

For streaming writers, bit 3 is important. When `0x0008` is set in the flags
field, local-header CRC and sizes may be zero or placeholder values; the final
values must be read from the data descriptor and central directory. This is
unrelated to compression method `0x0008`.

#### How to Read Combined Metadata

A diagnostic tool should report method and flags separately and should make clear
whether it is showing one entry or an aggregate across many entries.

Examples:

```text
method: deflated (0x0008)
flags: UTF-8 (0x0800)
```

means one entry, or every aggregated entry, is a DEFLATE ZIP entry and has the
UTF-8 filename/comment flag set.

```text
method: mixed (stored 0x0000: 20 entries; deflated 0x0008: 80 entries)
flags: none (0x0000)
```

means the archive contains both stored and deflated entries, and no reported
entries have general-purpose flag bits set. Avoid displaying this as
`Method 0x0000,0x0008`; that looks like one malformed 2-byte value instead of an
aggregate of multiple valid 2-byte values.

#### Validation Guidance

For strict parsers:

```markdown
- Read method and flags from both local and central headers.
- Cross-check local and central values, especially security-relevant flag bits.
- Reject unsupported compression methods.
- Treat method `0x0000` as raw stored bytes.
- Treat method `0x0008` as raw DEFLATE and inflate it before returning content.
- Treat flags bit `0x0008` as data-descriptor mode, not as a compression method.
- Decode filenames as UTF-8 when flags bit `0x0800` is set.
- Preserve the distinction between one entry's 2-byte value and an aggregate set
  of values across an archive.
```

---

## 22. The AES / Strong Encryption Compatibility Trap

**Metadata involved:** encryption flag, method `99`, AES extra field `0x9901`, strong encryption headers.

**The issue:** AES encryption in ZIP is an extension, distinct from legacy ZipCrypto.

**The trap:** Some recipients may only support ZipCrypto. Others support AES file encryption but not central directory encryption.

**Practical guidance:** Specify and test the exact encryption method, not just “password-protected ZIP.”

---

## 23. The Central Directory Encryption Trap

**Metadata involved:** encrypted central directory, local header masking, ZIP64 records, EOCD, archive comment.

**The issue:** Central directory encryption can hide more metadata than ordinary encrypted ZIPs, but it is less universally supported.

**The trap:** Some structural metadata and archive comments may remain visible. Many tools may not support the feature.

**Practical guidance:** For strong confidentiality, encrypt the whole ZIP as a blob using a separate authenticated encryption layer.

---

## 24. The Archive Comment Search Trap

**Metadata involved:** EOCD record, ZIP comment.

**The issue:** ZIP readers often scan backward from the end of the file to locate the End of Central Directory record.

**The trap:** Long comments, appended data, embedded ZIPs, or self-extracting stubs can confuse simplistic parsers.

**Practical guidance:** Use a real ZIP parser. Do not rely on fixed offsets or simple signature scanning.

---

## 25. The Self-Extracting ZIP Trap

**Metadata involved:** prepended executable stub, ZIP records later in the file.

**The issue:** ZIP archives can be embedded inside executable self-extracting files.

**The trap:** A file may be both an executable and a ZIP. Security tools may disagree about its type.

**Practical guidance:** Validate internal ZIP structure and file policy, not just extension or first bytes.

---

## 26. The Extension Does Not Mean ZIP Trap

**Metadata involved:** ZIP signatures and container records.

**The issue:** Many formats are ZIP-based: `.jar`, `.war`, `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, `.epub`, `.vsix`, `.xpi`, and others.

**The trap:** Security checks that only inspect `.zip` files may miss ZIP-based packages. Conversely, a `.zip` extension does not guarantee a safe or valid archive.

**Practical guidance:** Detect ZIP structure by container records and apply ZIP safety checks to ZIP-based formats.

---

## 27. The Duplicate Filename Trap

**Metadata involved:** central directory entries, filenames.

**The issue:** A ZIP archive can contain multiple entries with the same filename.

**The trap:** Some tools show the first entry; others extract the last; others expose both. This can bypass validation or package-signature assumptions.

**Practical guidance:** Reject duplicate normalized paths when writing or accepting package-like archives. If you read legacy archives, expose duplicates explicitly and do not assume external extractors pick the same winner.

---

## 28. The Case Sensitivity Trap

**Metadata involved:** filename field.

**The issue:** ZIP filenames are case-preserving, but target filesystems vary.

**The trap:** `Readme.txt` and `README.TXT` are distinct on many Unix filesystems but collide on typical Windows and default macOS filesystems.

**Practical guidance:** Detect collisions using the target platform’s case-sensitivity rules.

---

## 29. The Unicode Normalization Trap

**Metadata involved:** filename field, UTF-8 flag, Unicode path extra field.

**The issue:** Unicode filenames can be visually identical but byte-distinct.

**The trap:** Composed and decomposed Unicode names can collide, bypass filters, or extract differently across platforms.

**Practical guidance:** Normalize Unicode before policy checks and detect collisions after normalization.

---

## 30. The Hidden Metadata in Extra Fields Trap

**Metadata involved:** extra fields.

**The issue:** Extra fields can store UID/GID, ACLs, NTFS timestamps, Unicode paths, alignment data, application metadata, and proprietary fields.

**The trap:** A ZIP may leak metadata that is invisible in ordinary file listings.

**Practical guidance:** Strip unknown or unnecessary extra fields before external release.

---

## 31. The Host-Dependent External Attributes Trap

**Metadata involved:** version-made-by field, external file attributes.

**The issue:** External attributes are interpreted according to the originating host system.

**The trap:** The same bytes can mean different things depending on whether the archive was made on DOS, Unix, NTFS, macOS, or another system.

**Practical guidance:** Interpret external attributes together with the host OS field.

---

## 32. The Archive Order Trap

**Metadata involved:** local header order, central directory order.

**The issue:** ZIP entries may appear in arbitrary order.

**The trap:** Generic ZIP tools may reorder entries and break application-specific ZIP profiles that expect special ordering.

**Practical guidance:** Follow the higher-level package specification, not just generic ZIP validity.

---

## 33. The Manifest Trap

**Metadata involved:** ordinary file entries used as application metadata.

**The issue:** ZIP-based package formats often define manifests inside the archive.

**The trap:** Duplicate manifests, case variants, Unicode variants, or path tricks can make one tool validate a different manifest than another tool loads.

**Practical guidance:** Validate both the ZIP container and the application-level manifest rules.

---

## 34. The Split / Spanned Archive Trap

**Metadata involved:** disk number fields, ZIP64 locator, EOCD records.

**The issue:** ZIP supports split and spanned archives.

**The trap:** A single segment may appear corrupt or incomplete. Tools without split-archive support may misread metadata.

**Practical guidance:** Avoid split archives in automated pipelines unless all consumers support them.

---

## 35. The Appended ZIP Trap

**Metadata involved:** ZIP records embedded after leading bytes.

**The issue:** ZIP readers often tolerate leading data.

**The trap:** A file can contain one format at the beginning and a ZIP archive later. Different tools may classify the same file differently.

**Practical guidance:** Decide whether embedded or appended ZIP content is allowed. In strict modes, reject unexpected leading data.

---

## 36. The File Size Bomb Trap

**Metadata involved:** compressed size, uncompressed size, compression method, ZIP64 fields.

**The issue:** A small ZIP can expand into enormous output.

**The trap:** Extraction can exhaust disk, memory, CPU, inode counts, or scanning budgets.

**Practical guidance:** Enforce maximum total uncompressed size, single-file size, entry count, path depth, compression ratio, and extraction time.

---

## 37. The Nested ZIP Trap

**Metadata involved:** ordinary file entries whose contents are ZIPs.

**The issue:** ZIP files can contain other ZIP files.

**The trap:** Nested archives can multiply decompression cost or hide dangerous payloads from shallow scanners.

**Practical guidance:** Limit recursive archive depth and cumulative extracted size.

---

## 38. The Empty Archive Trap

**Metadata involved:** EOCD record.

**The issue:** A ZIP containing only an EOCD record can be a valid empty archive.

**The trap:** Some systems treat empty ZIPs as valid; others treat them as broken or suspicious.

**Practical guidance:** Handle empty archives explicitly.

---

## 39. The Directory Has No File Data Trap

**Metadata involved:** local header, central directory, zero-byte entries.

**The issue:** Directory entries normally contain no file data.

**The trap:** Odd directory entries can confuse extractors, especially when combined with path traversal, symlinks, or duplicate names.

**Practical guidance:** Treat entries ending in `/` as directories, but still validate their paths.

---

## 40. The Metadata Encoding Override Trap

**Metadata involved:** filename/comment encoding, UTF-8 flag, decoding override settings.

**The issue:** Some libraries allow metadata encoding overrides for legacy archives.

**The trap:** Encoding flags inside the archive may override caller-supplied decoding assumptions.

**Practical guidance:** Record both raw filename bytes and decoded filenames in ingestion pipelines. Validate the decoded form.

---

## 41. The Archive Listing Is Not Extraction Trap

**Metadata involved:** central directory, local headers, data descriptors.

**The issue:** Listing commonly reads the central directory. Extraction may use local headers and streamed data.

**The trap:** An archive may list cleanly but fail or behave differently during extraction.

**Practical guidance:** Perform full structural validation, not just listing.

---

## 42. The Valid ZIP, Invalid Application Package Trap

**Metadata involved:** ZIP container metadata plus application-specific metadata.

**The issue:** OOXML, ODF, EPUB, JAR, APK-like formats, VSIX, XPI, and other formats are ZIP-based but have extra rules.

**The trap:** A ZIP can be structurally valid while violating the package format’s required filenames, order, compression methods, encryption restrictions, or manifest rules.

**Practical guidance:** Validate against the package profile.

---

## 43. The Encryption-Method Confusion Trap

**Metadata involved:** general purpose bit 0, compression method, AES field, strong encryption headers.

**The issue:** “Encrypted ZIP” can mean ZipCrypto, AES, strong encryption, central directory encryption, or a tool-specific variant.

**The trap:** Users may assume all password ZIPs provide equivalent security.

**Practical guidance:** Name the encryption method explicitly and test recipient compatibility.

---

## 44. The File Name Masking Trap

**Metadata involved:** local header masking, central directory encryption, general purpose bit 13.

**The issue:** With central directory encryption, local header fields may be masked.

**The trap:** A parser expecting real filenames in local headers may see placeholder values instead.

**Practical guidance:** Implement central directory encryption masking rules correctly or reject such archives.

---

## 45. The ZIP Comment Is Never a Secret Trap

**Metadata involved:** archive comment.

**The issue:** ZIP comments may remain visible even when file data is encrypted.

**The trap:** Sensitive notes in comments can leak.

**Practical guidance:** Never place secrets in ZIP comments.

---

## 46. The Untrusted Library Trap

**Metadata involved:** all ZIP metadata fields.

**The issue:** Many libraries expose raw ZIP entries and leave safe extraction to callers.

**The trap:** “Using a library” does not automatically prevent Zip Slip, symlink escapes, bombs, duplicate names, or parser confusion.

**Practical guidance:** Wrap library extraction with path, symlink, size, count, collision, and structural checks.

---

## 47. The Magic Number Only Trap

**Metadata involved:** local file header signature, central directory signature, EOCD signature.

**The issue:** ZIP records have signatures, but ZIP structure is more than one magic number.

**The trap:** Checking only the first four bytes misses empty ZIPs, self-extracting ZIPs, appended ZIPs, malformed ZIPs, and polyglots.

**Practical guidance:** Validate the full ZIP structure.

---

## 48. The Metadata Preservation Trap

**Metadata involved:** timestamps, permissions, comments, extra fields, external attributes, encoding flags.

**The issue:** Re-zipping can alter metadata while preserving file contents.

**The trap:** Timestamps, permissions, extra fields, comments, compression methods, order, and ZIP64 usage may change.

**Practical guidance:** Use deterministic ZIP creation settings for reproducible archives.

---

## 49. The Forensic Attribution Trap

**Metadata involved:** timestamps, host OS, external attributes, comments, extra fields.

**The issue:** ZIP metadata can reveal useful clues but is easy to forge.

**The trap:** Investigators may over-trust timestamps, host OS, or comments as proof of origin.

**Practical guidance:** Treat ZIP metadata as evidence, not proof. Correlate with logs, hashes, signatures, and filesystem metadata.

---

## 50. The One ZIP Spec, Many Real ZIPs Trap

**Metadata involved:** all fields.

**The issue:** ZIP has accumulated ZIP64, strong encryption, central directory encryption, Unicode flags, extra fields, compression methods, streaming descriptors, comments, split archives, and package-specific profiles.

**The trap:** “Supports ZIP” is not precise.

**Practical guidance:** Ask which features are supported: Deflate, ZIP64, AES, central directory encryption, Unicode, symlinks, external attributes, split archives, data descriptors, and strict validation.

---

## 51. The Local Header Size Obfuscation Trap

**Metadata involved:** local file header compressed size, local file header uncompressed size, central directory sizes, CRC-32, file data boundaries.

**The issue:** A legitimate streaming archive uses bit 3 and a data descriptor. A malicious archive can instead leave bit 3 clear while making local header sizes and central directory sizes disagree.

**The trap:** A sequential scanner that trusts local header sizes may skip over payload bytes or mis-locate the next entry. A normal extractor that trusts the central directory may extract a different byte range.

**Practical guidance:**

```markdown
- If bit 3 is clear, require local size, central size, and actual consumed data length to agree.
- If ZIP64 is involved, validate both classic placeholder values and ZIP64 extra field values.
- Reject entries whose computed byte ranges do not match declared metadata.
- Do not let local-header scanning substitute for central-directory validation.
- Do not let central-directory validation substitute for local-header boundary validation.
```

---

## 52. The Prepended Polyglot / Signature Scanning Trap

**Metadata involved:** file magic bytes, local header signatures, central directory offset, EOCD record, prepended data.

**The issue:** ZIP readers commonly locate archives by scanning backward from the end to find the EOCD record.

**The trap:** A file can begin as a valid PNG, PDF, MP4, or executable while also containing a valid ZIP archive later. Header-only filters may see a harmless outer type and miss the ZIP payload.

**Example:**

```text
[ PNG/PDF/EXE header and body ]
[ ZIP local file headers       ]
[ ZIP compressed data          ]
[ ZIP central directory        ]
[ ZIP EOCD                     ]
```

**Practical guidance:**

```markdown
- Do not identify ZIP files using only the first four bytes.
- Do not identify non-ZIP files using only leading magic bytes if embedded ZIP content matters.
- Decide whether prepended data, appended data, and polyglots are allowed.
- For strict package formats, reject unexpected leading or trailing data.
- For security scanners, scan both the declared outer file type and embedded ZIP structures.
```

---

## 53. The Overlapping / Reused Local Header Offset Trap

**Metadata involved:** central directory relative offset of local header, compressed size, uncompressed size, local header length, extra field length, file name length, data descriptor.

**The issue:** The central directory points to each local file header by byte offset.

**The trap:** Multiple entries can point to the same local header, overlapping byte ranges, or ranges crossing into another entry. Different parsers may deduplicate, extract both, crash, loop, or verify one byte range while extracting another.

**Practical guidance:**

```markdown
- Build a byte-range map for every entry.
- Reject overlapping local header ranges, compressed data ranges, data descriptor ranges, and central directory ranges.
- Reject multiple central directory entries pointing to the same local header offset.
- Reject offsets that point outside the archive, into the central directory, into the EOCD, or into another entry’s data.
- Validate entry ranges even when entries are not physically sorted.
```

---

## 54. The Parser Semantic Gap Trap

**Metadata involved:** local headers, central directory, EOCD, ZIP64 records, extra fields, path names, comments, sizes, CRCs, offsets, compression methods.

**The issue:** ZIP parsers do not always interpret malformed or ambiguous archives the same way.

**The trap:** One parser may see a harmless archive while another parser extracts a malicious file tree.

**Attack pattern:**

```text
Security scanner parser: sees harmless entry
Application parser:      extracts malicious entry
Package verifier:        verifies one file tree
Runtime loader:          loads a different file tree
```

**Practical guidance:**

```markdown
- Use the same parser for validation and extraction whenever possible.
- Reject ambiguous ZIPs instead of repairing them.
- Reject mismatched local and central filenames.
- Reject duplicate normalized paths.
- Reject multiple EOCD records in strict mode.
- Reject trailing data for strict package formats.
- Treat parser differentials as a supply-chain security risk.
```

---

## 55. The Security Scanner vs. Extractor Disagreement Trap

**Metadata involved:** local header sizes, central directory sizes, entry offsets, duplicated filenames, recovery behavior.

**The issue:** Security scanners, package registries, CI systems, mail gateways, and endpoint tools may use different ZIP parsers than the final application.

**The trap:** A crafted ZIP may make the scanner see one file tree and the target extractor see another.

**Practical guidance:**

```markdown
- Require strict ZIP conformance before scanning.
- Scan the exact extracted file tree that the target extractor will use.
- Reject malformed archives instead of accepting parser recovery.
- For package ecosystems, define and enforce a strict ZIP profile at upload time.
```

---

# Strict ZIP Validation Profile

Use strict validation when ZIP input crosses a trust boundary: uploads, email attachments, CI/CD artifacts, software packages, document packages, plugin bundles, mobile packages, or archives later executed, rendered, indexed, or unpacked.

Reject the archive if any of these are true:

```markdown
- It has more than one EOCD record.
- The EOCD points outside the file.
- The central directory overlaps local file data unexpectedly.
- Any central directory entry points outside the file.
- Any central directory entry points into another entry’s data.
- Two entries point to the same local header offset.
- Two entries produce the same normalized destination path.
- Local header filename and central directory filename disagree.
- Local header flags and central directory flags disagree in security-relevant ways.
- Declared compressed or uncompressed sizes disagree outside the valid bit-3/data-descriptor case.
- ZIP64 placeholders and ZIP64 extra field values disagree.
- The archive contains absolute paths, drive letters, UNC paths, or path traversal.
- The archive contains symlinks unless explicitly allowed and safely resolved.
- The archive contains unsupported compression methods.
- The archive contains encrypted entries when encryption is not expected.
- The archive contains comments or unknown extra fields when using a strict package profile.
- The archive contains trailing or prepended data when using a strict package profile.
- The archive exceeds entry count, path depth, filename length, total uncompressed size, single-file size, or compression-ratio limits.
```

---

# Minimum Safe Extraction Blueprint

For every ZIP archive:

```markdown
1. Locate and validate the EOCD.
2. If ZIP64 is present, validate the ZIP64 EOCD record and locator.
3. Parse the central directory.
4. For every central directory entry, locate the referenced local file header.
5. Cross-check local header and central directory metadata.
6. If bit 3 is set, parse and validate the data descriptor.
7. If bit 3 is not set, require local sizes, central sizes, and actual data boundaries to agree.
8. Decode filenames according to the UTF-8 flag, legacy encoding rules, and Unicode extra field CRC checks.
9. Normalize Unicode, path separators, and platform-specific path forms.
10. Reject absolute paths, drive letters, UNC paths, empty unsafe names, reserved device names, and `..`.
11. Join the entry path with the destination directory.
12. Canonicalize the destination path.
13. Confirm the result is strictly a child of the destination directory.
14. Verify the destination path does not overwrite a pre-existing symlink or escape through a created symlink.
15. Reject duplicate normalized destination paths.
16. Build a byte-range map for every local header, file data segment, data descriptor, central directory entry, and EOCD structure.
17. Reject overlapping, reused, out-of-bounds, or structurally impossible byte ranges.
18. Enforce global and per-entry limits: count, depth, filename length, compressed size, uncompressed size, compression ratio, and total extracted bytes.
19. Extract using the same parser and metadata interpretation used during validation.
20. Verify calculated CRC-32 and actual output size after extraction.
21. Apply safe permissions explicitly rather than trusting archive permissions.
22. Preserve or discard timestamps according to an explicit policy.
```

---

# Reproducible ZIP Creation Profile

For deterministic builds and stable archive hashes:

```markdown
1. Sort entries by normalized path.
2. Use UTF-8 filenames and set the UTF-8 flag.
3. Avoid comments.
4. Strip unknown extra fields unless required.
5. Strip platform-specific UID/GID, ACL, NTFS, and Finder metadata unless required.
6. Use fixed timestamps.
7. Use fixed permissions.
8. Use a fixed compression method and compression level.
9. Avoid ZIP64 unless required.
10. Avoid data descriptors unless streaming is necessary.
11. Avoid duplicate paths after Unicode and case normalization.
12. Avoid symlinks unless the package format explicitly requires them.
13. Verify the final archive with a strict parser.
```

---

# Security Note on ZIP Encryption

Password-protected ZIP is not automatically metadata-private. Ordinary encrypted ZIPs may still expose filenames, paths, sizes, timestamps, comments, and directory structure.

Prefer:

```markdown
- A ZIP inside an authenticated encrypted container.
- An encrypted archive format with header encryption.
- A modern external encryption tool such as age, GPG, or an enterprise-approved equivalent.
```

Avoid:

```markdown
- Assuming AES-encrypted ZIP hides filenames.
- Placing secrets in ZIP comments.
- Depending on central directory encryption unless all recipients and tools support it.
```

---

# Quick Checklist for ZIP Consumers

```markdown
- Treat every entry name as untrusted input.
- Normalize `/`, `\`, Unicode, drive letters, and absolute paths.
- Reject path traversal and absolute paths.
- Reject or safely handle symlinks.
- Detect duplicate normalized paths.
- Enforce size, count, depth, and compression-ratio limits.
- Cross-check local headers against the central directory.
- Treat bit 3/data-descriptor archives as a special validated streaming mode.
- Build and check byte ranges for overlap, reuse, and out-of-bounds offsets.
- Verify CRC and final output size after extraction.
- Strip or ignore suspicious extra fields unless needed.
- Reject multiple EOCD records in strict mode.
- Reject unexpected prepended or trailing data in strict package formats.
- Scan the exact file tree that the final extractor will produce.
- Use the same parser for validation and extraction whenever possible.
- Treat parser differentials as a security risk, not just a compatibility problem.
- Validate application-level package rules for ZIP-based formats.
```

---

# Quick Checklist for ZIP Producers

```markdown
- Use UTF-8 filenames and set the UTF-8 flag.
- Normalize timestamps if reproducibility matters.
- Avoid comments and unnecessary extra fields.
- Use Deflate for compatibility.
- Avoid ZIP64 unless required.
- Do not assume password ZIP hides metadata.
- Set permissions explicitly and predictably.
- Avoid duplicate or case-colliding filenames.
- Avoid ambiguous Unicode names.
- Avoid split archives for automated pipelines.
- Test with the same tools used by recipients.
```

---

# Bottom Line

ZIP is safe only when treated as a structured, ambiguous, legacy container rather than a simple compressed folder. Robust handling requires strict path validation, metadata cross-checking, byte-range validation, parser consistency, size limits, duplicate detection, and explicit policy decisions about timestamps, permissions, comments, symlinks, encryption, extra fields, and ZIP-based package profiles.

Sources checked: PKWARE’s APPNOTE and related ZIP format references for structure and metadata behavior, ISO/IEC 21320-1 for the stored/deflated interoperability profile, Apache Commons Compress references for general-purpose bit handling, Python’s `zipfile` docs for timestamp boundaries and metadata handling, Android’s Zip Path Traversal guidance for extraction safety, and USENIX Security 2025 research for parser semantic gaps.
