import { closeDb, withSystem } from '@inmolink/db';
import { createStaffUser, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../index';

/** Alias resolver and unmatched queue on the real test database (S2-05). */

const RUN = newId().slice(-8).toLowerCase();
const code = (s: string) => `${s}-${RUN}`;
// Slugs are unique per parent, so each location carries the run; names stay clean so trigram scores are real.
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];

let founder: Founder;
let staffId: string;
const asMember = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('taxonomy.test', fn);
const asStaff = <T>(fn: Parameters<typeof withStaffCtx<T>>[1]) =>
  withStaffCtx({ userId: staffId, requestId: newId(), reason: 'resolver test' }, fn);

let spainId: string;
let costaId: string; // REGION
let marbellaId: string;
let sanPedroId: string; // AREA under Marbella
let longNameId: string; // a long name: one typo still scores above the accept threshold
let calahondaAltaId: string;
let calahondaBajaId: string;
let villaId: string;
let poolId: string;
let springfieldA: string;
let springfieldB: string;
let regionB: string;

beforeAll(async () => {
  await setupTestDb('worker');
  founder = await createFounder();
  staffId = (await createStaffUser('STAFF_DATA_OPS')).userId;
  await system(async (tx) => {
    spainId = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('res-es'),
      translations: tr('Reinoresolver', 'reinoresolver'),
    });
    costaId = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: spainId,
      code: code('res-costa'),
      translations: tr('Costa Zafiro', 'costa-zafiro'),
    });
    regionB = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: spainId,
      code: code('res-b'),
      translations: tr('Sierra Rubi', 'sierra-rubi'),
    });
    marbellaId = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: costaId,
      code: code('res-marbella'),
      translations: tr('Málaga Oriental', 'malaga-oriental'),
    });
    sanPedroId = await taxonomy.createLocation(tx, {
      level: 'AREA',
      parentId: marbellaId,
      code: code('res-sanpedro'),
      translations: tr('Quartzmar', 'quartzmar'),
    });
    longNameId = await taxonomy.createLocation(tx, {
      level: 'AREA',
      parentId: marbellaId,
      code: code('res-long'),
      translations: tr('Quartzmarandelaluna', 'quartzmarandelaluna'),
    });
    calahondaAltaId = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: costaId,
      code: code('res-calahonda-a'),
      translations: tr('Calahonda Alta', 'calahonda-alta'),
    });
    calahondaBajaId = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: costaId,
      code: code('res-calahonda-b'),
      translations: tr('Calahonda Baja', 'calahonda-baja'),
    });
    // The same town name under two regions: only a parent hint tells them apart.
    springfieldA = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: costaId,
      code: code('res-spring-a'),
      translations: tr('Springfieldia', 'springfieldia'),
    });
    springfieldB = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: regionB,
      code: code('res-spring-b'),
      translations: tr('Springfieldia', 'springfieldia'),
    });
    const typeGroup = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('res-houses'),
      sort: 0,
      translations: tr('Casas', 'casas'),
    });
    villaId = await taxonomy.createPropertyType(tx, {
      groupId: typeGroup,
      key: code('res-villa'),
      sort: 0,
      translations: tr('Chaletazo', 'chaletazo'),
    });
    const featureGroup = await taxonomy.createFeatureGroup(tx, {
      key: code('res-outdoor'),
      sort: 0,
      translations: tr('Exterior', 'exterior'),
    });
    poolId = await taxonomy.createFeature(tx, {
      groupId: featureGroup,
      key: code('res-pool'),
      sort: 0,
      icon: 'waves',
      translations: tr('Piscina Climatizada', 'piscina-climatizada'),
    });
    await taxonomy.addLocationAlias(tx, sanPedroId, `Quarzmar Beach ${RUN}`);
    await taxonomy.addPropertyTypeAlias(tx, villaId, `Detached House ${RUN}`);
    await taxonomy.addFeatureAlias(tx, poolId, `Heated Pool ${RUN}`);
  });
}, 120_000);

afterAll(async () => {
  await system(async (tx) => {
    await tx.execute(sql`delete from taxonomy_unmatched where value_key like '%quartz%' or value_key like '%zorbo%'
      or value_key like '%chaletazu%' or value_key like '%calahonda%' or value_key like '%piscinaa%' or value_key like '%springfieldia%'
      or value_key like '%${sql.raw(RUN)}%' or value_key like '%nonsensia%'`);
    await tx.execute(sql`delete from locations where depth = 4 and code like ${`%-${RUN}`}`);
    await tx.execute(sql`delete from locations where depth = 3 and code like ${`%-${RUN}`}`);
    await tx.execute(sql`delete from locations where depth = 2 and code like ${`%-${RUN}`}`);
    await tx.execute(sql`delete from locations where depth = 1 and code like ${`%-${RUN}`}`);
    await tx.execute(sql`delete from property_types where key like ${`%-${RUN}`}`);
    await tx.execute(sql`delete from property_type_groups where key like ${`%-${RUN}`}`);
    await tx.execute(sql`delete from features where key like ${`%-${RUN}`}`);
    await tx.execute(sql`delete from feature_groups where key like ${`%-${RUN}`}`);
  });
  await closeDb();
});

const queued = (kind: string, valueKey: string) =>
  system(async (tx) => {
    const res = await tx.execute(
      sql`select id, count, examples, status, candidate_id as "candidateId", mapped_to_id as "mappedToId"
            from taxonomy_unmatched where kind = ${kind} and value_key = ${valueKey}`,
    );
    return ((Array.isArray(res) ? res : (res as unknown as { rows: unknown[] }).rows) as Record<string, unknown>[])[0];
  });

describe('alias resolver', () => {
  it('[S2-05] a known alias is an exact match (case and accents ignored), for all three kinds', async () => {
    const loc = await asMember((ctx) => taxonomy.resolveLocation(ctx, `QUARZMAR   beach ${RUN}`));
    expect(loc).toMatchObject({ status: 'exact', id: sanPedroId, confidence: 1 });
    const type = await asMember((ctx) => taxonomy.resolveType(ctx, `detached-house ${RUN}`));
    expect(type).toMatchObject({ status: 'exact', id: villaId, confidence: 1 });
    const feature = await asMember((ctx) => taxonomy.resolveFeature(ctx, `HEATED POOL ${RUN}`));
    expect(feature).toMatchObject({ status: 'exact', id: poolId, confidence: 1 });
  });

  it('[S2-05] a canonical name matches exactly without an alias, accents folded', async () => {
    const r = await asMember((ctx) => taxonomy.resolveLocation(ctx, 'MALAGA oriental'));
    expect(r).toMatchObject({ status: 'exact', id: marbellaId });
  });

  it('[S2-05] a confident typo resolves as fuzzy with its confidence', async () => {
    const r = await asMember((ctx) => taxonomy.resolveLocation(ctx, 'Quartzmarandelalunaa'));
    expect(r.status).toBe('fuzzy');
    expect(r.id).toBe(longNameId);
    expect(r.confidence).toBeGreaterThanOrEqual(taxonomy.FUZZY_ACCEPT);
    expect(r.confidence).toBeLessThan(1);
  });

  it('[S2-05] low-confidence fuzzy is never guessed: unmatched, with the closest candidate as a hint', async () => {
    const r = await asMember((ctx) => taxonomy.resolveType(ctx, 'Chaletazu Zorbo'));
    expect(r.status).toBe('unmatched');
    expect(r.id).toBeNull();
    expect(r.candidate?.id).toBe(villaId);
    expect(r.candidate?.confidence).toBeLessThan(taxonomy.FUZZY_ACCEPT);
    const nothing = await asMember((ctx) => taxonomy.resolveFeature(ctx, 'Nonsensia Qwxzv'));
    expect(nothing).toEqual({ status: 'unmatched', id: null, confidence: 0, candidate: null });
  });

  it('[S2-05] a near-tie between two candidates goes to staff, not to the first', async () => {
    const r = await asMember((ctx) => taxonomy.resolveLocation(ctx, 'Calahonda'));
    expect(r.status).toBe('unmatched');
    expect([calahondaAltaId, calahondaBajaId]).toContain(r.candidate?.id);
  });

  it('[S2-05] hints: one name under two parents is ambiguous alone, exact with the parent', async () => {
    const alone = await asMember((ctx) => taxonomy.resolveLocation(ctx, 'Springfieldia'));
    expect(alone.status).toBe('unmatched');
    const a = await asMember((ctx) => taxonomy.resolveLocation(ctx, 'Springfieldia', { parentId: costaId }));
    const b = await asMember((ctx) => taxonomy.resolveLocation(ctx, 'Springfieldia', { parentId: regionB }));
    expect(a).toMatchObject({ status: 'exact', id: springfieldA });
    expect(b).toMatchObject({ status: 'exact', id: springfieldB });
    const level = await asMember((ctx) => taxonomy.resolveLocation(ctx, 'Quartzmar', { level: 'CITY' }));
    expect(level.status).toBe('unmatched');
  });

  it('[S2-05] a batch resolves in input order with one result per value', async () => {
    const out = await system((tx) =>
      taxonomy.resolveMany(tx, 'location', [`Quarzmar Beach ${RUN}`, '', 'Quartzmarandelalunaa', 'Nonsensia Qwxzv']),
    );
    expect(out.map((r) => r.status)).toEqual(['exact', 'unmatched', 'fuzzy', 'unmatched']);
  });
});

describe('unmatched queue', () => {
  it('[S2-05] unmatched values are queued with counts and examples, merged across runs, never the guess', async () => {
    const run = (extra: string) =>
      system((tx) =>
        taxonomy.resolveAndQueue(tx, 'propertyType', [
          { text: 'Chaletazu Zorbo', count: 3, example: 'ref-A' },
          { text: 'chaletazu  ZORBO', example: 'ref-B' },
          { text: `Detached House ${RUN}`, example: 'ref-C' },
          { text: 'Chaletazu Zorbo', example: extra },
        ]),
      );
    const first = await run('ref-D');
    expect(first.map((r) => r.status)).toEqual(['unmatched', 'unmatched', 'exact', 'unmatched']);
    expect(await queued('propertyType', 'chaletazu zorbo')).toMatchObject({
      count: 5,
      examples: ['ref-A', 'ref-B', 'ref-D'],
      status: 'OPEN',
      candidateId: villaId,
    });
    expect(await queued('propertyType', `detached house ${RUN}`)).toBeUndefined();
    await run('ref-E');
    expect(await queued('propertyType', 'chaletazu zorbo')).toMatchObject({
      count: 10,
      examples: ['ref-A', 'ref-B', 'ref-D', 'ref-E'],
    });
  });

  it('[S2-05] staff list the queue (most-seen first, candidate named) and map a value: alias created, next import exact', async () => {
    await system((tx) =>
      taxonomy.resolveAndQueue(tx, 'propertyType', [{ text: 'Nonsensia Qwxzv Chaletazu', count: 2, example: 'ref-Z' }]),
    );
    const page = await asStaff((ctx) =>
      taxonomy.listStaffUnmatched(ctx, { kind: 'propertyType', status: 'OPEN', limit: 100 }),
    );
    const zorbo = page.items.find((i) => i.value === 'Chaletazu Zorbo');
    expect(zorbo).toMatchObject({ count: 10, status: 'OPEN', candidate: { id: villaId, name: 'Chaletazo' } });
    const counts = page.items.map((i) => i.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));

    const mapped = await asStaff((ctx) => taxonomy.mapStaffUnmatched(ctx, zorbo?.id as string, { targetId: villaId }));
    expect(mapped).toMatchObject({ status: 'MAPPED', mappedToId: villaId });

    // The next import run: the same spelling now resolves exactly, and nothing new is queued.
    const [after] = await system((tx) =>
      taxonomy.resolveAndQueue(tx, 'propertyType', [{ text: 'chaletazu zorbo', example: 'ref-next' }]),
    );
    expect(after).toMatchObject({ status: 'exact', id: villaId });
    expect(await queued('propertyType', 'chaletazu zorbo')).toMatchObject({ status: 'MAPPED', count: 10 });
    const open = await asStaff((ctx) =>
      taxonomy.listStaffUnmatched(ctx, { kind: 'propertyType', status: 'OPEN', limit: 100 }),
    );
    expect(open.items.some((i) => i.id === zorbo?.id)).toBe(false);
  });

  it('[S2-05] adding the alias by hand also closes the queued value; ignored values leave the open queue', async () => {
    await system((tx) =>
      taxonomy.resolveAndQueue(tx, 'location', [
        { text: 'Quartzmar Playa', example: 'feed-1' },
        { text: 'Springfieldia Norte', example: 'feed-2' },
      ]),
    );
    await system((tx) => taxonomy.addLocationAlias(tx, sanPedroId, 'Quartzmar Playa'));
    expect(await queued('location', 'quartzmar playa')).toMatchObject({ status: 'MAPPED', mappedToId: sanPedroId });

    const row = await queued('location', 'springfieldia norte');
    const ignored = await asStaff((ctx) => taxonomy.ignoreStaffUnmatched(ctx, row?.id as string));
    expect(ignored.status).toBe('IGNORED');
    await system((tx) => taxonomy.resolveAndQueue(tx, 'location', [{ text: 'Springfieldia Norte' }]));
    expect(await queued('location', 'springfieldia norte')).toMatchObject({ status: 'IGNORED', count: 2 });
  });

  it('[S2-05] the queue pages by cursor and only data ops write', async () => {
    await system((tx) =>
      taxonomy.resolveAndQueue(tx, 'feature', [
        { text: 'Piscinaa Zorbo', count: 5 },
        { text: 'Piscinaa Zorbo Dos', count: 4 },
        { text: 'Piscinaa Zorbo Tres', count: 3 },
      ]),
    );
    const p1 = await asStaff((ctx) => taxonomy.listStaffUnmatched(ctx, { kind: 'feature', status: 'OPEN', limit: 2 }));
    expect(p1.items.map((i) => i.count)).toEqual([5, 4]);
    const p2 = await asStaff((ctx) =>
      taxonomy.listStaffUnmatched(ctx, { kind: 'feature', status: 'OPEN', limit: 2, cursor: p1.nextCursor as string }),
    );
    expect(p2.items.map((i) => i.count)).toEqual([3]);
    expect(p2.nextCursor).toBeNull();

    const support = (await createStaffUser('STAFF_SUPPORT')).userId;
    await expect(
      withStaffCtx({ userId: support, requestId: newId(), reason: 'resolver test' }, (ctx) =>
        taxonomy.mapStaffUnmatched(ctx, p1.items[0]?.id as string, { targetId: poolId }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const readable = await withStaffCtx({ userId: support, requestId: newId(), reason: 'resolver test' }, (ctx) =>
      taxonomy.listStaffUnmatched(ctx, { kind: 'feature', status: 'OPEN', limit: 1 }),
    );
    expect(readable.items).toHaveLength(1);
  });
});
