import { CreateListingBody, type ListingDto, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';
import * as properties from '../index';

/** Listing use cases on the real database (S3-02). */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];

type Member = { userId: string; agencyId: string };
let owner: Founder;
let agent: Member;
let reader: Founder;
let stranger: Founder;
let unverified: Founder;
let ids: { location: string; type: string };

const as = <T>(m: Member, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: { code?: string }) => err.code ?? String(err),
  );
const create = (m: Member, body: Partial<CreateListingBody> = {}) =>
  as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location, priceCents: 45_000_000, ...body }),
    ),
  );
const update = (m: Member, l: Pick<ListingDto, 'id' | 'version'>, body: Partial<UpdateListingBody>) =>
  as(m, (ctx) => properties.updateListing(ctx, l.id, UpdateListingBody.parse({ version: l.version, ...body })));

const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('properties.service.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const eventsOf = (listingId: string) =>
  rows<{ type: string; agency_id: string }>(
    sql`select type, agency_id from outbox_events where payload->>'listingId' = ${listingId} order by id`,
  ).then((r) => r.map((e) => e.type));

beforeAll(async () => {
  await setupTestDb('worker');
  [owner, reader, stranger, unverified] = await Promise.all([
    createFounder(),
    createFounder(),
    createFounder(),
    createFounder(),
  ]);
  for (const f of [owner, reader, stranger]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  // A second member of the owner agency, an agent.
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
      code: code('sc'),
      translations: tr(`Listland ${RUN}`, 'listland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('s-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 's-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('s-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 's-villa'),
    });
    return { location, type };
  });
}, 120_000);

afterEach(restoreClock);
afterAll(closeDb);

describe('listing service', () => {
  it("[S4-F1] a network reader cannot select external_ref of another agency's listing", async () => {
    const imported = await as(owner, (ctx) =>
      properties.createListing(ctx, CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location }), {
        source: 'KYERO',
        externalRef: `k-net-${RUN}`,
      }),
    );
    await system((tx) =>
      tx.execute(sql`update properties set visibility = 'SHARED', status = 'ACTIVE' where id = ${imported.id}`),
    );
    const read = (m: Member, q: ReturnType<typeof sql>) => as(m, async (ctx) => (await ctx.tx.execute(q)).rows);
    // the reader sees the listing on the network …
    expect(await read(reader, sql`select id from properties where id = ${imported.id}`)).toEqual([{ id: imported.id }]);
    expect((await as(reader, (ctx) => properties.getListing(ctx, imported.id))).private).toBeNull();
    // … but the shared row carries no feed reference or quality score, and the owner-only row is not there (RLS)
    expect(await refusal(read(reader, sql`select external_ref from properties where id = ${imported.id}`))).toMatch(
      /external_ref/,
    );
    expect(
      await read(
        reader,
        sql`select external_ref, quality_score from property_privates where property_id = ${imported.id}`,
      ),
    ).toEqual([]);
    expect(
      await read(reader, sql`select property_id from property_privates where external_ref = ${`k-net-${RUN}`}`),
    ).toEqual([]);
    // the owner still reads it
    expect(
      await read(
        owner,
        sql`select external_source, external_ref from property_privates where property_id = ${imported.id}`,
      ),
    ).toEqual([{ external_source: 'KYERO', external_ref: `k-net-${RUN}` }]);
  });

  it('[S3-02] new and imported listings get the agency defaults (500 bp, split 5000) unless the agent sets their own', async () => {
    const manual = await create(owner);
    expect(manual.commission).toEqual({
      total: { type: 'PCT', basisPoints: 500, includesVat: false },
      splitBp: 5000,
    });
    expect(manual).toMatchObject({ status: 'DRAFT', visibility: 'PRIVATE', source: 'MANUAL', version: 1 });
    const imported = await as(owner, (ctx) =>
      properties.createListing(ctx, CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location }), {
        source: 'KYERO',
        externalRef: `k-${RUN}`,
      }),
    );
    expect(imported.commission).toEqual(manual.commission);
    expect(imported).toMatchObject({ source: 'KYERO', private: { externalRef: `k-${RUN}` } });
    const own = await create(owner, {
      commission: { type: 'FIXED', amount: { amountCents: 1_200_000, currency: 'EUR' }, includesVat: true },
      splitBp: 0,
    });
    expect(own.commission).toEqual({
      total: { type: 'FIXED', amount: { amountCents: 1_200_000, currency: 'EUR' }, includesVat: true },
      splitBp: 0,
    });
  });

  it('[S3-02] split_bp accepts 0–100 % only', () => {
    for (const splitBp of [0, 5000, 10_000]) {
      expect(UpdateListingBody.safeParse({ version: 1, splitBp }).success, String(splitBp)).toBe(true);
    }
    for (const splitBp of [-1, 10_001, 50.5]) {
      expect(UpdateListingBody.safeParse({ version: 1, splitBp }).success, String(splitBp)).toBe(false);
      expect(
        CreateListingBody.safeParse({ propertyTypeId: newId(), locationId: newId(), splitBp }).success,
        String(splitBp),
      ).toBe(false);
    }
  });

  it('[S3-02] only the owner agency writes; agents edit only their own listings unless AGENCY_ADMIN', async () => {
    const adminsListing = await create(owner);
    const agentsListing = await create(agent);
    // The agent edits their own, not the admin's.
    expect((await update(agent, agentsListing, { bedrooms: 3 })).bedrooms).toBe(3);
    expect(await refusal(update(agent, adminsListing, { bedrooms: 3 }))).toBe('FORBIDDEN');
    // The admin edits any listing of the agency, and may hand one to another member.
    const reassigned = await update(owner, { ...agentsListing, version: 2 }, { ownerUserId: owner.userId });
    expect(reassigned.ownerUserId).toBe(owner.userId);
    expect(await refusal(create(agent, { ownerUserId: owner.userId }))).toBe('FORBIDDEN');
    // Another agency never writes, even a listing shared with it.
    const shared = await update(owner, adminsListing, { status: 'ACTIVE', visibility: 'SHARED' });
    expect((await as(reader, (ctx) => properties.getListing(ctx, shared.id))).id).toBe(shared.id);
    expect(await refusal(update(reader, shared, { bedrooms: 1 }))).toBe('FORBIDDEN');
    expect(await refusal(as(reader, (ctx) => properties.deleteListing(ctx, shared.id)))).toBe('FORBIDDEN');
    // A listing it cannot see does not exist for it.
    expect(await refusal(update(reader, agentsListing, { bedrooms: 1 }))).toBe('LISTING_NOT_FOUND');
  });

  it('[S3-02] PUBLIC without a CEE rating fails with ENERGY_RATING_REQUIRED', async () => {
    const l = await create(owner);
    const active = await update(owner, l, { status: 'ACTIVE' });
    expect(await refusal(update(owner, active, { visibility: 'PUBLIC' }))).toBe('ENERGY_RATING_REQUIRED');
    expect(await refusal(update(owner, active, { visibility: 'PUBLIC', energyRating: 'PENDING' }))).toBe(
      'ENERGY_RATING_REQUIRED',
    );
    const published = await update(owner, active, { visibility: 'PUBLIC', energyRating: 'E' });
    expect(published.visibility).toBe('PUBLIC');
    // A PUBLIC listing cannot drop its rating afterwards.
    expect(await refusal(update(owner, published, { energyRating: null }))).toBe('ENERGY_RATING_REQUIRED');
    // An unverified agency cannot share or publish at all (S1-01).
    const draft = await create(unverified);
    expect(await refusal(update(unverified, draft, { visibility: 'SHARED' }))).toBe('VERIFICATION_REQUIRED');
  });

  it('[S3-02] a stale version is a 409 VERSION_CONFLICT; history rows are written for price and status changes', async () => {
    const l = await create(owner);
    const v2 = await update(owner, l, { priceCents: 42_000_000 });
    expect(await refusal(update(owner, l, { priceCents: 1 }))).toBe('VERSION_CONFLICT');
    const v3 = await update(owner, v2, { status: 'ACTIVE' });
    await update(owner, v3, { status: 'UNDER_OFFER', priceCents: 41_000_000 });
    const prices = await rows<{ previous_price_cents: string | null; price_cents: string }>(
      sql`select previous_price_cents, price_cents from property_price_histories where property_id = ${l.id} order by changed_at, id`,
    );
    expect(
      prices.map((p) => [p.previous_price_cents && Number(p.previous_price_cents), Number(p.price_cents)]),
    ).toEqual([
      [null, 45_000_000],
      [45_000_000, 42_000_000],
      [42_000_000, 41_000_000],
    ]);
    const statuses = await rows<{ from_status: string | null; to_status: string }>(
      sql`select from_status, to_status from property_status_histories where property_id = ${l.id} order by changed_at, id`,
    );
    expect(statuses.map((s) => [s.from_status, s.to_status])).toEqual([
      [null, 'DRAFT'],
      ['DRAFT', 'ACTIVE'],
      ['ACTIVE', 'UNDER_OFFER'],
    ]);
    // A save that changes nothing writes nothing.
    const fresh = await as(owner, (ctx) => properties.getListing(ctx, l.id));
    expect((await update(owner, fresh, { priceCents: 41_000_000 })).version).toBe(fresh.version);
  });

  it('[S3-02] the status lifecycle refuses impossible moves (DRAFT → SOLD, a sale RENTED)', async () => {
    const l = await create(owner);
    expect(await refusal(update(owner, l, { status: 'SOLD' }))).toBe('LISTING_STATUS_INVALID');
    const active = await update(owner, l, { status: 'ACTIVE' });
    expect(await refusal(update(owner, active, { status: 'RENTED' }))).toBe('LISTING_STATUS_INVALID');
    const sold = await update(owner, active, { status: 'SOLD' });
    expect(sold.status).toBe('SOLD');
    // A sold listing cannot turn into a rental while it stays SOLD.
    expect(await refusal(update(owner, sold, { transactionType: 'RENT_LONG_TERM' }))).toBe('LISTING_STATUS_INVALID');
    // A rent price has a period; a sale price never does.
    const sale = await create(owner);
    expect(await refusal(update(owner, sale, { pricePeriod: 'MONTH' }))).toBe('VALIDATION_FAILED');
    const rent = await update(owner, sale, { transactionType: 'RENT_LONG_TERM', pricePeriod: 'MONTH' });
    expect(rent.pricePeriod).toBe('MONTH');
  });

  it('[S3-02] resending unchanged values (areas, coordinates, commission) writes nothing', async () => {
    const l = await create(owner, { builtM2: 120, plotM2: 500.5, coordinates: { lat: 36.5, lng: -4.9 } });
    const same = await update(owner, l, {
      builtM2: 120,
      plotM2: 500.5,
      coordinates: { lat: 36.5, lng: -4.9 },
      commission: l.commission?.total ?? undefined,
      splitBp: 5000,
    });
    expect(same.version).toBe(l.version);
    expect((await eventsOf(l.id)).filter((t) => t === 'properties.listing.updated')).toEqual([]);
  });

  it('[S3-02] a fixed commission is in the listing currency; the owner is an active member', async () => {
    const usd = { type: 'FIXED' as const, amount: { amountCents: 100_000, currency: 'USD' }, includesVat: false };
    expect(await refusal(create(owner, { commission: usd }))).toBe('VALIDATION_FAILED');
    expect(await refusal(create(owner, { ownerUserId: newId() }))).toBe('VALIDATION_FAILED');
    await system((tx) =>
      tx.execute(sql`update agency_members set deactivated_at = now() where user_id = ${agent.userId}`),
    );
    try {
      expect(await refusal(create(owner, { ownerUserId: agent.userId }))).toBe('VALIDATION_FAILED');
    } finally {
      await system((tx) =>
        tx.execute(sql`update agency_members set deactivated_at = null where user_id = ${agent.userId}`),
      );
    }
  });

  it('[S3-02] an agent cannot take over a colleague listing by naming themselves its owner', async () => {
    const l = await create(owner);
    // The agent may not even edit it…
    expect(await refusal(update(agent, l, { ownerUserId: agent.userId }))).toBe('FORBIDDEN');
    // …while naming themselves on their own listing is no change at all.
    const own = await create(agent);
    expect(await refusal(update(agent, own, { ownerUserId: agent.userId }))).not.toBe('FORBIDDEN');
  });

  it('[S3-02] staff acting as a member fix data but never change commission, split or status', async () => {
    const l = await create(owner);
    const staffUserId = newId();
    const asStaff = <T>(fn: (ctx: Ctx) => Promise<T>) =>
      as(owner, (ctx) =>
        fn({
          ...ctx,
          actor: { ...(ctx.actor as Extract<Ctx['actor'], { kind: 'user' }>), impersonatedBy: staffUserId },
        }),
      );
    const fixed = await asStaff((ctx) =>
      properties.updateListing(ctx, l.id, UpdateListingBody.parse({ version: l.version, bedrooms: 4 })),
    );
    expect(fixed.bedrooms).toBe(4);
    for (const body of [{ splitBp: 1000 }, { status: 'ACTIVE' as const }]) {
      expect(
        await refusal(
          asStaff((ctx) =>
            properties.updateListing(ctx, l.id, UpdateListingBody.parse({ version: fixed.version, ...body })),
          ),
        ),
        JSON.stringify(body),
      ).toBe('FORBIDDEN');
    }
    expect(await refusal(asStaff((ctx) => properties.deleteListing(ctx, l.id)))).toBe('FORBIDDEN');
  });

  it('[S3-02] PREFERRED scope is visible only to agencies the owner lists as preferred', async () => {
    const l = await create(owner);
    const shared = await update(owner, l, { status: 'ACTIVE', visibility: 'SHARED', shareScope: 'PREFERRED' });
    const read = (m: Member) => refusal(as(m, (ctx) => properties.getListing(ctx, shared.id)));
    expect(await read(reader)).toBe('LISTING_NOT_FOUND');
    await system((tx) =>
      tx.execute(
        sql`insert into preferred_agencies (agency_id, preferred_agency_id) values (${owner.agencyId}, ${reader.agencyId})`,
      ),
    );
    try {
      const view = await as(reader, (ctx) => properties.getListing(ctx, shared.id));
      expect(view).toMatchObject({ id: shared.id, shareScope: 'PREFERRED', private: null });
      expect(view.commission).not.toBeNull(); // agents see the commission they share in
      expect(await read(stranger)).toBe('LISTING_NOT_FOUND');
    } finally {
      await system((tx) =>
        tx.execute(
          sql`delete from preferred_agencies where agency_id = ${owner.agencyId} and preferred_agency_id = ${reader.agencyId}`,
        ),
      );
    }
  });

  it('[S3-02] properties.listing.* events are emitted in the same transaction', async () => {
    const l = await create(owner);
    const v2 = await update(owner, l, { status: 'ACTIVE', visibility: 'SHARED', priceCents: 1_000_000 });
    await as(owner, (ctx) => properties.deleteListing(ctx, v2.id));
    await as(owner, (ctx) => properties.restoreListing(ctx, v2.id));
    expect(await eventsOf(l.id)).toEqual([
      'properties.listing.created',
      'properties.listing.statusChanged',
      'properties.listing.visibilityChanged',
      'properties.listing.updated',
      'properties.listing.deleted',
      'properties.listing.restored',
    ]);
    // A change that rolls back leaves no event behind.
    const id = newId();
    const rolledBack = as(owner, async (ctx) => {
      const created = await properties.createListing(
        ctx,
        CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location }),
        { source: 'TEST', externalRef: id },
      );
      throw Object.assign(new Error('rollback'), { listingId: created.id });
    });
    const err = (await rolledBack.catch((e: unknown) => e)) as { listingId: string };
    expect(await eventsOf(err.listingId)).toEqual([]);
  });

  it('[S3-02] soft delete leaves the network at once and restores within 30 days, not after', async () => {
    const l = await create(owner);
    const shared = await update(owner, l, { status: 'ACTIVE', visibility: 'SHARED' });
    const clock = useFakeClock();
    await as(owner, (ctx) => properties.deleteListing(ctx, shared.id));
    expect(await refusal(as(reader, (ctx) => properties.getListing(ctx, shared.id)))).toBe('LISTING_NOT_FOUND');
    const deleted = await as(owner, (ctx) => properties.listListings(ctx, { limit: 100, deleted: true }));
    expect(deleted.items.map((i) => i.id)).toContain(shared.id);
    clock.advance(29 * 24 * 3_600_000);
    const restored = await as(owner, (ctx) => properties.restoreListing(ctx, shared.id));
    expect(restored).toMatchObject({ deletedAt: null, visibility: 'SHARED' });
    await as(owner, (ctx) => properties.deleteListing(ctx, shared.id));
    clock.advance(31 * 24 * 3_600_000);
    expect(await refusal(as(owner, (ctx) => properties.restoreListing(ctx, shared.id)))).toBe(
      'LISTING_RESTORE_UNAVAILABLE',
    );
  });

  it('[S3-02] other agencies and Client Mode never get private fields; APPROX shows a rounded point', async () => {
    const l = await create(owner, {
      coordinates: { lat: 36.510071, lng: -4.882447 },
      cadastralRef: '1234567AB1234C0001XY',
      internalNotes: 'Owner wants a quick sale',
    });
    expect(l.coordinates).toEqual({ lat: 36.51, lng: -4.88 });
    expect(l.private).toMatchObject({
      coordinates: { lat: 36.510071, lng: -4.882447 },
      cadastralRef: '1234567AB1234C0001XY',
    });
    const shared = await update(owner, l, { status: 'ACTIVE', visibility: 'SHARED' });
    const network = await as(reader, (ctx) => properties.getListing(ctx, shared.id));
    expect(network.private).toBeNull();
    expect(network.coordinates).toEqual({ lat: 36.51, lng: -4.88 });
    const exact = await update(owner, shared, { locationPrecision: 'EXACT' });
    expect(exact.coordinates).toEqual({ lat: 36.510071, lng: -4.882447 });
    const client = await withMemberCtx({ userId: owner.userId, agencyId: owner.agencyId, requestId: newId() }, (ctx) =>
      properties.getListing({ ...ctx, clientMode: true }, l.id),
    );
    expect(client).toMatchObject({ private: null, commission: null });
    // A client shown another agency's listing never learns who owns it (white label).
    const clientView = await withMemberCtx(
      { userId: reader.userId, agencyId: reader.agencyId, requestId: newId() },
      (ctx) => properties.getListing({ ...ctx, clientMode: true }, l.id),
    );
    expect(clientView).toMatchObject({ agencyId: null, ownerUserId: null, ref: null, commission: null, private: null });
  });

  it('[S3-02] dashboard budget: reads and an update stay within 10 queries', async () => {
    const l = await create(owner);
    const budget = async (fn: (ctx: Ctx) => Promise<unknown>) => countQueries(() => as(owner, fn));
    expect(await budget((ctx) => properties.getListing(ctx, l.id))).toBeLessThanOrEqual(10);
    expect(await budget((ctx) => properties.listListings(ctx, { limit: 25 }))).toBeLessThanOrEqual(10);
    expect(
      await budget((ctx) =>
        properties.updateListing(
          ctx,
          l.id,
          UpdateListingBody.parse({
            version: l.version,
            status: 'ACTIVE',
            visibility: 'SHARED',
            priceCents: 1,
            internalNotes: 'x',
          }),
        ),
      ),
    ).toBeLessThanOrEqual(10);
  });

  it('[S3-02] lists the agency listings newest first, keyset paged; agents may filter to their own', async () => {
    const mine = await create(agent);
    const page1 = await as(agent, (ctx) => properties.listListings(ctx, { limit: 2, mine: true }));
    expect(page1.items[0]?.id).toBe(mine.id);
    expect(page1.items.every((i) => i.ownerUserId === agent.userId)).toBe(true);
    const all = await as(owner, (ctx) => properties.listListings(ctx, { limit: 1 }));
    expect(all.items).toHaveLength(1);
    expect(all.nextCursor).not.toBeNull();
    const next = await as(owner, (ctx) => properties.listListings(ctx, { limit: 1, cursor: all.nextCursor as string }));
    expect(next.items[0]?.id).not.toBe(all.items[0]?.id);
  });

  it('[S3-02] an unknown location or type is a validation error on that field', async () => {
    expect(await refusal(create(owner, { locationId: newId() }))).toBe('VALIDATION_FAILED');
    expect(await refusal(create(owner, { propertyTypeId: newId() }))).toBe('VALIDATION_FAILED');
  });
});
