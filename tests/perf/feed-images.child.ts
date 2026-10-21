/**
 * Feed-image jobs of `feed-images.int.test.ts` in a process of their own (S7-F3): what the `imports` worker runs —
 * `media.importFeedImages` for several agencies at once — so its peak RSS is the worker's, not the test's (which serves
 * the images). Plain `node` on the built packages, like `feed-import.child.ts`. The stack env comes from the parent;
 * argv[2] is `{ agencies: string[], origin }`. Prints one JSON line: `{ base, peak, maxRss, ms, arrayBuffers, heapUsed, results }`.
 */

import * as media from '@inmolink/core/modules/media';
import { closeDb } from '@inmolink/db';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { allowLoopbackOriginsForTests } from '@inmolink/platform/safe-fetch';
import { configureStorage, createS3Store, storageConfigFromEnv } from '@inmolink/platform/storage';

const { agencies, origin } = JSON.parse(process.argv[2] ?? '{}') as { agencies: string[]; origin: string };
const log = createLogger({ service: 'perf', level: 'warn' });
configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
const undoLoopback = allowLoopbackOriginsForTests([origin]);

// After the imports and before any download: what the compiled process holds idle.
const base = process.memoryUsage().rss;
let peak = base;
/** Where the peak went: Buffers / ArrayBuffers (outside the V8 heap) and the V8 heap itself. */
let arrayBuffers = 0;
let heapUsed = 0;
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  if (m.rss > peak) {
    peak = m.rss;
    arrayBuffers = m.arrayBuffers;
    heapUsed = m.heapUsed;
  }
}, 20);
const started = performance.now();
try {
  const results = await Promise.all(
    agencies.map((agencyId) => media.importFeedImages(agencyId, { signal: new AbortController().signal, log })),
  );
  const ms = performance.now() - started;
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  const maxRss = process.resourceUsage().maxRSS * 1024;
  console.log(JSON.stringify({ base, peak, maxRss, ms, arrayBuffers, heapUsed, results }));
} finally {
  clearInterval(sampler);
  undoLoopback();
  await closeDb();
  process.exit(0);
}
