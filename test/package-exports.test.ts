import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInThisContext } from "node:vm";

const require = createRequire(import.meta.url);

describe("package exports", () => {
  it("keeps a single worker-script subpath", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      exports: Record<string, unknown>;
    };

    expect(pkg.exports["./worker-script"]).toEqual({
      import: "./dist/jszipp.worker.mjs",
      default: "./dist/jszipp.worker.js"
    });
  });

  it("exposes ESM root and browser-legacy subpaths", async () => {
    const root = await import("web-jszipp");
    const workerPlugin = await import("web-jszipp/worker-plugin");
    const cr61ff58 = await import("web-jszipp/browser-legacy/cr61ff58");
    const cr61ff58WorkerPlugin = await import("web-jszipp/browser-legacy/cr61ff58/worker-plugin");
    const cr86ff68 = await import("web-jszipp/browser-legacy/cr86ff68");
    const cr86ff68WorkerPlugin = await import("web-jszipp/browser-legacy/cr86ff68/worker-plugin");

    expect(root.ZipWriter).toBeTypeOf("function");
    expect(root.ZipTransformStream).toBeTypeOf("function");
    expect(root.openZip).toBeTypeOf("function");
    expect(root.readZipStream).toBeTypeOf("function");

    expect(workerPlugin.createWorkerBackend).toBeTypeOf("function");
    expect(cr61ff58.ZipWriter).toBeTypeOf("function");
    expect(cr61ff58.openZip).toBeTypeOf("function");
    expect(cr61ff58WorkerPlugin.createWorkerBackend).toBeTypeOf("function");
    expect(cr86ff68.ZipWriter).toBeTypeOf("function");
    expect(cr86ff68.openZip).toBeTypeOf("function");
    expect(cr86ff68WorkerPlugin.createWorkerBackend).toBeTypeOf("function");
  });

  it("exposes the CommonJS root", () => {
    const root = require("web-jszipp");
    const workerPlugin = require("web-jszipp/worker-plugin");

    expect(root.ZipWriter).toBeTypeOf("function");
    expect(root.ZipTransformStream).toBeTypeOf("function");
    expect(root.openZip).toBeTypeOf("function");
    expect(root.readZipStream).toBeTypeOf("function");
    expect(workerPlugin.createWorkerBackend).toBeTypeOf("function");
  });

  it("emits direct browser-legacy UMD artifacts", () => {
    for (const filename of [
      "jszipp.worker-plugin.mjs",
      "jszipp.worker-plugin.cjs",
      "jszipp.worker-plugin.umd.js",
      "jszipp.worker.mjs",
      "jszipp.worker.js",
      "cr61ff58/jszipp.worker-plugin.mjs",
      "cr61ff58/jszipp.worker-plugin.cjs",
      "cr61ff58/jszipp.worker-plugin.umd.js",
      "cr61ff58/jszipp.worker.js",
      "cr61ff58/jszipp.umd.js",
      "cr61ff58/jszipp.reader.umd.js",
      "cr61ff58/jszipp.writer.umd.js",
      "cr86ff68/jszipp.worker-plugin.mjs",
      "cr86ff68/jszipp.worker-plugin.cjs",
      "cr86ff68/jszipp.worker-plugin.umd.js",
      "cr86ff68/jszipp.worker.js",
      "cr86ff68/jszipp.umd.js",
      "cr86ff68/jszipp.reader.umd.js",
      "cr86ff68/jszipp.writer.umd.js"
    ]) {
      expect(existsSync(join("dist", filename))).toBe(true);
    }
  });

  it("keeps reader and writer UMD bundles smaller than the full UMD bundle", () => {
    for (const prefix of ["", "cr61ff58/", "cr86ff68/"]) {
      const full = statSync(join("dist", prefix, "jszipp.umd.js")).size;
      const reader = statSync(join("dist", prefix, "jszipp.reader.umd.js")).size;
      const writer = statSync(join("dist", prefix, "jszipp.writer.umd.js")).size;

      expect(reader).toBeLessThan(full);
      expect(writer).toBeLessThan(full);
    }
  });

  it("does not emit direct throwIfAborted() calls in compat worker plugins", () => {
    for (const filename of [
      "cr61ff58/jszipp.worker-plugin.mjs",
      "cr61ff58/jszipp.worker-plugin.cjs",
      "cr61ff58/jszipp.worker-plugin.umd.js",
      "cr86ff68/jszipp.worker-plugin.mjs",
      "cr86ff68/jszipp.worker-plugin.cjs",
      "cr86ff68/jszipp.worker-plugin.umd.js"
    ]) {
      const source = readFileSync(join("dist", filename), "utf8");
      expect(source).not.toMatch(/\.throwIfAborted\(/);
    }
  });

  it("keeps UMD globals wired to live public symbols", () => {
    const reader = readFileSync(join("dist", "jszipp.reader.umd.js"), "utf8");
    const writer = readFileSync(join("dist", "jszipp.writer.umd.js"), "utf8");
    const workerPlugin = readFileSync(join("dist", "jszipp.worker-plugin.umd.js"), "utf8");

    expect(reader).toContain("openZip");
    expect(reader).toContain("readZipStream");
    expect(writer).toContain("ZipWriter");
    expect(writer).toContain("ZipTransformStream");
    expect(workerPlugin).toContain("createWorkerBackend");
  });

  it("exposes worker-plugin UMD global at correct path", () => {
    // Smoke test: verify that the UMD bundle exports the correct global shape.
    // The bundle should expose JSZippWorkerPlugin.createWorkerBackend, NOT
    // JSZippWorkerPlugin.default.createWorkerBackend.
    const sandboxGlobal = { globalThis: {} };
    sandboxGlobal.globalThis.self = sandboxGlobal.globalThis;

    const code = readFileSync(join("dist", "jszipp.worker-plugin.umd.js"), "utf8");
    runInThisContext(code, { filename: "jszipp.worker-plugin.umd.js" });

    const workerPlugin = (globalThis as any).JSZippWorkerPlugin;
    expect(workerPlugin).toBeDefined();
    expect(workerPlugin.createWorkerBackend).toBeTypeOf("function");
    // Should not have a .default property wrapping the actual export
    expect(workerPlugin.default).toBeUndefined();
  });
});
