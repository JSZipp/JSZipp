# Documentation Maintenance Guidelines

This file is normative. See [Specification Index](README.md) for repository-wide
specification scope and keyword meaning.

This guide describes how to keep markdown documentation maintainable across any
project that has multiple docs for different audiences. It also includes the
JSZipp-specific ownership map used by this repository after consolidation into a
single normative `specs/` folder.

The core rule is simple: each topic should have one canonical home. Other docs
may summarize or link to that home, but should not duplicate the full
explanation.

For this repository, all normative specifications live under `specs/`. No
normative document belongs in `pages/` or the repository root.

## Why This Matters

Duplicate explanations create predictable maintenance problems:

- two docs drift after only one is updated;
- a user finds conflicting wording and cannot tell which one is authoritative;
- implementation docs accumulate demo or tutorial details;
- project-specific guarantees get mixed with generic external-format rules;
- future edits require hunting through many files instead of updating one place.

Treat documentation as an information architecture problem, not just text.

## General Content Ownership Pattern

Most projects can use this ownership model:

| Document type | Owns |
| ------------- | ---- |
| Project overview / README | User-facing summary, install/use examples, common workflows, and links to deeper docs. |
| Public contract / API reference | Stable guarantees, supported behavior, error behavior, compatibility commitments, and versioned promises. |
| Implementation guide | Source-level flow, internal invariants, tradeoffs, and why the code is structured that way. |
| Domain or format reference | Generic domain rules, external specifications, interoperability traps, and validation guidance. |
| Topic deep dives | One focused topic such as memory, streaming, charset handling, time, security, migrations, or testing. |
| Demo or benchmark docs | Demo-specific UI behavior, benchmark interpretation, display choices, and local tooling notes. |
| Tests documentation | What the test suite proves, what it intentionally does not prove, and how edge cases are verified. |

If a topic crosses documents, put the detailed explanation in the canonical file
and link to it from the others.

## JSZipp Content Ownership

For this repository, use this concrete mapping:

| Document | Owns |
| -------- | ---- |
| `README.md` | User-facing overview, common usage, short examples, and links to deeper docs. |
| `specs/` | The only folder allowed to contain normative behavior, compatibility promises, validation rules, implementation constraints, and contributor process. |
| `specs/implementation.md` | Source-level implementation flow, internal invariants, and why the code is structured that way. |
| `pages/upgrade-guide.html`, `specs/e2e-smoke-test.md`, and `specs/bundle-size-optimization-rules.md` | Migration content for users, plus operational procedure and optimization rules for maintainers. |
| Demo files | UI behavior, benchmark interpretation, and demo-specific display choices. |

## Avoid Duplicate Explanations

Before adding a detailed explanation, search existing docs:

```sh
rg -n "keyword|related phrase|hex value|API name" -g '*.md'
```

Then decide:

- If a canonical explanation already exists, update it there.
- If another document needs the same information, add a short summary and a
  link, not another full explanation.
- If two existing docs disagree, fix the canonical doc first, then make the
  dependent docs refer to it.
- If no canonical doc exists, create one or explicitly choose the best existing
  document before writing.

## Keep Implementation Docs Source-Specific

Implementation docs should describe the project source behavior:

- internal flow;
- invariants;
- source-level tradeoffs;
- field values or protocol values the project writes or reads;
- why implementation choices exist.

Implementation docs should not become:

- benchmark result summaries;
- demo UI documentation;
- broad tutorials for an external domain;
- copies of public API docs;
- third-party behavior summaries unless needed to explain a source-level choice.

When implementation docs need generic context, use a short sentence plus a link
to the canonical domain or format reference.

Implementation docs MAY mention the current code layout, helper names, or build
modules when that materially helps navigation, but those references SHOULD be
treated as examples of the current implementation, not as the durable rule
itself. The normative statement SHOULD target:

- behavior;
- invariants;
- ownership boundaries;
- compatibility requirements;
- required proof obligations.

It SHOULD NOT make a private function name, source file path, or one current
tooling choice into the requirement unless that identifier is itself part of the
public contract or the repository layout is intentionally versioned as part of
the deliverable.

Preferred pattern:

```markdown
Prefer: "the compatibility seam must install the missing methods before public
APIs are used."

Avoid: "src/polyfill-compat.ts must call installPolyfills() from index.ts."
```

If a current file/module name is still worth mentioning, phrase it as
"currently implemented in ..." or "the current source tree uses ...", so a
refactor does not force a normative spec change when behavior is unchanged.

## Separate Generic Rules From Project Behavior

Many bugs in docs come from mixing three different layers:

| Layer | Example question | Where it belongs |
| ----- | ---------------- | ---------------- |
| Generic external rule | What does this protocol field mean? | Domain/format reference. |
| Project guarantee | What does this library promise to write, reject, or preserve? | Contract/API docs. |
| Project implementation | How does the source produce or validate that behavior? | Implementation docs. |

For JSZipp ZIP metadata:

- Generic ZIP validation rules belong in `specs/zip-validation.md`.
- JSZipp guarantees belong in `specs/api-contract.md`.
- JSZipp internals belong in `specs/implementation.md`.
- Usage guidance belongs in `README.md`.
- Demo rendering choices belong in the demo file or a demo-specific note.

Example:

```markdown
Generated archives use ZIP method `0x0008` for deflated entries. For the
ZIP-format distinction between compression method values and general-purpose bit
flags, see [ZIP validation spec](../specs/zip-validation.md#21-the-compression-method-compatibility-trap).
```

This keeps the detailed method/flag explanation in one place.

## Check For Conflicts Before Finishing

For documentation changes, run a targeted cross-doc search before finalizing.

Generic examples:

```sh
rg -n "APIName|optionName|error name|feature name" -g '*.md'
rg -n "protocol field|status code|flag name|magic value" -g '*.md'
rg -n "benchmark|demo|implementation|contract" -g '*.md'
```

JSZipp examples:

```sh
rg -n "compression method|general-purpose|0x0008|0x0800" -g '*.md'
rg -n "ZIP64|central directory|EOCD" -g '*.md'
rg -n "charset|UTF-8|CP437|filenameEncoding" -g '*.md'
```

Review matches for:

- duplicate full explanations;
- stale wording;
- contradictory terminology;
- links that should replace repeated paragraphs;
- implementation docs mentioning demo-specific behavior;
- README or contract docs carrying too much deep reference material.

## State Size Baselines Explicitly

When documenting archive byte costs, always say what the count is relative to.
ZIP entries normally have a local file header before the payload and a Central
Directory header near the end of the archive. A size statement such as "+18 bytes
per entry" should identify:

- whether it is incremental overhead beyond those base headers;
- which ZIP location pays the cost: local header, Central Directory header, EOCD,
  ZIP64 records, data descriptor, file data, or archive comment;
- whether the count is paid once per entry, twice per entry, or once per archive;
- what is excluded from the count, such as filename bytes, comments, compressed
  payload, base headers, or ZIP64 records.

Prefer labels such as "Extra timestamp bytes/entry" over ambiguous labels such
as "Extra bytes/entry" when the count describes only one metadata category.

## Update Links When Consolidating

When moving details to a canonical doc:

- leave short summaries in high-level docs;
- add relative markdown links to the canonical section;
- make link text describe the topic, not the destination file name alone;
- avoid copying large tables into multiple docs;
- update nearby wording so the link reads as part of the explanation;
- search again after the edit to confirm the duplicate explanation is gone.

## Preserve Audience Boundaries

Prefer this generic pattern:

```markdown
README.md: "What should a user do?"
specs/: "What does the project require and guarantee?"
specs/implementation.md: "How does the source implement it?"
domain reference: "What does the external format/protocol/domain mean?"
demo docs: "How does this example or UI present it?"
```

For this repository:

```markdown
README.md: "What should a JSZipp user do?"
specs/api-contract.md: "What does JSZipp guarantee?"
specs/implementation.md: "How does the JSZipp source implement it?"
specs/zip-validation.md: "What does the ZIP format require JSZipp to validate?"
demo files: "How does this demo display or benchmark it?"
```

When unsure, ask which audience will need to update the text later. Put the
canonical explanation where that maintainer would naturally look first.

## Pre-Finish Checklist

Before finishing a documentation change:

```markdown
- Did I identify the canonical home for the detailed explanation?
- Did I avoid copying the same table or paragraph into multiple files?
- Did I replace duplicate detail with links where appropriate?
- Did I keep implementation docs free of demo-specific wording?
- Did I separate generic domain rules from project-specific guarantees?
- Did I run targeted `rg` searches for the edited topic?
- Did I fix stale wording found during the cross-doc search?
```
