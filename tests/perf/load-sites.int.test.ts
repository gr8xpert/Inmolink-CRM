import * as identity from '@inmolink/core/modules/identity';
import * as search from '@inmolink/core/modules/search';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { createFounder } from '@inmolink/core/test';
import { closeDb, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeRateLimit, configureRateLimit, rateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../apps/feed-api/src/app';
import {
  LOAD_KEY_NAME,
  LOAD_SITE_NAME,
  type LoadKeysFile,
  loadKeyLimits,
  provisionLoadSites,
  revokeLoadKeys,
} from '../../scripts/perf/load-sites';

/**
 * Load-test sites and keys (S7-08): what `pnpm perf:load:setup` provisions before a k6 run and revokes after it. Here
 * the agencies are this run's founders (their e-mail domain stands in for the scale seed's), the request path is the
 * real feed-api with the real limiter on the test stack's limits Redis.
 */

const RUN = newId().slice(-8);
const DOMAIN = `${RUN}.load.inmolink.test`;
const LIKE = `%@${DOMAIN}`;
const SITES = 4;
let app: Awaited<ReturnType<typeof buildApp>>;
let first: LoadKeysFile;

const activeLoadKeys = () =>
  withSystem('test.load-sites', async (tx) => {
    const rows = await tx.execute<{ id: string; agency_id: string; rate_tier: string; site_id: string }>(sql`
      select k.id, k.agency_id, k.rate_tier, k.site_id from api_keys k
        join agency_members m on m.agency_id = k.agency_id
       where k.name = ${LOAD_KEY_NAME} and k.revoked_at is null and m.email like ${LIKE}`);
    return rows.rows;
  });

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:load-sites:${RUN}` });
  await configureRateLimit({ commandTimeoutMs: 5_000 });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  // Website search from the Postgres fallback (the engine is stopped), as in the S7-03 perf suite.
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker({ failureThreshold: 1, openMs: 3_600_000 });
  for (let i = 0; i < SITES; i++) {
    const f = await createFounder({ email: `a${i}-u0@${DOMAIN}` });
    await setAgencyStatus(f.agencyId, 'VERIFIED');
  }
  app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: rateLimiter(),
    checks: {},
  });
});

afterAll(async () => {
  await revokeLoadKeys(LIKE).catch(() => undefined);
  search.resetSearchBreaker();
  await app?.close();
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

it('[S7-08] provisions one HIGH-tier secret key per site and agency, served through the real key check and limiter', async () => {
  first = await provisionLoadSites({ sites: SITES, emailLike: LIKE });
  expect(first.keys).toHaveLength(SITES);
  expect(new Set(first.keys.map((k) => k.agencyId)).size).toBe(SITES);
  expect(first.keys.map((k) => k.policy).sort()).toEqual([
    'CUSTOM_MIN_COMMISSION',
    'CUSTOM_NETWORK',
    'OWN_ONLY',
    'OWN_PLUS_NETWORK',
  ]);
  expect(first.limits).toEqual(loadKeyLimits());
  for (const k of first.keys) {
    expect(k.key).toMatch(/^inl_test_/);
    expect(k.locales).toEqual(['en', 'es', 'de']);
  }
  const rows = await activeLoadKeys();
  expect(rows).toHaveLength(SITES);
  expect(rows.every((r) => r.rate_tier === 'HIGH')).toBe(true);
  // The keys work like any site's: listings, taxonomy (the load mix's endpoints), no bypass in the request path.
  for (const k of first.keys) {
    for (const url of ['/v2/sitemap?limit=1', '/v2/listings?limit=1', '/v2/taxonomy/types']) {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-api-key': k.key } });
      expect(res.statusCode, `${k.policy} ${url}: ${res.body.slice(0, 200)}`).toBe(200);
    }
  }
});

it('[S7-08] a re-run reuses the sites and replaces the keys; teardown revokes every load-test key', async () => {
  const again = await provisionLoadSites({ sites: SITES, emailLike: LIKE });
  expect(again.keys.map((k) => k.siteId).sort()).toEqual(first.keys.map((k) => k.siteId).sort());
  const rows = await activeLoadKeys();
  // One live key per agency: the first run's keys were revoked.
  expect(rows.map((r) => r.id).sort()).toEqual(again.keys.map((k) => k.keyId).sort());
  const sites = await withSystem('test.load-sites', (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from website_sites s
      join agency_members m on m.agency_id = s.agency_id
      where s.name = ${LOAD_SITE_NAME} and m.email like ${LIKE}`),
  );
  expect(sites.rows[0]?.n).toBe(SITES);
  expect(await revokeLoadKeys(LIKE)).toBe(SITES);
  expect(await activeLoadKeys()).toHaveLength(0);
});
