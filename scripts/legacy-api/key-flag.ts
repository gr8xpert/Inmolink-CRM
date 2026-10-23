// pnpm legacy:key-flag --agency <uuid> --prefix <key prefix> (--on | --off) --reason <code> [--test]
//
// Legacy website keys (S8-02, PLAN §9.3): marks a website API key as migrated from legacy Inmolink, so the v1 shim
// accepts it as the legacy `api_key` query parameter (legacy sites cannot be changed at cutover). Every other key sent
// that way is refused (401). The legacy key import (S14) sets the mark itself; this script is for single keys and for
// clearing the mark once a site moved to header keys (rotate the key after cutover: a query-string key appears in
// URLs). Audited (`identity.apiKey.legacyQueryKeyChanged`); the cached lookup is dropped.
import { parseArgs } from 'node:util';
import * as identity from '@inmolink/core/modules/identity';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { readStackEnv } from '../ops/stack-env';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    agency: { type: 'string' },
    prefix: { type: 'string' },
    on: { type: 'boolean', default: false },
    off: { type: 'boolean', default: false },
    reason: { type: 'string' },
  },
});

if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';

try {
  if (!values.agency || !UUID.test(values.agency)) throw new TypeError('--agency must be a UUID');
  if (!values.prefix) throw new TypeError('--prefix is required');
  if (values.on === values.off) throw new TypeError('pass exactly one of --on and --off');
  if (!values.reason) throw new TypeError('--reason is required (a short code, e.g. legacy.cutover)');
  await configureDb(loadConfigOrExit(dbEnv));
  await configureCache();
  const agencyId = values.agency;
  const changed = await withSystem('legacy.key-flag', (tx) =>
    identity.setLegacyQueryKey(
      {
        tx,
        tenant: { agencyId, verified: true, plan: 'none', locales: ['en'] },
        actor: { kind: 'system', reason: 'legacy.key-flag' },
        locale: 'en',
        requestId: newId(),
        clientMode: false,
      },
      { prefix: values.prefix as string, enabled: values.on, reason: values.reason as string },
    ),
  );
  if (!changed) throw new Error('no active key with that prefix in that agency');
  console.log(`legacy query key ${values.on ? 'enabled' : 'disabled'} for ${values.prefix}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeCache();
  await closeDb();
}
