import { defineConfig, configDefaults } from 'vitest/config';
import { availableParallelism } from 'node:os';

// The fixture recompression suite mixes async inflate (off the main thread via
// the libuv threadpool) with synchronous JS deflate (on the main thread), so a
// small, bounded concurrency is the sweet spot: enough to overlap inflate, not
// so much that memory pressure climbs while the deflate sections still
// serialize. Scoping it to its own project keeps this cap off the fast unit
// suite instead of leaking through a global `vi.setConfig`.
const FIXTURE_CONCURRENCY = Math.max(2, Math.min(4, availableParallelism()));

const sharedExclude = [...configDefaults.exclude, 'e2e/**'];

export default defineConfig({
  test: {
    exclude: sharedExclude,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: sharedExclude,
        },
      },
      {
        test: {
          name: 'compression-fixtures',
          include: ['test-compression/**/*.test.ts'],
          exclude: sharedExclude,
          maxConcurrency: FIXTURE_CONCURRENCY,
        },
      },
    ],
  },
});
