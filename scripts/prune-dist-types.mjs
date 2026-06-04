import { rm } from "node:fs/promises";

for (const filename of [
  "polyfill.d.ts",
  "polyfill-compat.d.ts",
  "polyfill-CR61FF58.d.ts",
  "polyfill-CR86FF68.d.ts",
  "polyfill.d.ts.map",
  "polyfill-compat.d.ts.map",
  "polyfill-CR61FF58.d.ts.map",
  "polyfill-CR86FF68.d.ts.map"
]) {
  await rm(new URL(`../dist/${filename}`, import.meta.url), { force: true });
}
