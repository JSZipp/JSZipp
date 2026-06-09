import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { openZip } from "../src/index";

type TestBytes = Uint8Array<ArrayBuffer>;

const path = `./yauzl-issue-109-files`;

const fixtureUrl = (name: string): URL =>
  new URL(`${path}/${name}`, import.meta.url);

const readFixture = async (name: string): Promise<TestBytes> => {
  const bytes = await readFile(fixtureUrl(name));
  return new Uint8Array(bytes) as TestBytes;
};

describe("yauzl issue #109 fixtures — 0xffffffff central-directory fields without Zip64 extra", () => {
  it("opens a ZIP whose central-directory uncompressedSize is 0xffffffff without a Zip64 extra field", async () => {
    const zip = await openZip(
      await readFixture("yauzl-109-uncompressedSize-ffffffff-no-zip64.zip")
    );

    expect(zip.get("test.txt")).toBeDefined();
    expect(await zip.get("test.txt")?.text()).toBe("test\n");

    await zip.close();
  });

  it("opens a ZIP whose central-directory compressedSize is 0xffffffff without a Zip64 extra field", async () => {
    const zip = await openZip(
      await readFixture("yauzl-109-compressedSize-ffffffff-no-zip64.zip")
    );

    expect(zip.get("test.txt")).toBeDefined();
    expect(await zip.get("test.txt")?.text()).toBe("test\n");

    await zip.close();
  });

  it("handles a ZIP whose central-directory relativeOffsetOfLocalHeader is 0xffffffff without requiring a Zip64 extra field", async () => {
    const zipBytes = await readFixture(
      "yauzl-109-relativeOffsetOfLocalHeader-ffffffff-no-zip64.zip"
    );

    await expect(openZip(zipBytes)).rejects.not.toThrow(
      /expected zip64 extended information extra field/i
    );
  });
});
