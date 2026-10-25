// pnpm billing:catalog [--file scripts/ops/billing-catalog.json] [--test]
//
// Writes the plan catalog (S13-01, PLAN §3 #28 / §11): plans, add-ons and their prices, from a JSON data file. Idempotent;
// a changed amount retires the old price and adds a new one (subscriptions on the old one keep it). The worker's
// `billing.syncCatalog` (every 15 minutes) then creates the Stripe products and prices.
import { parseArgs } from 'node:util';
import * as billing from '@inmolink/core/modules/billing';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { readCatalog } from './billing-catalog';
import { readStackEnv } from './stack-env';

const { values } = parseArgs({ options: { test: { type: 'boolean', default: false }, file: { type: 'string' } } });

// Locally, read the stack's env file (dev or --test) unless real credentials are already set.
if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'ops:sync-billing-catalog', level: process.env.LOG_LEVEL });

try {
  const items = readCatalog(values.file);
  await configureDb(loadConfigOrExit(dbEnv));
  const result = await withSystem('ops.sync-billing-catalog', (tx) => billing.upsertCatalog(tx, items, newId));
  log.info(result, 'billing catalog written (the worker syncs it to Stripe)');
} catch (err) {
  log.error({ err }, 'sync-billing-catalog failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
