import { rm, mkdir } from "node:fs/promises";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
