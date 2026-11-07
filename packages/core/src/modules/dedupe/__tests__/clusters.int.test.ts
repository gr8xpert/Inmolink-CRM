import { CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, type Tx, withSystem, withTenant } from '@inmolink/db';
import { createStaffUser, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, StaffCtx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as dedupe from '../index';
import * as repo from '../repo';
import type { PairSignals } from '../scoring';
import { signatureOf } from '../signature';

/**
 * Clusters, the review queue and disputes (R2-03b) on the real test database: real listings of three agencies (read
 * models, so the visibility rules are the real ones), fixture signatures and pair scores written as the R2-03a worker
 * would, then the recluster pass, the member services and the staff resolution. Every statement and assertion is
 * scoped to this run's ids (one shared database on CI).
 */

const RUN = newId().slice(-8).toLowerCase();
const L = FALLBACK_CONTENT_LOCALE;
const code = (s: string) => `${s}-dd-${RUN}`;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('dedupe.clusters.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const uuids = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

let A: Founder;
let B: Founder;
let C: Founder;
let ids: { city: string; villa: string };
let dataOps: string;
let support: string;
const mine: string[] = [];

const as = <T>(f: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId(), locale: 'en' }, fn);
const asStaff = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'dedupe int test' }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'none';
}

/** An ACTIVE listing of `f` (shared to ALL, or PREFERRED with nobody preferred), its read model and signature. */
async function listing(f: Founder, shareScope: 'ALL' | 'PREFERRED' = 'ALL'): Promise<string> {
  const version = async (id: string) => (await as(f, (ctx) => properties.getListing(ctx, id))).version;
  const { id } = await as(f, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 50_000_000,
        bedrooms: 3,
        energyRating: 'B',
        commission: { type: 'PCT', basisPoints: 500, includesVat: false },
        splitBp: 5000,
      }),
    ),
  );
  await as(f, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ status: 'ACTIVE', visibility: 'SHARED', shareScope, version: await version(id) }),
    ),
  );
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  mine.push(id);
  const sig = signatureOf({
    listingId: id,
    ownerAgencyId: f.agencyId,
    version: 1,
    transactionType: 'SALE',
    propertyTypeId: ids.villa,
    locationIds: [ids.city],
    beds: 3,
    baths: 2,
    areaM2: 120,
    priceCents: 50_000_000,
    geo: null,
    images: [],
  });
  await system((tx) => repo.upsertSignatures(tx, [sig]));
  return id;
}

const SIGNALS: PairSignals = {
  images: 1,
  phash: 1,
  geo: 1,
  type: 1,
  beds: 1,
  baths: 1,
  area: 1,
  price: 1,
  text: null,
};

/** A stored pair as the R2-03a scorer would write it (`conflict`: price 20 % off). */
async function pair(x: [string, Founder], y: [string, Founder], score: number, conflict = false) {
  const [[a, fa], [b, fb]] = x[0] < y[0] ? [x, y] : [y, x];
  await system((tx) =>
    repo.upsertPairs(tx, [
      {
        listingA: a,
        listingB: b,
        agencyA: fa.agencyId,
        agencyB: fb.agencyId,
        score,
        signals: conflict ? { ...SIGNALS, price: 0 } : SIGNALS,
        scorerVersion: 1,
        versionA: 1,
        versionB: 1,
      },
    ]),
  );
}

const membersOf = (listingId: string) =>
  rows<{ listing_id: string; cluster_id: string; rank: number; via: string }>(sql`
    select m.listing_id, m.cluster_id, m.rank, m.via from dedupe_cluster_members m
     where m.cluster_id in (select cluster_id from dedupe_cluster_members where listing_id = ${listingId})
     order by m.rank`);

const clusterEvents = (listingId: string) =>
  rows<{ cluster_id: string; canonical: string | null }>(sql`
    select payload->>'clusterId' as cluster_id, payload->>'canonicalListingId' as canonical from outbox_events
     where type = 'dedupe.cluster.changed' and payload->'listingIds' ? ${listingId} order by id`);

const reviewsOf = (listingId: string) =>
  rows<{ id: string; agency_id: string; listing_id: string; other_listing_id: string; status: string }>(sql`
    select id, agency_id, listing_id, other_listing_id, status from dedupe_reviews
     where listing_id = ${listingId} or other_listing_id = ${listingId} order by agency_id`);

beforeAll(async () => {
  await setupTestDb('worker');
  [A, B, C] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  for (const f of [A, B, C]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  dataOps = (await createStaffUser('STAFF_DATA_OPS')).userId;
  support = (await createStaffUser('STAFF_SUPPORT')).userId;
  ids = await system(async (tx) => {
    const name = (x: string) => [{ locale: L, name: `${x} ${RUN}`, slug: code(x.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: name('Dupeland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: name('Dupeshire'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: name('Dupeton'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: code('g'), sort: 0, translations: name('Homes') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('villa'),
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
}, 240_000);

afterAll(async () => {
  if (mine.length > 0) {
    await rows(sql`delete from dedupe_clusters where id in
      (select cluster_id from dedupe_cluster_members where listing_id = any(${uuids(mine)}))`);
    await rows(
      sql`delete from dedupe_pair_decisions where listing_a = any(${uuids(mine)}) or listing_b = any(${uuids(mine)})`,
    );
    await rows(sql`delete from dedupe_canonical_pins where listing_id = any(${uuids(mine)})`);
    await rows(
      sql`delete from dedupe_pair_scores where listing_a = any(${uuids(mine)}) or listing_b = any(${uuids(mine)})`,
    );
    await rows(sql`delete from dedupe_listing_signatures where listing_id = any(${uuids(mine)})`);
  }
  await closeDb();
});

describe('dedupe clusters, review queue, disputes (R2-03b)', () => {
  it('[R2-03b] pairs ≥ 0.9 auto-cluster across agencies; dedupe.cluster.changed is emitted; a re-run changes nothing', async () => {
    const a1 = await listing(A);
    const b1 = await listing(B);
    await pair([a1, A], [b1, B], 0.95);
    const r = await dedupe.recluster([a1]);
    expect(r).toMatchObject({ clusters: 1, changed: 1, dissolved: 0, truncated: false });
    const members = await membersOf(a1);
    expect(new Set(members.map((m) => m.listing_id))).toEqual(new Set([a1, b1]));
    expect(members.map((m) => m.rank)).toEqual([0, 1]);
    expect(members.every((m) => m.via === 'AUTO')).toBe(true);
    const events = await clusterEvents(a1);
    expect(events).toEqual([{ cluster_id: members[0]?.cluster_id, canonical: members[0]?.listing_id }]);
    // each agency reads its own listing's projection
    for (const [f, l] of [
      [A, a1],
      [B, b1],
    ] as const) {
      const page = await as(f, (ctx) => dedupe.listDuplicateClusters(ctx, {}));
      const mineRow = page.items.find((x) => x.listingId === l);
      expect(mineRow?.members.map((m) => m.card.id)).toEqual(members.map((m) => m.listing_id));
      expect(mineRow?.canonical).toBe(members[0]?.listing_id === l);
    }
    // idempotent: the same inputs change nothing, emit nothing
    expect(await dedupe.recluster([a1, b1])).toMatchObject({ changed: 0, dissolved: 0 });
    expect(await clusterEvents(a1)).toHaveLength(1);
    // a review-band pair (0.7–0.9) does not cluster
    const a2 = await listing(A);
    const b2 = await listing(B);
    await pair([a2, A], [b2, B], 0.85);
    expect(await dedupe.recluster([a2])).toMatchObject({ clusters: 0 });
    expect(await membersOf(a2)).toEqual([]);
  }, 120_000);

  it('[R2-03b] no chaining: A ~ B ~ C (≥ 0.9) with a hard conflict between A and C never puts all three in one cluster', async () => {
    const a = await listing(A);
    const b = await listing(B);
    const c = await listing(C);
    await pair([a, A], [b, B], 0.95);
    await pair([b, B], [c, C], 0.95);
    await pair([a, A], [c, C], 0.8, true);
    await dedupe.recluster([a]);
    const members = await membersOf(b);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.listing_id)).toContain(b);
    // the one left out reviews nothing against the other conflicting one's cluster mate: its pairs are in the queue
    const out = [a, c].find((x) => !members.some((m) => m.listing_id === x)) as string;
    expect((await reviewsOf(out)).length).toBeGreaterThan(0);
  }, 120_000);

  it('[R2-03b] a member removed (listing gone): the canonical is re-picked; the last pair gone dissolves the cluster', async () => {
    const a = await listing(A);
    const b = await listing(B);
    const c = await listing(C);
    await pair([a, A], [b, B], 0.95);
    await pair([a, A], [c, C], 0.95);
    await pair([b, B], [c, C], 0.95);
    await dedupe.recluster([a]);
    const before = await membersOf(a);
    expect(before).toHaveLength(3);
    const [canonical, next, last] = before.map((m) => m.listing_id) as [string, string, string];
    const clusterId = before[0]?.cluster_id;
    // the canonical goes away (the rescore drops its signature and pairs) and the cluster re-picks
    await system((tx) => repo.deleteListings(tx, [canonical]));
    await dedupe.recluster([canonical]);
    const after = await membersOf(next);
    expect(after.map((m) => [m.listing_id, m.rank])).toEqual([
      [next, 0],
      [last, 1],
    ]);
    expect(after[0]?.cluster_id).toBe(clusterId);
    expect((await clusterEvents(next)).at(-1)).toEqual({ cluster_id: clusterId, canonical: next });
    const gone = await rows<{ n: number }>(
      sql`select count(*)::int as n from dedupe_listing_clusters where listing_id = ${canonical}`,
    );
    expect(gone[0]?.n).toBe(0);
    // the next one goes too: a single listing is no cluster
    await system((tx) => repo.deleteListings(tx, [next]));
    await dedupe.recluster([next]);
    expect(await membersOf(last)).toEqual([]);
    expect((await clusterEvents(last)).at(-1)).toEqual({ cluster_id: clusterId, canonical: null });
  }, 120_000);

  it('[R2-03b] the review queue shows only own-involved pairs and hides listings the caller may not see; ≤ 10 statements', async () => {
    const a = await listing(A);
    const b = await listing(B);
    const hidden = await listing(C, 'PREFERRED'); // C prefers nobody: A may not see it
    await pair([a, A], [b, B], 0.8);
    await pair([a, A], [hidden, C], 0.8);
    await dedupe.recluster([a]);
    const all = await reviewsOf(a);
    // one row per agency involved
    expect(all.map((r) => r.agency_id).sort()).toEqual([A.agencyId, A.agencyId, B.agencyId, C.agencyId].sort());
    const pageA = await as(A, (ctx) => dedupe.listDuplicateReviews(ctx, { limit: 100 }));
    const forA = pageA.items.filter((i) => i.listing.id === a);
    expect(forA.map((i) => i.other.card.id)).toEqual([b]);
    expect(forA[0]).toMatchObject({ status: 'PENDING', score: 0.8, other: { network: true } });
    // the hidden pair cannot be decided by A either
    const hiddenRow = all.find((r) => r.agency_id === A.agencyId && r.other_listing_id === hidden);
    expect(await refusal(as(A, (ctx) => dedupe.decideDuplicateReview(ctx, hiddenRow?.id as string, 'CONFIRMED')))).toBe(
      'DEDUPE_REVIEW_NOT_FOUND',
    );
    // C sees its own listing's pair with A's (shared to ALL) listing
    const pageC = await as(C, (ctx) => dedupe.listDuplicateReviews(ctx, { limit: 100 }));
    expect(pageC.items.filter((i) => i.listing.id === hidden).map((i) => i.other.card.id)).toEqual([a]);
    // B never sees A's other pair, nor another agency's review row
    const pageB = await as(B, (ctx) => dedupe.listDuplicateReviews(ctx, { limit: 100 }));
    expect(pageB.items.some((i) => i.listing.id === hidden || i.other.card.id === hidden)).toBe(false);
    expect(
      await refusal(as(B, (ctx) => dedupe.decideDuplicateReview(ctx, hiddenRow?.id as string, 'NOT_DUPLICATE'))),
    ).toBe('DEDUPE_REVIEW_NOT_FOUND');
    // RLS: B reads none of A's rows even in SQL
    const leaked = await withTenant(
      { agencyId: B.agencyId, userId: B.userId },
      async (tx) =>
        (await tx.execute(sql`select count(*)::int as n from dedupe_reviews where agency_id = ${A.agencyId}`)).rows,
    );
    expect((leaked[0] as { n: number }).n).toBe(0);
    // a group whose only other member A may not see is not shown, nor can it be disputed (it would tell it exists)
    const lone = await listing(A);
    const hiddenMate = await listing(C, 'PREFERRED');
    await pair([lone, A], [hiddenMate, C], 0.95);
    await dedupe.recluster([lone]);
    expect((await membersOf(lone)).map((m) => m.listing_id).sort()).toEqual([lone, hiddenMate].sort());
    const clustersA = await as(A, (ctx) => dedupe.listDuplicateClusters(ctx, { limit: 100 }));
    expect(clustersA.items.some((i) => i.listingId === lone || i.members.some((m) => m.card.id === hiddenMate))).toBe(
      false,
    );
    for (const kind of ['CANONICAL', 'NOT_DUPLICATE'] as const) {
      expect(
        await refusal(as(A, (ctx) => dedupe.openDuplicateDispute(ctx, { listingId: lone, kind, reason: 'x' }))),
      ).toBe('DEDUPE_LISTING_NOT_CLUSTERED');
    }
    // budgets
    for (const fn of [
      (ctx: Ctx) => dedupe.listDuplicateReviews(ctx, { limit: 100 }),
      (ctx: Ctx) => dedupe.listDuplicateClusters(ctx, { limit: 100 }),
      (ctx: Ctx) => dedupe.listDuplicateDisputes(ctx, { limit: 100 }),
    ]) {
      expect(await as(A, (ctx) => countQueries(() => fn(ctx)))).toBeLessThanOrEqual(10);
    }
  }, 120_000);

  it('[R2-03b] confirm joins the cluster; "not a duplicate" blocks the pair forever, whatever a rescore says', async () => {
    const a = await listing(A);
    const b = await listing(B);
    await pair([a, A], [b, B], 0.8);
    await dedupe.recluster([a]);
    const rowA = (await reviewsOf(a)).find((r) => r.agency_id === A.agencyId);
    expect(await as(A, (ctx) => dedupe.decideDuplicateReview(ctx, rowA?.id as string, 'CONFIRMED'))).toEqual({
      id: rowA?.id,
      status: 'CONFIRMED',
    });
    const decided = await rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
      where type = 'dedupe.review.decided' and payload->>'reviewId' = ${rowA?.id as string}`);
    expect(decided[0]?.n).toBe(1);
    await dedupe.applyReview(rowA?.id as string);
    const members = await membersOf(a);
    expect(members).toHaveLength(2);
    expect(members.some((m) => m.via === 'CONFIRMED')).toBe(true);
    // the other agency's review of the pair closed (it disputes instead, if it disagrees)
    expect((await reviewsOf(a)).map((r) => r.status)).toEqual(['CONFIRMED']);
    expect(await refusal(as(A, (ctx) => dedupe.decideDuplicateReview(ctx, rowA?.id as string, 'CONFIRMED')))).toBe(
      'DEDUPE_REVIEW_STATE',
    );

    // not a duplicate: final
    const x = await listing(A);
    const y = await listing(B);
    await pair([x, A], [y, B], 0.8);
    await dedupe.recluster([x]);
    const rowB = (await reviewsOf(x)).find((r) => r.agency_id === B.agencyId);
    // the other agency's admin decides its own row
    expect(await as(B, (ctx) => dedupe.decideDuplicateReview(ctx, rowB?.id as string, 'NOT_DUPLICATE'))).toEqual({
      id: rowB?.id,
      status: 'NOT_DUPLICATE',
    });
    await dedupe.applyReview(rowB?.id as string);
    expect((await reviewsOf(x)).map((r) => r.status)).toEqual(['NOT_DUPLICATE']);
    // a rescore now scores it 0.99: still never clustered, never queued again
    await pair([x, A], [y, B], 0.99);
    await dedupe.recluster([x, y]);
    expect(await membersOf(x)).toEqual([]);
    expect((await reviewsOf(x)).map((r) => r.status)).toEqual(['NOT_DUPLICATE']);
    // and a later confirmation by the other agency cannot undo it
    await system((tx) =>
      repo.upsertDecisions(tx, [
        { a: x < y ? x : y, b: x < y ? y : x, decision: 'CONFIRMED', source: 'REVIEW', agencyId: A.agencyId },
      ]),
    );
    const d = await rows<{ decision: string }>(sql`select decision from dedupe_pair_decisions
      where listing_a = ${x < y ? x : y} and listing_b = ${x < y ? y : x}`);
    expect(d).toEqual([{ decision: 'NOT_DUPLICATE' }]);
  }, 120_000);

  it('[R2-03b] dispute: the listing stays in its cluster while open; staff resolve with an audit row; upheld splits or pins (the latest pin wins)', async () => {
    const a = await listing(A);
    const b = await listing(B);
    await pair([a, A], [b, B], 0.95);
    await dedupe.recluster([a]);
    const [first, second] = (await membersOf(a)).map((m) => m.listing_id) as [string, string];
    const ownerOf = (l: string) => (l === a ? A : B);

    // the canonical cannot ask to be canonical; the other one can
    expect(
      await refusal(
        as(ownerOf(first), (ctx) =>
          dedupe.openDuplicateDispute(ctx, { listingId: first, kind: 'CANONICAL', reason: 'x' }),
        ),
      ),
    ).toBe('DEDUPE_DISPUTE_CONFLICT');
    // not the caller's listing
    expect(
      await refusal(
        as(ownerOf(first), (ctx) =>
          dedupe.openDuplicateDispute(ctx, { listingId: second, kind: 'CANONICAL', reason: 'x' }),
        ),
      ),
    ).toBe('DEDUPE_LISTING_NOT_CLUSTERED');
    const dispute = await as(ownerOf(second), (ctx) =>
      dedupe.openDuplicateDispute(ctx, {
        listingId: second,
        kind: 'CANONICAL',
        reason: 'We hold the exclusive mandate',
      }),
    );
    expect(dispute).toMatchObject({ status: 'OPEN', kind: 'CANONICAL', listingId: second });
    expect(
      await refusal(
        as(ownerOf(second), (ctx) =>
          dedupe.openDuplicateDispute(ctx, { listingId: second, kind: 'NOT_DUPLICATE', reason: 'again' }),
        ),
      ),
    ).toBe('DEDUPE_DISPUTE_CONFLICT');
    // still in the cluster, the dispute shown on its row
    expect(await membersOf(second)).toHaveLength(2);
    const row = (await as(ownerOf(second), (ctx) => dedupe.listDuplicateClusters(ctx, { limit: 100 }))).items.find(
      (i) => i.listingId === second,
    );
    expect(row?.openDispute).toEqual({ id: dispute.id, kind: 'CANONICAL' });

    // support staff read the queue but may not resolve; data ops resolve (audited, event for the worker)
    const queue = await asStaff(support, (ctx) => dedupe.listStaffDuplicateDisputes(ctx, { limit: 100 }));
    expect(queue.items.find((d) => d.id === dispute.id)?.members.map((m) => m.listingId)).toEqual([first, second]);
    expect(
      await refusal(
        asStaff(support, (ctx) => dedupe.resolveDuplicateDispute(ctx, dispute.id, { outcome: 'UPHELD', note: 'ok' })),
      ),
    ).toBe('FORBIDDEN');
    const resolved = await asStaff(dataOps, (ctx) =>
      dedupe.resolveDuplicateDispute(ctx, dispute.id, { outcome: 'UPHELD', note: 'Mandate seen' }),
    );
    expect(resolved).toMatchObject({ status: 'UPHELD', resolutionNote: 'Mandate seen' });
    const audit = await rows<{ agency_id: string; actor_user_id: string; metadata: Record<string, unknown> }>(sql`
      select agency_id, actor_user_id, metadata from audit_logs
       where type = 'staff.dedupe.disputeResolved' and target_id = ${dispute.id}`);
    expect(audit).toEqual([
      {
        agency_id: ownerOf(second).agencyId,
        actor_user_id: dataOps,
        metadata: { outcome: 'UPHELD', kind: 'CANONICAL', listingId: second },
      },
    ]);
    const event = await rows<{ agency_id: string }>(sql`select agency_id from outbox_events
      where type = 'dedupe.dispute.resolved' and payload->>'disputeId' = ${dispute.id}`);
    expect(event).toEqual([{ agency_id: ownerOf(second).agencyId }]);
    expect(
      await refusal(
        asStaff(dataOps, (ctx) => dedupe.resolveDuplicateDispute(ctx, dispute.id, { outcome: 'REJECTED', note: 'no' })),
      ),
    ).toBe('DEDUPE_DISPUTE_STATE');
    // the worker applies it: the disputing listing is pinned canonical
    await dedupe.applyDispute(dispute.id);
    expect((await membersOf(a)).map((m) => m.listing_id)).toEqual([second, first]);
    // a later upheld CANONICAL dispute of the other listing moves the canonical back (the latest staff decision wins)
    const back = await as(ownerOf(first), (ctx) =>
      dedupe.openDuplicateDispute(ctx, { listingId: first, kind: 'CANONICAL', reason: 'Our mandate is newer' }),
    );
    await asStaff(dataOps, (ctx) => dedupe.resolveDuplicateDispute(ctx, back.id, { outcome: 'UPHELD', note: 'ok' }));
    await dedupe.applyDispute(back.id);
    expect((await membersOf(a)).map((m) => m.listing_id)).toEqual([first, second]);

    // a NOT_DUPLICATE dispute upheld: the listing leaves the cluster for good
    const split = await as(ownerOf(first), (ctx) =>
      dedupe.openDuplicateDispute(ctx, { listingId: first, kind: 'NOT_DUPLICATE', reason: 'Another unit' }),
    );
    await asStaff(dataOps, (ctx) => dedupe.resolveDuplicateDispute(ctx, split.id, { outcome: 'UPHELD', note: 'ok' }));
    await dedupe.applyDispute(split.id);
    expect(await membersOf(a)).toEqual([]);
    await dedupe.recluster([a, b]);
    expect(await membersOf(a)).toEqual([]);
    const mineDisputes = await as(ownerOf(first), (ctx) => dedupe.listDuplicateDisputes(ctx, { limit: 100 }));
    expect(mineDisputes.items.find((d) => d.id === split.id)?.status).toBe('UPHELD');
  }, 120_000);
});
