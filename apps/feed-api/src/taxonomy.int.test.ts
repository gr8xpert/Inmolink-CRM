import {
  type ApiKeyScope,
  TaxonomyCatalogDto,
  WebsiteLocationChildrenDto,
  WebsiteLocationsDto,
} from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { createFounder } from '@inmolink/core/test';
import { adminQuery, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/** Website API taxonomy over HTTP (S2-03): API key scope, CDN headers, ETag and 304. */

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const RUN = newId().slice(-8).toLowerCase();
const GROUP_KEY = `apartments-${RUN}`;
let app: Awaited<ReturnType<typeof buildApp>>;
let taxonomyKey: string;
let listingsKey: string;

async function issue(founder: { userId: string; agencyId: string }, scopes: ApiKeyScope[]): Promise<string> {
  const issued = await withMemberCtx(
    { userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' },
    (ctx) => identity.createApiKey(ctx, { name: 'WP', kind: 'SECRET', scopes, allowedOrigins: [] }),
  );
  return issued.secret;
}

beforeAll(async () => {
  await setupTestDb('http');
  await configureCache({ prefix: `t:taxonomy-feed:${newId().slice(-12)}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  const founder = await createFounder();
  await setAgencyStatus(founder.agencyId, 'VERIFIED');
  taxonomyKey = await issue(founder, ['taxonomy:read']);
  listingsKey = await issue(founder, ['listings:read']);
  // Global reference data: feed-api (APP_ROLE=http) may not use withSystem, so the fixture is written as admin.
  const id = newId();
  await adminQuery('insert into property_type_groups (id, key, sort) values ($1, $2, 0)', [id, GROUP_KEY]);
  await adminQuery(
    `insert into property_type_group_translations (group_id, locale, name, slug)
     values ($1, 'en', 'Apartments', $2), ($1, 'es', 'Pisos', $3)`,
    [id, GROUP_KEY, `pisos-${RUN}`],
  );
  app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allowAll,
    checks: {},
  });
}, 120_000);

afterAll(async () => {
  await adminQuery('delete from property_type_groups where key = $1', [GROUP_KEY]);
  await app?.close();
  await closeCache();
  await closeDb();
});

describe('website API taxonomy', () => {
  it('[S2-03] catalog in `lang` with CDN Cache-Control and a strong ETag; If-None-Match → 304', async () => {
    const headers = { 'x-api-key': taxonomyKey };
    const res = await app.inject({ method: 'GET', url: '/v2/taxonomy/catalog?lang=es', headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=600, stale-while-revalidate=600, stale-if-error=86400',
    );
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    const body = TaxonomyCatalogDto.parse(res.json());
    expect(body.propertyTypes.find((g) => g.key === GROUP_KEY)).toMatchObject({ name: 'Pisos' });

    const again = await app.inject({
      method: 'GET',
      url: '/v2/taxonomy/catalog?lang=es',
      headers: { ...headers, 'if-none-match': `W/${etag}` },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.etag).toBe(etag);
  });

  it('[S2-03] locations one level at a time; unknown id → 404; unsupported lang → 422; scope enforced', async () => {
    const headers = { 'x-api-key': taxonomyKey };
    const res = await app.inject({ method: 'GET', url: '/v2/taxonomy/locations', headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    const top = WebsiteLocationsDto.parse(res.json());
    expect(top.locale).toBe('es');
    const parent = top.locations[0];
    if (parent) {
      const children = await app.inject({
        method: 'GET',
        url: `/v2/taxonomy/locations/${parent.id}/children`,
        headers,
      });
      expect(children.statusCode).toBe(200);
      expect(WebsiteLocationChildrenDto.parse(children.json())).toMatchObject({ parentId: parent.id });
    }
    const missing = await app.inject({ method: 'GET', url: `/v2/taxonomy/locations/${newId()}/children`, headers });
    expect(missing.statusCode).toBe(404);
    const notUuid = await app.inject({ method: 'GET', url: '/v2/taxonomy/locations/nope/children', headers });
    expect(notUuid.statusCode).toBe(422);

    const bad = await app.inject({ method: 'GET', url: '/v2/taxonomy/locations?lang=xx', headers });
    expect(bad.statusCode).toBe(422);

    const denied = await app.inject({
      method: 'GET',
      url: '/v2/taxonomy/catalog',
      headers: { 'x-api-key': listingsKey },
    });
    expect(denied.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v2/taxonomy/catalog' })).statusCode).toBe(401);
  });
});
