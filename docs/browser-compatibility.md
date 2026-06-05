# Browser Compatibility & the Polyfill Architecture

This is the **canonical** document for how JSZipp supports older browsers: which
targets exist, what each one is missing, and exactly how the source, the polyfill
seam, and the build configuration cooperate to cover the gaps **without changing
the public API**.

Read this before touching anything under `src/polyfill*.ts`, the
`CR61FF58` / `CR86FF68` build flags, or the syntax targets in
`rspack_config.mjs`. A change that looks harmless in one build can silently break
a different one, because each target ships a different mix of native features and
polyfills.

What lives elsewhere (this doc links, it does not duplicate):

- Public, versioned compatibility promises and error categories → `CONTRACT.md`.
- User-facing install, the `browser-legacy/*` subpaths, and CDN tags → `README.md`.
- Why the Web Streams surface is shaped the way it is, and why JSZipp does not do
  true streaming compression → `streaming.md`.
- Source-level flow and invariants (including Abort support) → `implementation.md`.
- What the tests prove and do not prove → `testing.md`.

---

## 1. The mental model: two completely different kinds of gap

Every compatibility problem in this library is one of two kinds. Conflating them
is the single most common source of mistakes.

1. **Syntax the engine cannot parse.** Example: `async function*`, `for await`,
   optional chaining `?.`, nullish coalescing `??`, optional catch binding
   `catch {}`. If the bundle contains syntax the engine does not understand, the
   **entire script fails to load** with a `SyntaxError` — before any of our code
   or feature detection runs. This is solved **at build time** by lowering the
   SWC syntax target so SWC downlevels the syntax to a form the engine can parse.
   It is *not* something a runtime polyfill can fix.

2. **Runtime APIs / globals the engine does not provide.** Example: `globalThis`,
   `ReadableStream`, `TransformStream`, `DecompressionStream`, `AbortController`,
   `Symbol.asyncIterator`, `AbortSignal.prototype.throwIfAborted`. The syntax
   parses fine, but the identifier is missing or a method is absent at runtime.
   This is solved **in code** by the polyfill seam (providing an implementation)
   or by reading globals defensively (feature detection through a safe stand-in).

> Rule of thumb: if the fix is "transpile it differently," it is a **syntax** gap
> and belongs in `rspack_config.mjs`. If the fix is "provide or detect an API," it
> is a **runtime** gap and belongs in the polyfill modules.

---

## 2. Supported targets at a glance

JSZipp ships three flavors of every entry point. They share one source tree and
one public API; they differ only in syntax target and how much polyfill code is
bundled.

| Build | Minimum browsers | Syntax target | Polyfill seam module | Extra weight |
| ----- | ---------------- | ------------- | -------------------- | ------------ |
| **Modern** (default) | Chrome 80+ / Firefox 113+ class | `es2019` | `polyfill.ts` (native passthrough) | none — zero polyfill bytes, zero deps |
| **CR86FF68** (`jszipp/browser-legacy/cr86ff68`) | Chrome 86 / Firefox 68 | `es2019` | `polyfill-CR86FF68.ts` → `polyfill-compat.ts` | Web Streams family + DEFLATE inflater + private-Symbol install of `Blob.arrayBuffer` + `throwIfAborted` |
| **CR61FF58** (`jszipp/browser-legacy/cr61ff58`) | Chrome 61 / Firefox 58 | **`es2015`** | `polyfill-CR61FF58.ts` → `polyfill-compat.ts` | everything CR86FF68 ships **plus** an AbortController/Signal poly, the `globalThis` stand-in, the `@@asyncIterator` fallback, and SWC's inlined async/regenerator runtime |

Notes that matter:

- The **modern baseline is gated by native `DecompressionStream`** (Chrome 80 /
  Firefox 113). That is the one feature the modern build refuses to polyfill, so
  it defines the floor. See `README.md` → Runtime.
- Each legacy build is named and tuned for the **weaker engine of its pair**.
  CR86FF68 carries the Web Streams ponyfill because **Firefox 68 lacks
  `TransformStream`** even though Chrome 86 has it. CR61FF58 downlevels async
  generators because **Chrome 61 lacks them** even though Firefox 58 has them.
- The version numbers below are practical baselines, not contractual minimums;
  `CONTRACT.md` owns the stable promises.

---

## 3. The polyfill seam

All Web-API access is routed through a single module boundary so the modern build
can collapse to native and tree-shake every byte of compat code away.

### 3.1 The four modules

- **`polyfill.ts`** — the native passthrough. Every binding is the platform
  global (`ReadableStream`, `TransformStream`, `AbortController`, …), the member
  keys `arrayBuffer_` / `throwIfAborted_` are the **native string names**,
  `installPolyfills()` is a no-op, and `DecompressionStream_` is read off the
  global. Used by the modern build and by typechecking. Carries zero polyfill
  weight and stays dependency-free.
- **`polyfill-compat.ts`** — the shared compat surface. Owns the hand-written Web
  Streams family, the `deflate-raw` `DecompressionStream` polyfill (a pure-JS
  inflater), the `glob` global stand-in, the `ASYNC_ITERATOR` key, the private
  **`arrayBuffer_` / `throwIfAborted_` Symbol keys**, and the symbol-keyed
  `installPolyfills()` prototype install. Bundled **only** into the two legacy
  builds.
- **`polyfill-CR86FF68.ts`** — thin entry for the Chrome 86 / Firefox 68 pair.
  Re-exports the keys / streams / `installPolyfills` from `polyfill-compat.ts` and
  uses the **native** `AbortController` (both engines have the base class; the
  symbol-keyed install adds `throwIfAborted` to the native `AbortSignal.prototype`).
- **`polyfill-CR61FF58.ts`** — thin entry for the Chrome 61 / Firefox 58 pair.
  Re-exports the keys / streams / DecompressionStream from `polyfill-compat.ts`, but
  supplies a **hand-written** `AbortController`/`AbortSignal` because Chrome 61 has
  no base class at all — its poly signal defines `[throwIfAborted_]` under the same
  private key. Reads `AbortController` through the shared `glob` stand-in (not bare
  `globalThis`).

### 3.2 How a build picks one

`index.ts` imports all three seam modules and selects at runtime with a ternary on
two build flags:

```ts
const polyfill_ = CR61FF58_ ? polyfillCR61FF58 : CR86FF68_ ? polyfillCR86FF68 : polyfillNative;
```

`CR61FF58` and `CR86FF68` are injected as **literal booleans** by
`rspack.DefinePlugin` (the same mechanism as `__DEV__`). Because the condition is
a literal, the minifier folds the ternary and **dead-code-eliminates the other
two seam modules**. In the modern build both flags are `false`, so the ternary
collapses to `polyfillNative` and *both* compat modules — and everything they
import — drop out. `package.json` has `"sideEffects": false`, which is what lets
this elimination actually reach the bundle.

`installPolyfills()` is called once at module load (in `index.ts`) before any
export is used. In a compat build it installs `arrayBuffer` / `throwIfAborted` onto
the real `Blob.prototype` / `AbortSignal.prototype`, but under **private Symbol
keys**, so native user objects inherit the methods while nothing observable changes
on the globals (§5.7). In the modern build it is a no-op (the methods already
exist). Keep the call: the call site keeps the install alive against tree-shaking
and ensures it runs before user code.

---

## 4. Build configuration (`rspack_config.mjs`)

### 4.1 Syntax targets, and the es2017 trap

| Build | SWC `jsc.target` | Minifier `ecma` | Why |
| ----- | ---------------- | --------------- | --- |
| Modern | `es2019` | 2019 | Native everything; object spread is native at es2019 so `unsafe_arrows` can stay on. |
| CR86FF68 | `es2019` | 2019 | Chrome 86 / Firefox 68 support async generators, `globalThis`, `?.`, `??` natively; only the runtime-API gaps (streams, DecompressionStream, `throwIfAborted`) need help. |
| CR61FF58 | **`es2015`** | 2015 | Chrome 61 cannot parse async generators / `for await` / optional catch binding. The target must be low enough that **SWC downlevels them**. |

**The trap (do not regress this):** SWC does **not** downlevel `async function*`
at `target: es2017`. It leaves it as native async-generator syntax. SWC only
downlevels async generators at **`es2016` or lower**. So `es2017` produces a
CR61FF58 bundle that Chrome 61 cannot even parse. The correct target is `es2015`
(the value the config comment always intended; an earlier revision passed
`es2017` by mistake). `es2016` would also work, but `es2015` is the conservative,
documented choice. The cost of `es2015` is that async/await is also downleveled to
SWC's **inlined, self-contained** regenerator (no external `regeneratorRuntime`
global required) — about **0.5 KB gzipped**, added to the CR61FF58 bundle only.

What `es2015` downleveling buys us, verified by transpiling the real sources:

- `async function*` / `for await` → inlined async-generator state machine.
- The library's only async generator is `readZipStream`; it stays a normal
  `for await`-able async iterable for callers (the feature is preserved).
- Optional catch binding `catch {}` → `catch (e) {}`.
- Optional chaining `?.` and nullish `??` → equivalent ES5/ES2015 expressions.
- Object spread `{...x}` → an `_object_spread` helper.

### 4.2 `unsafe_arrows` must stay OFF for the compat builds

Below `es2019`, SWC downlevels object spread to a helper that relies on
`arguments`. The `unsafe_arrows` compress pass rewrites such helpers to arrow
functions, which have no `arguments`, silently dropping fields. The compat
minimizer is therefore created with `unsafe_arrows: false`
(`mkMinimizer(ecma, false)`). The modern build keeps it on (object spread is
native there). Do not "simplify" this to one shared minimizer.

### 4.3 `output.globalObject` for the UMD wrappers

The UMD wrapper itself needs a global object to attach the library to. Setting
`output.globalObject: "globalThis"` makes rspack emit `globalThis` **in the
wrapper**, which is a `ReferenceError` on Chrome 61 / Firefox 58 before any of our
code runs. For the **CR61FF58 UMD outputs**, use a `self`/`this` fallback instead:

```js
globalObject: "typeof self !== 'undefined' ? self : this"
```

CR86FF68 and modern engines have `globalThis`, so their wrappers may keep it.

### 4.4 Property mangling allow-list

`mangle.props.regex` renames only internal fields that are never part of the
public surface. Option keys that arrive on user objects (`outputAs`, `mimeType`,
`comment`, `path`, …) must **never** be added to that regex — renaming the read
silently breaks callers. Re-run the full suite after touching the list.

---

## 5. Runtime-API coverage, feature by feature

This section is the canonical explanation of *why each polyfill exists* and
*which engines actually need it*.

### 5.1 `globalThis` → the `glob` stand-in

`globalThis` shipped in Chrome 71 / Firefox 65, so it is **absent on the CR61FF58
floor**. A bare reference throws `ReferenceError` before feature detection can
run. `polyfill-compat.ts` exports a single stand-in used everywhere a global is
read:

```ts
export const glob: typeof globalThis =
  (typeof globalThis !== "undefined" ? globalThis
    : typeof self !== "undefined" ? self
      : typeof window !== "undefined" ? window
        : {}) as typeof globalThis;
```

- `typeof x` on an undeclared name is itself safe (returns `"undefined"`), so the
  chain never throws.
- `self` exists in every browser context (windows and workers) far below the
  floor; `window` is the next fallback; `{}` is a last resort so feature-detect
  reads return `undefined` instead of throwing.
- No `eval` / `Function("return this")`, so it is **CSP-safe**.

**Rule:** inside any module that ships to a legacy build (`polyfill-compat.ts`,
`polyfill-CR61FF58.ts`), never reference `globalThis` directly except inside a
`typeof globalThis !== "undefined"` guard. Read globals through `glob`.
`polyfill.ts` is modern-only and may use `globalThis` directly.

### 5.2 Web Streams (ReadableStream / WritableStream / TransformStream / pipeThrough)

`TransformStream` and `pipeThrough` are missing on **Firefox < 102** and
**Chrome < 67**, so both legacy pairs need a real implementation
(`ZipTransformStream` extends `TransformStream_`, the default writer output is a
`ReadableStream_`, and deflate reading uses `pipeThrough`). `polyfill-compat.ts`
provides a small, hand-written WHATWG stream **family** that replaces the former
`web-streams-polyfill` dependency (which added ~67 KB / ~15 KB gzip per legacy
bundle for a slice of surface the library barely uses).

Two design rules are load-bearing and must not be broken:

- **The three classes are one family.** A polyfill `ReadableStream` can only
  `pipeThrough` a polyfill `TransformStream`; native `pipeThrough` rejects a
  readable that is not its own class. Because `ZipTransformStream` extends our
  `TransformStream_`, the readable side must also be ours. This is why the legacy
  builds use the ponyfill streams **uniformly**, even on engines that have some
  native stream classes.
- **It only implements the slice the library drives** (`{ start }` sources,
  `controller.enqueue/close/error`, `getReader().read/cancel/releaseLock`,
  `cancel`, `pipeTo`, `pipeThrough`, async iteration, and a `{ write, close,
  abort }` sink). It deliberately has no queuing strategy / backpressure, because
  the library always drains eagerly. The readable queue is head-indexed (O(1)
  dequeue, consumed slots freed, backing array released on full drain) so a large
  archive does not turn draining into O(n²). For the shape and rationale of the
  stream surface itself, see `streaming.md`.

### 5.3 `DecompressionStream("deflate-raw")` → the pure-JS inflater

Native `DecompressionStream` is Chrome 80 / Firefox 113 — i.e. the modern floor.
Both legacy pairs lack it (Firefox 68 and 58 entirely; Chrome 61 entirely; even
Chrome 86 cannot help, because a ponyfill `ReadableStream` cannot `pipeThrough` a
*native* `DecompressionStream`). So the legacy builds use a **pure-JS
`deflate-raw` inflater uniformly**, built on the ponyfill `TransformStream` so
`ponyfillReadable.pipeThrough(new DecompressionStreamPoly(...))` interoperates.

The inflater (`inflateRawDynamic`) is LUT-based with module-scoped scratch tables
reused across calls and the fixed Huffman tree built once. It is correctness-
checked against Node's `zlib` (see `testing.md` / `inflate_test.ts`). The modern
build tree-shakes this entire subsystem out.

### 5.4 `AbortController` / `AbortSignal` and `throwIfAborted`

- **Base class.** `AbortController` shipped in Chrome 66 / Firefox 57. **Chrome 61
  has no base class at all**, so `polyfill-CR61FF58.ts` supplies a minimal
  poll-based `AbortController`/`AbortSignal` (no `EventTarget`; the library only
  does `new AbortController().signal` and polls `signal.throwIfAborted()`). Where
  the platform class exists (Firefox 58) it is used unchanged, selected via
  `glob.AbortController ?? Poly`. CR86FF68 uses the native class directly.
- **`throwIfAborted`.** The method shipped in Chrome 100 / Firefox 97, so **both
  legacy pairs lack it** even when they have the base class. It is supplied through
  the seam's private-member-key install (see §5.7): the library calls
  `signal[throwIfAborted_]()`, where `throwIfAborted_` is the native string name in
  the modern build and a private Symbol in the compat builds. On Firefox 58/68 and
  Chrome 86 the Symbol method is attached to the native `AbortSignal.prototype`; on
  Chrome 61 the poll-based poly signal defines it directly. See `implementation.md`
  → Abort Support for how the library calls it.

### 5.5 `Symbol.asyncIterator` / async iteration → the `@@asyncIterator` fallback

`Symbol.asyncIterator` shipped in Chrome 63 / Firefox 57, so it is **undefined on
Chrome 61**. Two consequences:

1. **The library's `readZipStream` async generator.** Once the CR61FF58 target is
   `es2015` (§4.1), SWC downlevels it and keys the async iterator as
   `Symbol.asyncIterator || "@@asyncIterator"`. The string fallback works without
   the symbol, and it is the same convention Babel/SWC use, so a caller's
   downleveled `for await` finds it. No global `Symbol` mutation is required.
2. **The polyfill stream's own async iterator.** `polyfill-compat.ts` mirrors that
   exact fallback so its streams are async-iterable under the **same** key:

   ```ts
   const ASYNC_ITERATOR =
     ((typeof Symbol === "function" && Symbol.asyncIterator) || "@@asyncIterator") as symbol;
   // ...
   [ASYNC_ITERATOR](): AsyncIterableIterator<T> { /* ... */ }
   ```

   Using a literal `[Symbol.asyncIterator]` computed key here would be wrong on
   Chrome 61: `Symbol.asyncIterator` is `undefined`, so the method would be keyed
   under the string `"undefined"` and `for await` would never find it.

**Rule:** in code that ships to CR61FF58, never use a bare `[Symbol.asyncIterator]`
computed key. Use the `ASYNC_ITERATOR` constant (or the same
`Symbol.asyncIterator || "@@asyncIterator"` expression) so the key matches what
downleveled `for await` looks up.

### 5.6 `Blob.prototype.arrayBuffer()`

`Blob.prototype.arrayBuffer()` shipped in **Chrome 76 / Firefox 69**. The library
reads user-supplied `Blob` / `File` inputs through it in two places: the `openZip`
Blob/File source path and the entry-payload reader. On an engine without it a bare
`blob.arrayBuffer()` would throw `TypeError: … is not a function`.

This is the one gap that catches people out, so it is worth stating plainly:

- It affects **both legacy builds**. CR61FF58 obviously (Chrome 61 / Firefox 58).
- It **also affects CR86FF68 — but only because of Firefox 68.** Chrome 86 has
  `arrayBuffer()` (it is ≥ 76); Firefox 68 does not (it is < 69). This is the
  clearest example of the "**build for the weaker engine of the pair**" rule: the
  shim exists purely for the Firefox side, even though the Chrome side wouldn't
  need it.

The method is supplied through the seam's private-member-key install (§5.7),
backed by `FileReader` (`readAsArrayBuffer`), which is available on every target
engine (Chrome 6+ / Firefox 3.6+). The library reads via `blob[arrayBuffer_]()`;
in compat the method is attached to the real `Blob.prototype` under a private
Symbol (so a native user Blob/File inherits it) without adding any observable
string property.

### 5.7 The private member key (`arrayBuffer_` / `throwIfAborted_`)

`Blob.arrayBuffer` and `AbortSignal.throwIfAborted` are both **missing methods on a
class that already exists**, and the library calls them on **objects it does not
own** (a Blob/File or an `AbortSignal` handed in by the caller). That last point is
decisive: a caller's Blob is a *native* `Blob`, so a subclass can't help — the
method has to be reachable from the real `Blob.prototype` the user object inherits.

The trick is the **key** the method is installed and called under. The seam exports
`arrayBuffer_` / `throwIfAborted_`, and the library always indexes with them
(`blob[arrayBuffer_]()`, `signal[throwIfAborted_]()`):

- **Modern seam (`polyfill.ts`)** — the keys are the **native string names**:

  ```ts
  export const arrayBuffer_ = "arrayBuffer" as const;
  export const throwIfAborted_ = "throwIfAborted" as const;
  export const installPolyfills = (): void => undefined; // nothing to install
  ```

  So `blob[arrayBuffer_]()` is `blob["arrayBuffer"]()`, which rspack's module
  concatenation + minifier fold back to `blob.arrayBuffer()`. **The modern bundle is
  byte-for-byte the native call** — no overhead, no behaviour change.

- **Compat seam (`polyfill-compat.ts`)** — the keys are a **unique `Symbol` per
  build**, and `installPolyfills()` attaches the method to the real prototype under
  that Symbol (reusing the native method where the engine has it, a fallback where
  it doesn't):

  ```ts
  // typed as the native name so call sites typecheck; runtime value is a Symbol
  export const arrayBuffer_ = Symbol("jszipp.arrayBuffer") as unknown as "arrayBuffer";
  export const throwIfAborted_ = Symbol("jszipp.throwIfAborted") as unknown as "throwIfAborted";

  export const installPolyfills = (): void => {
    const B = glob.Blob;
    if (B) {
      const proto = B.prototype as unknown as Record<PropertyKey, unknown>;
      if (!proto[arrayBuffer_]) {
        proto[arrayBuffer_] = typeof (proto as { arrayBuffer?: unknown }).arrayBuffer === "function"
          ? (proto as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer   // native fast path
          : function (this: Blob) { return readBlobBytes(this); };               // FileReader fallback
      }
    }
    // AbortSignal: same, where the base exists (FF58/FF68/Chrome 86). Chrome 61 has
    // no global AbortSignal, so this finds nothing and the poly signal carries the
    // method itself.
    // ...
  };
  ```

**Why a Symbol, not a string.** Installing under the native string name *would*
work, but it would change the **observable global**: `"arrayBuffer" in Blob.prototype`
and `typeof Blob.prototype.arrayBuffer` would start reporting a method that the
engine does not actually have, which can confuse other libraries' feature
detection. A Symbol key is skipped by `for…in`, `Object.keys`, `JSON`, and does not
shadow the spec method, so feature-detection still reports the true answer; the only
way to see it is `Object.getOwnPropertySymbols`. The polyfill is present where the
library needs it and invisible everywhere else.

**Chrome 61 / `AbortSignal`.** Chrome 61 has no `AbortSignal` base class to attach
to, so `polyfill-CR61FF58.ts`'s poll-based signal defines `[throwIfAborted_]` on its
own class (under the same imported Symbol). On Firefox 58 that build uses the native
`AbortController`, and `installPolyfills` attaches the Symbol method to the native
`AbortSignal.prototype` — so caller-supplied native signals work there too.

**Call sites.** `index.ts` uses `source[arrayBuffer_]()` / `input[arrayBuffer_]()`
and `signal?.[throwIfAborted_]()`. The `instanceof Blob` **detection** stays on the
global `Blob` (a user Blob is a native Blob). Because the keys come from the seam,
the existing `CR61FF58` / `CR86FF68` build flags already determine string-vs-Symbol
— no extra rspack constant is needed. (A Symbol *can't* be DefinePlugin-injected
anyway: each textual occurrence would create a different Symbol, so it must be
defined once in the seam module and imported.)

### 5.8 Never hand the polyfilled output stream to native `Response`

`ZipWriter`'s output is a `ReadableStream_`, which is the **polyfilled** stream in
the compat builds. The native `Response` constructor (and `Request`, and the fetch
body machinery) brand-checks its body for a *real* `ReadableStream`; a poly stream
fails that check and is coerced to a `USVString`, so `new Response(polyStream)`
silently produces a body of the literal text `"[object Object]"` rather than the
archive bytes. This is a **silent corruption**, not a throw — easy to miss because
the Node tests run the native seam where it works.

So the `blob` / `response` output modes must not pass the poly stream to `Response`.
The seam exposes `responseAcceptsStream_` (modern `true`, compat `false`); `close()`
keeps the native streaming path on modern and **drains the poly stream to bytes**
in the compat builds, building the Blob/Response from a `BufferSource` instead:

```ts
if (this.outputAs === "response") {
  const body = responseAcceptsStream_ ? this.output : await readStream(this.output, signal);
  return new Response(body, { headers: { "Content-Type": this.mimeType } });
}
```

This buffers the whole archive for those two modes on legacy engines (acceptable —
`blob` was always fully materialised, and streaming `response` is preserved on
modern). The general rule: a polyfilled stream may only flow through the **poly
family** (its own `pipeThrough` / `getReader` / async iteration) or be drained by the
library; it must never be passed to a native stream-consuming Web API.

---

## 6. Feature → minimum native browser reference

Approximate "first stable version" for every feature this library touches. Use it
to reason about which build covers what; `CONTRACT.md` owns the contractual
promises.

| Feature | Chrome | Firefox | Needed natively by | How legacy builds cover it |
| ------- | ------ | ------- | ------------------ | -------------------------- |
| `DecompressionStream` (`deflate-raw`) | 80 | 113 | Modern (defines the floor) | Pure-JS inflater (§5.3) |
| `Blob.prototype.arrayBuffer()` | 76 | 69 | Modern | `installPolyfills` Symbol-key install + FileReader fallback — both legacy builds, incl. **Firefox 68** (§5.6, §5.7) |
| `globalThis` | 71 | 65 | Modern, CR86FF68 | `glob` stand-in (§5.1) |
| `TransformStream` / `pipeThrough` | 67 | 102 | Modern | Ponyfill stream family (§5.2) |
| `AbortController` / `AbortSignal` | 66 | 57 | Modern, CR86FF68 | Hand-written poly on CR61FF58 (§5.4) |
| `catch {}` (optional catch binding) | 66 | 58 | Modern, CR86FF68 | Downleveled at `es2015` (§4.1) |
| `async function*` / `for await` / `Symbol.asyncIterator` | 63 | 57 | Modern, CR86FF68 | Downleveled + `@@asyncIterator` fallback (§4.1, §5.5) |
| `WritableStream` | 59 | 100 | Modern | Ponyfill stream family (§5.2) |
| `ReadableStream` | 43 | 65 | Modern | Ponyfill stream family (§5.2) |
| `AbortSignal#throwIfAborted` | 100 | 97 | Modern | `installPolyfills` Symbol-key install; poly signal on Chrome 61 (§5.4, §5.7) |
| `?.` / `??` | 80 | 72 | Modern | Downleveled (≤ `es2017`) |
| Object spread `{...x}` | 60 | 55 | Modern, CR86FF68 | Downleveled helper (§4.2) |

(Chrome 86 / Firefox 68 and Chrome 61 / Firefox 58 are the legacy floors. A build
is always built for the **weaker engine of its pair**, so a feature can need a
shim because of just one side: `Blob.prototype.arrayBuffer()` (Chrome 76 / Firefox
69) is present on the Chrome 86 side of CR86FF68 but missing on the Firefox 68
side, so CR86FF68 ships the shim regardless.)

---

## 7. Invariants every contributor must preserve

A change that violates any of these can pass typecheck and the Node test suite yet
break a real legacy browser, because the tests run the **source** (native seam),
not the transpiled legacy bundle.

1. **Modern build stays native and dependency-free.** Never import a runtime
   dependency into `index.ts` / `polyfill.ts`, and never make `polyfill.ts`
   anything other than a native passthrough. The 70 KB `web-streams-polyfill`
   removal must not creep back in.
2. **Route Web-API access through the seam.** New use of a stream / abort /
   compression global goes through `polyfill_`, not a direct global read, so the
   modern build can collapse it to native and the legacy builds can substitute.
   This includes methods on existing classes: read user Blobs via
   `blob[arrayBuffer_]()` and check signals via `signal?.[throwIfAborted_]()`, never
   `blob.arrayBuffer()` / `sig.throwIfAborted()` directly (§5.7).
3. **No bare `globalThis` in legacy-bundled code.** Use `glob` (§5.1). The only
   permitted bare reference is inside a `typeof globalThis !== "undefined"` guard.
4. **No bare `[Symbol.asyncIterator]` in legacy-bundled code.** Use the
   `ASYNC_ITERATOR` fallback key (§5.5).
5. **Keep the CR61FF58 syntax target at `es2015`** (or at most `es2016`). Raising
   it to `es2017+` reintroduces native `async function*`, which Chrome 61 cannot
   parse (§4.1).
6. **Keep `unsafe_arrows: false` for the compat minimizer** (§4.2).
7. **Keep the stream classes one family.** Do not mix native and ponyfill stream
   classes across a `pipeThrough` boundary (§5.2), and never pass the polyfilled
   output stream to a native stream-consuming API such as `Response` / `Request` /
   `fetch` — it is silently coerced to `"[object Object]"`; drain it to bytes first
   (§5.8).
8. **Keep the compat prototype install Symbol-keyed.** Compat methods
   (`Blob.arrayBuffer`, `AbortSignal.throwIfAborted`) are attached to the real
   prototypes under the private `arrayBuffer_` / `throwIfAborted_` Symbols, never
   the native string name — so the observable global surface (and other libraries'
   feature detection) is unchanged. `installPolyfills()` runs once at load; keep the
   call so it is not tree-shaken (§5.7).
9. **Preserve the public API and error categories across all builds.** Adding a
   compat measure must never remove or alter a feature, an exported name, or an
   exception class / DOMException name (`CONTRACT.md`).

---

## 8. How to verify a compatibility change

Typecheck and the Node suite are necessary but **not sufficient** — they exercise
the native seam. To prove a legacy build is actually safe, inspect the transpiled
output.

1. **Typecheck:** `tsc --noEmit` must stay clean (strict mode).
2. **Behavior:** run the suite (`vitest run`). The DEFLATE inflater and stream
   pipeline are checked against Node `zlib` in `inflate_test.ts`; see
   `testing.md`.
3. **Transpiled-syntax audit (the step people forget).** Transpile the changed
   source at the legacy target and confirm no un-parseable syntax survives:

   ```js
   // node check: does the CR61FF58 (es2015) output ship anything Chrome 61 can't parse?
   const { transform } = require("@swc/core");
   const fs = require("fs");
   const code = (await transform(fs.readFileSync("src/index.ts", "utf8"), {
     filename: "src/index.ts",
     jsc: { parser: { syntax: "typescript" }, target: "es2015", externalHelpers: false },
     module: { type: "es6" },
   })).code;

   // All of these must be false / clean:
   /async\s+function\s*\*/.test(code);            // native async generator
   /for\s+await/.test(code);                      // native for-await (ignore matches inside comments)
   /catch\s*\{/.test(code);                       // optional catch binding
   /(^|[^.\w"])globalThis/.test(code             // bare globalThis...
       .replace(/typeof globalThis/g, "_"));      // ...other than a typeof guard
   ```

4. **Compat smoke test (faithful runtime-API floor emulation).** This is **not a
   real browser** — it runs in Node on a modern V8 and emulates a floor by
   *deleting* the native Web-API globals that floor's weaker engine lacks before the
   bundle loads, so V8 misses those lookups exactly as the old engine would. It
   therefore tests the **runtime-API gap only** (kind #2 in §1); the syntax gap
   (kind #1) is step 3's job, and the wrapper/`FileReader` paths are step 5's.

   Run `pnpm run build` then `pnpm run test:compat-smoke` (or
   `node scripts/compat-smoke-test.mjs`). For each compat build it spawns a child
   process, **deletes the native Web-API globals the floor's weaker engine lacks**
   (CR61FF58: `ReadableStream` / `WritableStream` / `TransformStream` /
   `DecompressionStream` / `AbortController` / `AbortSignal`; CR86FF68:
   `TransformStream` / `WritableStream` / `DecompressionStream` plus
   `AbortSignal.prototype.throwIfAborted`), loads the **built UMD** as a browser
   `<script>` would (global assignment), and runs real round-trips: a
   `ZipWriter → openZip` round-trip whose deflated entry forces the **pure-JS
   inflater** (native `DecompressionStream` is gone), the writer's ponyfill
   `ReadableStream` piped into `readZipStream` `for await`, and — on CR86FF68, where
   a native `AbortSignal` can exist — an already-aborted signal that must reject via
   the `throwIfAborted_` seam. A green run is honest proof that the bundled polyfills
   **actually wire up and run** — the exact class of regression the native-seam
   suite cannot catch. See `testing.md` → *Compat smoke test*.

   What a green run does **not** prove (do not over-read it):
   - **Syntax** the floor cannot parse — Node's V8 parses `async function*`, `?.`,
     etc., so an un-downleveled bundle passes here yet `SyntaxError`s on real Chrome
     61. Guarded by step 3.
   - **The UMD wrapper's `globalObject` choice (§4.3)** and a **bare `globalThis` in
     library code** — Node always has `globalThis` (and the harness sets `self`), so
     a missing `glob` stand-in cannot surface here; only a real engine that lacks
     `globalThis` exposes it (step 5).
   - **The `Blob.prototype.arrayBuffer` FileReader fallback** — it needs a DOM
     `FileReader`, which Node has no built-in for, so the harness uses
     `Uint8Array` / stream sources, never a `Blob` source (step 5).
   - **The `@@asyncIterator` divergence** — it only differs from
     `Symbol.asyncIterator` when the latter is undefined; deleting it process-wide
     would break the harness's own `for await`, so the divergent key is left to step
     3 while the `for await` path itself is still exercised.

5. **Real browser.** Two complementary checks exercise a genuine engine:

   - **Modern engine, automated.** The Playwright end-to-end smoke test (`e2e/`,
     run with `pnpm run test:e2e`) loads the built **ESM** bundle in headless
     Chromium through the `demo/compress.html` demo and validates the archive the
     browser produces with an independent reader. This automates the real-engine
     round-trip for a modern browser. See
     [testing.md → End-to-end browser smoke test](testing.md#end-to-end-browser-smoke-test-real-engine).
     Because it runs a modern Chromium and the ESM build, it does **not** cover the
     legacy floors or the UMD wrapper.
   - **Legacy floor, manual.** When feasible, load the built **UMD** in an actual
     Chrome 61 / Firefox 58 (or 86 / 68) and run the same round-trip. This remains
     the only check that exercises the UMD wrapper's `globalObject` choice (§4.3)
     and the `FileReader` Blob path against a genuine *old* engine; Playwright's
     bundled Chromium cannot stand in for those floors.

---

## 9. Adding or changing a target

1. Pick the **weaker engine** of the pair and look up every feature in §6 against
   it. Anything the weaker engine lacks must be covered by a polyfill (runtime
   gap) or a lower syntax target (syntax gap).
2. Set the SWC `jsc.target` and the minifier `ecma` to the **highest** level the
   weaker engine fully parses. Lower if any §6 syntax feature is unsupported.
   Remember the es2017 async-generator trap (§4.1).
3. Add a `DefinePlugin` flag and a thin `polyfill-<TARGET>.ts` entry that
   re-exports `polyfill-compat.ts` and supplies only the deltas unique to the
   pair (as `polyfill-CR61FF58.ts` supplies its AbortController poly).
4. Wire the flag into the `index.ts` selection ternary.
5. Set a Chrome-/Firefox-safe `output.globalObject` for that build's UMD outputs
   if the floor lacks `globalThis` (§4.3).
6. Run §8 against the new target, including the transpiled-syntax audit.
7. Update §2, §6, `README.md` (subpaths / CDN tags), and `CONTRACT.md` if the
   supported floor changes.

---

## 10. Non-goals and residual risk

- **Not a general ES polyfill.** JSZipp polyfills only the Web APIs and syntax its
  own code needs. It does not provide `Promise`, `Symbol`, `Map`, `TypedArray`,
  `TextEncoder`/`TextDecoder`, etc.; the floor engines already have them. An app
  targeting something below the floors must bring its own core polyfills.
- **`new Response(stream)` on legacy engines.** `outputAs: "blob" | "response"`
  hands the writer's `ReadableStream` to a native `Response`. A ponyfill stream is
  not a native `ReadableStream`, so this behaves exactly as it did with
  `web-streams-polyfill` (no better, no worse). On engines whose `Response` does
  not accept the writer's stream, prefer `outputAs: "uint8array"` /
  `"arraybuffer"`, which fully materialize bytes.
- **The Node test suite runs the native seam.** It cannot, by itself, catch a
  legacy-only regression. Two checks cover the two classes: the transpiled-syntax
  audit (§8.3) guards against **syntax** the floor cannot parse, and the compat
  smoke test (§8.4) guards against **runtime/global** gaps by running the built
  compat bundle with the floor's native APIs removed.
