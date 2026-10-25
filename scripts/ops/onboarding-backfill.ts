// pnpm ops:onboarding-backfill [--test] [--agency <uuid>] [--after <uuid>] [--batch <n>]
//
// Completes the onboarding checklist steps (S13-F26) of agencies that did them before the checklist shipped, from
// their current data: listings or developments, shared listings, sites, invites or a second member, VERIFIED status,
// each with the earliest known time. Idempotent (a rerun writes nothing) and resumable: progress logs the last agency
// id of each page; pass it as --after to continue. S14's legacy import calls `backfillAgency` per agency instead.
import { parseArgs } from 'node:util';
import * as onboarding from '@inmolink/core/modules/onboarding';
import { closeDb, configureDb, dbEnv } from '@inmolink/db';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { readStackEnv } from './stack-env';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    agency: { type: 'string' },
    after: { type: 'string' },
    batch: { type: 'string', default: String(onboarding.BACKFILL_MAX_BATCH) },
  },
});

if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'ops:onboarding-backfill', level: process.env.LOG_LEVEL });

try {
  if (values.agency && !UUID.test(values.agency)) throw new TypeError('--agency must be a UUID');
  if (values.after && !UUID.test(values.after)) throw new TypeError('--after must be a UUID');
  const batch = Number(values.batch);
  if (!Number.isInteger(batch) || batch < 1) throw new TypeError('--batch must be a positive integer');
  await configureDb(loadConfigOrExit({ ...dbEnv }));
  const result = await onboarding.backfillOnboarding({
    agencyId: values.agency,
    after: values.after,
    batch,
    reason: 'ops.onboarding-backfill',
    onPage: (p) => log.info(p, 'page done'),
  });
  log.info({ result }, 'onboarding backfilled');
} catch (err) {
  log.error({ err }, 'backfill failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
