// Minimal zero-dependency static file server for the demo pages.
//
// The Playwright e2e suite (see e2e/) drives the real browser demo in
// `pages/compress.html`, which loads the BUILT ESM bundle with a relative
// `import("../dist/jszipp.mjs")`. ES module imports need a real HTTP origin and
// a JavaScript MIME type — a `file://` URL will not load the module — so this
// server exists purely to serve the repository root over HTTP for the tests.
//
// It is intentionally dependency-free (node:http + node:fs only) to match the
// project's other `scripts/*.mjs` tooling and to keep the e2e setup from pulling
// in a static-server package. It is NOT a production server: no caching, no
// range requests beyond what the demo needs, no security hardening.
//
// Usage:
//   node scripts/serve-demo.mjs [--port 65077] [--root .]
// Playwright starts it automatically via `webServer` in playwright.config.ts.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, resolve, sep } from "node:path";

function parseArgs(argv) {
  const args = { port: Number(process.env.PORT) || 65077, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) args.port = Number(argv[++i]);
    else if (argv[i] === "--root" && argv[i + 1]) args.root = resolve(argv[++i]);
  }
  return args;
}

// `.mjs` MUST be served as JavaScript or the browser refuses the module import.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm"
};

const { port, root } = parseArgs(process.argv.slice(2));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);

    // Resolve inside root and reject path traversal.
    let target = normalize(join(root, pathname));
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    let info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      target = join(target, "index.html");
      info = await stat(target).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] || "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store"
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(err));
  }
});

server.listen(port, () => {
  console.log(`serve-demo: http://localhost:${port}/ (root: ${root})`);
});
