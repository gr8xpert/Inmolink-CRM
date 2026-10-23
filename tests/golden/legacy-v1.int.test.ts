import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as migration from '@inmolink/core/modules/migration';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { countQueries, withPublicRead } from '@inmolink/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FeedApp, type Fixture, loadWorld, startWorld, stopWorld, type World } from './world';

/**
 * The v1 shim beyond golden parity (S8-02): cache headers, legacy key parameter, legacy errors, site isolation of legacy
 * ids, numbered pages and the query budget (≤ 3 statements per request). Data: the synthetic golden fixture, loaded
 * twice — site A, and site B with its own ids — so a legacy id of B's listing can be asked of A.
 */

const synthetic = JSON.parse(readFileSync(join(import.meta.dirname, 'synthetic', 'fixture.json'), 'utf8')) as Fixture;

/** The same fixture under other target ids, codes and legacy property ids (another agency's copy). */
function otherCopy(f: Fixture): Fixture {
  const text = JSON.stringify(f)
    .replaceAll('0195f0a5-0801-', '0195f0a5-0811-')
    .replaceAll('"G00000', '"H00000')
    .replaceAll('"9100', '"9200');
  return { ...(JSON.parse(text) as Fixture), legacyIds: [] };
}

let app: FeedApp;
let a: World;
let b: World;

beforeAll(async () => {
  app = await startWorld('legacy-v1');
  a = await loadWorld(synthetic);
  b = await loadWorld(otherCopy(synthetic));
  migration.resetLegacyIdCache();
}, 180_000);

afterAll(() => stopWorld(app));

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
const withKey = (url: string, key = a.key) =>
  `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`;

describe('[S8-02] v1 shim over HTTP', () => {
  it('[S8-02] v1 answers carry Cache-Control and a strong ETag, and answer If-None-Match with 304', async () => {
    for (const url of ['/v1/properties?lang=en', '/v1/properties/910001', '/v1/types']) {
      const res = await get(withKey(url));
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('private, no-cache');
      const etag = String(res.headers.etag);
      expect(etag, url).toMatch(/^"[^"]+"$/);
      const again = await get(withKey(url), { 'if-none-match': etag });
      expect(again.statusCode, url).toBe(304);
      expect(again.body, url).toBe('');
    }
  });

  it('[S8-02] the legacy api_key parameter and the X-Api-Key header both authenticate; a wrong key is a legacy 401', async () => {
    const byParam = await get(withKey('/v1/properties'));
    const byHeader = await get('/v1/properties', { 'x-api-key': a.key });
    expect(byParam.statusCode).toBe(200);
    expect(byHeader.body).toBe(byParam.body);
    const wrong = await get('/v1/properties?api_key=inl_test_nope_000000000000000000000000');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ status: 'error', message: 'Invalid API key' });
    expect(wrong.headers['cache-control']).toBe('private, no-store');
    const none = await get('/v1/properties');
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ status: 'error' });
  });

  it('[S8-02] only migrated legacy keys may come as the api_key query parameter: a v2 key there is a 401', async () => {
    const v2InQuery = await get(withKey('/v1/properties', a.v2Key));
    expect(v2InQuery.statusCode).toBe(401);
    expect(v2InQuery.json()).toEqual({ status: 'error', message: 'Invalid API key' });
    // The same key in its header is fine.
    expect((await get('/v1/properties', { 'x-api-key': a.v2Key })).statusCode).toBe(200);
    // A query value longer than any key is not looked at.
    expect((await get(`/v1/properties?api_key=${'x'.repeat(201)}`)).statusCode).toBe(401);
    // v2 routes never read the query string.
    const v2 = await get(`/v2/listings?api_key=${encodeURIComponent(a.key)}`);
    expect(v2.statusCode).toBe(401);
  });

  it('[S8-02] app_public reads only taxonomy legacy maps; listing ids come from the definer lookups, for the ids asked', async () => {
    const direct = await withPublicRead((tx) =>
      tx.execute(sql`select count(*)::int as n from legacy_id_maps where entity in ('listing', 'unit')`),
    );
    expect((direct.rows[0] as { n: number }).n).toBe(0);
    const viaLookup = await withPublicRead((tx) =>
      tx.execute(sql`select entity, legacy_id from public.legacy_target_ids(array['910001', '929999']::text[])`),
    );
    expect(viaLookup.rows).toEqual([{ entity: 'listing', legacy_id: '910001' }]);
    const back = await withPublicRead((tx) =>
      tx.execute(
        sql`select legacy_id from public.legacy_ids_of(array['0195f0a5-0801-7000-8000-000000000001']::uuid[])`,
      ),
    );
    expect(back.rows).toEqual([{ legacy_id: '910001' }]);
  });

  it("[S8-02] a legacy id of another site's listing is the same 404 as an unknown one", async () => {
    // B's own legacy id opens on B's site and nowhere else.
    expect((await get(withKey('/v1/properties/920001', b.key))).statusCode).toBe(200);
    const foreign = await get(withKey('/v1/properties/920001'));
    const unknown = await get(withKey('/v1/properties/929999'));
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(unknown.body);
    // The same reference on B's site is B's listing (its own legacy id), never A's.
    expect((await get(withKey('/v1/properties/GH-101', b.key))).json()).toMatchObject({
      property: { id: '920001', ref: 'GH-101' },
    });
    const list = (await get(withKey('/v1/properties?limit=50'))).json() as { properties: { id: string }[] };
    expect(list.properties.map((p) => p.id)).not.toContain('920001');
  });

  it('[S8-02] legacy page numbers: page 2 follows page 1; under the Postgres fallback (keyset only) a later page is empty', async () => {
    const first = (await get(withKey('/v1/properties?limit=2&page=1'))).json() as {
      total: number;
      total_pages: number;
      properties: unknown[];
    };
    expect(first).toMatchObject({ total: 4, total_pages: 2 });
    expect(first.properties).toHaveLength(2);
    // The engine is unreachable here: an offset page restarts the fallback's keyset walk, which is not page 2.
    const second = (await get(withKey('/v1/properties?limit=2&page=2'))).json() as {
      page: number;
      total: number;
      properties: unknown[];
    };
    expect(second).toMatchObject({ page: 2, total: 4, properties: [] });
    // Past the engine's 10,000-result cap: no page, the first page's total.
    const deep = (await get(withKey('/v1/properties?limit=50&page=201'))).json() as { total: number; properties: [] };
    expect(deep).toMatchObject({ total: 4, properties: [] });
  });

  it('[S8-02] unknown query parameters are ignored, bad values are a legacy 400', async () => {
    const res = await get(withKey('/v1/properties?lang=en&_=1700000000&utm_source=x'));
    expect(res.statusCode).toBe(200);
    const bad = await get(withKey('/v1/properties?limit=500'));
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ status: 'error', message: 'Invalid parameter' });
    // A language the site does not speak falls back to its default.
    expect((await get(withKey('/v1/properties/910001?lang=de'))).statusCode).toBe(200);
  });

  it('[S8-02] /v1/types lists property types by legacy id where they have one', async () => {
    const res = (await get(withKey('/v1/types?lang=en'))).json() as { status: string; types: { id: string }[] };
    expect(res.status).toBe('ok');
    expect(res.types.map((t) => t.id)).toEqual(['gt-1', 'gt-2', '0195f0a5-0802-7000-8000-000000000003']);
  });

  it("[S8-02] legacy 'rent' filters long-term rentals and 'holiday' short-term ones, as the answers name them", async () => {
    const rent = (await get(withKey('/v1/properties?transaction=rent'))).json() as {
      properties: { ref: string; transaction: string }[];
    };
    expect(rent.properties.map((p) => [p.ref, p.transaction])).toEqual([['GH-103', 'rent']]);
    const holiday = (await get(withKey('/v1/properties?transaction=holiday'))).json() as { properties: unknown[] };
    expect(holiday.properties).toEqual([]);
  });

  it('[S8-02] at most 3 statements per v1 request, warm and cold; filter ids never resolved in SQL', async () => {
    const urls = [
      '/v1/properties?lang=en',
      '/v1/properties?type=gt-1&location=gl-2&feature=gf-1',
      '/v1/properties?q=GH-102',
      '/v1/properties/910001',
      '/v1/properties/GH-103',
      '/v1/properties/929999',
      '/v1/types',
    ];
    for (const url of urls) await get(withKey(url));
    for (const url of urls) {
      const warm = await countQueries(() => get(withKey(url)));
      expect(warm, `${url} warm`).toBeLessThanOrEqual(3);
    }
    // Cold: compiled owner identities and resolved listing legacy ids dropped (the site scope and the taxonomy maps stay
    // loaded, as in production: feed-api loads the maps at boot and refreshes them in the background).
    for (const url of urls) {
      websiteApi.resetWebsiteApiCaches();
      migration.resetLegacyIdCache();
      const cold = await countQueries(() => get(withKey(url)));
      expect(cold, `${url} cold`).toBeLessThanOrEqual(3);
    }
    // Made-up filter ids never reach SQL: each is unknown in the taxonomy maps, the page is empty without a statement.
    for (let i = 0; i < 5; i++) {
      const none = await countQueries(() => get(withKey(`/v1/properties?type=nope-${i}&location=nope-${i}`)));
      expect(none).toBe(0);
    }
    // One unknown id beside a known one costs nothing extra either.
    const mixed = await countQueries(() => get(withKey('/v1/properties?type=gt-1,nope-x')));
    expect(mixed).toBeLessThanOrEqual(3);
  });
});
