// pnpm perf:load:setup [--test] [--staging] [--rate 1000] [--seconds 1020] [--sites N] [--out file]
// pnpm perf:load:setup --teardown [--test] [--staging]
//
// Website API load test (S7-08): provisions the load-test sites and HIGH-tier secret keys on scale-seed agencies
// (enough that no limit trips at --rate for --seconds; --sites overrides) and writes the keys file the k6 script
// reads (secrets: default `tests/load/.data/website-keys.json`, git-ignored). --teardown revokes every load-test key.
// Never in production (see `assertLoadTarget`). Runbook: docs/runbooks/website-api.md › Load test.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import * as identity from '@inmolink/core/modules/identity';
import { closeDb, configureDb, dbEnv } from '@inmolink/db';
import { cryptoEnv, loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { keysNeeded, PROFILES } from '../../tests/load/lib/website-mix';
import { readStackEnv } from '../ops/stack-env';
import { assertLoadTarget, loadKeyLimits, provisionLoadSites, revokeLoadKeys } from './load-sites';

const ROOT = join(import.meta.dirname, '..', '..');
export const DEFAULT_KEYS_FILE = join(ROOT, 'tests', 'load', '.data', 'website-keys.json');

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    staging: { type: 'boolean', default: false },
    teardown: { type: 'boolean', default: false },
    rate: { type: 'string', default: String(PROFILES.staging.rate) },
    seconds: { type: 'string', default: String(PROFILES.staging.seconds + PROFILES.staging.warmupSeconds) },
    sites: { type: 'string' },
    out: { type: 'string', default: DEFAULT_KEYS_FILE },
  },
});

// Locally, read the stack's env file (dev or --test) unless real credentials are already set.
if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'perf:load-setup', level: process.env.LOG_LEVEL ?? 'info' });

const positive = (name: string, v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`--${name} must be a positive integer`);
  return n;
};

try {
  assertLoadTarget(process.env, values.staging);
  const config = loadConfigOrExit({ ...dbEnv, HMAC_KEY: cryptoEnv.HMAC_KEY });
  await configureDb(config, { logger: log });
  // Keys of this environment (`test`, `staging`…), checked with the same HMAC key feed-api uses.
  identity.configureIdentity({
    hmacKey: config.HMAC_KEY,
    apiKeyEnv: identity.apiKeyEnvFor(process.env.DEPLOY_ENV ?? process.env.NODE_ENV),
  });
  if (values.teardown) {
    log.info({ revoked: await revokeLoadKeys() }, 'load-test keys revoked');
  } else {
    const rate = positive('rate', values.rate);
    const seconds = positive('seconds', values.seconds);
    const needed = keysNeeded(rate, seconds, loadKeyLimits());
    const sites = values.sites ? positive('sites', values.sites) : needed;
    if (sites < needed) log.warn({ sites, needed, rate }, 'fewer sites than the rate needs: k6 setup will refuse');
    const file = await provisionLoadSites({ sites });
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, JSON.stringify(file, null, 2), { mode: 0o600 });
    const policies = file.keys.reduce<Record<string, number>>(
      (n, k) => Object.assign(n, { [k.policy]: (n[k.policy] ?? 0) + 1 }),
      {},
    );
    log.info({ sites: file.keys.length, needed, rate, policies, out: values.out }, 'load-test keys written');
  }
} catch (err) {
  log.error({ err }, 'load-test setup failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
