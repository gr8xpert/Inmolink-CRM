import { TaxonomyCatalogDto, TaxonomyDto, WebsiteLocationChildrenDto, WebsiteLocationsDto } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { cache, closeCache, configureCache } from '@inmolink/platform/cache';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers, PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../index';

/** Localized taxonomy reads, cache and change events on the real test database and redis-cache (S2-03). */

const RUN = newId().slice(-8).toLowerCase();
const key = (s: string) => `${s}-${RUN}`;
const tr = (en: string, s: string, es?: string) => [
  { locale: 'en', name: en, slug: key(s) },
  ...(es ? [{ locale: 'es', name: es, slug: key(`${s}-es`) }] : []),
];

let founder: Founder;
const asMember = <T>(fn: (ctx: Ctx) => Promise<T>, locale = 'en') =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('taxonomy.test', fn);

const ids: Record<string, string> = {};

type OutboxRow = { id: string; agency_id: string; version: number; payload: { entity: string; id: string } };
const changedEvents = () =>
  system(async (tx) => {
    const r = await tx.execute<OutboxRow>(
      sql`select id, agency_id, version, payload from outbox_events
           where type = 'taxonomy.data.changed' and payload->>'id' = any(string_to_array(${Object.values(ids).join(',')}, ','))`,
    );
    return r.rows;
  });

/** Runs this process's subscribers for an outbox event (the dispatcher's job). */
async function deliver(event: OutboxRow): Promise<void> {
  const subscribers = defaultSubscribers.get('taxonomy.data.changed', event.version);
  expect(subscribers.length).toBeGreaterThan(0);
  for (const s of subscribers) {
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

/** Starts from an empty cache: a new tag version in Redis, nothing in-process. */
async function coldCache(): Promise<void> {
  await taxonomy.invalidateTaxonomyCache();
  cache.clearLocal();
}

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:taxonomy:${newId().slice(-12)}` });
  taxonomy.registerTaxonomySubscriptions();
  founder = await createFounder();
  await system(async (tx) => {
    ids.country = await taxonomy.createLocation(tx, {
      parentId: null,
      level: 'COUNTRY',
      translations: tr('Spain', 'spain', 'España'),
    });
    ids.region = await taxonomy.createLocation(tx, {
      parentId: ids.country,
      level: 'REGION',
      translations: tr('Andalusia', 'andalusia', 'Andalucía'),
    });
    ids.city = await taxonomy.createLocation(tx, {
      parentId: ids.region,
      level: 'CITY',
      translations: tr('Marbella', 'marbella'),
    });
    ids.area = await taxonomy.createLocation(tx, {
      parentId: ids.city,
      level: 'AREA',
      translations: tr('Golden Mile', 'golden-mile', 'Milla de Oro'),
    });
    ids.locationAlias = await taxonomy.addLocationAlias(tx, ids.area, `Golden Mile ${RUN}`);
    ids.locationGroup = await taxonomy.createLocationGroup(tx, {
      key: key('costa'),
      translations: tr('Costa del Sol', 'costa', 'Costa del Sol'),
      memberIds: [ids.city, ids.area],
    });
    ids.typeGroup = await taxonomy.createPropertyTypeGroup(tx, {
      key: key('houses'),
      sort: 0,
      translations: tr('Houses', 'houses', 'Casas'),
    });
    ids.type = await taxonomy.createPropertyType(tx, {
      groupId: ids.typeGroup,
      key: key('villa'),
      sort: 0,
      translations: tr('Villa', 'villa', 'Chalet'),
    });
    ids.typeAlias = await taxonomy.addPropertyTypeAlias(tx, ids.type, `Detached villa ${RUN}`);
    ids.featureGroup = await taxonomy.createFeatureGroup(tx, {
      key: key('outdoor'),
      sort: 0,
      translations: tr('Outdoor', 'outdoor'),
    });
    ids.feature = await taxonomy.createFeature(tx, {
      groupId: ids.featureGroup,
      key: key('pool'),
      sort: 0,
      icon: 'waves',
      translations: tr('Swimming pool', 'pool', 'Piscina'),
    });
    ids.featureAlias = await taxonomy.addFeatureAlias(tx, ids.feature, `Pool ${RUN}`);
  });
}, 120_000);

afterAll(async () => {
  taxonomy.unregisterTaxonomySubscriptions();
  await system(async (tx) => {
    await tx.execute(sql`delete from location_groups where key like ${`%-${RUN}`}`);
    for (const id of [ids.area, ids.city, ids.region, ids.country]) {
      if (id) await tx.execute(sql`delete from locations where id = ${id}`);
    }
    await tx.execute(sql`delete from property_types where key like ${`%-${RUN}`}`);
    await tx.execute(sql`delete from property_type_groups where key like ${`%-${RUN}`}`);
    await tx.execute(sql`delete from features where key like ${`%-${RUN}`}`);
    await tx.execute(sql`delete from feature_groups where key like ${`%-${RUN}`}`);
  });
  await closeCache();
  await closeDb();
});

describe('localized taxonomy', () => {
  it('[S2-03] a full localized taxonomy read uses ≤ 3 queries cold and 0 warm', async () => {
    await coldCache();
    const cold = await asMember((ctx) => countQueries(() => taxonomy.getTaxonomy(ctx)));
    expect(cold).toBeLessThanOrEqual(3);
    const warm = await asMember((ctx) => countQueries(() => taxonomy.getTaxonomy(ctx)));
    expect(warm).toBe(0);

    // Another process: nothing in memory, the Redis entry still serves it without a query.
    cache.clearLocal();
    expect(await asMember((ctx) => countQueries(() => taxonomy.getTaxonomy(ctx)))).toBe(0);
    // The website API shares the entries.
    expect(await countQueries(() => taxonomy.getWebsiteLocations('en'))).toBe(0);
    expect(await countQueries(() => taxonomy.getWebsiteLocationChildren(ids.region as string, 'en'))).toBe(0);
    expect(await countQueries(() => taxonomy.getWebsiteCatalog('en'))).toBe(0);
  });

  it('[S2-03] localized trees: nested locations, groups and catalog in the locale, English fallback', async () => {
    await coldCache();
    const es = TaxonomyDto.parse(await asMember((ctx) => taxonomy.getTaxonomy(ctx), 'es'));
    expect(es.locale).toBe('es');

    const country = es.locations.find((c) => c.id === ids.country);
    expect(country).toMatchObject({ level: 'COUNTRY', name: 'España', slug: key('spain-es') });
    const region = country?.children.find((r) => r.id === ids.region);
    expect(region).toMatchObject({ level: 'REGION', name: 'Andalucía' });
    // No Spanish name for Marbella: English is the fallback.
    const city = region?.children.find((c) => c.id === ids.city);
    expect(city).toMatchObject({ level: 'CITY', name: 'Marbella', slug: key('marbella') });
    expect(city?.children).toEqual([
      { id: ids.area, level: 'AREA', code: null, name: 'Milla de Oro', slug: key('golden-mile-es') },
    ]);
    expect(es.locationGroups.find((g) => g.id === ids.locationGroup)).toEqual({
      id: ids.locationGroup,
      key: key('costa'),
      name: 'Costa del Sol',
      slug: key('costa-es'),
      locationIds: [ids.city, ids.area].sort(),
    });

    expect(es.propertyTypes.find((g) => g.id === ids.typeGroup)).toEqual({
      id: ids.typeGroup,
      key: key('houses'),
      name: 'Casas',
      slug: key('houses-es'),
      types: [{ id: ids.type, key: key('villa'), name: 'Chalet', slug: key('villa-es') }],
    });
    expect(es.features.find((g) => g.id === ids.featureGroup)).toEqual({
      id: ids.featureGroup,
      key: key('outdoor'),
      name: 'Outdoor',
      slug: key('outdoor'),
      features: [{ id: ids.feature, key: key('pool'), name: 'Piscina', slug: key('pool-es'), icon: 'waves' }],
    });

    // English is a separate cache entry with its own names.
    const en = await asMember((ctx) => taxonomy.getTaxonomy(ctx), 'en');
    expect(en.locale).toBe('en');
    expect(en.locations.find((c) => c.id === ids.country)?.name).toBe('Spain');
  });

  it('[S2-03] every write emits taxonomy.data.changed; its subscriber invalidates the cached taxonomy', async () => {
    const events = await changedEvents();
    const byId = new Map(events.map((e) => [e.payload.id, e]));
    const expected: Record<string, string> = {
      country: 'location',
      region: 'location',
      city: 'location',
      area: 'location',
      locationAlias: 'locationAlias',
      locationGroup: 'locationGroup',
      typeGroup: 'propertyTypeGroup',
      type: 'propertyType',
      typeAlias: 'propertyTypeAlias',
      featureGroup: 'featureGroup',
      feature: 'feature',
      featureAlias: 'featureAlias',
    };
    for (const [name, entity] of Object.entries(expected)) {
      const e = byId.get(ids[name] as string);
      expect(e, name).toBeDefined();
      expect(e?.payload, name).toEqual({ entity, id: ids[name] });
      expect(e?.agency_id, name).toBe(PLATFORM_AGENCY_ID);
    }

    // Warm cache, then a new feature: readers keep the cached catalog until the event is delivered.
    await asMember((ctx) => taxonomy.getTaxonomy(ctx));
    const jacuzziId = await system((tx) =>
      taxonomy.createFeature(tx, {
        groupId: ids.featureGroup as string,
        key: key('jacuzzi'),
        sort: 1,
        icon: 'bath',
        translations: tr('Jacuzzi', 'jacuzzi'),
      }),
    );
    ids.jacuzzi = jacuzziId;
    const featuresOf = async () =>
      (await asMember((ctx) => taxonomy.getTaxonomy(ctx))).features
        .find((g) => g.id === ids.featureGroup)
        ?.features.map((f) => f.id);
    expect(await featuresOf()).toEqual([ids.feature]);

    const [event] = (await changedEvents()).filter((e) => e.payload.id === jacuzziId);
    await deliver(event as OutboxRow);
    expect(await featuresOf()).toEqual([ids.feature, jacuzziId]);
  });

  it('[S2-03] website reads: one level at a time, same cache, ≤ 3 queries cold and 0 warm', async () => {
    await coldCache();
    const cold =
      (await countQueries(() => taxonomy.getWebsiteLocations('es'))) +
      (await countQueries(() => taxonomy.getWebsiteLocationChildren(ids.city as string, 'es'))) +
      (await countQueries(() => taxonomy.getWebsiteCatalog('es')));
    expect(cold).toBeLessThanOrEqual(3);
    const warm =
      (await countQueries(() => taxonomy.getWebsiteLocations('es'))) +
      (await countQueries(() => taxonomy.getWebsiteLocationChildren(ids.region as string, 'es'))) +
      (await countQueries(() => taxonomy.getWebsiteCatalog('es')));
    expect(warm).toBe(0);

    const top = WebsiteLocationsDto.parse(JSON.parse((await taxonomy.getWebsiteLocations('es')).json));
    const spain = top.locations.find((c) => c.id === ids.country);
    // Countries carry their regions; deeper levels only as counts.
    expect(spain?.children.find((r) => r.id === ids.region)).toEqual({
      id: ids.region,
      level: 'REGION',
      code: null,
      name: 'Andalucía',
      slug: key('andalusia-es'),
      childCount: 1,
    });
    expect(top.locationGroups.find((g) => g.id === ids.locationGroup)?.locationIds).toHaveLength(2);

    const areas = WebsiteLocationChildrenDto.parse(
      JSON.parse((await taxonomy.getWebsiteLocationChildren(ids.city as string, 'es')).json),
    );
    expect(areas).toEqual({
      locale: 'es',
      parentId: ids.city,
      children: [
        { id: ids.area, level: 'AREA', code: null, name: 'Milla de Oro', slug: key('golden-mile-es'), childCount: 0 },
      ],
    });
    const leaf = WebsiteLocationChildrenDto.parse(
      JSON.parse((await taxonomy.getWebsiteLocationChildren(ids.area as string, 'es')).json),
    );
    expect(leaf.children).toEqual([]);

    const unknown = await taxonomy.getWebsiteLocationChildren(newId(), 'es').then(
      () => null,
      (e) => e,
    );
    expect(isAppError(unknown) && unknown.code).toBe('LOCATION_NOT_FOUND');
  });

  it('[S2-03] website reads: locale validated, strong ETag that changes with the data', async () => {
    await coldCache();
    const first = await taxonomy.getWebsiteCatalog('en');
    TaxonomyCatalogDto.parse(JSON.parse(first.json));
    expect(first.etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    // Serialized once per cached copy.
    expect(await taxonomy.getWebsiteCatalog('en')).toBe(first);
    // Absent → the default content locale.
    expect(JSON.parse((await taxonomy.getWebsiteLocations()).json).locale).toBe('es');

    const err = await taxonomy.getWebsiteCatalog('xx').then(
      () => null,
      (e) => e,
    );
    expect(isAppError(err) && err.code).toBe('VALIDATION_FAILED');

    await system((tx) =>
      taxonomy.createPropertyType(tx, {
        groupId: ids.typeGroup as string,
        key: key('finca'),
        sort: 2,
        translations: tr('Country house', 'finca', 'Finca'),
      }),
    );
    await coldCache();
    expect((await taxonomy.getWebsiteCatalog('en')).etag).not.toBe(first.etag);
  });

  it('[S2-03] Client Mode reads the taxonomy (reference data, nothing to strip)', async () => {
    const full = await asMember((ctx) => taxonomy.getTaxonomy(ctx));
    const client = await asMember((ctx) => taxonomy.getTaxonomy({ ...ctx, clientMode: true }));
    expect(client).toEqual(full);
  });
});
