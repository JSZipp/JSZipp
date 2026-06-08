import { defineConfig } from "@rspack/cli";
import { rspack } from "@rspack/core";

// unsafeArrows defaults on (safe for the es2019 modern builds where object spread
// is native). It MUST be off for the compat builds: below es2019, SWC downlevels
// object spread to a helper that relies on `arguments`, and unsafe_arrows rewrites
// that helper to an arrow function — which has no `arguments` — silently dropping
// fields. See compatBase below.
const mkMinimizer = (ecma, unsafeArrows = true) =>
  new rspack.SwcJsMinimizerRspackPlugin({
        minimizerOptions: {
          ecma,
          compress: {
            ecma,
            arrows: true,
            unsafe_arrows: unsafeArrows,
            booleans: true,
            booleans_as_integers: true,
            collapse_vars: true,
            comparisons: true,
            conditionals: true,
            dead_code: true,
            evaluate: true,
            hoist_props: true,
            if_return: true,
            join_vars: true,
            keep_fargs: false,
            passes: 3,
            reduce_funcs: true,
            reduce_vars: true,
            sequences: true,
            side_effects: true,
            typeofs: true,
            unused: true
          },
          // toplevel mangling is safe: the only thing the UMD wrapper exposes is
          // the single global, so every top-level binding can be renamed.
          //
          // Property mangling is OPT-IN and limited to fields that are *never*
          // part of the public surface (option keys, ZIP-structure fields, or
          // anything read off a host object). outputAs/mimeType/comment/path/etc.
          // must NOT appear here — they arrive on user-supplied objects, and
          // renaming the internal read silently breaks them. Run the full test
          // suite after touching this list.
          mangle: {
            toplevel: true,
            props: {
              regex: "^(bitBuffer|bitCount|consumed|encoder|collected|assertOpen)$"
            }
          },
          format: { comments: false }
        }
      });

const modernDefines = (namespace = true) => ({
  __DEV__: "false",
  // Older-browser flags OFF: modern builds collapse the polyfill seam to
  // native and tree-shake the compat modules + web-streams-polyfill out.
  CR61FF58: "false",
  CR86FF68: "false",
  // Sub-entry UMD bundles import selected exports from src/index.ts. This flag
  // prevents src/index.ts from materializing the full default namespace when
  // that would keep the opposite half of the library alive.
  __JSZIPP_NAMESPACE__: String(namespace)
});

const compatDefines = (flag, namespace = true) => ({
  __DEV__: "false",
  CR61FF58: String(flag === "CR61FF58"),
  CR86FF68: String(flag === "CR86FF68"),
  __JSZIPP_NAMESPACE__: String(namespace)
});

const withModernApiFlags = (config, namespace) => ({
  ...config,
  plugins: [new rspack.DefinePlugin(modernDefines(namespace))]
});

const compatBuild = (flag, esTarget, ecma, externalHelpers = false, namespace = true) => ({
  ...compatBase(flag, esTarget, ecma, externalHelpers),
  plugins: [new rspack.DefinePlugin(compatDefines(flag, namespace))]
});

const base = {
  mode: "production",
  target: ["web", "es2019"],
  devtool: false,
  plugins: [
    new rspack.DefinePlugin(modernDefines())
  ],
  optimization: {
    minimize: true,
    moduleIds: "deterministic",
    sideEffects: true,
    usedExports: true,
    minimizer: [
      mkMinimizer(2019)
    ]
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        type: "javascript/auto",
        use: {
          loader: "builtin:swc-loader",
          options: { jsc: { parser: { syntax: "typescript" }, target: "es2019" } }
        }
      }
    ]
  },
  resolve: { extensions: [".ts", ".js"] }
};

// Compat build factory: same as `base` but flips one older-browser flag on (own
// DefinePlugin) and lowers the JS-syntax target so the bundle parses on the
// oldest engine in the pair (Chrome 61 ~ ES2017 -> target ES2015; Chrome 86 /
// Firefox 68 -> ES2019). Runtime Web-API gaps are covered by the bundled
// polyfill; this only addresses syntax level.
const compatBase = (flag, esTarget, ecma, externalHelpers = false) => ({
  ...base,
  target: ["web", esTarget],
  plugins: [
    new rspack.DefinePlugin(compatDefines(flag))
  ],
  optimization: { ...base.optimization, minimizer: [mkMinimizer(ecma, false)] },
  module: {
    rules: [{
      test: /\.ts$/,
      type: "javascript/auto",
      use: {
        loader: "builtin:swc-loader",
        options: { jsc: { parser: { syntax: "typescript" }, target: esTarget }, externalHelpers }
      }
    }]
  }
});

const dist = new URL("dist", import.meta.url).pathname;
const cr61ff58Dist = new URL("dist/cr61ff58", import.meta.url).pathname;
const cr86ff68Dist = new URL("dist/cr86ff68", import.meta.url).pathname;
const umd = (name) => ({ name, type: "umd", export: "default" });
const cjs = { type: "commonjs2", export: "default" };

export default defineConfig([
  // ESM (full) — modern-module so bundlers can still tree-shake on top.
  {
    ...base,
    entry: "./src/index.ts",
    experiments: { outputModule: true },
    output: { filename: "jszipp.mjs", path: dist, library: { type: "modern-module" } }
  },
  // Worker async plugin/script — keep diagnostics adjacent to the matching main build.
  {
    ...base,
    entry: "./src/worker-plugin.ts",
    experiments: { outputModule: true },
    output: { filename: "jszipp.worker-plugin.mjs", path: dist, library: { type: "modern-module" } }
  },
  // ESM worker script — static file for CSP-safe Worker construction.
  {
    ...withModernApiFlags(base, false),
    entry: "./src/worker-script.ts",
    experiments: { outputModule: true },
    output: { filename: "jszipp.worker.mjs", path: dist, library: { type: "modern-module" } }
  },
  // UMD (full) — JSZipp global, both reader + writer.
  {
    ...base,
    entry: "./src/index.ts",
    output: { filename: "jszipp.umd.js", path: dist, globalObject: "globalThis", library: umd("JSZipp") }
  },
  {
    ...base,
    entry: "./src/worker-plugin.ts",
    output: { filename: "jszipp.worker-plugin.umd.js", path: dist, globalObject: "globalThis", library: umd("JSZippWorkerPlugin") }
  },
  {
    ...withModernApiFlags(base, false),
    entry: "./src/worker-script.ts",
    output: { filename: "jszipp.worker.js", path: dist, globalObject: "globalThis", library: umd("JSZippWorker") }
  },
  // CJS (full) — Node/CommonJS require() entry.
  {
    ...base,
    entry: "./src/index.ts",
    output: { filename: "jszipp.cjs", path: dist, library: cjs }
  },
  {
    ...base,
    entry: "./src/worker-plugin.ts",
    output: { filename: "jszipp.worker-plugin.cjs", path: dist, library: cjs }
  },
  // UMD (writer-only) — JSZippWriter global; reader tree-shaken out.
  {
    ...withModernApiFlags(base, false),
    entry: "./src/writer.ts",
    output: { filename: "jszipp.writer.umd.js", path: dist, globalObject: "globalThis", library: umd("JSZippWriter") }
  },
  // UMD (reader-only) — JSZippReader global; compressor tree-shaken out.
  {
    ...withModernApiFlags(base, false),
    entry: "./src/reader.ts",
    output: { filename: "jszipp.reader.umd.js", path: dist, globalObject: "globalThis", library: umd("JSZippReader") }
  },
  // ---- Compat: CR61FF58 (min Chrome 61 / Firefox 58) ----
  {
    ...compatBuild("CR61FF58", "es2015", 2015, true),
    entry: "./src/index.ts",
    experiments: { outputModule: true },
    output: { filename: "jszipp.mjs", path: cr61ff58Dist, library: { type: "modern-module" } }
  },
  {
    ...compatBuild("CR61FF58", "es2015", 2015, true, false),
    entry: "./src/worker-plugin.ts",
    experiments: { outputModule: true },
    output: { filename: "jszipp.worker-plugin.mjs", path: cr61ff58Dist, library: { type: "modern-module" } }
  },
  {
    ...compatBuild("CR61FF58", "es2015", 2015, true),
    entry: "./src/index.ts",
    output: { filename: "jszipp.umd.js", path: cr61ff58Dist, globalObject: "typeof self !== 'undefined' ? self : this", library: umd("JSZipp") }
  },
  {
    ...compatBuild("CR61FF58", "es2015", 2015, true, false),
    entry: "./src/worker-plugin.ts",
    output: { filename: "jszipp.worker-plugin.umd.js", path: cr61ff58Dist, globalObject: "typeof self !== 'undefined' ? self : this", library: umd("JSZippWorkerPlugin") }
  },
  {
    ...compatBuild("CR61FF58", "es2015", 2015, true, false),
    entry: "./src/worker-script.ts",
    output: { filename: "jszipp.worker.js", path: cr61ff58Dist, globalObject: "typeof self !== 'undefined' ? self : this", library: umd("JSZippWorker") }
  },
  {
    ...compatBuild("CR61FF58", "es2015", 2015, true),
    entry: "./src/index.ts",
    output: { filename: "jszipp.cjs", path: cr61ff58Dist, library: cjs }
  },
  {
    ...compatBuild("CR61FF58", "es2015", 2015, true, false),
    entry: "./src/worker-plugin.ts",
    output: { filename: "jszipp.worker-plugin.cjs", path: cr61ff58Dist, library: cjs }
  },
  {
    ...compatBuild("CR61FF58", "es2015", 2015, true, false),
    entry: "./src/reader.ts",
    output: { filename: "jszipp.reader.umd.js", path: cr61ff58Dist, globalObject: "typeof self !== 'undefined' ? self : this", library: umd("JSZippReader") }
  },
  {
    ...compatBuild("CR61FF58", "es2015", 2015, true, false),
    entry: "./src/writer.ts",
    output: { filename: "jszipp.writer.umd.js", path: cr61ff58Dist, globalObject: "typeof self !== 'undefined' ? self : this", library: umd("JSZippWriter") }
  },
  // ---- Compat: CR86FF68 (min Chrome 86 / Firefox 68) ----
  {
    ...compatBuild("CR86FF68", "es2019", 2019),
    entry: "./src/index.ts",
    experiments: { outputModule: true },
    output: { filename: "jszipp.mjs", path: cr86ff68Dist, library: { type: "modern-module" } }
  },
  {
    ...compatBuild("CR86FF68", "es2019", 2019, false, false),
    entry: "./src/worker-plugin.ts",
    experiments: { outputModule: true },
    output: { filename: "jszipp.worker-plugin.mjs", path: cr86ff68Dist, library: { type: "modern-module" } }
  },
  {
    ...compatBuild("CR86FF68", "es2019", 2019),
    entry: "./src/index.ts",
    output: { filename: "jszipp.umd.js", path: cr86ff68Dist, globalObject: "globalThis", library: umd("JSZipp") }
  },
  {
    ...compatBuild("CR86FF68", "es2019", 2019, false, false),
    entry: "./src/worker-plugin.ts",
    output: { filename: "jszipp.worker-plugin.umd.js", path: cr86ff68Dist, globalObject: "globalThis", library: umd("JSZippWorkerPlugin") }
  },
  {
    ...compatBuild("CR86FF68", "es2019", 2019, false, false),
    entry: "./src/worker-script.ts",
    output: { filename: "jszipp.worker.js", path: cr86ff68Dist, globalObject: "globalThis", library: umd("JSZippWorker") }
  },
  {
    ...compatBuild("CR86FF68", "es2019", 2019),
    entry: "./src/index.ts",
    output: { filename: "jszipp.cjs", path: cr86ff68Dist, library: cjs }
  },
  {
    ...compatBuild("CR86FF68", "es2019", 2019, false, false),
    entry: "./src/worker-plugin.ts",
    output: { filename: "jszipp.worker-plugin.cjs", path: cr86ff68Dist, library: cjs }
  },
  {
    ...compatBuild("CR86FF68", "es2019", 2019, false, false),
    entry: "./src/reader.ts",
    output: { filename: "jszipp.reader.umd.js", path: cr86ff68Dist, globalObject: "globalThis", library: umd("JSZippReader") }
  },
  {
    ...compatBuild("CR86FF68", "es2019", 2019, false, false),
    entry: "./src/writer.ts",
    output: { filename: "jszipp.writer.umd.js", path: cr86ff68Dist, globalObject: "globalThis", library: umd("JSZippWriter") }
  }
]);
