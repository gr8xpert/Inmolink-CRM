import { createHash } from 'node:crypto';
import { CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, type Tx, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as media from '../../media';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as dedupe from '../index';
import * as repo from '../repo';
import { AUTO_CLUSTER_SCORE } from '../scoring';
import { COMMON_KEY_LISTINGS, MAX_CANDIDATES, scoreSignatures } from '../service';
import { imageKeyOf, type Signature, signatureOf } from '../signature';
import { buildFixtureSet, type FixtureSet } from './fixtures';

/**
 * Duplicate detection (R2-03a) on the real test database: the labelled fixture set's signatures written and scored as
 * the worker does — blocking finds every duplicate, skips a common (logo) hash, bounds candidates; a re-score changes
 * nothing; a `search.listings.changed` event queues one job; the whole path from read models and media rows. Every
 * statement and assertion is scoped to this run's ids (one shared database on CI).
 */

const RUN = newId().slice(-8).toLowerCase();
const L = FALLBACK_CONTENT_LOCALE;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('dedupe.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const uuids = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** Every listing id this run wrote (cleanup). */
const mine: string[] = [];
const AGENCIES = Array.from({ length: 6 }, () => newId());
const TYPES: [string, string] = [newId(), newId()];
const PLACES = [newId(), newId(), newId()];
const SHA = () => createHash('sha256').update(newId()).digest('hex');

let set: FixtureSet;
let o: Founder;

const write = async (sigs: readonly Signature[]) => {
  mine.push(...sigs.map((s) => s.listingId));
  await system((tx) => repo.upsertSignatures(tx, sigs));
};
const scoreAll = async (sigs: readonly Signature[]) => {
  for (let i = 0; i < sigs.length; i += 100) await scoreSignatures(sigs.slice(i, i + 100));
};
const pairOf = (a: string, b: string) => {
  const [x, y] = a < b ? [a, b] : [b, a];
  return rows<{ score: number; signals: Record<string, number | null>; computed_at: string }>(sql`
    select score, signals, computed_at::text from dedupe_pair_scores where listing_a = ${x} and listing_b = ${y}`).then(
    (r) => r[0],
  );
};
/** A bare signature (no pin, no pHash) with these image keys. */
const bare = (imageKeys: bigint[], over: Partial<Signature> = {}): Signature => ({
  ...signatureOf({
    listingId: newId(),
    ownerAgencyId: AGENCIES[0] as string,
    version: 1,
    transactionType: 'SALE',
    propertyTypeId: TYPES[0],
    locationIds: PLACES,
    beds: 2,
    baths: 1,
    areaM2: 90,
    priceCents: 30_000_000,
    geo: null,
    images: [],
  }),
  imageKeys,
  phashes: imageKeys.map(() => 0n),
  blockKeys: imageKeys,
  ...over,
});

beforeAll(async () => {
  await setupTestDb('worker');
  set = await buildFixtureSet({
    newId,
    agencies: AGENCIES,
    types: TYPES,
    locationIds: PLACES,
    origin: { lat: 30 + Math.random() * 10, lng: -10 + Math.random() * 10 },
    seed: Number.parseInt(RUN, 16) % 1_000_000,
  });
  o = await createFounder();
  await setAgencyStatus(o.agencyId, 'VERIFIED');
  media.configureMedia({ urlKey: `dedupe-test-key-${RUN}-0123456789abcdef` });
}, 240_000);

afterAll(async () => {
  if (mine.length > 0) {
    await rows(
      sql`delete from dedupe_pair_scores where listing_a = any(${uuids(mine)}) or listing_b = any(${uuids(mine)})`,
    );
    await rows(sql`delete from dedupe_listing_signatures where listing_id = any(${uuids(mine)})`);
  }
  await closeDb();
});

describe('dedupe candidates + scoring (R2-03a)', () => {
  it('[R2-03a] blocking finds every labelled duplicate; precision at the auto-cluster threshold holds in the database', async () => {
    const sigs = set.listings.map(signatureOf);
    await write(sigs);
    await scoreAll(sigs);
    let tp = 0;
    let fp = 0;
    for (const p of set.pairs) {
      const row = await pairOf(p.a, p.b);
      if (p.duplicate) expect(row, `${p.kind} pair not found by blocking`).toBeDefined();
      if (row && row.score >= AUTO_CLUSTER_SCORE) {
        if (p.duplicate) tp++;
        else fp++;
      }
    }
    expect(tp / (tp + fp)).toBeGreaterThanOrEqual(0.98);
    const stored = await rows<{ n: number }>(sql`
      select count(*)::int as n from dedupe_pair_scores where listing_a = any(${uuids(mine)})`);
    // never all pairs: far fewer stored than the set's n² / 2
    expect(stored[0]?.n ?? 0).toBeLessThan(set.listings.length * 4);
  }, 240_000);

  it('[R2-03a] a hash in more than the cap of listings (a logo) finds no candidates; a rare one does', async () => {
    const logo = imageKeyOf(SHA());
    const rare = imageKeyOf(SHA());
    const crowd = Array.from({ length: COMMON_KEY_LISTINGS + 1 }, () => bare([logo, imageKeyOf(SHA())]));
    await write(crowd);
    const x = bare([logo, imageKeyOf(SHA())]);
    const y = bare([logo, imageKeyOf(SHA())], { ownerAgencyId: AGENCIES[1] as string });
    const x2 = bare([logo, rare]);
    const y2 = bare([logo, rare], { ownerAgencyId: AGENCIES[1] as string });
    await write([x, y, x2, y2]);
    const counts = await system((tx) => repo.keyPostings(tx, [logo, rare], COMMON_KEY_LISTINGS, true));
    expect(counts.get(logo)).toEqual({ n: COMMON_KEY_LISTINGS + 1, ids: [] });
    expect(counts.get(rare)?.n).toBe(2);
    expect(counts.get(rare)?.ids.sort()).toEqual([x2.listingId, y2.listingId].sort());
    const r = await scoreSignatures([x, x2]);
    expect(r.candidates).toBe(1);
    expect(await pairOf(x.listingId, y.listingId)).toBeUndefined();
    const found = await pairOf(x2.listingId, y2.listingId);
    // the logo is not evidence: the rare image alone is the whole shared gallery
    expect(found?.signals.images).toBe(1);
  }, 120_000);

  it('[R2-03a] candidates are bounded per listing, in a bounded number of statements', async () => {
    const k = imageKeyOf(SHA());
    const group = Array.from({ length: 70 }, (_, i) =>
      bare([k, imageKeyOf(SHA())], { ownerAgencyId: AGENCIES[i % 6] as string }),
    );
    await write(group);
    let candidates = 0;
    const queries = await countQueries(async () => {
      candidates = (await scoreSignatures([group[0] as Signature])).candidates;
    });
    expect(candidates).toBe(MAX_CANDIDATES);
    expect(queries).toBeLessThanOrEqual(10);
  }, 120_000);

  it('[R2-03a] a re-score of unchanged listings writes nothing (idempotent)', async () => {
    const sigs = set.listings.slice(0, 40).map(signatureOf);
    const before = await pairOf(set.pairs[0]?.a as string, set.pairs[0]?.b as string);
    const again = await scoreSignatures(sigs);
    expect(again).toMatchObject({ stored: 0, deleted: 0 });
    expect(again.candidates).toBeGreaterThan(0);
    const after = await pairOf(set.pairs[0]?.a as string, set.pairs[0]?.b as string);
    expect(after?.computed_at).toBe(before?.computed_at);
  }, 120_000);

  it('[R2-03a] a pair scores the same from either side; an older score or signature never overwrites a newer one; a change below the store minimum deletes the pair', async () => {
    const p = set.pairs[1] as (typeof set.pairs)[number];
    const src = new Map(set.listings.map((l) => [l.listingId, l]));
    const sa = signatureOf(src.get(p.a) as never);
    const sb = signatureOf(src.get(p.b) as never);
    const first = await pairOf(p.a, p.b);
    expect(first).toBeDefined();
    // symmetric: rescoring from either listing writes nothing
    expect(await scoreSignatures([sa])).toMatchObject({ stored: 0, deleted: 0 });
    expect(await scoreSignatures([sb])).toMatchObject({ stored: 0, deleted: 0 });

    const [a, b] = p.a < p.b ? [sa, sb] : [sb, sa];
    const stale: repo.PairRow = {
      listingA: a.listingId,
      listingB: b.listingId,
      agencyA: a.ownerAgencyId,
      agencyB: b.ownerAgencyId,
      score: 0.71,
      signals: { ...(first?.signals as object), images: 0 } as repo.PairRow['signals'],
      scorerVersion: 1,
      versionA: 0,
      versionB: 1,
    };
    expect(await system((tx) => repo.upsertPairs(tx, [stale]))).toBe(0);
    expect((await pairOf(p.a, p.b))?.score).toBe(first?.score);

    // the second listing is now for rent (a newer read model): no longer a duplicate, the pair goes
    const rent = { ...sb, transactionType: 'RENT', sourceVersion: 2 };
    expect(await system((tx) => repo.upsertSignatures(tx, [rent]))).toEqual([sb.listingId]);
    expect(await system((tx) => repo.upsertSignatures(tx, [sb]))).toEqual([]);
    expect((await system((tx) => repo.signaturesOf(tx, [sb.listingId]))).get(sb.listingId)?.transactionType).toBe(
      'RENT',
    );
    expect(await scoreSignatures([rent])).toMatchObject({ deleted: 1 });
    expect(await pairOf(p.a, p.b)).toBeUndefined();
  }, 120_000);

  it('[R2-03a] a search.listings.changed event queues one rescore job (job id from the event, group = agency)', async () => {
    const queued: unknown[] = [];
    const spy = vi.spyOn(dedupe.dedupeJobs.rescoreListings, 'enqueue').mockImplementation(async (p) => {
      queued.push(p);
      return { id: 'test' };
    });
    dedupe.registerDedupeSubscriptions();
    const listingId = newId();
    try {
      const meta = {
        eventId: newId(),
        agencyId: o.agencyId,
        type: 'search.listings.changed',
        version: 1,
        createdAt: new Date(),
        attempt: 1,
      };
      for (const s of defaultSubscribers.get('search.listings.changed', 1)) {
        if (s.name === 'dedupe.rescore')
          await s.handler({ agencyId: o.agencyId, listingIds: [listingId] } as never, meta);
      }
      expect(queued).toEqual([{ eventId: meta.eventId, agencyId: o.agencyId, listingIds: [listingId] }]);
      const spec = dedupe.dedupeJobs.rescoreListings.spec;
      expect(spec.jobId?.(queued[0] as never)).toBe(`dedupe:${meta.eventId}`);
      expect(spec.group?.(queued[0] as never)).toBe(o.agencyId);
    } finally {
      dedupe.unregisterDedupeSubscriptions();
      spy.mockRestore();
    }
  });

  it('[R2-03a] from read models and media: two listings sharing photos are scored; a listing gone loses its pairs', async () => {
    const tax = await system(async (tx) => {
      const name = (x: string) => [{ locale: L, name: `${x} ${RUN}`, slug: `${x.toLowerCase()}-dd-${RUN}` }];
      const country = await taxonomy.createLocation(tx, {
        level: 'COUNTRY',
        parentId: null,
        code: `c-dd-${RUN}`,
        translations: name('Dupland'),
      });
      const region = await taxonomy.createLocation(tx, {
        level: 'REGION',
        parentId: country,
        code: `r-dd-${RUN}`,
        translations: name('Dupshire'),
      });
      const city = await taxonomy.createLocation(tx, {
        level: 'CITY',
        parentId: region,
        code: `ci-dd-${RUN}`,
        translations: name('Dupton'),
      });
      const group = await taxonomy.createPropertyTypeGroup(tx, {
        key: `g-dd-${RUN}`,
        sort: 0,
        translations: name('Homes'),
      });
      const villa = await taxonomy.createPropertyType(tx, {
        groupId: group,
        key: `villa-dd-${RUN}`,
        sort: 0,
        translations: name('Villa'),
      });
      return { city, villa };
    });
    const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
      withMemberCtx({ userId: o.userId, agencyId: o.agencyId, requestId: newId(), locale: 'en' }, fn);
    const lat = 30 + Math.random() * 5;
    const listing = async (dLat: number) => {
      const { id } = await as((ctx) =>
        properties.createListing(
          ctx,
          CreateListingBody.parse({
            propertyTypeId: tax.villa,
            locationId: tax.city,
            priceCents: 75_000_000,
            bedrooms: 4,
            builtM2: 240,
            coordinates: { lat: lat + dLat, lng: -5 },
            commission: { type: 'PCT', basisPoints: 500, includesVat: false },
            splitBp: 5000,
          }),
        ),
      );
      const v = (await as((ctx) => properties.getListing(ctx, id))).version;
      await as((ctx) =>
        properties.updateListing(
          ctx,
          id,
          UpdateListingBody.parse({ status: 'ACTIVE', visibility: 'SHARED', shareScope: 'ALL', version: v }),
        ),
      );
      return id;
    };
    const a = await listing(0);
    const b = await listing(0.0002);
    mine.push(a, b);
    const shas = [SHA(), SHA(), SHA()];
    await system(async (tx) => {
      for (const [i, sha] of shas.entries()) {
        await tx.execute(sql`insert into media_objects (sha256, size_bytes, content_type, phash, pipeline,
                                variants_ready, width, height, refcount)
                             values (${sha}, 1000, 'image/jpeg', ${(BigInt(i + 1) << 40n).toString()}::bigint, 1, 1, 10, 10, 2)`);
        for (const [n, listingId] of [a, b].entries()) {
          await tx.execute(sql`insert into property_media (id, property_id, agency_id, sha256, kind, position)
                               values (${newId()}, ${listingId}, ${o.agencyId}, ${sha}, 'IMAGE', ${i + n})`);
        }
      }
      await search.rebuildReadModels(tx, 'LISTING', [a, b]);
    });
    try {
      const r = await dedupe.rescoreListings([a, b]);
      expect(r).toMatchObject({ signatures: 2, changed: 2 });
      // unchanged signatures: nothing to score again
      expect(await dedupe.rescoreListings([a, b])).toMatchObject({ changed: 0, candidates: 0, stored: 0 });
      const pair = await pairOf(a, b);
      expect(pair?.signals).toMatchObject({ images: 1, phash: 1, geo: 1, beds: 1, price: 1 });
      // one agency: flagged for review, never auto-clustered
      expect(pair?.score).toBeLessThan(AUTO_CLUSTER_SCORE);

      const gone = newId();
      await write([{ ...signatureOf(set.listings[0] as never), listingId: gone, ownerAgencyId: o.agencyId }]);
      await rows(sql`insert into dedupe_pair_scores (listing_a, listing_b, agency_a, agency_b, score, signals,
                       scorer_version, version_a, version_b)
                     values (least(${a}::uuid, ${gone}::uuid), greatest(${a}::uuid, ${gone}::uuid), ${o.agencyId},
                       ${o.agencyId}, 0.6, '{}', 1, 1, 1)`);
      // no read model: its signature and pairs go
      const dropped = await dedupe.rescoreListings([gone]);
      expect(dropped.dropped).toBe(1);
      const left = await rows<{ n: number }>(sql`
        select (select count(*) from dedupe_listing_signatures where listing_id = ${gone})
             + (select count(*) from dedupe_pair_scores where listing_a = ${gone} or listing_b = ${gone}) as n`);
      expect(Number(left[0]?.n)).toBe(0);
    } finally {
      await system(async (tx) => {
        await tx.execute(sql`delete from property_media where property_id = any(${uuids([a, b])})`);
        await tx.execute(sql`delete from media_objects where sha256 = any(${`{${shas.join(',')}}`}::text[])`);
      });
    }
  }, 120_000);
});
