import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("package exports", () => {
  it("exposes ESM root and browser-legacy subpaths", async () => {
    const root = await import("jszipp");
    const cr61ff58 = await import("jszipp/browser-legacy/cr61ff58");
    const cr86ff68 = await import("jszipp/browser-legacy/cr86ff68");

    expect(root.ZipWriter).toBeTypeOf("function");
    expect(root.ZipTransformStream).toBeTypeOf("function");
    expect(root.openZip).toBeTypeOf("function");
    expect(root.readZipStream).toBeTypeOf("function");

    expect(cr61ff58.ZipWriter).toBeTypeOf("function");
    expect(cr61ff58.openZip).toBeTypeOf("function");
    expect(cr86ff68.ZipWriter).toBeTypeOf("function");
    expect(cr86ff68.openZip).toBeTypeOf("function");
  });

  it("exposes the CommonJS root", () => {
    const root = require("jszipp");

    expect(root.ZipWriter).toBeTypeOf("function");
    expect(root.ZipTransformStream).toBeTypeOf("function");
    expect(root.openZip).toBeTypeOf("function");
    expect(root.readZipStream).toBeTypeOf("function");
  });

  it("emits direct browser-legacy UMD artifacts", () => {
    for (const filename of [
      "cr61ff58/jszipp.umd.js",
      "cr61ff58/jszipp.reader.umd.js",
      "cr61ff58/jszipp.writer.umd.js",
      "cr86ff68/jszipp.umd.js",
      "cr86ff68/jszipp.reader.umd.js",
      "cr86ff68/jszipp.writer.umd.js"
    ]) {
      expect(existsSync(join("dist", filename))).toBe(true);
    }
  });
});
