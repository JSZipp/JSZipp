# Locating the EOCD Robustly in ZIP Parsing

## Overview

ZIP readers locate the **End of Central Directory** record (**EOCD**) by scanning backward from the end of the file for the EOCD signature. This is the right starting point: the EOCD is normally the last structure in the archive, optionally followed only by a variable-length comment, and the comment has a bounded maximum length, so the search region near the end of the file is bounded too.

The hazard is that the EOCD signature is just four bytes. The same sequence can occur elsewhere near the end of the file — inside a comment, in appended data, or in deliberately crafted content. A reader that accepts the first signature it finds, or that trusts a single self-consistent record, can be steered onto a fake EOCD and made to parse the wrong archive.

The robust strategy has two parts: treat a signature match as a **candidate** to be structurally validated, and choose between competing candidates by **real content** rather than by position or by a self-consistent claim.

## The failures this prevents

Two distinct steering attacks share one root cause — trusting local bytes over archive structure.

**Fake EOCD inside the comment.** A fake EOCD placed at the start of the real EOCD's comment sits at a *higher* offset than the real one, so a backward scan reaches it first. If its comment-length field is crafted so the fake record also ends at EOF, a naive reader selects it. A one-entry archive whose comment began with such a fake parsed as empty (`{ comment: "trail", entries: [] }`), silently hiding the real entry.

**Fake EOCD appended after the archive.** Appending a small EOCD after a complete archive pushes end-of-file past the real EOCD, so the real record's comment no longer reaches EOF. A reader that requires "comment reaches EOF" then drops the real EOCD from consideration entirely and reads the appended (empty) record — the same silent erasure, reached from the other direction. This is a classic parser-confusion / scanner-evasion vector: one tool sees an empty archive, another extracts the real payload.

In both cases a valid archive parses as the wrong archive (correctness), and for untrusted input the parse is steered by attacker-controlled bytes (security).

## Why per-candidate structural validation is not enough

The intuitive fix is to validate each candidate in isolation: confirm its central directory lies within the file, ends where it should, parses the declared number of records, and consumes the declared size. These checks are necessary, but they **cannot reject every fake**, because *emptiness is self-consistent at any offset*.

A fake EOCD can declare an **empty** central directory whose offset equals the fake record's own position. Then it lies within the file (a zero-length range always does), it "ends" exactly where it claims (`offset + 0 == offset`), and it parses the declared count (zero) consuming the declared size (zero). Every isolated structural check passes. Such a fake, anchored to itself, will still be selected ahead of the real, content-bearing EOCD. No amount of per-candidate validation closes the hole — the attacker controls a fully self-referential claim with no real content behind it.

### The principle, borrowed from a streaming-ZIP fix

fflate's streaming unzipper had the analogous bug for a different reason (issue #243, PR #275): it detected entry boundaries by scanning forward for signatures, and compressed bytes could contain those byte sequences by chance. The fix did not trust the signature; it tracked the bytes actually consumed and accepted a boundary only when that running count matched the data descriptor's declared compressed size.

The transferable principle is:

> Confirm a candidate against an invariant anchored to **real consumed content**, never against a self-consistent claim the input fully controls.

For a random-access reader the "real content" is the actual central-directory records. An empty central directory has no content to anchor, so it is the weakest possible interpretation and must lose to any interpretation backed by genuine records.

## The approach

Selection is **comparative and content-anchored**, applied uniformly to every EOCD signature in the bounded tail region — there is no special case for "exactly one signature" and no reliance on which record happens to end at EOF.

### 1. Scan the bounded tail for every signature

Walk backward over the bounded region (the last 22 + 65535 bytes) and consider every offset whose four bytes match the EOCD signature, newest (closest to EOF) first. Each match is only a candidate.

### 2. Score each candidate for coherence

Resolve the candidate into central-directory coordinates, following the Zip64 records when the legacy fields hold sentinels. A candidate is **coherent** only if:

1. its central directory ends **exactly** at the offset where the trailing EOCD records begin — the EOCD itself for a legacy archive, or the Zip64 EOCD record (reached through the locator) for a Zip64 archive (the structural "anchor"); and
2. the declared range parses as **exactly** the declared number of central records, each carrying a central-directory signature, **consuming exactly** the declared central-directory size.

The coherence check reports the number of records the candidate genuinely describes, or rejects it.

### 3. Select by content

Among the candidates, scanning newest first:

- return the first **coherent, content-bearing** candidate (one or more real records) — this is the genuine EOCD, and it wins over any empty fake whether the fake is embedded in the comment or appended after the archive;
- otherwise return the first **coherent but empty** candidate that ends at EOF — a genuinely empty archive;
- otherwise return the signature **nearest EOF**, so a malformed archive still reaches the main parser and produces a precise structural error (entry-count mismatch, size mismatch, out-of-bounds offset, missing Zip64 locator, and so on) rather than a vague "not found";
- if no signature is present at all, report that the EOCD was not found.

Because the genuine, content-bearing directory is preferred over a degenerate empty record regardless of position, both steering attacks fail: the empty fake — embedded or appended — never outranks the real archive's records.

### 4. Make the anchor Zip64-aware

The adjacency check in step 2 must use the correct anchor. For a legacy archive the central directory ends at the EOCD; for a Zip64 archive it ends at the **Zip64 EOCD record**, located via the Zip64 locator preceding the legacy EOCD. Anchoring a Zip64 archive against the legacy EOCD offset would wrongly reject every conformant Zip64 file. Resolving Zip64 during scoring also defeats a related forgery: a fake **legacy** EOCD carrying ordinary (non-sentinel) values can otherwise preempt the real Zip64 path, because the Zip64 branch is only entered when sentinels are present; scoring the real candidate through its Zip64 records keeps it the winner.

## Recommended algorithm

1. Scan the bounded tail region for every EOCD signature, newest first.
2. For each, score coherence: resolve (Zip64 included), require the central directory to end exactly at its anchor, and require it to parse as exactly the declared records consuming exactly the declared size.
3. Return the first coherent, content-bearing candidate.
4. Otherwise return the first coherent, empty, EOF-anchored candidate.
5. Otherwise return the signature nearest EOF so the parser can report a precise error; if there is none, report that the EOCD was not found.

This turns EOCD location from a signature/position heuristic into a structure-and-content decision, while leaving the common, healthy archive — whose genuine EOCD is the nearest coherent, content-bearing record — selected on the first match.

## Limitations

- **Backward-scan window.** Selection only considers the last 22 + 65535 bytes. If an attacker appends more trailing data than that window, the real EOCD falls outside the scanned region and cannot be recovered. This is an inherent property of bounded backward EOCD scanning, not specific to this strategy.
- **Diagnostics over silence.** When no candidate is coherent, the nearest signature is handed to the parser so a malformed archive yields a precise error. This deliberately keeps a malformed lone EOCD producing its specific structural message rather than a generic failure.

## Benefits

- **False-positive resistance.** EOCD-like bytes in comments or trailing data no longer win against the genuine record.
- **Resistance to crafted input.** A forgery must produce a coherent, content-bearing central directory ending at its own anchor — which requires controlling bytes outside an attacker's reach in the embedded and appended cases — not merely a plausible signature or a self-consistent empty claim.
- **Stronger Zip64 correctness.** A fake legacy EOCD cannot bypass the real Zip64 records.
- **Preserved diagnostics.** Malformed archives still reach the main parser, so existing precise error messages are retained.

## Summary

```text
Do not trust the EOCD signature, its position, or a self-consistent candidate.
Validate every candidate structurally, then choose the one anchored to real
central-directory content — so neither an embedded nor an appended fake can
hide the archive's entries.
```

The efficient backward scan stays. The decision becomes structural, and comparative — content over emptiness — so position alone can no longer steer the parser.
