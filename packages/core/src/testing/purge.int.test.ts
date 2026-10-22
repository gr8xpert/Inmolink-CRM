import { CreateListingBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withMemberCtx } from '../member';
import * as properties from '../modules/properties';
import * as taxonomy from '../modules/taxonomy';
import { createFounder, purgeReferenceFixtures, purgeStaleLocationFixtures } from './factories';

/** Fixture hygiene (S3-F3): what a crashed run left behind is removed by the next run's `beforeAll`. */

beforeAll(() => setupTestDb('worker'), 120_000);
afterAll(closeDb);

const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('purge.test', fn);
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug }];

it('[S3-F3] a crashed earlier run’s reference fixtures are removed by the next run, other files’ rows kept', async () => {
  // "Earlier run" of a file with prefix `purge-`: a whole tree, a group and a catalog entry with fixed names.
  const old = newId().slice(-8).toLowerCase();
  const other = newId().slice(-8).toLowerCase();
  const ids = await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      parentId: null,
      level: 'COUNTRY',
      translations: tr('Spain', `purge-spain-${old}`),
    });
    const region = await taxonomy.createLocation(tx, {
      parentId: country,
      level: 'REGION',
      translations: tr('Andalusia', `purge-andalusia-${old}`),
    });
    // a child whose slug lacks the prefix still goes with its tree
    const city = await taxonomy.createLocation(tx, {
      parentId: region,
      level: 'CITY',
      translations: tr('Marbella', `x-${old}`),
    });
    await taxonomy.createLocationGroup(tx, {
      key: `purge-costa-${old}`,
      translations: tr('Costa', `purge-costa-${old}`),
      memberIds: [city],
    });
    const group = await taxonomy.createFeatureGroup(tx, {
      key: `purge-outdoor-${old}`,
      sort: 0,
      translations: tr('Outdoor', `purge-outdoor-${old}`),
    });
    await taxonomy.createFeature(tx, {
      groupId: group,
      key: `purge-pool-${old}`,
      sort: 0,
      icon: 'waves',
      translations: tr('Pool', `purge-pool-${old}`),
    });
    // another file's row (different prefix) must survive
    const keep = await taxonomy.createLocation(tx, {
      parentId: null,
      level: 'COUNTRY',
      translations: tr('Elsewhere', `kept-${other}`),
    });
    return { country, region, city, keep };
  });

  await purgeReferenceFixtures('purge-');

  const left = await system(async (tx) => {
    const r = await tx.execute<{ n: number }>(sql`select
      (select count(*) from locations where id in (${ids.country}, ${ids.region}, ${ids.city}))::int
      + (select count(*) from location_translations where slug like 'purge-%')::int
      + (select count(*) from location_groups where key like 'purge-%')::int
      + (select count(*) from features where key like 'purge-%')::int
      + (select count(*) from feature_groups where key like 'purge-%')::int as n`);
    const kept = await tx.execute<{ n: number }>(sql`select count(*)::int as n from locations where id = ${ids.keep}`);
    await tx.execute(sql`delete from locations where id = ${ids.keep}`);
    return { removed: r.rows[0]?.n, kept: kept.rows[0]?.n };
  });
  expect(left).toEqual({ removed: 0, kept: 1 });
  await expect(purgeReferenceFixtures('Bad prefix')).rejects.toThrow(TypeError);
});

describe('purgeStaleLocationFixtures', () => {
  const RUN = newId().slice(-8).toLowerCase();
  const touched: string[] = [];
  const make = (parentId: string | null, level: 'COUNTRY' | 'REGION', slug: string) =>
    system(async (tx) => {
      const id = await taxonomy.createLocation(tx, { parentId, level, translations: tr(slug, `${slug}-${RUN}`) });
      touched.push(id);
      return id;
    });
  const age = (id: string, hours: number) =>
    system((tx) =>
      tx.execute(sql`update locations set created_at = now() - make_interval(hours => ${hours}) where id = ${id}`),
    );
  const present = (ids: string[]) =>
    system(async (tx) => {
      const r = await tx.execute<{ id: string }>(
        sql`select id from locations where id::text = any(string_to_array(${ids.join(',')}, ','))`,
      );
      return new Set(r.rows.map((x) => x.id));
    });

  afterAll(async () => {
    await system(async (tx) => {
      await tx.execute(
        sql`delete from properties where location_id::text = any(string_to_array(${touched.join(',')}, ','))`,
      );
      for (const depth of [2, 1]) {
        await tx.execute(
          sql`delete from locations where depth = ${depth} and id::text = any(string_to_array(${touched.join(',')}, ','))`,
        );
      }
      await tx.execute(sql`delete from property_types where key = ${`purgestale-t-${RUN}`}`);
      await tx.execute(sql`delete from property_type_groups where key = ${`purgestale-g-${RUN}`}`);
    });
  });

  it('[S7-F13] a stale leaf and its stale parent are deleted; a fresh row, a seed- row and a row a property points to stay', async () => {
    const parent = await make(null, 'COUNTRY', 'stale-parent');
    const leaf = await make(parent, 'REGION', 'stale-leaf');
    const fresh = await make(null, 'COUNTRY', 'fresh');
    const seed = await make(null, 'COUNTRY', 'seed');
    const used = await make(null, 'COUNTRY', 'used');
    // a stale child of a fresh parent goes; the fresh parent stays
    const staleUnderFresh = await make(fresh, 'REGION', 'stale-under-fresh');
    await system((tx) =>
      tx.execute(sql`update location_translations set slug = 'seed-' || ${RUN} || '-t' where location_id = ${seed}`),
    );
    for (const id of [parent, leaf, seed, used, staleUnderFresh]) await age(id, 2);

    const founder = await createFounder();
    await setAgencyStatus(founder.agencyId, 'VERIFIED');
    const type = await system(async (tx) => {
      const group = await taxonomy.createPropertyTypeGroup(tx, {
        key: `purgestale-g-${RUN}`,
        sort: 0,
        translations: tr('G', `purgestale-g-${RUN}`),
      });
      return taxonomy.createPropertyType(tx, {
        groupId: group,
        key: `purgestale-t-${RUN}`,
        sort: 0,
        translations: tr('T', `purgestale-t-${RUN}`),
      });
    });
    await withMemberCtx(
      { userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' },
      (ctx) => properties.createListing(ctx, CreateListingBody.parse({ propertyTypeId: type, locationId: used })),
    );

    await purgeStaleLocationFixtures();

    const left = await present([parent, leaf, fresh, seed, used, staleUnderFresh]);
    expect([...left].sort()).toEqual([fresh, seed, used].sort());
  });

  it('[S7-F13] a location in a group is kept', async () => {
    const member = await make(null, 'COUNTRY', 'in-group');
    await age(member, 2);
    const key = `purgestale-grp-${RUN}`;
    await system((tx) => taxonomy.createLocationGroup(tx, { key, translations: tr('Grp', key), memberIds: [member] }));
    await purgeStaleLocationFixtures();
    expect((await present([member])).has(member)).toBe(true);
    await system((tx) => tx.execute(sql`delete from location_groups where key = ${key}`));
  });
});
