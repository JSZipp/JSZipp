# Bundle-Size Optimization Rules (JS / TS)

A reusable playbook for shrinking the **final minified bundle** without changing
behavior, output, or time/space complexity. Apply these to any project.

> **Golden rule:** Optimize against the artifact you actually ship (minified,
> usually gzipped/brotli'd) — **measure it**, don't eyeball the source. Source
> line count is almost meaningless.

---

## 0. Measure first, always

Never optimize blind. Wire up a one-command before/after measurement and rerun it
after every change.

```bash
# minified size
esbuild entry.ts --bundle --minify --format=esm --legal-comments=none --outfile=out.js
wc -c < out.js
# gzipped size (what you actually serve)
gzip -9 -c out.js | wc -c
# brotli if available (closer to real CDN delivery)
brotli -q 11 -c out.js | wc -c
```

Also verify you didn't break anything:
- **Typecheck:** `tsc --noEmit` before and after — output must stay clean.
- **Behavior:** for deterministic code, assert the *output is byte-identical*
  before vs after (strongest possible proof the algorithm is unchanged). For the
  rest, run the existing test suite.

---

## 1. Know what is FREE (don't waste effort here)

The minifier/transpiler already removes these. Editing them changes the source but
**not the bundle**:

- **All comments** — including giant doc blocks and commented-out code. Free.
- **All TypeScript types** — `interface`, `type`, annotations, generics like
  `Uint8Array<ArrayBuffer>`. Erased entirely. Zero bytes.
- **Whitespace / formatting / blank lines.** Stripped.
- **Local variable & parameter names.** The minifier mangles every local to 1–2
  chars. Renaming `literalFrequencies` → `lf` by hand saves nothing.
- **`undefined` vs `void 0`, `true/false` vs `!0/!1`, hex vs decimal literals.**
  The minifier already picks the shortest form.

**Implication:** don't strip comments or shorten local names "for size." Spend the
effort on Section 2.

---

## 2. What actually moves minified bytes

These survive minification because the minifier can't safely transform them itself.

### 2.1 Deduplicate what the minifier won't

The minifier does **not** hoist duplicates of these. You must do it by hand:

- **Repeated string literals.** Hoist into a `const` (the const name gets mangled
  to ~1 char). Especially error names / codes used many times.
  ```ts
  const ERR_STATE = "InvalidStateError";
  throw new DOMException(msg, ERR_STATE); // was: "...InvalidStateError"
  ```
- **Repeated global/static member accesses.** Globals can't be mangled, but a
  local alias can. Destructure once:
  ```ts
  const { max, min, ceil } = Math;
  const { isInteger, isSafeInteger, isFinite } = Number; // safe: no `this` needed
  ```
  (Only destructure methods that don't rely on `this`; static helpers like
  `Math.*` / `Number.is*` / `Object.keys` are safe.)
- **Long built-in expressions with a short equivalent.** e.g.
  `Number.POSITIVE_INFINITY` → `Infinity` (identical value, ~16 bytes shorter
  each use). `Number.MAX_SAFE_INTEGER` → `9007199254740991` only if used many
  times; for a single use, leave it.

### 2.2 Object/class property names are NOT mangled (by default)

Property names on objects and class instances survive verbatim, so **duplicated
property writes are duplicated bytes**.

- **Hoist shared field initialization into a base class / shared factory.** If two
  subclasses each run `this.path = x; this.size = y; ...` (same 10 lines), move
  them into the common base constructor once. Biggest structural win in practice.
- Type the shared field with the **concrete narrow type** the data actually
  carries so it satisfies all subclass interfaces without per-subclass redeclares.
- ⚠️ With `useDefineForClassFields: true`, a subclass field *declaration* re-runs
  after `super()` and overwrites the base value with `undefined`. After moving
  init to the base, **delete the subclass declarations** (or mark them `declare`,
  which emits nothing and doesn't shadow).

### 2.3 Factor duplicated logic into a helper

Two near-identical functions (e.g. an `async` and a `sync` variant) that share a
validation block + error message: extract the shared prologue into one helper. The
duplicated *error-message string* and the duplicated *code* both collapse. Keep the
helper small — a helper that's bigger than what it saves is a loss.

### 2.4 Loop-form micro-tweaks — low value, use sparingly

`for (let i = n; i--; )` is ~3 chars shorter than `for (let i = 0; i < n; i++)`,
and the minifier won't flip loop direction for you. But:
- Only safe when **iteration order doesn't matter** (counting, equality, summing).
- **Never** on loops that write ordered output, accumulate offsets, or have
  index-dependent side effects.
- Payoff is tiny (single-digit bytes each). Do it only where it's obviously safe;
  it's not worth a correctness risk.

---

## 3. The gzip caveat (read before celebrating)

Minified-byte wins and gzipped-byte wins are different numbers.

- **gzip/brotli already collapse repeated strings** via back-references. So
  string-hoisting (2.1) shows a big *pre-gzip* drop but a small *post-gzip* one.
- **Structural dedup (2.2 / 2.3) survives gzip** much better, because you removed
  distinct logic, not just repetition.
- If you ship gzipped (almost everyone does), **prioritize structural dedup and
  tree-shaking over string golfing.**

---

## 4. Bigger levers than source golfing

When you need real savings, these usually beat hand-tuning:

- **Tree-shaking / dead-code elimination.** Ensure unused exports actually drop:
  - Set `"sideEffects": false` in `package.json` (or list the few files that have
    side effects).
  - Prefer named `export`s; ship ESM.
  - ⚠️ A **default-export aggregate object** (`export default { A, B, C, D }`)
    references every member, so importing the default pins *all* of them into a
    consumer's bundle — defeating tree-shaking for partial importers. Drop it or
    keep it optional if consumers only need one piece.
  - Avoid top-level side effects (eager table-building, module-load mutations);
    make them lazy/on-first-use so a bundler can drop the whole subsystem when an
    entry point never touches it.
- **Build tables/data at runtime** instead of embedding large literal arrays, when
  the generator code is smaller than the data it produces.
- **Minifier config** (verify, don't assume):
  - terser `mangle.properties` (with a safe regex like trailing `_`, or `#private`
    fields) can mangle internal property names — *powerful but risky*; gate it and
    test hard. Off by default for good reason.
  - `compress.passes: 2+`, `pure_funcs`, `drop_console`/`drop_debugger` where
    appropriate.
- **Dependencies dominate.** One mis-imported util library can outweigh every
  source tweak. Audit with a bundle analyzer; prefer `import { x }` over
  `import * as _`; check for duplicate/transitive copies.

---

## 5. Workflow checklist (copy/paste)

```
[ ] Set up before/after measurement: minified + gzipped (+ brotli).
[ ] Capture baseline numbers and a passing typecheck + tests.
[ ] Confirm comments/types/whitespace are already stripped (don't touch them).
[ ] Hoist repeated string literals into consts.
[ ] Destructure repeated global/static members (Math/Number/Object...).
[ ] Replace long built-ins with short equivalents (POSITIVE_INFINITY -> Infinity).
[ ] Hoist duplicated class-field init into a shared base (delete/`declare` in subs).
[ ] Factor duplicated logic (async/sync pairs, repeated validation) into helpers.
[ ] Reverse only obviously order-independent loops (optional, tiny).
[ ] Re-measure after EACH change. Keep only changes that help.
[ ] Verify byte-identical output (deterministic code) or green tests.
[ ] Then look at the big levers: tree-shaking, default-export object, deps.
[ ] Report minified AND gzipped deltas — they differ.
```

---

## 6. Hard rules (don't break behavior for bytes)

- Never change the **public API** (exported names, signatures, observable types
  consumers depend on) for size.
- Never reorder operations with side effects, change error semantics, or alter
  numeric/precision behavior.
- Don't destructure a method that needs its `this` binding.
- Every change must keep `tsc --noEmit` clean and tests green; for deterministic
  pipelines, prove output is byte-identical.
- If a change's measured saving is ~0 (e.g. eaten entirely by gzip), revert it —
  it's just added risk and reduced readability.
