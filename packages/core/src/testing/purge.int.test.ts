import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as taxonomy from '../modules/taxonomy';
import { purgeReferenceFixtures } from './factories';

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
