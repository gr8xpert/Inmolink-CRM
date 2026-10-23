// pnpm exports:sync-channels [--test]
//
// Writes the portal catalog (S9-01, PLAN §3 #19): Kyero, thinkSPAIN, A Place in the Sun, generic XML available;
// idealista and Fotocasa planned. Idempotent: run after a deploy that changes the catalog (and once on a new stack).
import { parseArgs } from 'node:util';
import * as exportsModule from '@inmolink/core/modules/exports';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { readStackEnv } from './stack-env';

const { values } = parseArgs({ options: { test: { type: 'boolean', default: false } } });

// Locally, read the stack's env file (dev or --test) unless real credentials are already set.
if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'ops:sync-portal-channels', level: process.env.LOG_LEVEL });

try {
  await configureDb(loadConfigOrExit(dbEnv));
  await withSystem('ops.sync-portal-channels', (tx) => exportsModule.syncPortalChannels(tx));
  log.info({ channels: exportsModule.PORTAL_CHANNEL_CATALOG.map((c) => c.code) }, 'portal catalog synced');
} catch (err) {
  log.error({ err }, 'sync-portal-channels failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
