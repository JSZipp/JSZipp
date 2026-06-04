# Timezone Handling

ZIP entries carry modification time in two places:

1. the legacy MS-DOS date/time fields in the local and central headers;
2. the Extended Timestamp extra field (`0x5455`), when present.

These fields are not equivalent. They encode different timestamp models, and
that difference is the reason the same ZIP file can appear to have different
modified times when read by different tools.

## Summary

JSZipp treats `modifiedAt` as a JavaScript `Date`, which represents one exact
instant in time. When writing an entry, JSZipp:

- always writes the legacy DOS date/time fields;
- packs those DOS fields from the local wall-clock parts of the `Date`;
- also writes a `0x5455` Extended Timestamp mtime when the `timestamps` mask
  includes `TimestampMode.Unix` and the timestamp is representable as an unsigned
  32-bit Unix timestamp;
- also writes an NTFS extra field (`0x000a`) when the `timestamps` mask includes
  `TimestampMode.Ntfs`, storing modification, last-access, and creation FILETIMEs at
  100-nanosecond UTC precision; the field needs all three values, so when
  `meta.createdAt` or `meta.lastAccess` is omitted JSZipp defaults each missing one
  to `meta.modifiedAt` rather than rejecting the entry;
- does not add its own `0x5455` or `0x000a` field if the caller already supplied
  one of that id in `meta.extraField`;
- on read, treats an NTFS extra that carries both creation and last-access times
  as authoritative — `modifiedAt`, `createdAt`, and `lastAccess` come from it and
  the DOS/Extended-Timestamp fields are ignored; otherwise reads `0x5455` mtime
  first and falls back to DOS date/time when no usable `0x5455` timestamp is
  present;
- may show a normal one-second difference between the DOS timestamp and the
  `0x5455` timestamp when the true second is odd, because DOS timestamps have
  only two-second precision.

The practical result is that modern tools should recover the exact instant from
the UTC extra field, while legacy tools that only understand DOS timestamps get
the local wall-clock time they traditionally expect.

## The Legacy MS-DOS Field

The ZIP local file header and central directory header both contain a two-word
MS-DOS/FAT timestamp:

```text
date = 7 bits year-1980 | 4 bits month | 5 bits day
time = 5 bits hour      | 6 bits minute | 5 bits second/2
```

This format has no timezone slot. It cannot say whether `15:30` means Tokyo
time, New York time, UTC, or anything else. It stores only calendar fields.

Many legacy ZIP tools historically wrote the creator's local wall-clock time
into these fields. Under that convention, a file saved at `15:30` in Tokyo would
put `15:30` in the DOS field. If a legacy tool in New York later reads that ZIP,
it also sees only `15:30`; because there is no offset to apply, it may display
`15:30` as New York local time. The archive has lost the original instant.

JSZipp follows that local-time convention for the DOS field. It writes the DOS
field from `Date#getFullYear()`, `getMonth()`, `getDate()`, `getHours()`,
`getMinutes()`, and `getSeconds()`. For example, on a Tokyo host, a `Date`
representing `2026-01-01T15:30:00+09:00` writes `15:30` to the DOS field.

That choice is deliberate compatibility behavior. A legacy reader that ignores
extra fields and assumes DOS timestamps are local wall-clock time can display a
useful time without doing timezone math.

The cost is that the DOS field alone still cannot identify a unique instant.
If that Tokyo-created DOS-only timestamp is read on a New York host, a legacy
reader may display `15:30` as New York local time. The exact instant is
recoverable only from the `0x5455` Extended Timestamp field.

The DOS field also has format limits:

- two-second precision, because the stored seconds value is `seconds >> 1`;
- a year range of 1980 through 2107, clamped by JSZipp when writing;
- no timezone, no UTC offset, and no way to distinguish local time from UTC.

Because the DOS field stores seconds divided by two, it can represent only even
second values: `00`, `02`, `04`, ..., `58`. When JSZipp writes the DOS time, it
uses `seconds >> 1`, which truncates the original second to the nearest lower
even second. For example, an exact modification time of `10:14:35` is encoded in
the DOS field as `10:14:34`. This one-second difference is normal and expected;
it does not mean that the DOS field and the Extended Timestamp field disagree
about the timezone or the underlying instant. It is only a consequence of the
legacy DOS timestamp format's two-second granularity.

## The Extended Timestamp Extra Field

The Extended Timestamp extra field has header ID `0x5455`. JSZipp writes it with
only the modification-time flag set:

```text
header ID   = 0x5455
data size   = 5
flags       = 0x01, meaning mtime is present
mtime       = unsigned 32-bit Unix timestamp
```

Unlike the DOS field, this value is a Unix timestamp: seconds since
`1970-01-01T00:00:00Z`. It is therefore UTC-based and represents one exact
instant. The same `2026-01-01T15:30:00+09:00` example is written as Unix seconds
for `2026-01-01T06:30:00Z`.

When a modern reader sees this value, it can convert the instant to the user's
current local timezone for display. A New York machine using EST would display
the instant `06:30 UTC` as `01:30` local time. A Tokyo machine would display the
same instant as `15:30` local time. Both displays describe the same moment.

JSZipp emits this field only when the timestamp can be represented in the field:

- the Unix seconds value must be finite;
- it must be greater than or equal to `0`;
- it must be less than or equal to `0xffffffff`.

That range covers `1970-01-01T00:00:00Z` through early 2106. Outside that range,
JSZipp writes only the DOS fields.

The extra field preserves one-second precision. It does not preserve
milliseconds, because the ZIP `0x5455` mtime stores whole Unix seconds. This is
more precise than the legacy DOS field, so a timestamp whose true second is odd
can appear one second later in `0x5455` than in the DOS field. For example, a
`0x5455` value displayed as `10:14:35` local time can correspond to a DOS
display of `10:14:34`. The `0x5455` value should be treated as the exact value
when present.

## Reading Order

When JSZipp reads a ZIP entry, it parses the central directory extra field and
uses this order:

1. If a valid `0x5455` field exists and its mtime-present flag is set, JSZipp
   returns `modifiedAt` from that UTC Unix timestamp.
2. Otherwise, JSZipp falls back to the legacy DOS date/time fields and builds a
   local wall-clock `Date`.

This means JSZipp ignores the DOS field for `modifiedAt` whenever a usable
Extended Timestamp mtime is present. The DOS value remains in the raw ZIP
headers for compatibility with tools that do not understand `0x5455`.

## Why Both Fields Are Written

The DOS fields are mandatory in ordinary ZIP headers. They are needed for broad
compatibility with old operating systems, old ZIP utilities, and simple readers
that know only the baseline ZIP format.

The Extended Timestamp field is optional, but written by default in JSZipp (the
default `timestamps` mask is `TimestampMode.Dos | TimestampMode.Unix`). It fixes
the main weakness of the DOS fields: it stores a UTC instant instead of a
timezone-less wall-clock value. Modern tools should prefer it because it avoids
timezone drift when archives move between regions. Use `timestamps:
TimestampMode.Dos` only when compact per-entry metadata is more important than
UTC timestamp fidelity. Adding `TimestampMode.Ntfs` to the mask additionally
writes the NTFS extra (`0x000a`), which also stores a UTC instant but at
100-nanosecond precision.

Writing both fields is therefore the compatibility tradeoff:

- legacy readers get a timestamp they can parse from the DOS header fields;
- modern readers get the exact instant from `0x5455`;
- JSZipp's own reader gets stable behavior by preferring `0x5455` and by
  interpreting fallback DOS fields as local wall-clock time.

## Interoperability Expectations

Archives written by JSZipp:

- modern readers that honor `0x5455` should display the correct local time for
  the original instant;
- legacy readers that ignore `0x5455` see the DOS local wall-clock fields;
- when a ZIP crosses timezones, those legacy readers may still display the
  creator's local wall-clock time as if it belonged to the reader's timezone.

Archives written by other tools:

- if they contain a valid `0x5455` mtime, JSZipp uses that UTC instant;
- if they contain only DOS fields written as local time, JSZipp has no timezone
  information to recover the original instant and will interpret those fields as
  local wall-clock time on the reading host;
- therefore, DOS-only archives cannot be timezone-correct across regions.

## Reproducibility

For byte-identical archives, callers should provide `meta.modifiedAt` explicitly
for every entry. If `modifiedAt` is omitted, JSZipp defaults it to `new Date()`
at write time, so each run can produce different timestamp bytes.

Because JSZipp derives the DOS fields from local wall-clock parts, the same
explicit `modifiedAt` can produce different DOS bytes on machines in different
timezones. The `0x5455` UTC extra field remains stable for the same instant,
subject to its one-second precision and 1970-through-early-2106 range. For
byte-identical archives across machines, run builds under a fixed timezone, keep
a `TimestampMode.Unix` timestamp flag and compare the UTC extra timestamp rather
than the legacy DOS field, or use `timestamps: TimestampMode.Dos` only when
DOS-only timestamp semantics are acceptable.
