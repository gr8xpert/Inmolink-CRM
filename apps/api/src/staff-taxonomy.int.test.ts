import { StaffLocationDto, UnmatchedPageDto, WebsiteLocationChildrenDto } from '@inmolink/contracts';
import { closeDb, pingDb } from '@inmolink/core';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder } from '@inmolink/core/test';
import { adminQuery, createStaffUser, setupTestDb } from '@inmolink/db/testing';
import { cache, closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/** Staff taxonomy admin over HTTP (S2-04): create an area, draw its polygon, translate it, see it served. */

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' });
const bearer = async (sub: string, agency?: string) => ({
  authorization: `Bearer ${(await signer.sign({ sub, aud: 'api', sv: 1, ...(agency ? { agency } : {}) })).token}`,
});

const build = () =>
  buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allowAll,
    readinessCacheMs: 0,
    checks: { db: () => pingDb('app_user') },
    verifier: createAccessTokenVerifier({ publicKeys: parsePublicKeys(`t1:${pair.publicKey}`) }),
  });

let app: Awaited<ReturnType<typeof build>>;

beforeAll(async () => {
  await setupTestDb('http');
  await configureCache({ prefix: `t:staff-taxonomy:${newId().slice(-12)}` });
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeCache();
  await closeDb();
});

const RUN = newId().slice(-8).toLowerCase();
const slug = (s: string) => `${s}-${RUN}`;
const tr = (locale: string, name: string, s: string) => ({ locale, name, slug: slug(s) });

const square = (x: number, y: number, size: number) => ({
  type: 'MultiPolygon' as const,
  coordinates: [
    [
      [
        [x, y],
        [x + size, y],
        [x + size, y + size],
        [x, y + size],
        [x, y],
      ],
    ],
  ],
});
/** A bow-tie: its ring crosses itself, so PostGIS calls it invalid. */
const bowTie = {
  type: 'MultiPolygon' as const,
  coordinates: [
    [
      [
        [0, 0],
        [2, 2],
        [2, 0],
        [0, 2],
        [0, 0],
      ],
    ],
  ],
};

/** Runs this process's `taxonomy.data.changed` subscribers on every event the test caused (the dispatcher's job). */
async function deliverChanged(ids: string[]): Promise<void> {
  const rows = await adminQuery<{ id: string; agency_id: string; version: number; payload: unknown }>(
    `select id, agency_id, version, payload from outbox_events
      where type = 'taxonomy.data.changed' and payload->>'id' = any($1::text[])`,
    [ids],
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const event of rows) {
    for (const s of defaultSubscribers.get('taxonomy.data.changed', event.version)) {
      await s.handler(
        event.payload as never,
        {
          eventId: event.id,
          agencyId: event.agency_id,
          type: 'taxonomy.data.changed',
          version: event.version,
          createdAt: new Date(),
          attempt: 1,
        } as never,
      );
    }
  }
  cache.clearLocal();
}

describe('staff taxonomy admin', () => {
  it('[S2-04] create area → draw polygon → translate → appears in the localized endpoints after cache invalidation', async () => {
    taxonomy.registerTaxonomySubscriptions();
    const ops = await bearer((await createStaffUser('STAFF_DATA_OPS')).userId);
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: ops, payload });
    const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url, headers: ops, payload });

    const country = await post('/v1/staff/taxonomy/locations', {
      parentId: null,
      level: 'COUNTRY',
      translations: [tr('en', 'Spain', 'spain')],
    });
    expect(country.statusCode, country.body).toBe(201);
    const region = await post('/v1/staff/taxonomy/locations', {
      parentId: country.json().id,
      level: 'REGION',
      translations: [tr('en', 'Andalusia', 'andalusia')],
    });
    const city = await post('/v1/staff/taxonomy/locations', {
      parentId: region.json().id,
      level: 'CITY',
      translations: [tr('en', 'Marbella', 'marbella')],
    });
    expect(city.statusCode, city.body).toBe(201);

    // 1. Create the area (English name only).
    const area = await post('/v1/staff/taxonomy/locations', {
      parentId: city.json().id,
      level: 'AREA',
      translations: [tr('en', 'Golden Mile', 'golden-mile')],
    });
    expect(area.statusCode, area.body).toBe(201);
    const areaId: string = area.json().id;
    // Warm the Spanish cache now, before the polygon and translation exist.
    await taxonomy.getWebsiteLocationChildren(city.json().id, 'es');

    // 2. Draw its polygon, and map a feed spelling.
    const drawn = await patch(`/v1/staff/taxonomy/locations/${areaId}`, {
      polygon: square(-4.9, 36.48, 0.05),
      centroid: { type: 'Point', coordinates: [-4.875, 36.505] },
    });
    expect(drawn.statusCode, drawn.body).toBe(200);
    expect(StaffLocationDto.parse(drawn.json()).polygon?.type).toBe('MultiPolygon');
    const aliased = await post(`/v1/staff/taxonomy/locations/${areaId}/aliases`, { alias: `Milla de Oro ${RUN}` });
    expect(aliased.statusCode, aliased.body).toBe(201);
    expect(aliased.json().aliases.map((a: { alias: string }) => a.alias)).toEqual([`Milla de Oro ${RUN}`]);
    const covers = await adminQuery<{ id: string }>(
      `select id from locations where ST_Covers(polygon, ST_SetSRID(ST_MakePoint(-4.875, 36.505), 4326)) and id = $1`,
      [areaId],
    );
    expect(covers).toHaveLength(1);

    // 3. Translate it: the Spanish set is replaced in, English stays.
    const translated = await patch(`/v1/staff/taxonomy/locations/${areaId}`, {
      translations: [tr('en', 'Golden Mile', 'golden-mile'), tr('es', 'Milla de Oro', 'milla-de-oro')],
    });
    expect(translated.statusCode, translated.body).toBe(200);
    expect(translated.json().translations.map((t: { locale: string }) => t.locale)).toEqual(['en', 'es']);

    // 4. The website endpoint serves the new area in Spanish once the cache has been invalidated.
    const before = WebsiteLocationChildrenDto.parse(
      JSON.parse((await taxonomy.getWebsiteLocationChildren(city.json().id, 'es')).json),
    );
    await deliverChanged([areaId]);
    const after = WebsiteLocationChildrenDto.parse(
      JSON.parse((await taxonomy.getWebsiteLocationChildren(city.json().id, 'es')).json),
    );
    // The cache still holds the tree from before the edits (English fallback) until the event is delivered.
    expect(before.children).toEqual([expect.objectContaining({ id: areaId, name: 'Golden Mile' })]);
    expect(after.children).toEqual([
      expect.objectContaining({ id: areaId, name: 'Milla de Oro', slug: slug('milla-de-oro') }),
    ]);
    // The staff tree is read fresh and shows the same.
    const tree = await app.inject({ method: 'GET', url: '/v1/staff/taxonomy', headers: ops });
    expect(tree.statusCode).toBe(200);
    expect(tree.headers['cache-control']).toBe('no-store');

    // Every write was audited under the platform.
    const audits = await adminQuery<{ type: string }>(
      `select type from audit_logs where type = 'staff.taxonomy.changed' and metadata->>'entity' in ('location','locationAlias')`,
    );
    expect(audits.length).toBeGreaterThanOrEqual(6);
  });

  it('[S2-04] polygons must be valid; a taken slug or alias is a conflict', async () => {
    const ops = await bearer((await createStaffUser('SUPER_ADMIN')).userId);
    const root = await app.inject({
      method: 'POST',
      url: '/v1/staff/taxonomy/locations',
      headers: ops,
      payload: { parentId: null, level: 'COUNTRY', translations: [tr('en', 'Portugal', 'portugal')] },
    });
    const id: string = root.json().id;
    const bad = await app.inject({
      method: 'PATCH',
      url: `/v1/staff/taxonomy/locations/${id}`,
      headers: ops,
      payload: { polygon: bowTie },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('LOCATION_POLYGON_INVALID');

    const other = await app.inject({
      method: 'POST',
      url: '/v1/staff/taxonomy/locations',
      headers: ops,
      payload: { parentId: null, level: 'COUNTRY', translations: [tr('en', 'France', 'france')] },
    });
    const clash = await app.inject({
      method: 'PATCH',
      url: `/v1/staff/taxonomy/locations/${other.json().id}`,
      headers: ops,
      payload: { translations: [tr('en', 'Portugal again', 'portugal')] },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('LOCATION_SLUG_TAKEN');

    const first = await app.inject({
      method: 'POST',
      url: `/v1/staff/taxonomy/locations/${id}/aliases`,
      headers: ops,
      payload: { alias: `Lusitania ${RUN}` },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: `/v1/staff/taxonomy/locations/${other.json().id}/aliases`,
      headers: ops,
      payload: { alias: `lusitánia ${RUN}` },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('LOCATION_ALIAS_TAKEN');
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/staff/taxonomy/locations/${id}/aliases/${first.json().aliases[0].id}`,
      headers: ops,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().aliases).toEqual([]);
  });

  it('[S2-04] drag-and-drop order: siblings keep the saved order; a partial or foreign list is refused', async () => {
    const ops = await bearer((await createStaffUser('STAFF_DATA_OPS')).userId);
    const root = await app.inject({
      method: 'POST',
      url: '/v1/staff/taxonomy/locations',
      headers: ops,
      payload: { parentId: null, level: 'COUNTRY', translations: [tr('en', 'Ordering', 'ordering')] },
    });
    const parentId: string = root.json().id;
    const ids: string[] = [];
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/staff/taxonomy/locations',
        headers: ops,
        payload: { parentId, level: 'REGION', translations: [tr('en', name, `ord-${name.toLowerCase()}`)] },
      });
      ids.push(r.json().id);
    }
    const [alpha, beta, gamma] = ids as [string, string, string];
    const put = (orderedIds: string[]) =>
      app.inject({
        method: 'PUT',
        url: '/v1/staff/taxonomy/locations-order',
        headers: ops,
        payload: { parentId, orderedIds },
      });
    const children = async () => {
      const t = await app.inject({ method: 'GET', url: '/v1/staff/taxonomy', headers: ops });
      const node = (t.json().locations as { id: string; children: { id: string }[] }[]).find((c) => c.id === parentId);
      return node?.children.map((c) => c.id);
    };

    expect(await children()).toEqual([alpha, beta, gamma]); // creation order: new locations go last
    const ok = await put([gamma, alpha, beta]);
    expect(ok.statusCode, ok.body).toBe(204);
    expect(await children()).toEqual([gamma, alpha, beta]);
    const partial = await put([gamma, alpha]);
    expect(partial.statusCode).toBe(422);
    expect(partial.json().error.code).toBe('TAXONOMY_ORDER_INVALID');
    expect((await put([gamma, alpha, beta, root.json().id])).statusCode).toBe(422);
    expect((await put([gamma, gamma, alpha])).statusCode).toBe(422);
  });

  it('[S2-04] catalog: reorder items, edit translations and aliases', async () => {
    const ops = await bearer((await createStaffUser('STAFF_DATA_OPS')).userId);
    const [groupId, a, b] = [newId(), newId(), newId()] as const;
    await adminQuery(`insert into property_type_groups (id, key, sort) values ($1, $2, 0)`, [groupId, `grp-${RUN}`]);
    await adminQuery(
      `insert into property_type_group_translations (group_id, locale, name, slug) values ($1, 'en', 'Group', $2)`,
      [groupId, slug('grp')],
    );
    for (const [id, n, sort] of [
      [a, 'one', 0],
      [b, 'two', 1],
    ] as const) {
      await adminQuery(`insert into property_types (id, group_id, key, sort) values ($1, $2, $3, $4)`, [
        id,
        groupId,
        `${n}-${RUN}`,
        sort,
      ]);
      await adminQuery(
        `insert into property_type_translations (type_id, locale, name, slug) values ($1, 'en', $2, $3)`,
        [id, n, slug(`t-${n}`)],
      );
    }
    const order = await app.inject({
      method: 'PUT',
      url: '/v1/staff/taxonomy/catalog-order',
      headers: ops,
      payload: { kind: 'propertyType', groupId, orderedIds: [b, a] },
    });
    expect(order.statusCode, order.body).toBe(204);
    const sorts = await adminQuery<{ id: string }>(`select id from property_types where group_id = $1 order by sort`, [
      groupId,
    ]);
    expect(sorts.map((r) => r.id)).toEqual([b, a]);

    const edit = await app.inject({
      method: 'PUT',
      url: `/v1/staff/taxonomy/catalog/${a}`,
      headers: ops,
      payload: {
        kind: 'propertyType',
        scope: 'item',
        translations: [tr('en', 'one', 't-one'), tr('es', 'Uno', 't1-es')],
      },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json().translations.map((t: { locale: string }) => t.locale)).toEqual(['en', 'es']);
    const alias = await app.inject({
      method: 'POST',
      url: `/v1/staff/taxonomy/catalog/propertyType/${a}/aliases`,
      headers: ops,
      payload: { alias: `Uno ${RUN}` },
    });
    expect(alias.statusCode, alias.body).toBe(201);
    const gone = await app.inject({
      method: 'DELETE',
      url: `/v1/staff/taxonomy/catalog/propertyType/${a}/aliases/${alias.json().aliases[0].id}`,
      headers: ops,
    });
    expect(gone.json().aliases).toEqual([]);
  });

  it('[S2-04] reading is for all staff; writing for super admins and data ops; everyone else gets 403', async () => {
    const support = await bearer((await createStaffUser('STAFF_SUPPORT')).userId);
    const f = await createFounder();
    const member = await bearer(f.userId, f.agencyId);
    const body = { parentId: null, level: 'COUNTRY', translations: [tr('en', 'Nope', 'nope')] };

    expect((await app.inject({ method: 'GET', url: '/v1/staff/taxonomy', headers: support })).statusCode).toBe(200);
    for (const headers of [support, member]) {
      const w = await app.inject({ method: 'POST', url: '/v1/staff/taxonomy/locations', headers, payload: body });
      expect(w.statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/staff/taxonomy', headers: member })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/staff/taxonomy' })).statusCode).toBe(401);
  });
  it('[S2-05] the unmatched queue over HTTP: list, map to a location, ignore; non-staff get 403', async () => {
    const ops = await bearer((await createStaffUser('STAFF_DATA_OPS')).userId);
    const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: ops, payload });
    const country = await post('/v1/staff/taxonomy/locations', {
      parentId: null,
      level: 'COUNTRY',
      translations: [tr('en', 'Queueland', 'queueland')],
    });
    const countryId: string = country.json().id;
    const spelling = `Qland Zorbo ${RUN}`;
    // The API process cannot use withSystem (APP_ROLE=http): seed the queue as an import worker would have.
    await adminQuery(
      `insert into taxonomy_unmatched (id, kind, value_key, value, count, examples) values
         ($1, 'location', lower($3), $3, 7, '["feed-1"]'), ($2, 'location', lower($4), $4, 1, '["feed-2"]')`,
      [newId(), newId(), spelling, `Ignorable ${RUN}`],
    );

    const list = await app.inject({
      method: 'GET',
      url: '/v1/staff/taxonomy/unmatched?kind=location&limit=100',
      headers: ops,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    const items = UnmatchedPageDto.parse(list.json()).items;
    const row = items.find((i) => i.value === spelling);
    expect(row).toMatchObject({ count: 7, examples: ['feed-1'], status: 'OPEN' });

    const mapped = await post(`/v1/staff/taxonomy/unmatched/${row?.id}/map`, { targetId: countryId });
    expect(mapped.statusCode, mapped.body).toBe(200);
    expect(mapped.json()).toMatchObject({ status: 'MAPPED', mappedToId: countryId });
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/staff/taxonomy/locations/${countryId}`,
      headers: ops,
    });
    expect(detail.json().aliases.map((a: { alias: string }) => a.alias)).toEqual([spelling]);

    const other = items.find((i) => i.value === `Ignorable ${RUN}`);
    const ignored = await post(`/v1/staff/taxonomy/unmatched/${other?.id}/ignore`);
    expect(ignored.json().status).toBe('IGNORED');
    const missing = await post(`/v1/staff/taxonomy/unmatched/${newId()}/ignore`);
    expect(missing.statusCode).toBe(404);

    const f = await createFounder();
    const member = await bearer(f.userId, f.agencyId);
    for (const url of ['/v1/staff/taxonomy/unmatched']) {
      expect((await app.inject({ method: 'GET', url, headers: member })).statusCode).toBe(403);
    }
    const support = await bearer((await createStaffUser('STAFF_SUPPORT')).userId);
    const denied = await app.inject({
      method: 'POST',
      url: `/v1/staff/taxonomy/unmatched/${other?.id}/map`,
      headers: support,
      payload: { targetId: countryId },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('[S3-F1] a translation in a non-content locale and an over-sized polygon are refused with 422', async () => {
    const ops = await bearer((await createStaffUser('STAFF_DATA_OPS')).userId);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/staff/taxonomy/locations',
      headers: ops,
      payload: { parentId: null, level: 'COUNTRY', translations: [tr('zz', 'Nowhere', 'nowhere')] },
    });
    expect(created.statusCode, created.body).toBe(422);
    expect(created.json().error.code).toBe('VALIDATION_FAILED');

    const root = await app.inject({
      method: 'POST',
      url: '/v1/staff/taxonomy/locations',
      headers: ops,
      payload: { parentId: null, level: 'COUNTRY', translations: [tr('en', 'Capland', 'capland')] },
    });
    const id: string = root.json().id;
    const relabel = await app.inject({
      method: 'PATCH',
      url: `/v1/staff/taxonomy/locations/${id}`,
      headers: ops,
      payload: { translations: [tr('en', 'Capland', 'capland'), tr('zz', 'Capland', 'capland-zz')] },
    });
    expect(relabel.statusCode).toBe(422);

    // 51 polygons: one over the cap
    const many = {
      type: 'MultiPolygon' as const,
      coordinates: Array.from({ length: 51 }, (_, i) => square(i * 0.01, 0, 0.005).coordinates[0]),
    };
    const tooMany = await app.inject({
      method: 'PATCH',
      url: `/v1/staff/taxonomy/locations/${id}`,
      headers: ops,
      payload: { polygon: many },
    });
    expect(tooMany.statusCode).toBe(422);
    expect(tooMany.json().error.code).toBe('VALIDATION_FAILED');
    // one ring of 10,001 vertices: over the vertex cap
    const ring = Array.from({ length: 10_000 }, (_, i) => {
      const a = (2 * Math.PI * i) / 10_000;
      return [Math.cos(a), Math.sin(a)] as [number, number];
    });
    const dense = { type: 'MultiPolygon' as const, coordinates: [[[...ring, ring[0] as [number, number]]]] };
    const tooDense = await app.inject({
      method: 'PATCH',
      url: `/v1/staff/taxonomy/locations/${id}`,
      headers: ops,
      payload: { polygon: dense },
    });
    expect(tooDense.statusCode).toBe(422);
    const fine = await app.inject({
      method: 'PATCH',
      url: `/v1/staff/taxonomy/locations/${id}`,
      headers: ops,
      payload: { polygon: square(1, 1, 0.5) },
    });
    expect(fine.statusCode, fine.body).toBe(200);
  });

  it('[S3-F1] an audit row for a taxonomy change names the entity', async () => {
    const ops = await bearer((await createStaffUser('STAFF_DATA_OPS')).userId);
    const root = await app.inject({
      method: 'POST',
      url: '/v1/staff/taxonomy/locations',
      headers: ops,
      payload: { parentId: null, level: 'COUNTRY', translations: [tr('en', 'Auditland', 'auditland')] },
    });
    const id: string = root.json().id;
    await app.inject({
      method: 'PATCH',
      url: `/v1/staff/taxonomy/locations/${id}`,
      headers: ops,
      payload: { code: `AU${RUN}`.slice(0, 40) },
    });
    const audits = await adminQuery<{ action: string; target_type: string; target_id: string; entity_id: string }>(
      `select metadata->>'action' as action, target_type, target_id, metadata->>'entityId' as entity_id
         from audit_logs where type = 'staff.taxonomy.changed' and target_id = $1 order by occurred_at`,
      [id],
    );
    expect(audits.map((a) => a.action)).toEqual(['createLocation', 'updateLocation']);
    for (const a of audits) expect(a).toMatchObject({ target_type: 'taxonomy', target_id: id, entity_id: id });
  });

  it('[S3-F1] a catalog slug clash has its own code', async () => {
    const ops = await bearer((await createStaffUser('STAFF_DATA_OPS')).userId);
    const [groupId, a, b] = [newId(), newId(), newId()] as const;
    await adminQuery(`insert into feature_groups (id, key, sort) values ($1, $2, 0)`, [groupId, `fgrp-${RUN}`]);
    for (const [id, n] of [
      [a, 'pool'],
      [b, 'lift'],
    ] as const) {
      await adminQuery(`insert into features (id, group_id, key, sort, icon) values ($1, $2, $3, 0, 'waves')`, [
        id,
        groupId,
        `${n}-${RUN}`,
      ]);
      await adminQuery(`insert into feature_translations (feature_id, locale, name, slug) values ($1, 'en', $2, $3)`, [
        id,
        n,
        slug(`f-${n}`),
      ]);
    }
    const clash = await app.inject({
      method: 'PUT',
      url: `/v1/staff/taxonomy/catalog/${b}`,
      headers: ops,
      payload: { kind: 'feature', scope: 'item', translations: [tr('en', 'lift', 'f-pool')] },
    });
    expect(clash.statusCode, clash.body).toBe(409);
    expect(clash.json().error.code).toBe('TAXONOMY_SLUG_TAKEN');
  });

  it('[S3-F1] queue paging is stable while imports count: no value twice; the unfiltered list pages too', async () => {
    const ops = await bearer((await createStaffUser('STAFF_DATA_OPS')).userId);
    // a count band no other test uses, so this run's rows are contiguous in the most-seen-first order
    await adminQuery(`delete from taxonomy_unmatched where value_key like 'paging %'`);
    const ids = Array.from({ length: 6 }, () => newId());
    for (const [i, id] of ids.entries()) {
      await adminQuery(
        `insert into taxonomy_unmatched (id, kind, value_key, value, count, examples)
         values ($1, $2, $3, $3, $4, '[]')`,
        [id, i % 2 ? 'feature' : 'location', `paging ${i} ${RUN}`, 900_000 + i],
      );
    }
    const page = async (cursor?: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/staff/taxonomy/unmatched?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        headers: ops,
      });
      expect(res.statusCode, res.body).toBe(200);
      return UnmatchedPageDto.parse(res.json());
    };
    const seen: string[] = [];
    let p = await page();
    seen.push(...p.items.map((i) => i.id));
    // an import counts a value of a later page while staff browse: it moves up, never into a page twice
    await adminQuery(`update taxonomy_unmatched set count = count + 50 where id = $1`, [ids[1]]);
    while (p.nextCursor && seen.filter((s) => ids.includes(s)).length < 6) {
      p = await page(p.nextCursor);
      seen.push(...p.items.map((i) => i.id));
      if (p.items.every((i) => i.count < 900_000)) break;
    }
    const mine = seen.filter((s) => ids.includes(s));
    expect(new Set(mine).size).toBe(mine.length);
    expect(mine.slice(0, 2)).toEqual([ids[5], ids[4]]);
    await adminQuery(`delete from taxonomy_unmatched where id = any($1::uuid[])`, [ids]);
  });
});
