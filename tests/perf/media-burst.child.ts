/**
 * The media burst of `media-processing.int.test.ts` in a process of its own (S3-F3): only what the media worker
 * runs — `media.processObject` on already uploaded objects — so its peak RSS is the worker's, not the test's (which
 * generated the 48 MP inputs with sharp in the same process). Prints one JSON line: `{ base, peak, made }`.
 * S4-F2: run with plain `node` (type stripping, no tsx, no source condition), so the workspace packages resolve to
 * their built `dist` — the compiled code the media container runs, and its total RSS. The stack env comes from the
 * parent (it ran `loadStackEnv`); argv[2] is a JSON list of `{ hash, sizeBytes, contentType }`.
 */

import * as media from '@inmolink/core/modules/media';
import { closeDb } from '@inmolink/db';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureStorage, createS3Store, storageConfigFromEnv } from '@inmolink/platform/storage';

type Upload = { hash: string; sizeBytes: number; contentType: 'image/jpeg' | 'image/png' | 'image/heic' };

const uploads = JSON.parse(process.argv[2] ?? '[]') as Upload[];
const log = createLogger({ service: 'perf', level: 'silent' });
configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
media.configureMedia({ urlKey: process.env.MEDIA_PERF_URL_KEY ?? 'media-perf-key-0123456789abcdef0123' });

// After the imports and before any image: what the compiled process holds idle.
const base = process.memoryUsage().rss;
let peak = base;
const sampler = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 20);
try {
  const results = await Promise.all(
    uploads.map((u) =>
      media.mediaJobs.processObject.spec.run(
        {
          sha256: u.hash,
          agencyId: null,
          upload: { sizeBytes: u.sizeBytes, contentType: u.contentType },
          trigger: newId(),
        },
        { log, jobId: newId(), attempt: 1, progress: async () => {}, signal: new AbortController().signal },
      ),
    ),
  );
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  console.log(JSON.stringify({ base, peak, made: results.length }));
} finally {
  clearInterval(sampler);
  await closeDb();
}
