import { type CreateLocationInput, PORTAL_ZONE_MAX_MEMBERS } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../index';

/** Locations on the real test database with PostGIS (S2-01). */

const RUN = newId().slice(-8).toLowerCase();
const slug = (s: string) => `${s}-${RUN}`.replace(/[^a-z0-9-]/g, '');
const tr = (name: string, s: string) => [{ locale: 'en', name, slug: slug(s) }];

/** A square MultiPolygon (lon/lat degrees). */
const square = (x: number, y: number, size: number): NonNullable<CreateLocationInput['polygon']> => ({
  type: 'MultiPolygon',
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

let founder: Founder;
const asMember = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('taxonomy.test', fn);

let countryId: string;
let regionId: string;
let cityId: string;
let areaId: string;

beforeAll(async () => {
  await setupTestDb('worker');
  founder = await createFounder();
  await purge('S201-%');
  await system(async (tx) => {
    countryId = await taxonomy.createLocation(tx, {
      parentId: null,
      level: 'COUNTRY',
      code: `S201-${RUN}`,
      polygon: square(-10, 35, 20),
      translations: tr('Spain', 'spain'),
    });
    regionId = await taxonomy.createLocation(tx, {
      parentId: countryId,
      level: 'REGION',
      polygon: square(-5, 36, 3),
      translations: tr('Andalusia', 'andalusia'),
    });
    cityId = await taxonomy.createLocation(tx, {
      parentId: regionId,
      level: 'CITY',
      polygon: square(-4.6, 36.4, 0.5),
      translations: tr('Marbella', 'marbella'),
    });
    areaId = await taxonomy.createLocation(tx, {
      parentId: cityId,
      level: 'AREA',
      centroid: { type: 'Point', coordinates: [-4.35, 36.5] },
      polygon: square(-4.4, 36.45, 0.1),
      translations: tr('Nueva Andalucía', 'nueva-andalucia'),
    });
  });
}, 120_000);

/**
 * Removes trees whose country code matches (deepest level first, parents are RESTRICT) and this file's groups.
 * `beforeAll` also removes those of earlier runs that never reached `afterAll` (a crashed fork): their polygons
 * cover the same points and would win the lookup.
 */
const purge = (countryCode: string, groupKey?: string) =>
  system(async (tx) => {
    if (groupKey) await tx.execute(sql`delete from location_groups where key like ${groupKey}`);
    for (const depth of [4, 3, 2, 1]) {
      await tx.execute(sql`
        delete from locations where depth = ${depth} and id in (
          with recursive t as (
            select id from locations where depth = 1 and code like ${countryCode}
            union all select l.id from locations l join t on l.parent_id = t.id
          ) select id from t)`);
    }
  });

afterAll(async () => {
  await purge(`S201-${RUN}`, `%-${RUN}`);
  await closeDb();
});

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(isAppError(err) && err.code).toBe(code);
};

describe('locations', () => {
  it('[S2-01] point-in-polygon returns the deepest matching location', async () => {
    const inArea = await asMember((ctx) => taxonomy.findLocationAtPoint(ctx, -4.35, 36.5));
    expect(inArea).toMatchObject({ id: areaId, level: 'AREA', name: 'Nueva Andalucía' });
    const inCity = await asMember((ctx) => taxonomy.findLocationAtPoint(ctx, -4.55, 36.45));
    expect(inCity?.id).toBe(cityId);
    const inRegion = await asMember((ctx) => taxonomy.findLocationAtPoint(ctx, -3, 38));
    expect(inRegion?.id).toBe(regionId);
    expect((await asMember((ctx) => taxonomy.findLocationAtPoint(ctx, 100, 10)))?.id).toBeUndefined();
  });

  it('[S2-01] the lookup stays under 10 ms with a GiST index on a large tree', async () => {
    await system((tx) =>
      tx.execute(sql`
        insert into locations (id, parent_id, level, depth, polygon)
        select gen_random_uuid(), ${cityId}::uuid, 'AREA', 4,
          ST_SetSRID(ST_Multi(ST_MakeEnvelope(x * 0.01 - 80, y * 0.01 + 50, x * 0.01 - 79.995, y * 0.01 + 50.005)), 4326)
        from generate_series(0, 199) x, generate_series(0, 49) y`),
    );
    await system((tx) => tx.execute(sql`analyze locations`));
    // Server-side execution time (EXPLAIN ANALYZE): stable under a busy parallel verify, unlike client wall-clock.
    const times: number[] = [];
    await asMember(async (ctx) => {
      expect((await taxonomy.findLocationAtPoint(ctx, -4.35, 36.5))?.id).toBe(areaId);
      for (let i = 0; i < 10; i++) {
        const res = await ctx.tx.execute(sql`explain (analyze, format text)
          select id from locations
          where ST_Covers(polygon, ST_SetSRID(ST_MakePoint(-4.35, 36.5), 4326)) order by depth desc limit 1`);
        const text = res.rows.map((r) => String(Object.values(r)[0])).join('\n');
        expect(text).not.toMatch(/Seq Scan on locations/);
        times.push(Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1]));
      }
    });
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(10);
  });

  it('[S2-01] slugs are unique per (parent, locale), not globally', async () => {
    await system(async (tx) => {
      await rejects(
        taxonomy.createLocation(tx, {
          parentId: regionId,
          level: 'CITY',
          translations: tr('Marbella again', 'marbella'),
        }),
        'LOCATION_SLUG_TAKEN',
      );
    });
    await system(async (tx) => {
      // Same slug under another parent and in another locale is fine.
      const otherRegion = await taxonomy.createLocation(tx, {
        parentId: countryId,
        level: 'REGION',
        translations: tr('Other', 'other-region'),
      });
      await taxonomy.createLocation(tx, {
        parentId: otherRegion,
        level: 'CITY',
        translations: tr('Marbella', 'marbella'),
      });
      await taxonomy.createLocation(tx, {
        parentId: regionId,
        level: 'CITY',
        translations: [{ locale: 'es', name: 'Marbella', slug: slug('marbella') }],
      });
    });
  });

  it('[S2-01] a location sits exactly one level below its parent', async () => {
    await system(async (tx) => {
      await rejects(
        taxonomy.createLocation(tx, { parentId: countryId, level: 'CITY', translations: tr('X', 'x-skip') }),
        'LOCATION_PARENT_INVALID',
      );
      await rejects(
        taxonomy.createLocation(tx, { parentId: null, level: 'REGION', translations: tr('X', 'x-root') }),
        'LOCATION_PARENT_INVALID',
      );
    });
  });

  it('[S2-01] aliases resolve feed spellings to the canonical location', async () => {
    await system((tx) => taxonomy.addLocationAlias(tx, areaId, `Nueva Andalucia ${RUN}`));
    const hit = await asMember((ctx) => taxonomy.resolveLocationAlias(ctx, `  NUEVA  andalucía ${RUN}`));
    expect(hit?.id).toBe(areaId);
    await system(async (tx) => {
      await rejects(taxonomy.addLocationAlias(tx, cityId, `nueva andalucia ${RUN}`), 'LOCATION_ALIAS_TAKEN');
    });
    expect(await asMember((ctx) => taxonomy.resolveLocationAlias(ctx, `nowhere ${RUN}`))).toBeNull();
  });

  it('[S2-01] location groups hold members and reject unknown ones', async () => {
    await system(async (tx) => {
      const id = await taxonomy.createLocationGroup(tx, {
        key: slug('costa-del-sol'),
        translations: tr('Costa del Sol', 'costa-del-sol'),
        memberIds: [cityId, areaId],
      });
      expect(id).toBeTruthy();
      await rejects(
        taxonomy.createLocationGroup(tx, { key: slug('bad'), translations: tr('Bad', 'bad'), memberIds: [newId()] }),
        'LOCATION_NOT_FOUND',
      );
    });
  });

  it('[S15-F8] a zone over the portal member cap is refused at save, one at the cap is saved', async () => {
    await system(async (tx) => {
      const over = Array.from({ length: PORTAL_ZONE_MAX_MEMBERS + 1 }, () => newId());
      await rejects(
        taxonomy.createLocationGroup(tx, { key: slug('big'), translations: tr('Big', 'big'), memberIds: over }),
        'LOCATION_ZONE_TOO_LARGE',
      );
      // duplicates count once, so the cap is on distinct members
      const dupes = Array.from({ length: PORTAL_ZONE_MAX_MEMBERS + 5 }, () => cityId);
      expect(
        await taxonomy.createLocationGroup(tx, {
          key: slug('dupes'),
          translations: tr('Dupes', 'dupes'),
          memberIds: dupes,
        }),
      ).toBeTruthy();
    });
  });
});
