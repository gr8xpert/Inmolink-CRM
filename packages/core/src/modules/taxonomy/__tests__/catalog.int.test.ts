import { PORTAL_MAX_SEARCH_TYPES } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, purgeReferenceFixtures } from '../../../testing/factories';
import * as taxonomy from '../index';

/** Property types and features on the real test database (S2-02). */

const RUN = newId().slice(-8).toLowerCase();
/** File prefix, so `beforeAll` can clear what a crashed earlier run left (S3-F3). */
const PREFIX = 'cat-';
const key = (s: string) => `${PREFIX}${s}-${RUN}`;
const tr = (en: string, s: string, es?: string) => [
  { locale: 'en', name: en, slug: key(s) },
  ...(es ? [{ locale: 'es', name: es, slug: key(`${s}-es`) }] : []),
];

let founder: Founder;
const asMember = <T>(fn: (ctx: Ctx) => Promise<T>, locale = 'en') =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('taxonomy.test', fn);

let typeGroupId: string;
let villaId: string;
let featureGroupId: string;
let poolId: string;

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(isAppError(err) && err.code).toBe(code);
};

beforeAll(async () => {
  await setupTestDb('worker');
  await purgeReferenceFixtures(PREFIX);
  founder = await createFounder();
  await system(async (tx) => {
    typeGroupId = await taxonomy.createPropertyTypeGroup(tx, {
      key: key('houses'),
      sort: 0,
      translations: tr('Houses', 'houses'),
    });
    villaId = await taxonomy.createPropertyType(tx, {
      groupId: typeGroupId,
      key: key('villa'),
      sort: 0,
      translations: tr('Villa', 'villa', 'Chalet'),
    });
    featureGroupId = await taxonomy.createFeatureGroup(tx, {
      key: key('outdoor'),
      sort: 0,
      translations: tr('Outdoor', 'outdoor'),
    });
    poolId = await taxonomy.createFeature(tx, {
      groupId: featureGroupId,
      key: key('pool'),
      sort: 0,
      icon: 'waves',
      translations: tr('Swimming pool', 'pool', 'Piscina'),
    });
  });
}, 120_000);

afterAll(async () => {
  // Reference data is global: remove this file's rows.
  await purgeReferenceFixtures(PREFIX);
  await closeDb();
});

describe('property types and features', () => {
  it('[S2-02] aliases resolve case- and accent-insensitively', async () => {
    await system(async (tx) => {
      await taxonomy.addPropertyTypeAlias(tx, villaId, `Chalét Independiente ${RUN}`);
      await taxonomy.addFeatureAlias(tx, poolId, `Piscína Privada ${RUN}`);
    });
    for (const spelling of [
      `chalet independiente ${RUN}`,
      `CHALÉT   INDEPENDIENTE ${RUN}`,
      `Chalet-Independiente ${RUN}`,
    ]) {
      expect((await asMember((ctx) => taxonomy.resolvePropertyTypeAlias(ctx, spelling)))?.id).toBe(villaId);
    }
    for (const spelling of [`PISCINA PRIVADA ${RUN}`, `piscína privada ${RUN}`]) {
      expect((await asMember((ctx) => taxonomy.resolveFeatureAlias(ctx, spelling)))?.id).toBe(poolId);
    }
    expect(await asMember((ctx) => taxonomy.resolvePropertyTypeAlias(ctx, 'no such spelling'))).toBeNull();
  });

  it('[S2-02] names come in the requested locale, falling back to English', async () => {
    const es = await asMember((ctx) => taxonomy.resolvePropertyTypeAlias(ctx, `chalet independiente ${RUN}`), 'es');
    expect(es).toMatchObject({ name: 'Chalet', groupId: typeGroupId });
    const fr = await asMember((ctx) => taxonomy.resolvePropertyTypeAlias(ctx, `chalet independiente ${RUN}`), 'fr');
    expect(fr?.name).toBe('Villa');
  });

  it('[S2-02] features carry a Lucide icon name, property types do not need one', async () => {
    const feature = await asMember((ctx) => taxonomy.resolveFeatureAlias(ctx, `piscina privada ${RUN}`));
    expect(feature).toMatchObject({ key: key('pool'), icon: 'waves', name: 'Swimming pool' });
    await system(async (tx) => {
      await expect(
        taxonomy.createFeature(tx, {
          groupId: featureGroupId,
          key: key('bad-icon'),
          sort: 0,
          icon: 'Not An Icon',
          translations: tr('Bad', 'bad-icon'),
        }),
      ).rejects.toThrow();
    });
  });

  it('[S2-02] a spelling maps to one entry, a key is used once, parents must exist', async () => {
    await system((tx) =>
      rejects(taxonomy.addPropertyTypeAlias(tx, villaId, `CHALET INDEPENDIENTE ${RUN}`), 'TAXONOMY_ALIAS_TAKEN'),
    );
    await system((tx) =>
      rejects(
        taxonomy.createPropertyTypeGroup(tx, {
          key: key('houses'),
          sort: 0,
          translations: tr('Again', 'houses-again'),
        }),
        'TAXONOMY_KEY_TAKEN',
      ),
    );
    await system((tx) =>
      rejects(
        taxonomy.createPropertyType(tx, {
          groupId: newId(),
          key: key('ghost'),
          sort: 0,
          translations: tr('Ghost', 'ghost'),
        }),
        'TAXONOMY_NOT_FOUND',
      ),
    );
    await system((tx) => rejects(taxonomy.addFeatureAlias(tx, newId(), 'anything'), 'TAXONOMY_NOT_FOUND'));
  });

  it('[S15-F8] a type group past the portal type cap refuses another type', async () => {
    await system(async (tx) => {
      const gid = await taxonomy.createPropertyTypeGroup(tx, {
        key: key('cap'),
        sort: 9,
        translations: tr('Cap', 'cap'),
      });
      for (let i = 0; i < PORTAL_MAX_SEARCH_TYPES; i++) {
        await taxonomy.createPropertyType(tx, {
          groupId: gid,
          key: key(`cap-${i}`),
          sort: i,
          translations: tr(`Cap ${i}`, `cap-${i}`),
        });
      }
      await rejects(
        taxonomy.createPropertyType(tx, {
          groupId: gid,
          key: key('cap-x'),
          sort: 99,
          translations: tr('Cap x', 'cap-x'),
        }),
        'TAXONOMY_GROUP_TOO_LARGE',
      );
    });
  });
});
