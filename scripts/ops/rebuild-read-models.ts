// pnpm ops:rebuild-read-models [--test] [--agency <uuid>] [--kind listing|unit] [--batch <n>] [--concurrency <n>]
//
// Rebuilds every listing and new-build unit read model (S5-01, PLAN §5.3 #3) from the source tables and drops the
// documents of targets that no longer have one. Idempotent and restartable: unchanged documents are not rewritten,
// and the outbox consumers keep running alongside. Use after a builder change, a taxonomy rename, or to repair
// drift. Progress is logged after every batch (done, rate, ETA).
import { parseArgs } from 'node:util';
import * as media from '@inmolink/core/modules/media';
import * as search from '@inmolink/core/modules/search';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { loadConfigOrExit, mediaEnv } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { readStackEnv } from './stack-env';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    agency: { type: 'string' },
    kind: { type: 'string' },
    batch: { type: 'string', default: String(search.READ_MODEL_BATCH) },
    concurrency: { type: 'string', default: '4' },
  },
});

// Locally, read the stack's env file (dev or --test) unless real credentials are already set.
if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'ops:rebuild-read-models', level: process.env.LOG_LEVEL });

function positive(name: string, value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`--${name} must be a positive integer`);
  return n;
}

try {
  if (values.agency && !UUID.test(values.agency)) throw new TypeError('--agency must be a UUID');
  if (values.kind && !['listing', 'unit'].includes(values.kind)) throw new TypeError('--kind must be listing or unit');
  const kinds: search.ReadModelKind[] = values.kind
    ? [values.kind === 'listing' ? 'LISTING' : 'UNIT']
    : ['LISTING', 'UNIT'];
  const batch = positive('batch', values.batch);
  const concurrency = positive('concurrency', values.concurrency);
  const config = loadConfigOrExit({ ...dbEnv, ...mediaEnv });
  await configureDb(config);
  media.configureMedia({ urlKey: config.MEDIA_URL_KEY });

  // Totals for progress (the walk itself is exact).
  const totals = await withSystem('ops.rebuild-read-models.count', async (tx) => ({
    LISTING: await search.countReadModelTargets(tx, 'LISTING', values.agency),
    UNIT: await search.countReadModelTargets(tx, 'UNIT', values.agency),
  }));
  log.info({ totals, agencyId: values.agency, batch, concurrency }, 'rebuilding read models');

  let last = 0;
  const result = await search.rebuildAllReadModels({
    agencyId: values.agency,
    kinds,
    batch,
    concurrency,
    reason: 'ops.rebuild-read-models',
    onProgress: (p) => {
      if (Date.now() - last < 2_000) return;
      last = Date.now();
      const total = totals[p.kind];
      const rate = p.done / Math.max(p.elapsedMs / 1000, 0.001);
      log.info(
        {
          kind: p.kind,
          done: p.done,
          total,
          percent: total ? Math.min(100, Math.round((p.done / total) * 100)) : 100,
          perSecond: Math.round(rate),
          etaSeconds: Math.max(0, Math.round((total - p.done) / Math.max(rate, 1))),
          written: p.written,
          deleted: p.deleted,
        },
        'progress',
      );
    },
  });
  log.info({ result }, 'read models rebuilt');
} catch (err) {
  log.error({ err }, 'rebuild failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
