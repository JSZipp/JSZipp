# Filename Charset Handling

ZIP filenames are byte sequences. They are not always self-describing, so the
same filename bytes can produce different text depending on the charset used to
decode them.

JSZipp writes new archives with UTF-8 filenames and sets the ZIP UTF-8 flag.
When reading existing archives, JSZipp follows the ZIP metadata first, then uses
`filenameEncoding` only as a fallback for legacy names.

## How JSZipp Decodes Names

For each filename and ZIP comment:

1. If a valid Info-ZIP Unicode Path extra field (`0x7075`) is present on the
   entry, JSZipp uses its UTF-8 name. "Valid" means its embedded CRC-32 matches
   the primary header name bytes; a stale field (mismatched CRC) is ignored and
   decoding continues with the steps below. This applies to entry paths only.
2. If the ZIP UTF-8 flag is set, JSZipp decodes the bytes as UTF-8.
3. If the ZIP UTF-8 flag is not set, JSZipp decodes the bytes with
   `filenameEncoding`.
4. If `filenameEncoding` is omitted, JSZipp uses `"utf-8"`.

```ts
const reader = await openZip(file, {
  filenameEncoding: "shift_jis"
});
```

The fallback applies to entry paths, entry comments, and the archive comment.
It does not affect file contents. To decode file contents, read the entry bytes
and decode them separately.

## Supported Fallback Encodings

`filenameEncoding` accepts:

- `"cp437"`
- any charset label supported by the runtime's `TextDecoder`
- a custom `TextDecoder`-shaped object with `encoding`, `fatal`, `ignoreBOM`,
  and `decode(bytes)` properties

Examples:

```ts
await openZip(file, { filenameEncoding: "cp437" });
await openZip(file, { filenameEncoding: "shift_jis" });
await openZip(file, { filenameEncoding: "windows-1252" });
await openZip(file, { filenameEncoding: "gbk" });
await openZip(file, { filenameEncoding: "big5" });
await openZip(file, { filenameEncoding: "euc-kr" });
await openZip(file, { filenameEncoding: "cp866" });
await openZip(file, { filenameEncoding: customDecoder });
```

Runtime support can vary. If `TextDecoder` does not support a charset label,
`openZip` will throw when it tries to decode legacy names with that label.
Custom decoder objects are used directly and are useful for encodings supplied by
application code rather than the platform.

## Why CP437 Is Special

CP437, also known as IBM Code Page 437, is historically important for ZIP.
Older DOS-era ZIP tools commonly used CP437 for filenames when the UTF-8 flag
was not set.

Modern browser `TextDecoder` implementations generally do not support CP437.
Because CP437 is still important for ZIP compatibility, JSZipp includes a small
built-in CP437 decoder instead of relying on `TextDecoder("cp437")`.

## Choosing An Encoding

Use the ZIP UTF-8 flag when possible. For archives created by JSZipp, this is
already handled automatically.

For legacy archives without the UTF-8 flag, choose the fallback based on the
tool or locale that created the archive:

- Use `"cp437"` for classic DOS or ZIP-compatible fallback behavior.
- Use `"shift_jis"` for many Japanese legacy archives.
- Use `"gbk"` for many Simplified Chinese legacy archives.
- Use `"big5"` for many Traditional Chinese legacy archives.
- Use `"euc-kr"` for many Korean legacy archives.
- Use `"windows-1252"` for many Western European Windows archives.
- Use `"cp866"` for many Cyrillic DOS/Russian legacy archives.

There is no universal way to infer the correct legacy charset from a ZIP file
when the UTF-8 flag is missing. If the wrong fallback is used, filenames may
decode as replacement characters or readable but incorrect text.

## Testing Runtime Support

Use this helper in the same runtime where JSZipp will run:

```js
function testTextDecoderSupport(encodings = [
    // common
    "utf-8",
    "shift_jis",
    "windows-1252",
    "gbk",
    "big5",
    "euc-kr",
    // ibm
    "cp866", // ibm866
    "cp437", // ibm437
    // other
    "utf-16le",
    "utf-16be",
    "ibm866",
    "iso-8859-2",
    "iso-8859-3",
    "iso-8859-4",
    "iso-8859-5",
    "iso-8859-6",
    "iso-8859-7",
    "iso-8859-8",
    "iso-8859-8-i",
    "iso-8859-10",
    "iso-8859-13",
    "iso-8859-14",
    "iso-8859-15",
    "koi8-r",
    "koi8-u",
    "macintosh",
    "windows-874",
    "windows-1250",
    "windows-1251",
    "windows-1253",
    "windows-1254",
    "windows-1255",
    "windows-1256",
    "windows-1257",
    "windows-1258",
    "x-mac-cyrillic",
    "gb18030",
    "euc-jp",
    "iso-2022-jp", 
]) {
  return encodings.map((encoding) => {
    try {
      const decoder = new TextDecoder(encoding);
      return {
        encoding,
        supported: true,
        canonical: decoder.encoding
      };
    } catch (error) {
      return {
        encoding,
        supported: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
}

console.table(testTextDecoderSupport());
```

Expect `"cp437"` to be unsupported by `TextDecoder` in many browsers. JSZipp
still supports `"cp437"` through its built-in decoder.

## Common Pitfalls

Do not set `filenameEncoding` for archives that already set the ZIP UTF-8 flag.
JSZipp will ignore the fallback for those names and correctly use UTF-8.

Do not assume `filenameEncoding` changes entry content decoding. It only affects
ZIP metadata names and comments.

Do not assume every label accepted by other tools is accepted by `TextDecoder`.
For example, a runtime may accept `"shift_jis"` but reject a related alias.
Prefer standard `TextDecoder` labels when possible.
