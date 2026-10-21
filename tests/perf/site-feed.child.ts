/**
 * The feed runs of `site-feed.int.test.ts` in a process of its own (S7-07): only what the `exports` worker runs —
 * `websiteApi.generateSiteFeed`, for each site at once (the pool's per-process cap is 2) — so its peak RSS is the
 * job's process, not the test's (which seeded the rows). Plain `node` on the built packages, like the media burst
 * (S4-F2). The stack env comes from the parent; argv[2] is a comma-separated list of site ids. The files stream to
 * the test stack's MinIO, as in the worker. Prints one JSON line: `{ base, peak, runs }`.
 */

import * as websiteApi from '@inmolink/core/modules/website-api';
import { closeDb } from '@inmolink/db';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { configureStorage, createS3Store, storageConfigFromEnv } from '@inmolink/platform/storage';

const siteIds = (process.argv[2] as string).split(',');
await configureCache({ prefix: `t:perf-feed-child:${(siteIds[0] as string).slice(-8)}` });
websiteApi.configureWebsiteApi({
  mediaBaseUrl: 'https://media.example',
  cursorKey: 'test-cursor-key-0123456789abcdef0123',
});
configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));

// After the imports and before the run: what the compiled process holds idle.
const base = process.memoryUsage().rss;
let peak = base;
const sampler = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 20);
try {
  const runs = await Promise.all(siteIds.map((id) => websiteApi.generateSiteFeed(id)));
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  console.log(JSON.stringify({ base, peak, runs }));
} finally {
  clearInterval(sampler);
  await closeCache();
  await closeDb();
}
