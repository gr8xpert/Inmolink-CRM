import {
  type ListingBulkDto,
  type ListingSummaryDto,
  ListingViewBody,
  ListListingsQuery,
  StartListingBulkBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as properties from '../index';

/** Listing list, saved views and bulk actions on the real database (S3-07). */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];

type Member = { userId: string; agencyId: string };
let owner: Founder;
let agent: Member;
let big: Founder;
let ids: { location: string; type: string };
/** Agencies whose listings `afterAll` deletes. */
const created: string[] = [];

const as = <T>(m: Member, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('properties.list-bulk.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const list = (m: Member, q: Record<string, unknown> = {}) =>
  as(m, (ctx) => properties.listListings(ctx, ListListingsQuery.parse({ limit: 100, ...q })));
const refsOf = (items: ListingSummaryDto[]) => items.map((i) => i.ref);

const log = createLogger({ service: 'properties.list-bulk.test', level: 'silent' });
const jobCtx = (progress: unknown[] = []) => ({
  log,
  jobId: newId(),
  attempt: 1,
  progress: async (v: unknown) => {
    progress.push(v);
  },
  signal: new AbortController().signal,
});
const startBulk = (m: Member, body: unknown) =>
  as(m, (ctx) => properties.startBulkAction(ctx, StartListingBulkBody.parse(body)));
/** Runs the queued job the way the worker does (the subscription's payload). */
const runJob = (m: Member, bulk: Pick<ListingBulkDto, 'id'>, progress: unknown[] = []) =>
  properties.propertiesJobs.runBulkAction.spec.run(
    { bulkActionId: bulk.id, agencyId: m.agencyId, userId: m.userId },
    jobCtx(progress),
  );
const bulkOf = (m: Member, id: string) => as(m, (ctx) => properties.getBulkAction(ctx, id));

/**
 * `n` listings of `agencyId` owned by `ownerUserId`, straight into the table (no events, no history): refs
 * `<prefix>00001…`, created one second apart, prices 100,000 € + i × 1,000 € (every 10th without a price).
 */
async function seedListings(
  agencyId: string,
  ownerUserId: string,
  n: number,
  prefix: string,
  over: { status?: string; visibility?: string; energyRating?: string | null } = {},
): Promise<string[]> {
  const res = await rows<{ id: string }>(sql`
    insert into properties (id, agency_id, owner_user_id, ref, status, visibility, transaction_type, price_cents,
                            bedrooms, energy_rating, property_type_id, location_id, created_at, updated_at)
    select gen_random_uuid(), ${agencyId}, ${ownerUserId}, ${prefix} || lpad(i::text, 5, '0'),
           ${over.status ?? 'DRAFT'}::listing_status, ${over.visibility ?? 'PRIVATE'}::visibility, 'SALE',
           case when i % 10 = 0 then null else 10000000 + i::bigint * 100000 end,
           i % 6, ${over.energyRating === undefined ? 'C' : over.energyRating}::cee_rating,
           ${ids.type}, ${ids.location},
           now() - make_interval(secs => ${n} - i), now() - make_interval(secs => ${n} - i)
      from generate_series(1, ${n}) as i
    returning id`);
  return res.map((r) => r.id);
}

beforeAll(async () => {
  await setupTestDb('worker');
  [owner, big] = await Promise.all([createFounder(), createFounder()]);
  for (const f of [owner, big]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  created.push(owner.agencyId, big.agencyId);
  const agentId = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${owner.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`agent-${agentId}@example.com`})`);
  });
  agent = { userId: agentId, agencyId: owner.agencyId };
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('lb'),
      translations: tr(`Bulkland ${RUN}`, 'bulkland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('lb-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'lb-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('lb-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'lb-villa'),
    });
    return { location, type };
  });
}, 120_000);

afterAll(async () => {
  // The shared test database keeps every run's rows: drop this file's listings (children cascade).
  await system(async (tx) => {
    for (const agencyId of created) {
      await tx.execute(sql`delete from listing_bulk_actions where agency_id = ${agencyId}`);
      await tx.execute(sql`delete from properties where agency_id = ${agencyId}`);
    }
  });
  await closeDb();
}, 120_000);

describe('listing list (S3-07)', () => {
  it('[S3-07] filters, reference search, tags and every sort page through the agency’s own listings with keyset cursors', async () => {
    const own = await seedListings(owner.agencyId, owner.userId, 30, 'FL');
    const agents = await seedListings(owner.agencyId, agent.userId, 5, 'FA', { status: 'ACTIVE' });
    // Another agency's listings never show.
    await seedListings(big.agencyId, big.userId, 5, 'FL');

    const all = await list(owner, { q: 'f' });
    expect(all.items).toHaveLength(35);
    expect(all.items[0]?.ref).toBe('FA00005'); // newest first
    expect((await list(owner, { q: 'FA' })).items).toHaveLength(5);
    expect((await list(agent, { q: 'f', mine: 'true' })).items.map((i) => i.id).sort()).toEqual([...agents].sort());
    expect((await list(owner, { q: 'f', ownerUserId: agent.userId })).items).toHaveLength(5);
    expect((await list(owner, { q: 'f', status: 'ACTIVE' })).items).toHaveLength(5);
    // Prices 100,000 € + i × 1,000 €; i = 10, 20, 30 have none and never match a range.
    const range = await list(owner, { q: 'FL', priceMin: 10_500_000, priceMax: 10_900_000 });
    expect(refsOf(range.items).sort()).toEqual(['FL00005', 'FL00006', 'FL00007', 'FL00008', 'FL00009']);
    expect((await list(owner, { q: 'FL', bedroomsMin: 5 })).items).toHaveLength(5); // i % 6 = 5

    // Tags: listed with each listing, filterable.
    await system((tx) =>
      tx.execute(sql`insert into property_tags (property_id, agency_id, tag)
        values (${own[0]}, ${owner.agencyId}, 'sea view'), (${own[0]}, ${owner.agencyId}, 'golf'),
               (${own[1]}, ${owner.agencyId}, 'golf')`),
    );
    const golf = await list(owner, { tag: ' GOLF ' });
    expect(refsOf(golf.items).sort()).toEqual(['FL00001', 'FL00002']);
    expect(golf.items.find((i) => i.ref === 'FL00001')?.tags).toEqual(['golf', 'sea view']);

    // Each sort pages through every row once, in order, 7 at a time.
    const walk = async (sort: string) => {
      const seen: ListingSummaryDto[] = [];
      let cursor: string | undefined;
      do {
        const page = await list(owner, { q: 'FL', sort, limit: 7, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return seen;
    };
    expect(refsOf(await walk('oldest'))).toEqual(
      Array.from({ length: 30 }, (_, i) => `FL${String(i + 1).padStart(5, '0')}`),
    );
    expect(refsOf(await walk('newest'))).toEqual(refsOf(await walk('oldest')).reverse());
    const asc = await walk('price_asc');
    expect(asc).toHaveLength(30);
    expect(asc.slice(-3).every((i) => i.price === null)).toBe(true); // no price: last
    const ascPrices = asc.flatMap((i) => (i.price ? [i.price.amountCents] : []));
    expect(ascPrices).toEqual([...ascPrices].sort((a, b) => a - b));
    const desc = await walk('price_desc');
    expect(desc.slice(-3).every((i) => i.price === null)).toBe(true);
    expect(desc.flatMap((i) => (i.price ? [i.price.amountCents] : []))).toEqual([...ascPrices].reverse());
    expect(new Set((await walk('updated')).map((i) => i.id)).size).toBe(30);

    // A cursor of another sort is the caller's error, never a full scan.
    const page = await list(owner, { q: 'FL', sort: 'price_asc', limit: 2 });
    expect(await refusal(list(owner, { q: 'FL', sort: 'newest', cursor: page.nextCursor }))).toBe('VALIDATION_FAILED');
  });

  it('[S3-07] a page with tags costs the member context + 2 statements; Client Mode never sees tags', async () => {
    const [tagged] = await seedListings(owner.agencyId, owner.userId, 3, 'CM');
    await system((tx) =>
      tx.execute(sql`insert into property_tags (property_id, agency_id, tag)
        values (${tagged}, ${owner.agencyId}, 'motivated seller')`),
    );
    expect(await countQueries(() => list(owner, { q: 'CM', sort: 'price_desc' }))).toBeLessThanOrEqual(10);
    expect((await list(owner, { q: 'CM', tag: 'motivated seller' })).items[0]?.tags).toEqual(['motivated seller']);
    const client = await as(owner, (ctx) =>
      properties.listListings({ ...ctx, clientMode: true }, ListListingsQuery.parse({ q: 'CM' })),
    );
    expect(client.items).toHaveLength(3);
    expect(client.items.every((i) => i.tags.length === 0)).toBe(true);
  });
});

describe('saved views (S3-07)', () => {
  const body = (name: string) =>
    ListingViewBody.parse({
      name,
      query: { status: 'ACTIVE', sort: 'price_desc', mine: true },
      columns: ['ref', 'price'],
    });

  it('[S3-07] a member saves, renames and deletes their own views; others never see them; names are unique', async () => {
    const saved = await as(agent, (ctx) => properties.createListingView(ctx, body('Active by price')));
    expect(saved).toMatchObject({ name: 'Active by price', columns: ['ref', 'price'] });
    expect(saved.query).toEqual({ status: 'ACTIVE', sort: 'price_desc', mine: true });
    expect(await refusal(as(agent, (ctx) => properties.createListingView(ctx, body('Active by price'))))).toBe(
      'LISTING_VIEW_NAME_TAKEN',
    );
    // The admin of the same agency neither sees nor changes it.
    expect((await as(owner, (ctx) => properties.listListingViews(ctx))).items).toEqual([]);
    expect(await refusal(as(owner, (ctx) => properties.updateListingView(ctx, saved.id, body('Mine now'))))).toBe(
      'LISTING_VIEW_NOT_FOUND',
    );
    expect(await refusal(as(owner, (ctx) => properties.deleteListingView(ctx, saved.id)))).toBe(
      'LISTING_VIEW_NOT_FOUND',
    );
    const renamed = await as(agent, (ctx) => properties.updateListingView(ctx, saved.id, body('Hot')));
    expect(renamed.name).toBe('Hot');
    expect((await as(agent, (ctx) => properties.listListingViews(ctx))).items.map((v) => v.name)).toEqual(['Hot']);
    await as(agent, (ctx) => properties.deleteListingView(ctx, saved.id));
    expect((await as(agent, (ctx) => properties.listListingViews(ctx))).items).toEqual([]);
  });

  it('[S3-07] Client Mode reads views but never saves one; a member keeps at most 50', async () => {
    expect(
      await refusal(as(owner, (ctx) => properties.createListingView({ ...ctx, clientMode: true }, body('Client')))),
    ).toBe('FORBIDDEN');
    await system((tx) =>
      tx.execute(sql`insert into listing_views (id, agency_id, user_id, name, query, columns)
        select gen_random_uuid(), ${owner.agencyId}, ${owner.userId}, 'v' || i, '{}'::jsonb, '{ref}'
          from generate_series(1, 50) as i`),
    );
    expect(await refusal(as(owner, (ctx) => properties.createListingView(ctx, body('One more'))))).toBe(
      'LISTING_VIEW_LIMIT',
    );
    expect((await as(owner, (ctx) => properties.listListingViews(ctx))).items).toHaveLength(50);
  });
});

describe('bulk actions (S3-07)', () => {
  it('[S3-07] a bulk action runs as a job in chunks, reports progress and emits one event per listing; a rerun changes nothing', async () => {
    const team = await createFounder();
    created.push(team.agencyId);
    await setAgencyStatus(team.agencyId, 'VERIFIED');
    const N = 300;
    const listingIds = await seedListings(team.agencyId, team.userId, N, 'BK');
    const bulk = await startBulk(team, { action: { type: 'STATUS', status: 'ACTIVE' }, target: { ids: listingIds } });
    expect(bulk).toMatchObject({ state: 'QUEUED', total: N, processed: 0 });
    // Queued through the outbox in the request's transaction.
    const requested = await rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
      where type = 'properties.bulkAction.requested' and payload->>'bulkActionId' = ${bulk.id}`);
    expect(requested[0]?.n).toBe(1);

    const progress: unknown[] = [];
    await runJob(team, bulk, progress);
    expect(progress).toEqual([
      { processed: properties.BULK_CHUNK, total: N },
      { processed: N, total: N },
    ]);

    const done = await bulkOf(team, bulk.id);
    expect(done).toMatchObject({ state: 'DONE', processed: N, succeeded: N, unchanged: 0, failed: 0 });
    expect(done.finishedAt).not.toBeNull();
    const perListing = await rows<{ type: string; listings: number; events: number }>(sql`
      select type, count(distinct payload->>'listingId')::int as listings, count(*)::int as events
        from outbox_events
       where agency_id = ${team.agencyId} and type like 'properties.listing.%'
       group by type order by type`);
    expect(perListing).toEqual([
      { type: 'properties.listing.statusChanged', listings: N, events: N },
      { type: 'properties.listing.updated', listings: N, events: N },
    ]);
    const state = await rows<{ active: number; history: number; version2: number }>(sql`
      select count(*) filter (where status = 'ACTIVE')::int as active,
             count(*) filter (where version = 2)::int as version2,
             (select count(*)::int from property_status_histories h
               where h.agency_id = ${team.agencyId} and h.from_status = 'DRAFT' and h.to_status = 'ACTIVE') as history
        from properties where agency_id = ${team.agencyId}`);
    expect(state[0]).toEqual({ active: N, history: N, version2: N });

    // A job that runs again (BullMQ retry, duplicate delivery) changes nothing more.
    await runJob(team, bulk);
    const again = await rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
      where agency_id = ${team.agencyId} and type = 'properties.listing.updated'`);
    expect(again[0]?.n).toBe(N);

    // The job acts only as the member who asked: a payload naming a colleague stops the action, untouched.
    const colleague = newId();
    await system(async (tx) => {
      await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
        values (${colleague}, ${`c-${colleague}@example.com`}, 'x', 'Colleague', 'es', 'ACTIVE')`);
      await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
        values (${team.agencyId}, ${colleague}, 'AGENCY_ADMIN', 'Colleague', ${`c-${colleague}@example.com`})`);
    });
    const other = await startBulk(team, { action: { type: 'ADD_TAG', tag: 'x' }, target: { ids: listingIds } });
    expect(await refusal(runJob({ ...team, userId: colleague }, other))).not.toBe('resolved');
    const [rec] = await rows<{ state: string; processed: number; error: string }>(
      sql`select state, processed, error from listing_bulk_actions where id = ${other.id}`,
    );
    expect(rec).toEqual({ state: 'FAILED', processed: 0, error: 'FORBIDDEN' });
  });

  it('[S3-07] the requested event queues the job for the event’s agency; a partial run resumes where it stopped', async () => {
    const team = await createFounder();
    created.push(team.agencyId);
    await setAgencyStatus(team.agencyId, 'VERIFIED');
    const N = properties.BULK_CHUNK + 10;
    const unpriced = Math.floor(N / 10); // every 10th seeded listing has no price
    const listingIds = await seedListings(team.agencyId, team.userId, N, 'RS');
    const bulk = await startBulk(team, {
      action: { type: 'PRICE_CHANGE', percentBp: 1_000 },
      target: { ids: listingIds },
    });

    // Outbox → job: the subscription enqueues `properties.runBulkAction` with the event's (RLS-checked) agency.
    const [event] = await rows<{
      id: string;
      agency_id: string;
      version: number;
      payload: unknown;
      created_at: string;
    }>(
      sql`select id, agency_id, version, payload, created_at from outbox_events
           where type = 'properties.bulkAction.requested' and payload->>'bulkActionId' = ${bulk.id}`,
    );
    const enqueue = vi.spyOn(properties.propertiesJobs.runBulkAction, 'enqueue').mockResolvedValue({ id: 'test' });
    properties.registerPropertiesSubscriptions();
    try {
      const subscribers = defaultSubscribers.get('properties.bulkAction.requested', 1);
      expect(subscribers).toHaveLength(1);
      if (!event) throw new Error('no requested event');
      await subscribers[0]?.handler(event.payload as never, {
        eventId: event.id,
        agencyId: event.agency_id,
        type: 'properties.bulkAction.requested',
        version: event.version,
        createdAt: new Date(event.created_at),
        attempt: 1,
      });
      expect(enqueue).toHaveBeenCalledWith({ bulkActionId: bulk.id, agencyId: team.agencyId, userId: team.userId });
    } finally {
      properties.unregisterPropertiesSubscriptions();
      enqueue.mockRestore();
    }

    // One chunk commits, then the worker dies; the retried job does the rest, once.
    const first = await as(team, (ctx) => properties.runBulkChunk(ctx, bulk.id));
    expect(first).toEqual({ done: false, processed: properties.BULK_CHUNK, total: N });
    expect((await bulkOf(team, bulk.id)).state).toBe('RUNNING');
    await runJob(team, bulk);
    expect(await bulkOf(team, bulk.id)).toMatchObject({
      state: 'DONE',
      processed: N,
      succeeded: N - unpriced,
      failed: unpriced,
    });
    const [counts] = await rows<{ events: number; history: number }>(sql`
      select (select count(*)::int from outbox_events
               where agency_id = ${team.agencyId} and type = 'properties.listing.updated') as events,
             (select count(*)::int from property_price_histories where agency_id = ${team.agencyId}) as history`);
    expect(counts).toEqual({ events: N - unpriced, history: N - unpriced });
  });

  it('[S3-07] a member who left stops their action (FAILED, FORBIDDEN); a lost job is failed as STALLED', async () => {
    const team = await createFounder();
    created.push(team.agencyId);
    await setAgencyStatus(team.agencyId, 'VERIFIED');
    const leaver = newId();
    await system(async (tx) => {
      await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
        values (${leaver}, ${`l-${leaver}@example.com`}, 'x', 'Leaver', 'es', 'ACTIVE')`);
      await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
        values (${team.agencyId}, ${leaver}, 'AGENT', 'Leaver', ${`l-${leaver}@example.com`})`);
    });
    const member: Member = { userId: leaver, agencyId: team.agencyId };
    const listingIds = await seedListings(team.agencyId, leaver, 3, 'LV');
    const bulk = await startBulk(member, { action: { type: 'ADD_TAG', tag: 'x' }, target: { ids: listingIds } });
    await system((tx) =>
      tx.execute(sql`update agency_members set deactivated_at = now()
        where agency_id = ${team.agencyId} and user_id = ${leaver}`),
    );
    expect(await refusal(runJob(member, bulk))).not.toBe('resolved');
    const [left] = await rows<{ state: string; processed: number; error: string }>(
      sql`select state, processed, error from listing_bulk_actions where id = ${bulk.id}`,
    );
    expect(left).toEqual({ state: 'FAILED', processed: 0, error: 'FORBIDDEN' });

    // A job lost to a crash never marks its record: the sweep does, once it has not moved for 2 hours.
    const stuck = await startBulk(team, { action: { type: 'ADD_TAG', tag: 'x' }, target: { ids: listingIds } });
    await system((tx) =>
      tx.execute(sql`update listing_bulk_actions set updated_at = now() - interval '3 hours' where id = ${stuck.id}`),
    );
    await properties.propertiesJobs.failStaleBulkActions.spec.run({}, jobCtx());
    expect(await bulkOf(team, stuck.id)).toMatchObject({ state: 'FAILED', error: 'STALLED' });
    // …which frees the member's one-at-a-time slot.
    expect((await startBulk(team, { action: { type: 'ADD_TAG', tag: 'y' }, target: { ids: listingIds } })).state).toBe(
      'QUEUED',
    );
  });

  it('[S3-07] each listing follows the edit rules: agents only their own, lifecycle, CEE for PUBLIC; failures are kept, the rest change', async () => {
    const mine = await seedListings(owner.agencyId, agent.userId, 3, 'RA', { status: 'DRAFT' });
    const admins = await seedListings(owner.agencyId, owner.userId, 2, 'RB', { status: 'DRAFT' });
    const foreign = await seedListings(big.agencyId, big.userId, 1, 'RC');
    const status = await startBulk(agent, {
      action: { type: 'STATUS', status: 'ACTIVE' },
      target: { ids: [...mine, ...admins, ...foreign] },
    });
    await runJob(agent, status);
    const s = await bulkOf(agent, status.id);
    expect(s).toMatchObject({ state: 'DONE', total: 6, succeeded: 3, failed: 3 });
    expect(s.failures).toEqual([
      ...admins.map((listingId) => ({ listingId, code: 'FORBIDDEN' })),
      ...foreign.map((listingId) => ({ listingId, code: 'LISTING_NOT_FOUND' })),
    ]);

    // DRAFT → SOLD is not a lifecycle step; ACTIVE → SOLD is.
    const sold = await startBulk(owner, {
      action: { type: 'STATUS', status: 'SOLD' },
      target: { ids: [...mine, ...admins] },
    });
    await runJob(owner, sold);
    const so = await bulkOf(owner, sold.id);
    expect(so).toMatchObject({ succeeded: 3, failed: 2 });
    expect(new Set(so.failures.map((f) => f.code))).toEqual(new Set(['LISTING_STATUS_INVALID']));

    // PUBLIC needs a CEE rating, per listing.
    const [rated, unrated] = [
      await seedListings(owner.agencyId, owner.userId, 1, 'RD'),
      await seedListings(owner.agencyId, owner.userId, 1, 'RE', { energyRating: null }),
    ];
    const pub = await startBulk(owner, {
      action: { type: 'VISIBILITY', visibility: 'PUBLIC' },
      target: { ids: [...rated, ...unrated] },
    });
    await runJob(owner, pub);
    expect(await bulkOf(owner, pub.id)).toMatchObject({
      succeeded: 1,
      failures: unrated.map((listingId) => ({ listingId, code: 'ENERGY_RATING_REQUIRED' })),
    });
    const vis = await rows<{ type: string }>(sql`select type from outbox_events
      where payload->>'listingId' = ${rated[0]} order by id`);
    expect(vis.map((e) => e.type)).toEqual(['properties.listing.visibilityChanged', 'properties.listing.updated']);

    // An agent never sees another member's bulk action; the admin sees every one.
    expect(await refusal(bulkOf(agent, sold.id))).toBe('LISTING_BULK_NOT_FOUND');
    expect((await bulkOf(owner, status.id)).id).toBe(status.id);
  }, 60_000);

  it('[S3-07] price change by percentage rounds to whole euros, writes price history and skips listings without a price', async () => {
    const listingIds = await seedListings(owner.agencyId, owner.userId, 10, 'PR'); // i = 10 has no price
    const bulk = await startBulk(owner, {
      action: { type: 'PRICE_CHANGE', percentBp: -333 },
      target: { ids: listingIds },
    });
    await runJob(owner, bulk);
    const done = await bulkOf(owner, bulk.id);
    expect(done).toMatchObject({ succeeded: 9, failed: 1, failures: [{ code: 'LISTING_PRICE_MISSING' }] });
    const [first] = await rows<{ price_cents: string; prev: string; history: string }>(sql`
      select p.price_cents, h.previous_price_cents as prev, h.price_cents as history
        from properties p join property_price_histories h on h.property_id = p.id
       where p.id = ${listingIds[0]}`);
    // 101,000 € − 3.33 % = 97,636.70 € → 97,637 €
    expect(first).toEqual({ price_cents: '9763700', prev: '10100000', history: '9763700' });
    expect(properties.changedPrice(10_100_000, -333)).toBe(9_763_700);
    expect(properties.changedPrice(12_345, 10_000)).toBe(24_700);
  });

  it('[S3-07] add tag, assign agent and share scope; a filter targets every matching listing up to 5,000', async () => {
    const listingIds = await seedListings(owner.agencyId, owner.userId, 4, 'TG');
    await system((tx) =>
      tx.execute(sql`insert into property_tags (property_id, agency_id, tag)
        values (${listingIds[0]}, ${owner.agencyId}, 'priority')`),
    );
    const tag = await startBulk(owner, {
      action: { type: 'ADD_TAG', tag: 'Priority ' },
      target: { filter: { q: 'TG' } },
    });
    expect(tag.total).toBe(4);
    await runJob(owner, tag);
    expect(await bulkOf(owner, tag.id)).toMatchObject({ succeeded: 3, unchanged: 1, failed: 0 });
    expect((await list(owner, { tag: 'priority', q: 'TG' })).items).toHaveLength(4);

    // Only admins hand listings to another member, and only to a member.
    expect(
      await refusal(
        startBulk(agent, { action: { type: 'ASSIGN', ownerUserId: agent.userId }, target: { ids: listingIds } }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await refusal(
        startBulk(owner, { action: { type: 'ASSIGN', ownerUserId: big.userId }, target: { ids: listingIds } }),
      ),
    ).toBe('VALIDATION_FAILED');
    const assign = await startBulk(owner, {
      action: { type: 'ASSIGN', ownerUserId: agent.userId },
      target: { ids: listingIds },
    });
    await runJob(owner, assign);
    expect((await list(agent, { mine: 'true', q: 'TG' })).items).toHaveLength(4);

    const scope = await startBulk(owner, {
      action: { type: 'SHARE_SCOPE', shareScope: 'PREFERRED' },
      target: { ids: listingIds },
    });
    await runJob(owner, scope);
    expect(await bulkOf(owner, scope.id)).toMatchObject({ succeeded: 4 });

    // Too many or no matches are refused before anything is recorded; one action at a time per member.
    await seedListings(big.agencyId, big.userId, 5_001, 'MX');
    expect(await refusal(startBulk(big, { action: { type: 'ADD_TAG', tag: 'x' }, target: { filter: {} } }))).toBe(
      'LISTING_BULK_TOO_MANY',
    );
    await startBulk(big, { action: { type: 'ADD_TAG', tag: 'x' }, target: { filter: { q: 'MX00001' } } });
    expect(
      await refusal(startBulk(big, { action: { type: 'ADD_TAG', tag: 'y' }, target: { filter: { q: 'MX00002' } } })),
    ).toBe('LISTING_BULK_BUSY');
    expect(
      await refusal(startBulk(owner, { action: { type: 'ADD_TAG', tag: 'x' }, target: { filter: { q: 'NOPE' } } })),
    ).toBe('VALIDATION_FAILED');
  });

  it('[S3-07] staff acting as a member, Client Mode and unverified agencies cannot start a bulk action', async () => {
    const listingIds = await seedListings(owner.agencyId, owner.userId, 1, 'IM');
    const body = StartListingBulkBody.parse({ action: { type: 'ADD_TAG', tag: 'x' }, target: { ids: listingIds } });
    expect(
      await refusal(as(owner, async (ctx) => properties.startBulkAction(await impersonatedCtx(ctx, newId()), body))),
    ).toBe('FORBIDDEN');
    expect(await refusal(as(owner, (ctx) => properties.startBulkAction({ ...ctx, clientMode: true }, body)))).toBe(
      'FORBIDDEN',
    );
    const unverified = await createFounder();
    created.push(unverified.agencyId);
    const theirs = await seedListings(unverified.agencyId, unverified.userId, 1, 'UV');
    expect(
      await refusal(
        startBulk(unverified, { action: { type: 'VISIBILITY', visibility: 'SHARED' }, target: { ids: theirs } }),
      ),
    ).toBe('VERIFICATION_REQUIRED');
  });
});
