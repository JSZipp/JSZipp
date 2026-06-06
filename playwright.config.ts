import { defineConfig, devices } from "@playwright/test";

// E2E smoke test config for JSZipp.
//
// What this layer proves that the others do not: the Vitest suite runs the
// SOURCE tree (the native polyfill seam) and the compat smoke test runs the
// BUILT compat bundles in Node with floor globals deleted. Neither loads the
// shipped bundle in a real browser engine through the public demo UI. This
// suite does exactly that — it drives `demo/compress.html`, which imports the
// real `dist/jszipp.mjs`, in headless Chromium and validates the archive the
// browser produces. See docs/testing.md and browser-compatibility.md §8.
//
// Prerequisites: run `pnpm run build` first so `dist/jszipp.mjs` exists. The
// `test:e2e` package script chains the build for you.

const PORT = Number(process.env.PORT) || 65077;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "line",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry"
  },
  // Serve the repo root so `demo/compress.html` can resolve `../dist/jszipp.mjs`.
  webServer: {
    command: `node scripts/serve-demo.mjs --port ${PORT} --root .`,
    url: `${BASE_URL}/demo/compress.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  // Chromium is the canonical smoke target. Firefox/WebKit are valuable but
  // require `pnpm exec playwright install firefox webkit`; enable them in CI as needed.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
    // { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    // { name: "webkit", use: { ...devices["Desktop Safari"] } }
  ]
});
