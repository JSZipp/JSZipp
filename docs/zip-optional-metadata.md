# ZIP Optional Metadata: What Adds Bytes and What Does Not

This document separates ZIP metadata into two categories:

1. **Optional metadata/settings that do not make the ZIP larger**, because the ZIP format already has a fixed-size field or bit reserved for them.
2. **Optional metadata/settings that do make the ZIP larger**, because they require variable-length fields, extra-field records, comments, descriptors, encryption headers, or other additional records.

A key distinction:

* Setting a value inside an already-existing fixed field does **not** increase the archive size.
* Adding an extra field, comment, data descriptor, encryption header, or archive-level extension **does** increase the archive size.
* Extra fields cost at least **4 bytes each**: 2 bytes for the Header ID and 2 bytes for the data length, plus the actual data.
* If the same extra field is written in both the local file header and the central directory header, that overhead is paid twice.

This is about ZIP container size, not about whether the compressed file data itself becomes larger.

---

# Optional Settings That Usually Do Not Make the ZIP Larger

These settings are optional in the sense that a compressor can choose how much metadata to preserve, but they live in fields that already exist in the normal ZIP header layout. Setting them to a meaningful value rather than zero usually does not add bytes.

## `ExternalAttributes`

`ExternalAttributes` is a 4-byte field in the central directory file header.

It is commonly used to store host-platform file attributes. On Unix-like systems, ZIP tools often encode permissions and file type bits here, such as executable permission, regular file, directory, or symlink mode information. On DOS/Windows-style archives, it can store DOS attributes such as read-only, hidden, system, archive, and directory.

It does **not** make the ZIP larger because the 4-byte field is already present in every central directory entry.

It is optional for basic decompression. A ZIP reader can extract the file data without understanding or applying these attributes. However, it is important for restoring permissions, executable bits, directory flags, symlink-ish metadata conventions, and platform-specific behavior.

Commonly set: yes. Many ZIP writers set some form of external attributes, especially for directories and Unix permission bits. 7-Zip, Info-ZIP, Python `zipfile`, Java libraries, and many other tools may set this depending on platform and API usage.

Practical note: if you want Unix executable permissions to survive extraction, this is usually the field you care about, not an extra field.

---

## `InternalAttributes`

`InternalAttributes` is a 2-byte field in the central directory file header.

It is historically used for internal file attributes, especially whether a file is apparently text or binary. In modern ZIP usage, it is usually not very important.

It does **not** make the ZIP larger because the 2-byte field already exists.

It is not needed for decompression. Most modern tools ignore it or set it to zero.

Commonly set: not very meaningfully. It may exist as zero in most archives.

---

## `VersionMadeBy`

`VersionMadeBy` is a 2-byte field in the central directory header.

The upper byte identifies the host system that created the entry, such as MS-DOS/FAT, Unix, NTFS, OS X/Darwin, and so on. The lower byte identifies the ZIP specification version supported by the creating software.

It does **not** make the ZIP larger because the field already exists.

It matters because some other fields depend on it. For example, `ExternalAttributes` should be interpreted differently depending on the host system encoded here. Unix permission bits in `ExternalAttributes` only make sense when the host system indicates a Unix-like origin.

Commonly set: yes. ZIP writers usually set it automatically.

---

## `VersionNeededToExtract`

`VersionNeededToExtract` is a 2-byte field present in both local file headers and central directory headers.

It tells readers the minimum ZIP feature level needed to extract the file. For example, ordinary stored or deflated files need a low version, while ZIP64, BZIP2, AES/strong encryption, or newer compression methods require higher versions.

It does **not** make the ZIP larger because the field already exists.

It is not metadata for the user, but it is important compatibility metadata for tools. Incorrect values can confuse older readers.

Commonly set: always set by writers, but often just to a default value such as 2.0 for ordinary deflate.

---

## `GeneralPurposeBitFlag`

The general purpose bit flag is a 2-byte field in both local and central headers.

Some bits describe how the file should be interpreted. Setting the bit field itself does **not** add bytes because the field is fixed-size.

Important examples:

* Bit 0: file is encrypted.
* Bit 3: CRC and sizes are not known in the local header and will appear later in a data descriptor.
* Bit 11: filename and comment are UTF-8.
* Bit 13: local header metadata is masked when central directory encryption is used.

The bit field itself does not enlarge the ZIP, but some bits imply that other records are present. For example, bit 3 normally implies a data descriptor after the file data, and encryption implies encryption headers or extra metadata.

Commonly set: yes. Bit 11 is common for UTF-8 names. Bit 3 is common in streaming ZIP writers. Bit 0 appears in encrypted archives.

---

## UTF-8 Filename/Comment Flag: General Purpose Bit 11

Bit 11 of the general purpose bit flag indicates that the filename and comment are encoded in UTF-8.

This does **not** make the ZIP larger because it is just one bit in an existing field.

It is useful because it avoids needing separate Unicode path/comment extra fields in many modern ZIPs.

It is needed when filenames or comments are UTF-8 and the reader needs to know that. Without it, some readers may interpret names using legacy encodings.

Commonly set: yes in modern ZIP software when UTF-8 filenames are used.

Practical note: using bit 11 is usually smaller than storing both a legacy filename and a Unicode Path extra field.

---

## DOS Last Modification Time and Date

Every normal ZIP entry has fixed fields for last modification time and last modification date in MS-DOS format.

These do **not** make the ZIP larger because they are part of the base local and central headers.

They are enough for basic ZIP timestamp preservation, but they have limitations:

* Only modification time is stored.
* Precision is only 2 seconds.
* Date range is limited.
* No creation time or access time is represented.
* No timezone is explicitly stored.

Commonly set: yes. Almost all ZIP writers set the DOS modification timestamp.

7-Zip practical note: for ZIP creation, 7-Zip normally stores the DOS timestamp. Higher-resolution NTFS timestamps require explicit timestamp options or other tool behavior.

---

## Compression Method

The compression method is a 2-byte fixed field in both local and central headers.

Choosing `Store`, `Deflate`, `BZIP2`, `LZMA`, `Zstandard`, or another method does not itself add metadata bytes, because the method field already exists.

However, the chosen compression method obviously affects compressed data size. That is different from metadata overhead.

Commonly set: always. Ordinary ZIPs commonly use method 8, Deflate. Stored files use method 0.

---

## Compression Level Hints in General Purpose Bits

For some older methods, especially Deflate, bits 1 and 2 of the general purpose bit flag can indicate compression speed/level hints such as normal, maximum, fast, or super fast.

These bits do **not** make the ZIP larger.

They are not required for decompression in the ordinary sense. A Deflate stream is self-contained enough for the decompressor.

Commonly meaningful: not very. Many tools do not rely on these hints.

---

## CRC-32

CRC-32 is a fixed 4-byte field in local and central headers.

It does not make the ZIP larger because the field already exists.

It is not optional for normal ZIP integrity checking. Even if a writer does not know it at the time it writes the local header, the CRC must be supplied later in the central directory and often in a data descriptor.

Commonly set: yes, always for normal entries.

---

## Compressed Size and Uncompressed Size

The classic ZIP fields for compressed size and uncompressed size are fixed 4-byte fields in local and central headers.

Using them does not make the ZIP larger because the fields already exist.

However, if the values do not fit in 32 bits, ZIP64 extra fields are needed, and those do add bytes.

Commonly set: yes. For ordinary non-streamed, non-ZIP64 files, these fields carry the actual sizes.

---

## Disk Number Start

The central directory has a fixed field for the disk number on which a file starts.

It does not make the ZIP larger because the field already exists.

It is only relevant for split or spanned ZIP archives. Most modern single-file ZIP archives set it to zero.

Commonly set meaningfully: no, unless using split/spanned ZIP.

---

## Relative Offset of Local Header

The central directory stores the offset of the corresponding local file header.

It does not make the ZIP larger because the field already exists.

It is required for normal random access to ZIP entries.

If the offset exceeds 32-bit range, ZIP64 metadata is needed, and that does add bytes.

Commonly set: yes, always.

---

## Directory Entries Using Existing Attributes

A directory can be represented by a central-directory entry whose filename ends in `/`, often with directory attributes in `ExternalAttributes`.

The directory attribute itself does not add metadata bytes if stored in the existing external attributes field.

However, explicitly adding directory entries can make the ZIP larger because each directory entry is itself an additional ZIP member with its own local header and central directory header. That is separate from the attribute field.

Commonly used: yes. Many ZIP writers include explicit directory entries, but some omit them and rely on paths in filenames.

---

# Optional Settings and Metadata That Make the ZIP Larger

These features add bytes because they require variable-length fields, extra fields, descriptors, comments, encryption headers, or extra archive records.

---

## File Name

The filename is variable-length and is stored in both the local file header and the central directory header.

It always contributes bytes to the ZIP because the name itself is stored. This is required for useful archives, but its exact length affects archive size.

Why it is present: to identify the path/name of the entry.

Why it is needed: practically required, although the specification has edge cases such as standard input.

Commonly set: always.

Size impact: filename byte length appears at least once in the local header and once in the central directory header. Long paths increase ZIP size.

---

## Per-File Comment

The per-file comment is a variable-length field in the central directory header.

It makes the ZIP larger by the number of comment bytes. The fixed field that stores the comment length already exists, but the comment data itself is additional.

Why it is present: to attach human-readable or application-specific notes to a single entry.

Why it is needed: almost never needed for decompression.

Commonly set: uncommon in modern general-purpose ZIPs.

Size impact: adds exactly the encoded comment length for each entry that has a comment.

---

## Archive Comment

The archive comment is a variable-length field at the end of the ZIP, in the End of Central Directory record.

It makes the ZIP larger by the number of comment bytes.

Why it is present: to attach a comment to the whole archive.

Why it is needed: not needed for decompression.

Commonly set: uncommon.

Security note: archive comments are generally not encrypted or authenticated in ordinary ZIP usage, so they should not contain secrets.

---

## Data Descriptor

A data descriptor is an optional record after the compressed file data.

It makes the ZIP larger.

Why it is present: it allows a writer to stream a ZIP entry before knowing the CRC-32, compressed size, or uncompressed size. This is useful when writing to a pipe, socket, HTTP response, or any non-seekable output.

Why it is needed: not needed when the writer can seek backward and fill in the local header after compression. Needed or very useful for streaming writers.

Commonly set: common in streaming ZIP creation. Some libraries use it routinely.

Typical size impact:

* Classic descriptor without signature: 12 bytes.
* Classic descriptor with signature: 16 bytes.
* ZIP64 descriptor without signature: 20 bytes.
* ZIP64 descriptor with signature: 24 bytes.

There is no extra-field code because it is a separate record, not an extra field.

---

## ZIP64 Extended Information Extra Field — `0x0001`

`0x0001` is the ZIP64 Extended Information Extra Field.

It makes the ZIP larger.

Why it is present: classic ZIP fields are too small for files, offsets, or entry counts beyond old ZIP limits. ZIP64 stores 64-bit sizes and offsets.

Why it is needed: required when a file size, compressed size, local-header offset, or disk-start value cannot fit in the classic 16-bit or 32-bit fields.

Commonly set: yes, but usually only when needed. Some tools may also create ZIP64 proactively depending on options or when streaming unknown sizes.

Size impact: at least 4 bytes for the extra-field wrapper, plus 8-byte or 4-byte values depending on which classic field overflowed. It may be present in the local header, central directory, or both.

Practical note: avoid adding ZIP64 for small archives unless your writer requires it, because it can reduce compatibility with very old tools and adds unnecessary metadata.

---

## ZIP64 End of Central Directory Record and Locator

These are archive-level ZIP64 records, not per-file extra fields.

They make the ZIP larger.

Why they are present: they extend archive-level central directory size, offset, disk numbers, and total entry counts beyond classic ZIP limits.

Why they are needed: required when archive-level values exceed classic limits, such as more than 65,535 entries or a central directory offset beyond 4 GiB.

Commonly set: only for large archives, or by writers configured to force ZIP64.

Size impact: the ZIP64 End of Central Directory record is at least 56 bytes, and the ZIP64 locator is 20 bytes, before any extensible data.

---

## NTFS Extra Field — `0x000A`

`0x000A` is the NTFS extra field.

It makes the ZIP larger.

Why it is present: the base ZIP timestamp stores only MS-DOS modification time with 2-second precision. The NTFS extra field can store higher-resolution Windows file times: modification time, access time, and creation time.

Why it is needed: needed if you want to preserve Windows high-resolution timestamps, especially creation time and access time.

Commonly set: sometimes. Windows-oriented tools may preserve it. 7-Zip can write NTFS timestamp metadata when timestamp options are used, but ordinary ZIPs often contain only the DOS modification timestamp.

Size impact: the common NTFS timestamp block is roughly 32 bytes of extra-field payload structure including its reserved and subfield data, plus the 4-byte extra-field wrapper. If written in both local and central headers, the cost is paid twice.

Practical note: this field is useful for Windows fidelity but unnecessary for basic extraction.

---

## Extended Timestamp Extra Field — `0x5455`

`0x5455` is the extended timestamp extra field, often associated with Info-ZIP and commonly called `UT`.

It makes the ZIP larger.

Why it is present: it stores Unix-style timestamps, usually modification time and optionally access and creation times, with 1-second precision and UTC semantics.

Why it is needed: useful when the DOS timestamp is insufficient or when timezone-safe modification times matter.

Commonly set: common in Unix/Linux ZIP tooling, especially Info-ZIP style tools. Not all tools write it. 7-Zip ZIP creation has historically favored DOS timestamps by default and NTFS timestamps when requested rather than Unix `UT` timestamps.

Size impact: at least 5 bytes including flags and one timestamp payload, plus the 4-byte extra-field wrapper. More timestamps add more bytes.

Practical note: this is often the most compact common way to preserve Unix modification time more accurately than the DOS timestamp.

---

## PKWARE Unix Extra Field — `0x000D`

`0x000D` is the PKWARE Unix extra field.

It makes the ZIP larger.

Why it is present: it can store Unix access time, modification time, UID, GID, and variable file-type-specific data such as link targets or device numbers.

Why it is needed: useful for preserving Unix metadata beyond what the base ZIP fields can store.

Commonly set: not as common in modern general-purpose ZIPs as `0x5455` and Info-ZIP Unix fields. Unix permissions are often stored in `ExternalAttributes` instead.

Size impact: at least the 4-byte wrapper plus its fixed timestamp/UID/GID data, and possibly variable-length link or device metadata.

Practical note: for ordinary Unix permissions, prefer `ExternalAttributes`; for UID/GID or link/device metadata, extra fields may be needed.

---

## Info-ZIP Old Unix Extra Field — `0x5855`

`0x5855` is the old Info-ZIP Unix extra field.

It makes the ZIP larger.

Why it is present: it stores access time, modification time, and optionally UID/GID information.

Why it is needed: legacy Unix metadata preservation.

Commonly set: obsolete. Readers may still support it, but modern writers generally should not create it for new entries.

Size impact: variable, depending on whether UID/GID is included and whether it appears in local and/or central headers.

Practical note: if both old and newer Unix extra fields are present, newer fields generally take precedence.

---

## Info-ZIP Unix Extra Field, Previous New — `0x7855`

`0x7855` stores Unix UID and GID information in a newer Info-ZIP style than `0x5855`.

It makes the ZIP larger.

Why it is present: to preserve Unix owner and group IDs.

Why it is needed: only needed when ownership matters and the extraction environment can meaningfully restore it.

Commonly set: uncommon in casual ZIPs. More relevant for backup/archive workflows.

Size impact: local-header version stores UID/GID data; central-directory version may be zero-length as a marker, but even a zero-length extra field still costs the 4-byte extra-field wrapper.

Practical note: UID/GID values are often machine-specific and may require elevated privileges to restore.

---

## Info-ZIP New Unix Extra Field — `0x7875`

`0x7875` is the newer Info-ZIP Unix UID/GID extra field.

It makes the ZIP larger.

Why it is present: it stores UID and GID with variable-sized integer fields, allowing wider UID/GID values than older fields.

Why it is needed: useful for preserving Unix ownership metadata in archives intended for faithful restoration.

Commonly set: uncommon in general-purpose ZIP files; more likely in archival or backup contexts.

Size impact: at least 4-byte wrapper plus version, UID size, UID bytes, GID size, and GID bytes.

Practical note: like other UID/GID metadata, it can be undesirable for portable application packages because owner IDs may not mean the same thing on another system.

---

## ASi Unix Extra Field — `0x756E`

`0x756E` is an ASi Unix extra field.

It makes the ZIP larger.

Why it is present: it can store Unix mode, UID, GID, symlink target, and device information.

Why it is needed: useful for preserving Unix filesystem semantics that base ZIP does not represent well.

Commonly set: uncommon today.

Size impact: variable; includes fixed metadata plus optional symlink target.

Practical note: many tools instead use `ExternalAttributes` for permissions and other Info-ZIP fields for timestamps/UID/GID.

---

## Unicode Path Extra Field — `0x7075`

`0x7075` stores a UTF-8 version of the entry path.

It makes the ZIP larger.

Why it is present: it was designed for compatibility with tools that store a legacy-encoded filename in the normal filename field but also want to preserve the Unicode name.

Why it is needed: useful when the main filename field is not UTF-8 and a Unicode version must be preserved.

Commonly set: seen in Info-ZIP-compatible archives, but less necessary when using the UTF-8 general purpose bit 11 and storing the main filename as UTF-8.

Size impact: 4-byte extra-field wrapper plus version byte, filename CRC-32, and the UTF-8 name.

Practical note: if both filename and comment are already UTF-8, using general purpose bit 11 is usually smaller than adding Unicode Path and Unicode Comment extra fields.

---

## Unicode Comment Extra Field — `0x6375`

`0x6375` stores a UTF-8 version of the per-file comment.

It makes the ZIP larger.

Why it is present: it preserves a Unicode version of a comment when the normal comment field is stored in a legacy encoding.

Why it is needed: only needed when per-file comments are used and Unicode compatibility matters.

Commonly set: uncommon, because per-file comments themselves are uncommon.

Size impact: 4-byte extra-field wrapper plus version byte, comment CRC-32, and the UTF-8 comment.

---

## WinZip AES Extra Field — `0x9901`

`0x9901` is the WinZip AES extra field.

It makes the ZIP larger.

Why it is present: WinZip AES uses compression method 99 in the normal method field, so the real compression method, AES strength, vendor version, and vendor ID are stored in this extra field.

Why it is needed: required for WinZip AES-encrypted ZIP entries.

Commonly set: yes when using WinZip-compatible AES encryption. Supported by tools such as WinZip and 7-Zip. Not present for ordinary unencrypted ZIPs or traditional ZipCrypto.

Size impact: the AES extra field itself adds bytes in local and central headers, and AES encryption also adds salt, password verification bytes, and authentication code near the encrypted file data. So AES increases metadata/overhead beyond just the extra-field record.

Practical note: this is different from PKWARE Strong Encryption extra field `0x0017`.

---

## Strong Encryption Header — `0x0017`

`0x0017` is the PKWARE Strong Encryption Header.

It makes the ZIP larger.

Why it is present: it stores metadata needed for PKWARE’s Strong Encryption Specification, including algorithm and key-related information.

Why it is needed: required for that style of strong encryption.

Commonly set: uncommon compared with WinZip AES in many consumer ZIP workflows. 7-Zip commonly supports AES-style ZIP encryption but not necessarily every PKWARE strong-encryption variant.

Size impact: variable and can be significant, especially with certificate-based encryption.

---

## Traditional PKWARE Encryption Header

Traditional ZipCrypto encryption does not use a normal extra-field code for its basic per-file header.

It makes the ZIP larger.

Why it is present: encrypted file data is preceded by an encryption header used by the traditional encryption scheme.

Why it is needed: required if using traditional ZIP encryption.

Commonly set: still supported by many ZIP tools, including OS-integrated ZIP utilities, but cryptographically weak.

Size impact: traditionally 12 bytes per encrypted file, plus the encrypted data itself.

Practical note: use AES when security matters, but AES has its own compatibility and overhead considerations.

---

## Archive Decryption Header

The Archive Decryption Header is an archive-level record used with Central Directory Encryption.

It makes the ZIP larger.

Why it is present: it supports encryption of the central directory metadata.

Why it is needed: needed when encrypting central directory metadata, not for ordinary file-content encryption.

Commonly set: uncommon.

Size impact: variable, depending on the encryption method and related metadata.

Practical note: central directory encryption protects filenames and other central directory metadata better than ordinary ZIP encryption, but it reduces compatibility with older ZIP readers.

---

## Archive Extra Data Record

The Archive Extra Data Record is an archive-level record introduced for Central Directory Encryption support.

It makes the ZIP larger.

Why it is present: it can store extra data associated with encrypted or compressed central directory handling.

Why it is needed: only for specialized central directory encryption/compression cases.

Commonly set: uncommon.

Size impact: 4-byte signature, 4-byte extra-field length, and variable extra-field data.

---

## Digital Signature Record

The central directory can be followed by a digital signature record.

It makes the ZIP larger.

Why it is present: to authenticate or sign central directory information in older PKWARE designs.

Why it is needed: not needed for decompression.

Commonly set: uncommon.

Size impact: 4-byte signature, 2-byte size field, and variable signature data.

---

## PKCS#7 Store for X.509 Certificates — `0x0014`

`0x0014` stores PKCS#7 data for X.509 certificates.

It makes the ZIP larger.

Why it is present: supports certificate storage for signing or encryption workflows.

Why it is needed: only needed for certificate-based security features.

Commonly set: uncommon in everyday ZIP files.

Size impact: variable and potentially large because certificate chains can be large.

---

## X.509 Certificate ID and Signature for Individual File — `0x0015`

`0x0015` stores certificate ID and signature information for an individual file.

It makes the ZIP larger.

Why it is present: supports per-file signing/authentication.

Why it is needed: only when the archive requires per-file certificate-based verification.

Commonly set: uncommon.

Size impact: variable.

---

## X.509 Certificate ID for Central Directory — `0x0016`

`0x0016` stores certificate ID information for the central directory.

It makes the ZIP larger.

Why it is present: supports central-directory signing/authentication.

Why it is needed: only for certificate-based security workflows.

Commonly set: uncommon.

Size impact: variable.

---

## Record Management Controls — `0x0018`

`0x0018` stores record management control metadata.

It makes the ZIP larger.

Why it is present: enterprise/compliance record-management use cases.

Why it is needed: not needed for normal ZIP decompression.

Commonly set: rare in general-purpose ZIP files.

Size impact: variable.

---

## PKCS#7 Encryption Recipient Certificate List — `0x0019`

`0x0019` stores recipient certificate list information.

It makes the ZIP larger.

Why it is present: supports certificate-recipient encryption workflows.

Why it is needed: only when encrypting for multiple certificate recipients or similar PKWARE security features.

Commonly set: uncommon.

Size impact: variable and potentially large.

---

## Policy Decryption Key Record — `0x0021`

`0x0021` is a PKWARE-defined extra field for policy decryption key data.

It makes the ZIP larger.

Why it is present: supports enterprise policy-based decryption.

Why it is needed: only for such enterprise encryption policy systems.

Commonly set: rare outside PKWARE/SecureZIP-style enterprise contexts.

Size impact: variable.

---

## Smartcrypt Key Provider Record — `0x0022`

`0x0022` is a Smartcrypt Key Provider Record.

It makes the ZIP larger.

Why it is present: supports PKWARE Smartcrypt key-provider metadata.

Why it is needed: only for Smartcrypt workflows.

Commonly set: rare in ordinary ZIPs.

Size impact: variable.

---

## Smartcrypt Policy Key Data Record — `0x0023`

`0x0023` is a Smartcrypt Policy Key Data Record.

It makes the ZIP larger.

Why it is present: supports Smartcrypt policy key metadata.

Why it is needed: only for Smartcrypt-managed archives.

Commonly set: rare in ordinary ZIPs.

Size impact: variable.

---

## AV Info — `0x0007`

`0x0007` is AV Info, historically related to authenticity verification.

It makes the ZIP larger.

Why it is present: supports authenticity verification metadata.

Why it is needed: not needed for decompression.

Commonly set: rare in modern general-purpose ZIPs.

Size impact: variable.

---

## Reserved Extended Language Encoding Data — `0x0008`

`0x0008` is reserved for extended language encoding data.

It makes the ZIP larger if present.

Why it is present: reserved for encoding-related extension data.

Why it is needed: generally not used in ordinary ZIPs.

Commonly set: rare.

Size impact: variable.

Practical note: modern UTF-8 handling usually uses general purpose bit 11, or older compatibility extra fields such as `0x7075` and `0x6375`.

---

## OS/2 Extended Attributes — `0x0009`

`0x0009` stores OS/2 extended attributes.

It makes the ZIP larger.

Why it is present: preserves OS/2 filesystem extended attributes.

Why it is needed: only for OS/2 metadata fidelity.

Commonly set: rare today.

Size impact: variable; can include compressed attribute data.

---

## OpenVMS Extra Field — `0x000C`

`0x000C` stores OpenVMS metadata.

It makes the ZIP larger.

Why it is present: preserves OpenVMS file attributes and record-format metadata.

Why it is needed: only for OpenVMS fidelity.

Commonly set: rare in general-purpose ZIPs.

Size impact: variable.

---

## Reserved File Stream and Fork Descriptors — `0x000E`

`0x000E` is reserved for file stream and fork descriptors.

It makes the ZIP larger if present.

Why it is present: reserved for filesystems that have multiple streams or forks, such as classic Mac resource forks or other forked-file systems.

Why it is needed: only when preserving fork/stream metadata through a ZIP extension.

Commonly set: rare.

Size impact: variable.

---

## Patch Descriptor — `0x000F`

`0x000F` is the Patch Descriptor extra field.

It makes the ZIP larger.

Why it is present: supports patch data sets.

Why it is needed: only for patching/update workflows that use this ZIP feature.

Commonly set: rare.

Size impact: variable.

---

## Reserved Timestamp Record — `0x0020`

`0x0020` is reserved for a timestamp record.

It makes the ZIP larger if present.

Why it is present: reserved by PKWARE for timestamp-related metadata.

Why it is needed: not normally used for basic ZIP timestamp preservation.

Commonly set: rare.

Size impact: variable.

Practical note: common timestamp preservation more often uses `0x000A` NTFS or `0x5455` extended timestamp.

---

## IBM S/390 / AS/400 Attributes, Uncompressed — `0x0065`

`0x0065` stores IBM S/390 or AS/400 attributes in uncompressed form.

It makes the ZIP larger.

Why it is present: preserves platform-specific mainframe or midrange system metadata.

Why it is needed: only for those environments.

Commonly set: rare in ordinary ZIP files.

Size impact: variable.

---

## IBM S/390 / AS/400 Attributes, Compressed — `0x0066`

`0x0066` is reserved for compressed IBM S/390 or AS/400 attributes.

It makes the ZIP larger if present.

Why it is present: same general purpose as `0x0065`, but for compressed metadata.

Why it is needed: only for those platform-specific workflows.

Commonly set: rare.

Size impact: variable.

---

## POSZIP 4690 Reserved Field — `0x4690`

`0x4690` is reserved for POSZIP 4690.

It makes the ZIP larger if present.

Why it is present: reserved for POSZIP 4690-specific metadata.

Why it is needed: only for that specialized environment.

Commonly set: rare.

Size impact: variable.

---

## Windows NT Security Descriptor — `0x4453`

`0x4453` stores a Windows NT security descriptor, such as ACL/security metadata.

It makes the ZIP larger.

Why it is present: preserves Windows ACL/security descriptor information beyond simple DOS attributes.

Why it is needed: only when restoring Windows security metadata matters.

Commonly set: uncommon in ordinary ZIPs.

Size impact: variable; ACLs can be large.

Practical note: this is different from `ExternalAttributes`, which can store simple attributes but not full Windows ACLs.

---

## OS/2 Access Control List — `0x4C41`

`0x4C41` stores OS/2 ACL metadata.

It makes the ZIP larger.

Why it is present: preserves OS/2 access control list metadata.

Why it is needed: only for OS/2 fidelity.

Commonly set: rare.

Size impact: variable.

---

## Macintosh Extra Fields

Several extra fields exist for classic Macintosh metadata:

* `0x07C8`: old Info-ZIP Macintosh.
* `0x2605`: ZipIt Macintosh first version.
* `0x2705`: ZipIt Macintosh newer short form.
* `0x334D`: newer Info-ZIP Macintosh.
* `0x4D63`: Macintosh SmartZIP.

They make the ZIP larger.

Why they are present: classic Mac files can have metadata such as file type, creator code, Finder flags, resource forks, comments, icon positions, and Mac-specific timestamps.

Why they are needed: only when preserving classic Mac metadata matters.

Commonly set: uncommon in modern general-purpose ZIPs, but relevant for faithful preservation of older Mac files.

Size impact: variable; some are fixed-size, others include variable path/comment/finder metadata.

Practical note: modern macOS ZIP workflows may use other conventions such as AppleDouble `__MACOSX` entries, which add whole extra files rather than just extra fields.

---

## Acorn/SparkFS Extra Field — `0x4341`

`0x4341` stores Acorn RISC OS / SparkFS metadata.

It makes the ZIP larger.

Why it is present: preserves RISC OS load address, execution address, file type, and permissions.

Why it is needed: only for RISC OS fidelity.

Commonly set: rare.

Size impact: commonly around a small fixed payload plus the extra-field wrapper.

---

## VM/CMS Extra Field — `0x4704`

`0x4704` stores VM/CMS file attributes.

It makes the ZIP larger.

Why it is present: preserves VM/CMS platform metadata.

Why it is needed: only in that environment.

Commonly set: rare.

Size impact: variable.

---

## MVS Extra Field — `0x470F`

`0x470F` stores MVS file attributes.

It makes the ZIP larger.

Why it is present: preserves MVS/z/OS-style dataset or file metadata.

Why it is needed: only for mainframe fidelity.

Commonly set: rare.

Size impact: variable.

---

## FWKCS MD5 Extra Field — `0x4B46`

`0x4B46` stores an MD5-based content signature.

It makes the ZIP larger.

Why it is present: supports rapid content identification independent of filename.

Why it is needed: not needed for decompression; useful for a specific content-signature system.

Commonly set: rare.

Size impact: around the MD5 hash and related signature payload plus the wrapper.

Practical note: MD5 is not recommended for modern security integrity, but this field was not designed as a modern cryptographic signature replacement.

---

## Xceed Unicode Extra Field — `0x554E`

`0x554E` is an Xceed Unicode extra field.

It makes the ZIP larger.

Why it is present: stores Unicode metadata for compatibility with Xceed’s ZIP implementation.

Why it is needed: only for compatibility with that ecosystem or older Unicode handling.

Commonly set: uncommon.

Size impact: variable.

---

## Xceed Original Location Extra Field — `0x4F4C`

`0x4F4C` stores original-location metadata.

It makes the ZIP larger.

Why it is present: records where a file originally came from.

Why it is needed: not needed for decompression.

Commonly set: uncommon.

Size impact: variable.

---

## BeOS Extra Field — `0x6542`

`0x6542` stores BeOS file attributes.

It makes the ZIP larger.

Why it is present: preserves BeOS-specific extended attributes.

Why it is needed: only for BeOS fidelity.

Commonly set: rare.

Size impact: variable; may include compressed or uncompressed attribute data.

---

## AOS/VS Extra Field — `0x5356`

`0x5356` stores Data General AOS/VS metadata.

It makes the ZIP larger.

Why it is present: preserves AOS/VS file status and ACL metadata.

Why it is needed: only for that platform.

Commonly set: rare.

Size impact: variable.

---

## Tandem NSK Extra Field — `0x4154`

`0x4154` stores Tandem NSK attributes.

It makes the ZIP larger.

Why it is present: preserves Tandem NSK platform metadata.

Why it is needed: only for that platform.

Commonly set: rare.

Size impact: usually small fixed metadata plus wrapper.

---

## THEOS Extra Fields — `0x6854` and `0x4854`

THEOS metadata may appear under:

* `0x6854`: THEOS.
* `0x4854`: older unofficial THEOS.

They make the ZIP larger.

Why they are present: preserve THEOS file organization, record length, key length, protection flags, and related metadata.

Why they are needed: only for THEOS fidelity.

Commonly set: rare.

Size impact: variable.

---

## SMS/QDOS Extra Field — `0xFB4A`

`0xFB4A` stores SMS/QDOS metadata.

It makes the ZIP larger.

Why it is present: preserves QDOS-specific directory and file metadata.

Why it is needed: only for SMS/QDOS fidelity.

Commonly set: rare.

Size impact: often relatively large because the field can include a fixed directory-like structure.

---

## Alignment / Padding Extra Fields

Some ZIP writers add padding or alignment extra fields so compressed data starts at a particular byte boundary.

They make the ZIP larger.

Why they are present: alignment can improve memory mapping, direct I/O, page alignment, embedded-system access, APK-style optimization, or performance in some readers.

Why they are needed: not needed for decompression.

Commonly set: common in some packaging ecosystems, uncommon in simple desktop ZIPs.

Size impact: variable padding bytes.

Practical note: these fields intentionally trade archive size for alignment or access performance.

---

## Custom Vendor Extra Fields

Any vendor can define extra fields outside PKWARE’s reserved range.

They make the ZIP larger.

Why they are present: to store application-specific metadata while remaining forward-compatible. Unknown ZIP readers can skip them using their length field.

Why they are needed: only for the application that understands them.

Commonly set: depends on the ecosystem.

Size impact: at least 4 bytes per extra field plus vendor data.

Practical note: if you create your own extra field, choose an ID that does not collide with known assignments.

---

## Extra Directory Entries

Explicit directory entries are optional in many ZIPs.

They make the ZIP larger because each directory is represented as its own ZIP entry.

Why they are present: preserve empty directories, directory timestamps, directory permissions, and directory-level metadata.

Why they are needed: needed if you want empty directories to survive extraction. Not needed merely to extract files whose paths imply directories.

Commonly set: yes, many tools include them.

In JSZipp this is controlled by the per-archive `explicitDirectoryEntries` writer
option (on `ZipEncoderOptions`, default `false`). When `true`, the writer
materializes a standalone entry for each parent directory implied by an entry's
path. JSZipp never scans for genuinely empty directories, so an empty folder must
still be added explicitly (`add({ path: "empty/" })`) regardless of the option.

Size impact: each directory entry has a local header, central directory header, filename, and possibly extra fields.

---

## Symlink Entries

Symlink entries are not part of basic ZIP decompression semantics in a universally portable way, but many Unix tools encode them.

They make the ZIP larger as separate entries.

Why they are present: preserve symbolic links.

Why they are needed: only when archiving Unix-like filesystem semantics.

Commonly set: common in Unix archives when symlinks are included and the tool preserves them; not always handled correctly by Windows ZIP tools.

Size impact: the symlink is usually an entry whose file data or metadata stores the link target, plus normal ZIP headers.

Practical note: permissions/file type are often encoded in `ExternalAttributes`; the link target may be stored as entry data or in Unix extra metadata depending on the tool.

---

## AppleDouble / `__MACOSX` Metadata Entries

macOS ZIP tools may add `__MACOSX` entries or AppleDouble sidecar files.

These make the ZIP larger, often noticeably.

Why they are present: preserve macOS Finder metadata, resource forks, extended attributes, and other filesystem metadata.

Why they are needed: only for macOS metadata fidelity.

Commonly set: common when creating ZIPs with Finder or certain macOS tools. Often considered unwanted clutter for cross-platform distribution.

Size impact: can be substantial because metadata is stored as additional ZIP entries, not just tiny header fields.

Practical note: for clean cross-platform ZIPs, many people strip `__MACOSX` and `.DS_Store`.

---

## `.DS_Store` Files

`.DS_Store` is not a ZIP metadata field. It is a normal file that may be included in the archive.

It makes the ZIP larger.

Why it is present: Finder stores folder view metadata in `.DS_Store`.

Why it is needed: not needed for decompression or for most recipients.

Commonly set: common accidentally in macOS-created ZIPs.

Size impact: the compressed `.DS_Store` file data plus full ZIP entry headers.

Practical note: omit it for distribution archives unless you specifically need Finder folder layout metadata.

---

# Quick Recommendations

For smallest, portable ZIPs:

* Use normal DOS modification timestamp only.
* Use UTF-8 filenames with general purpose bit 11 instead of Unicode path extra fields.
* Avoid per-file comments and archive comments.
* Avoid NTFS, Unix UID/GID, ACL, and platform-specific extra fields unless fidelity matters.
* Avoid explicit directory entries unless you need empty directories or directory metadata.
* Avoid `__MACOSX` and `.DS_Store` for cross-platform distribution.
* Use ZIP64 only when required by size, offset, or entry count.
* Avoid data descriptors if the writer can seek and patch local headers.
* Use `ExternalAttributes` for Unix permissions/executable bits because it does not add bytes beyond the already-existing central directory field.

For best metadata preservation:

* Use `ExternalAttributes` for Unix permissions and file type.
* Use `0x5455` Extended Timestamp for compact Unix-style timestamps.
* Use `0x000A` NTFS if Windows creation/access/high-resolution times matter.
* Use ZIP64 when size or offset limits require it.
* Use explicit directory entries if empty directories or directory timestamps matter.
* Use platform-specific extra fields only when the target extractor understands them.
* Use AES extra field `0x9901` only when encryption is required and compatibility with WinZip/7-Zip-style AES is acceptable.

# Platform Metadata Checklist: DOS, Unix, NTFS, and macOS

This section summarizes which ZIP metadata fields are typically necessary or useful when trying to preserve platform-specific file metadata.

Legend:

- **Required**: needed for basic or faithful preservation on that platform.
- **Useful**: commonly useful, but not strictly required.
- **Rare**: only needed for specialized compatibility.
- **No**: generally not needed for that platform.
- **Adds bytes**: yes if it creates extra fields, comments, sidecar entries, or other optional records.
- **No size increase**: uses fields already present in the normal ZIP headers.

| ZIP metadata option | DOS / FAT | Unix / Linux | NTFS / Windows | macOS |
|---|---|---|---|---|
| DOS modification time/date | **Required** for normal ZIP timestamp compatibility. No size increase. | **Required baseline** because ZIP readers expect it, but limited. No size increase. | **Required baseline**, even if NTFS timestamps are also stored. No size increase. | **Required baseline**, even if richer macOS metadata exists. No size increase. |
| `ExternalAttributes` | **Useful** for DOS read-only, hidden, system, archive, directory flags. No size increase. | **Required/useful** for Unix mode bits, executable bit, directory flag, symlink file type conventions. No size increase. | **Useful** for simple DOS/Windows attributes. No size increase. | **Useful** for Unix-style mode bits on modern macOS. No size increase. |
| `VersionMadeBy` host OS byte | **Useful** to mark DOS/FAT origin. No size increase. | **Important** so Unix `ExternalAttributes` are interpreted as Unix mode bits. No size increase. | **Useful** to mark NTFS/Windows origin. No size increase. | **Useful** to mark Unix/Darwin/macOS origin. No size increase. |
| General purpose bit 11, UTF-8 names | **Useful** if filenames are UTF-8. No size increase. | **Useful/common** for UTF-8 paths. No size increase. | **Useful/common** for Unicode filenames. No size increase. | **Useful/common** for Unicode filenames. No size increase. |
| Filename field | **Required**. Adds bytes according to filename length. | **Required**. Adds bytes according to path length. | **Required**. Adds bytes according to path length. | **Required**. Adds bytes according to path length. |
| Explicit directory entries | **Useful** for empty directories and directory attributes. Adds bytes. | **Useful** for empty directories, directory permissions, and timestamps. Adds bytes. | **Useful** for empty directories and attributes. Adds bytes. | **Useful** for empty directories and folder metadata. Adds bytes. |
| ZIP64 extra field `0x0001` | **Only if needed** for large files/archive offsets. Adds bytes. | **Only if needed** for large files/archive offsets. Adds bytes. | **Only if needed** for large files/archive offsets. Adds bytes. | **Only if needed** for large files/archive offsets. Adds bytes. |
| Data descriptor | **Only if streaming**. Adds bytes. | **Only if streaming**. Adds bytes. | **Only if streaming**. Adds bytes. | **Only if streaming**. Adds bytes. |
| Extended Timestamp `0x5455` | **Usually no**; DOS timestamp is native baseline. Adds bytes. | **Useful/common** for UTC Unix mtime, and optionally atime/ctime. Adds bytes. | **Sometimes useful**, but NTFS `0x000A` is more Windows-native. Adds bytes. | **Useful** for Unix-style timestamp preservation. Adds bytes. |
| NTFS extra field `0x000A` | **No**, unless preserving from Windows tools. Adds bytes. | **Usually no**, though readers may ignore it safely. Adds bytes. | **Useful/important** for high-resolution modification, access, and creation times. Adds bytes. | **Usually no**, unless interoperability with Windows timestamp preservation matters. Adds bytes. |
| PKWARE Unix extra field `0x000D` | **No**. Adds bytes. | **Rare/legacy useful** for Unix UID/GID, atime/mtime, and special file data. Adds bytes. | **No**. Adds bytes. | **Rare**, because modern macOS is Unix-like but usually uses other conventions. Adds bytes. |
| Info-ZIP Unix UID/GID `0x7875` | **No**. Adds bytes. | **Useful only for ownership preservation**. Adds bytes. | **No**. Adds bytes. | **Sometimes useful** for Unix ownership preservation, but uncommon for normal sharing. Adds bytes. |
| Old Info-ZIP Unix fields `0x5855`, `0x7855` | **No**. Adds bytes. | **Rare/legacy**. Adds bytes. | **No**. Adds bytes. | **Rare/legacy**. Adds bytes. |
| ASi Unix field `0x756E` | **No**. Adds bytes. | **Rare/legacy** for Unix mode, UID/GID, symlink, device data. Adds bytes. | **No**. Adds bytes. | **Rare/legacy**. Adds bytes. |
| Symlink entries using Unix attributes / link target | **No native DOS meaning**. Adds bytes as entries/data. | **Required if symlinks must be preserved**. Adds bytes. | **Usually no**, Windows support varies. Adds bytes. | **Useful/important** if preserving symlinks. Adds bytes. |
| Windows NT security descriptor `0x4453` | **No**. Adds bytes. | **No**. Adds bytes. | **Useful only for ACL/security fidelity**. Adds bytes, sometimes significantly. | **No**. Adds bytes. |
| OS/2 extended attributes `0x0009` | **Rare**, only OS/2-like compatibility. Adds bytes. | **No**. Adds bytes. | **No**. Adds bytes. | **No**. Adds bytes. |
| OpenVMS extra field `0x000C` | **No**. Adds bytes. | **No**. Adds bytes. | **No**. Adds bytes. | **No**. Adds bytes. |
| IBM S/390 / AS/400 `0x0065`, `0x0066` | **No**. Adds bytes. | **No**. Adds bytes. | **No**. Adds bytes. | **No**. Adds bytes. |
| Unicode Path extra field `0x7075` | **Useful only for legacy filename encoding compatibility**. Adds bytes. | **Usually avoid if bit 11 UTF-8 is enough**. Adds bytes. | **Useful only for legacy compatibility**. Adds bytes. | **Usually avoid if bit 11 UTF-8 is enough**. Adds bytes. |
| Unicode Comment extra field `0x6375` | **Rare**, only if per-file comments need Unicode compatibility. Adds bytes. | **Rare**. Adds bytes. | **Rare**. Adds bytes. | **Rare**. Adds bytes. |
| Per-file comment | **Not needed**. Adds bytes. | **Not needed**. Adds bytes. | **Not needed**. Adds bytes. | **Not needed**. Adds bytes. |
| Archive comment | **Not needed**. Adds bytes. | **Not needed**. Adds bytes. | **Not needed**. Adds bytes. | **Not needed**. Adds bytes. |
| WinZip AES extra field `0x9901` | **Only if AES encryption is used**. Adds bytes. | **Only if AES encryption is used**. Adds bytes. | **Only if AES encryption is used**. Adds bytes. | **Only if AES encryption is used**. Adds bytes. |
| Traditional ZipCrypto header | **Only if legacy encryption is used**. Adds bytes. | **Only if legacy encryption is used**. Adds bytes. | **Only if legacy encryption is used**. Adds bytes. | **Only if legacy encryption is used**. Adds bytes. |
| macOS / Macintosh extra fields, e.g. `0x07C8`, `0x2605`, `0x2705`, `0x334D`, `0x4D63` | **No**. Adds bytes. | **No**. Adds bytes. | **No**. Adds bytes. | **Rare/useful** for classic Mac metadata. Adds bytes. |
| AppleDouble / `__MACOSX` entries | **No**; usually unwanted. Adds bytes. | **No**; usually unwanted. Adds bytes. | **No**; usually unwanted. Adds bytes. | **Useful only if Finder metadata, resource forks, or extended attributes must be preserved**. Adds bytes, often noticeably. |
| `.DS_Store` entries | **No**; usually unwanted. Adds bytes. | **No**; usually unwanted. Adds bytes. | **No**; usually unwanted. Adds bytes. | **Usually not necessary**, unless preserving Finder folder view state. Adds bytes. |
| Alignment / padding extra fields | **No**, unless a special packaging format needs it. Adds bytes. | **Sometimes useful** for special packaging or memory-mapped access. Adds bytes. | **Sometimes useful** for special packaging or memory-mapped access. Adds bytes. | **Sometimes useful** for special packaging or app/package formats. Adds bytes. |
| Custom vendor extra fields | **Only for application-specific metadata**. Adds bytes. | **Only for application-specific metadata**. Adds bytes. | **Only for application-specific metadata**. Adds bytes. | **Only for application-specific metadata**. Adds bytes. |

## Practical platform presets

### Smallest cross-platform ZIP

Use:

- DOS modification time/date.
- UTF-8 filename flag if needed.
- `ExternalAttributes` only for basic directory/read-only/executable metadata.
- ZIP64 only when required.

Avoid:

- NTFS `0x000A`.
- Unix UID/GID fields.
- Unicode path extra field if UTF-8 bit 11 is enough.
- Per-file/archive comments.
- `__MACOSX`, `.DS_Store`, and AppleDouble entries.

### Unix-preserving ZIP

Use:

- DOS modification time/date as the compatibility baseline.
- `VersionMadeBy` set to Unix-like host.
- `ExternalAttributes` for mode bits, executable bit, file type, directory/symlink convention.
- `0x5455` Extended Timestamp if accurate UTC mtime matters.
- `0x7875` only if UID/GID ownership matters.
- Explicit directory entries if empty directories or directory metadata matter.
- Symlink entries if symlinks must be preserved.

Avoid unless required:

- NTFS `0x000A`.
- Old Unix fields `0x5855` / `0x7855`.
- ASi Unix `0x756E`.

### Windows / NTFS-preserving ZIP

Use:

- DOS modification time/date as the compatibility baseline.
- `ExternalAttributes` for basic Windows/DOS attributes.
- NTFS extra field `0x000A` if creation/access/high-resolution modification times matter.
- Windows NT security descriptor `0x4453` only if ACL/security metadata must be preserved.
- Explicit directory entries if empty folders or folder attributes matter.

Avoid unless required:

- Unix UID/GID fields.
- macOS AppleDouble metadata.
- Unicode path extra field if UTF-8 bit 11 is enough.

### macOS-preserving ZIP

Use:

- DOS modification time/date as the compatibility baseline.
- UTF-8 filename flag.
- `ExternalAttributes` for Unix-style permissions.
- `0x5455` Extended Timestamp if accurate Unix-style timestamps matter.
- Symlink entries if symlinks must be preserved.
- AppleDouble / `__MACOSX` entries only if resource forks, Finder metadata, or extended attributes must be preserved.

Avoid for clean sharing:

- `.DS_Store`.
- `__MACOSX`.
- Classic Macintosh extra fields unless targeting old Mac metadata workflows.

# Summary

A ZIP entry already contains several metadata fields whether you use them or not. Fields such as `ExternalAttributes`, `InternalAttributes`, `VersionMadeBy`, DOS modification time, compression method, and general purpose flags do not increase size when set.

The archive gets larger when you add variable-length data or optional records: extra fields, comments, data descriptors, ZIP64 records, encryption headers, digital signatures, explicit directory entries, symlink entries, or platform-specific sidecar files.

The most important rule is:

> Fixed field already present: setting it does not add bytes.
> Extra record or variable-length metadata: adding it increases the ZIP size.
