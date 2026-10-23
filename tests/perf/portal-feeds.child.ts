/**
 * The portal feed passes of `portal-feeds.int.test.ts` in a process of its own (S9-03): only what an `exports` worker
 * process runs — `generatePortalFeeds`, `concurrency` agency passes at a time (the pool's per-process cap, 2) — so
 * its peak RSS is the job's process, not the test's (which seeded the rows). Plain `node` on the built packages, like
 * the site feed and media burst children. argv[2]: a comma-separated list of agency ids; argv[3]: concurrency. The
 * files stream to the test stack's MinIO, as in the worker. Prints one JSON line: `{ base, peak, seconds, passes }`.
 */

import { configurePortalFeeds, generatePortalFeeds } from '@inmolink/core/modules/exports/worker';
import { closeDb } from '@inmolink/db';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { configureStorage, createS3Store, storageConfigFromEnv } from '@inmolink/platform/storage';

const agencyIds = (process.argv[2] as string).split(',');
const concurrency = Number(process.argv[3] ?? 2);
configurePortalFeeds({ mediaBaseUrl: 'https://media.example' });
configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));

// After the imports and before the passes: what the compiled process holds idle.
const base = process.memoryUsage().rss;
let peak = base;
const sampler = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 20);
try {
  const passes: { ms: number; written: number; unchanged: number; failed: number }[] = [];
  const queue = [...agencyIds];
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const t = performance.now();
        const r = await generatePortalFeeds(id, { trigger: 'NIGHTLY' });
        passes.push({
          ms: performance.now() - t,
          written: r.written.length,
          unchanged: r.unchanged.length,
          failed: r.failed.length,
        });
      }
    }),
  );
  const seconds = (performance.now() - started) / 1_000;
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  console.log(JSON.stringify({ base, peak, seconds, passes }));
} finally {
  clearInterval(sampler);
  await closeDb();
}
