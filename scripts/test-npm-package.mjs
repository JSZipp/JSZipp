import { execSync } from "node:child_process";

const targets = [
  "web-jszipp",
  "web-jszipp/browser-legacy/cr86ff68",
  "web-jszipp/browser-legacy/cr61ff58"
];

function npmVersion(pkgName) {
  return execSync(`pnpm view ${pkgName} version`, { encoding: "utf8" }).trim();
}

async function testBuild(specifier) {
  console.log(`\nTesting: ${specifier}`);

  const mod = await import(specifier);
  const { ZipWriter, openZip } = mod;

  if (typeof ZipWriter !== "function") {
    throw new Error(`${specifier}: ZipWriter export missing`);
  }

  if (typeof openZip !== "function") {
    throw new Error(`${specifier}: openZip export missing`);
  }

  // Use level: 0 so the test does not depend on runtime compression support.
  const writer = new ZipWriter({
    outputAs: "uint8array",
    level: 0
  });

  await writer.add({
    path: "hello.txt",
    data: "Hello from JSZipp compat test"
  });

  const bytes = await writer.close();

  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`${specifier}: expected Uint8Array output`);
  }

  const zip = await openZip(bytes, {
    pathMode: "strict-package",
    maxArchiveSize: 1024 * 1024,
    maxEntrySize: 1024 * 1024
  });

  const text = await zip.get("hello.txt")?.text();
  await zip.close();

  if (text !== "Hello from JSZipp compat test") {
    throw new Error(`${specifier}: ZIP round-trip failed`);
  }

  console.log(`PASS: ${specifier}`);
}

console.log(`web-jszipp npm version: ${npmVersion("web-jszipp")}`);
console.log(`Node version: ${process.version}`);

for (const target of targets) {
  try {
    await testBuild(target);
  } catch (err) {
    console.error(`FAIL: ${target}`);
    console.error(err);
    process.exitCode = 1;
  }
}
