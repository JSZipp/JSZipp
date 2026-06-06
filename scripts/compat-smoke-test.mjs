// Compat-floor emulation smoke test for the compat builds (CR61FF58 / CR86FF68).
//
// This is NOT a real browser. It runs in Node, on a modern V8, and EMULATES a
// legacy floor by deleting the native Web-API globals that floor's weaker engine
// lacks (e.g. `delete globalThis.DecompressionStream`) BEFORE loading the bundle.
// V8 then misses those lookups exactly as Chrome 61 / Firefox 58 would, forcing
// the bundled polyfills to run. That makes it a faithful test of the RUNTIME-API
// gap (gap kind #2 in browser-compatibility.md §1) and nothing else.
//
// Why it exists: the Vitest suite and the typecheck both run the *source* tree,
// i.e. the NATIVE polyfill seam (polyfill.ts), so they cannot catch a legacy-only
// runtime regression — a polyfill that is bundled but never actually wires up, a
// ponyfill stream that cannot pipeThrough the inflater, an aborted signal that no
// longer rejects. This script closes that gap by loading the BUILT compat UMD with
// the floor's native globals removed, then running real ZIP round-trips through it.
// See browser-compatibility.md §8 (How to verify) and testing.md (Compat smoke test).
//
// What it deliberately does NOT prove (do not read more into a green run):
//   * SYNTAX the floor cannot parse (gap kind #1: `async function*`, `?.`, optional
//     catch binding). Node's V8 parses all of it; a bundle shipping un-downleveled
//     syntax would pass here yet `SyntaxError` on a real Chrome 61. That class is
//     guarded by the transpiled-syntax audit (§8.3), not here.
//   * The UMD wrapper's `globalObject` choice (§4.3). Node always has `globalThis`
//     and we set `self`, so a wrapper that wrongly emitted bare `globalThis` would
//     not surface here — only on a real engine that lacks it (§8.5).
//   * The `Blob.prototype.arrayBuffer` FileReader fallback on the COMPAT floors: it
//     needs a DOM `FileReader`, which Node has no built-in for, so the harness uses
//     Uint8Array / stream sources only. The modern build's Blob path IS covered by the
//     Playwright e2e test (demo/compress.html selects files via `<input>` and passes
//     them as Blob/File to ZipWriter), which runs in a real Chromium. However, the
//     CR61FF58 and CR86FF68 compat builds' FileReader fallback can only be proven by
//     loading the UMD in an actual Chrome 61 / Firefox 58/68 respectively (§8.5).
//   * The `@@asyncIterator` fallback key only diverges from `Symbol.asyncIterator`
//     when the latter is undefined (Chrome 61). Deleting it process-wide would also
//     break the harness's own `for await`, so the divergent key is left to the
//     syntax audit; here `for await` over the library stream is still exercised.
//
// In short: a faithful runtime-API floor emulation, not a substitute for loading
// the UMD in an actual old browser (§8.5).
//
// Run after a build:
//   pnpm run build && node scripts/compat-smoke-test.mjs
// or via the package script:
//   pnpm run test:compat-smoke

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The runtime Web-API globals each floor's WEAKER engine lacks. Deleting these
// before the bundle loads forces the bundled polyfills to actually run. (Syntax
// gaps are a separate, build-time concern — see the audit in §8.3.)
const TARGETS = {
  // Chrome 61 / Firefox 58. Firefox 58 lacks ReadableStream (FF65) and the whole
  // TransformStream/WritableStream family; Chrome 61 lacks AbortController/Signal
  // and DecompressionStream. Union of both = everything below.
  cr61ff58: {
    bundle: "../dist/cr61ff58/jszipp.umd.js",
    drop: ["ReadableStream", "WritableStream", "TransformStream", "DecompressionStream", "AbortController", "AbortSignal"],
    // Chrome 61 has no native AbortSignal to construct, so a user-supplied signal
    // is not representative of this floor; the AbortController poly is instead
    // exercised internally by every write (encoder.signal). Skip the user-abort
    // assertion here.
    userAbort: false
  },
  // Chrome 86 / Firefox 68. Both HAVE ReadableStream + AbortController; the real
  // gaps are TransformStream/WritableStream (FF68), DecompressionStream (both), and
  // throwIfAborted (both — Chrome 100 / Firefox 97). Blob.arrayBuffer is also
  // missing on FF68, but that path needs a Blob source (out of scope above).
  cr86ff68: {
    bundle: "../dist/cr86ff68/jszipp.umd.js",
    drop: ["WritableStream", "TransformStream", "DecompressionStream"],
    dropMethods: [["AbortSignal", "prototype", "throwIfAborted"]],
    userAbort: true
  }
};

const STORED = "stored entry — must not need the inflater";
// Repetitive payload so it is guaranteed to be DEFLATE-compressed (method 0x08),
// which forces the pure-JS inflater to run on read (native DecompressionStream is
// removed). A short non-repetitive string could be stored instead and skip it.
const DEFLATED = "JSZipp compat smoke ".repeat(400);

// ---------------------------------------------------------------------------
// Child mode: run inside a process whose globals have already been stripped.
// ---------------------------------------------------------------------------
async function runChild(targetName) {
  const cfg = TARGETS[targetName];
  const NativeReadableStream = globalThis.ReadableStream; // capture before dropping

  for (const name of cfg.drop) delete globalThis[name];
  for (const path of cfg.dropMethods ?? []) {
    let obj = globalThis;
    for (let i = 0; i < path.length - 1; i++) obj = obj?.[path[i]];
    if (obj) delete obj[path[path.length - 1]];
  }

  // Emulate a browser environment for the UMD wrapper: a browser always has a
  // global `self`, which is the object the wrapper attaches the library to (the
  // CR61FF58 wrapper deliberately uses `self`/`this`, never bare `globalThis` —
  // browser-compatibility.md §4.3). Node's ESM loader provides neither, so define
  // `self` here; the wrapper then assigns `self.JSZipp` exactly as a `<script>`
  // tag would. (A wrapper that emitted bare `globalThis` would only fail on a real
  // engine that lacks it, so it surfaces only in §8.5, not in this emulation.)
  globalThis.self ??= globalThis;
  delete globalThis.JSZipp;

  const bundleUrl = new URL(cfg.bundle, import.meta.url);
  const checks = [];
  const pass = (name) => checks.push(`  ok   ${name}`);
  const fail = (name, detail) => { checks.push(`  FAIL ${name}: ${detail}`); process.exitCode = 1; };

  // 1) The bundle loads at all. This catches a module-init failure caused by the
  //    globals we just deleted — e.g. top-level code that touches a now-missing
  //    `TransformStream`/`AbortController`. It does NOT catch a bare `globalThis`
  //    in library code: Node still has `globalThis`, so the `glob` stand-in's job
  //    (surviving an engine that lacks it) can only be proven on a real floor
  //    (§8.5). The UMD assigns its export to the global as a load side effect.
  let JSZipp;
  try {
    await import(bundleUrl.href);
    JSZipp = globalThis.JSZipp;
    if (!JSZipp) throw new Error("UMD did not attach the JSZipp global");
    pass("bundle loads with native streams/abort removed");
  } catch (err) {
    fail("bundle loads", err?.stack || err?.message || String(err));
    report(targetName, cfg, checks);
    return;
  }

  const { ZipWriter, openZip, readZipStream } = JSZipp;

  // 2) Writer -> openZip round-trip (random access). The DEFLATED entry forces the
  //    pure-JS inflater; the STORED entry checks the plain path.
  try {
    const w = new ZipWriter({ outputAs: "uint8array" });
    await w.add({ path: "stored.txt", data: STORED, level: 0 });
    await w.add({ path: "deflated.txt", data: DEFLATED }); // default level -> deflate
    const bytes = await w.close();
    if (!(bytes instanceof Uint8Array)) throw new Error("close() did not return Uint8Array");

    const zip = await openZip(bytes, { maxArchiveSize: 1 << 20, maxEntrySize: 1 << 20 });
    const storedText = await zip.get("stored.txt")?.text();
    const deflatedEntry = zip.get("deflated.txt");
    const deflatedText = await deflatedEntry?.text();
    await zip.close();

    if (storedText !== STORED) throw new Error("stored entry text mismatch");
    if (deflatedText !== DEFLATED) throw new Error("deflated entry text mismatch");
    if (!(deflatedEntry.compressedSize < deflatedEntry.size)) {
      throw new Error(`deflated entry was not compressed (compressed ${deflatedEntry.compressedSize} >= size ${deflatedEntry.size})`);
    }
    pass("ZipWriter -> openZip round-trip (stored + inflater-backed deflate)");
  } catch (err) {
    fail("ZipWriter -> openZip round-trip", err?.message || String(err));
  }

  // 3) Poly ReadableStream -> readZipStream `for await`. The writer's "stream"
  //    output is the ponyfill ReadableStream in compat; feeding it to readZipStream
  //    keeps the whole pipe inside the poly stream family (invariant #7) and drives
  //    pipeThrough(inflater) + async iteration end to end.
  try {
    const w = new ZipWriter({ outputAs: "stream" });
    await w.add({ path: "stream-deflated.txt", data: DEFLATED });
    const stream = await w.close();

    if (NativeReadableStream && stream instanceof NativeReadableStream) {
      throw new Error("writer output is a NATIVE ReadableStream; ponyfill not in use");
    }

    const seen = new Map();
    for await (const entry of readZipStream(stream, { maxEntrySize: 1 << 20 })) {
      seen.set(entry.path, await entry.text());
    }
    if (seen.get("stream-deflated.txt") !== DEFLATED) throw new Error("stream entry text mismatch");
    pass("poly ReadableStream -> readZipStream for-await (deflate)");
  } catch (err) {
    fail("readZipStream for-await", err?.message || String(err));
  }

  // 4) User-supplied already-aborted signal rejects (throwIfAborted_ seam). Only on
  //    CR86FF68, where a native AbortSignal can exist (see TARGETS note).
  if (cfg.userAbort) {
    try {
      const ac = new AbortController();
      ac.abort();
      const w = new ZipWriter({ outputAs: "uint8array" });
      await w.add({ path: "x.txt", data: "x", level: 0 });
      const bytes = await w.close();
      let threw = false;
      try {
        await openZip(bytes, { signal: ac.signal });
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("openZip did not reject an already-aborted signal");
      pass("already-aborted signal rejected (throwIfAborted seam)");
    } catch (err) {
      fail("aborted-signal rejection", err?.message || String(err));
    }
  }

  report(targetName, cfg, checks);
}

function report(targetName, cfg, checks) {
  const ok = !checks.some((c) => c.includes("FAIL"));
  console.log(`\n[${targetName}] dropped globals: ${cfg.drop.join(", ")}` +
    (cfg.dropMethods ? ` (+ ${cfg.dropMethods.map((p) => p.join(".")).join(", ")})` : ""));
  for (const line of checks) console.log(line);
  console.log(`[${targetName}] ${ok ? "PASS" : "FAIL"}`);
}

// ---------------------------------------------------------------------------
// Parent mode: spawn one stripped child per target so the global deletions are
// isolated (and the module cache is fresh) for each build.
// ---------------------------------------------------------------------------
function runParent() {
  const self = fileURLToPath(import.meta.url);
  let failed = false;

  for (const [name, cfg] of Object.entries(TARGETS)) {
    if (!existsSync(new URL(cfg.bundle, import.meta.url))) {
      console.error(`\n[${name}] FAIL: bundle not found at ${cfg.bundle}\n` +
        "Run `pnpm run build` first (the compat bundles live under dist/cr61ff58 and dist/cr86ff68).");
      failed = true;
      continue;
    }
    const res = spawnSync(process.execPath, [self], {
      stdio: "inherit",
      env: { ...process.env, JSZIPP_SMOKE_TARGET: name }
    });
    if (res.status !== 0) failed = true;
  }

  console.log(`\nCompat smoke test: ${failed ? "FAIL" : "PASS"}`);
  process.exit(failed ? 1 : 0);
}

const target = process.env.JSZIPP_SMOKE_TARGET;
if (target) {
  await runChild(target);
} else {
  runParent();
}
