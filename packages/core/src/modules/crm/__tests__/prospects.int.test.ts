import {
  ConvertProspectBody,
  type ConvertProspectInput,
  CreateContactBody,
  CreateProspectBody,
  type CreateProspectInput,
  ListProspectsQuery,
  MoveProspectBody,
  type MoveProspectInput,
  ProspectBoardQuery,
  ProspectFollowUpsQuery,
  UpdateListingBody,
  UpdateProspectBody,
  type UpdateProspectInput,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem, withTenant } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as crm from '../index';

/** S11-F15: a switch that makes the listing policy refuse `listing.create` while the CRM policy still allows. */
const listingPolicy = vi.hoisted(() => ({ denyCreate: false }));
vi.mock('../../properties/policy', async (importOriginal) => {
  const actual = await importOriginal<{ can: typeof properties.can }>();
  return {
    ...actual,
    can: (...args: Parameters<typeof properties.can>) =>
      listingPolicy.denyCreate && args[1] === 'listing.create' ? false : actual.can(...args),
  };
});

/**
 * The seller acquisition board (S10-07): prospects on fixed stages (board, list, by-date), confidential notes, and the
 * one-click conversion into a DRAFT listing with the seller in `property_privates` — never readable by another agency,
 * even one that sees the listing on the network.
 */

const RUN = newId().slice(-8).toLowerCase();
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.prospects.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const STAFF = '01900000-0000-7000-8000-0000000000bb';
const NOTES = `Owner divorcing, wants a quick sale ${RUN}`;

/** `a` acquires; `b` is another verified agency on the network. */
let a: Founder;
let b: Founder;
let ids: { city: string; villa: string };
let sellerId: string;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const create = (m: Founder, body: CreateProspectInput, opts: { idempotencyKey?: string } = {}) =>
  as(m, (ctx) => crm.createProspect(ctx, CreateProspectBody.parse(body), opts));
const update = (m: Founder, id: string, body: UpdateProspectInput) =>
  as(m, (ctx) => crm.updateProspect(ctx, id, UpdateProspectBody.parse(body)));
const move = (m: Founder, id: string, body: MoveProspectInput) =>
  as(m, (ctx) => crm.moveProspect(ctx, id, MoveProspectBody.parse(body)));
const convert = (m: Founder, id: string, body: ConvertProspectInput = {}) =>
  as(m, (ctx) => crm.convertProspect(ctx, id, ConvertProspectBody.parse(body)));
const title = (name: string) => `${name} ${RUN}`;

/** The statements of opening a member's context (session, membership, tenant): not the endpoint's. */
const setupQueries = () => countQueries(() => as(a, async () => null));

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

beforeAll(async () => {
  await setupTestDb('worker');
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `crm-pr-${RUN}`,
      translations: name('Prospectland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `crm-pr-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `crm-pr-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  const seller = await as(a, (ctx) =>
    crm.createContact(
      ctx,
      CreateContactBody.parse({
        firstName: 'Sofia',
        lastName: 'Seller',
        emails: [`seller-${RUN}@example.com`],
        types: ['SELLER'],
      }),
    ),
  );
  sellerId = seller.contact.id;
});

afterAll(async () => {
  await closeDb();
});

describe('conversion', () => {
  it('[S10-07] conversion creates a DRAFT listing and links the seller contact without exposing it to other tenants', async () => {
    const { prospect } = await create(a, {
      title: title('Villa on the hill'),
      contactId: sellerId,
      address: 'Calle Mayor 1',
      area: 'Old town',
      propertyTypeId: ids.villa,
      locationId: ids.city,
      estimatedPrice: { amountCents: 75_000_000, currency: 'EUR' },
      confidentialNotes: NOTES,
    });
    expect(prospect).toMatchObject({ stage: 'NEW', contactId: sellerId, contactName: 'Sofia Seller' });
    expect(prospect.confidentialNotes).toBe(NOTES);

    const result = await convert(a, prospect.id);
    expect(result.created).toBe(true);
    expect(result.prospect).toMatchObject({ stage: 'LISTED', listingId: result.listingId });
    const listing = await as(a, (ctx) => properties.getListing(ctx, result.listingId));
    expect(listing).toMatchObject({
      status: 'DRAFT',
      visibility: 'PRIVATE',
      price: { amountCents: 75_000_000, currency: 'EUR' },
    });
    const [privates] = await rows<{ seller_contact_id: string; agency_id: string; internal_notes: string | null }>(
      sql`select seller_contact_id, agency_id, internal_notes from property_privates where property_id = ${result.listingId}`,
    );
    expect(privates).toEqual({ seller_contact_id: sellerId, agency_id: a.agencyId, internal_notes: null });

    // later the owner shares the listing on the network: b reads the listing, never its seller or the notes
    await as(a, async (ctx) =>
      properties.updateListing(
        ctx,
        result.listingId,
        UpdateListingBody.parse({
          status: 'ACTIVE',
          visibility: 'SHARED',
          shareScope: 'ALL',
          energyRating: 'B',
          version: (await properties.getListing(ctx, result.listingId)).version,
        }),
      ),
    );
    const seen = await as(b, (ctx) => properties.getListing(ctx, result.listingId));
    expect(seen.id).toBe(result.listingId);
    const shown = JSON.stringify(seen);
    expect(shown).not.toContain(sellerId);
    expect(shown).not.toContain(NOTES);
    // RLS: b reads none of a's private side, prospects or contacts, whatever it asks for
    const bRows = await withTenant({ agencyId: b.agencyId, userId: b.userId }, async (tx) => ({
      privates: (await tx.execute(sql`select 1 from property_privates where property_id = ${result.listingId}`)).rows,
      sellers: (await tx.execute(sql`select 1 from property_privates where seller_contact_id = ${sellerId}`)).rows,
      prospects: (await tx.execute(sql`select 1 from seller_prospects where id = ${prospect.id}`)).rows,
      notes: (await tx.execute(sql`select 1 from seller_prospects where confidential_notes = ${NOTES}`)).rows,
      contact: (await tx.execute(sql`select 1 from contacts where id = ${sellerId}`)).rows,
    }));
    expect(bRows).toEqual({ privates: [], sellers: [], prospects: [], notes: [], contact: [] });
    expect(await refusal(as(b, (ctx) => crm.getProspect(ctx, prospect.id)))).toBe('PROSPECT_NOT_FOUND');
    expect(await refusal(as(b, (ctx) => crm.convertProspect(ctx, prospect.id, ConvertProspectBody.parse({}))))).toBe(
      'PROSPECT_NOT_FOUND',
    );
    const bList = await as(b, (ctx) => crm.listProspects(ctx, ListProspectsQuery.parse({ limit: 100 })));
    expect(bList.items.map((p) => p.id)).not.toContain(prospect.id);
    // nothing about the seller reaches what the public read models are built from (the read-model worker's input)
    const built = await system((tx) => properties.listingsForReadModels(tx, [result.listingId]));
    expect(built).toHaveLength(1);
    expect(JSON.stringify(built)).not.toContain(sellerId);
    expect(JSON.stringify(built)).not.toContain(NOTES);
  });

  it('[S11-F15] a role that manages prospects but cannot create listings gets FORBIDDEN on convert and no listing is created', async () => {
    const { prospect } = await create(a, {
      title: title('No listing right'),
      contactId: sellerId,
      propertyTypeId: ids.villa,
      locationId: ids.city,
    });
    const listings = () =>
      rows<{ n: number }>(sql`select count(*)::int as n from properties where agency_id = ${a.agencyId}`).then(
        (r) => r[0]?.n,
      );
    const before = await listings();
    listingPolicy.denyCreate = true;
    try {
      expect(await refusal(convert(a, prospect.id))).toBe('FORBIDDEN');
    } finally {
      listingPolicy.denyCreate = false;
    }
    expect(await listings()).toBe(before);
    expect((await as(a, (ctx) => crm.getProspect(ctx, prospect.id))).listingId).toBeNull();
    expect((await convert(a, prospect.id)).created).toBe(true);
  });

  it('[S10-07] conversion is idempotent: converting twice — or twice at once — gives the same listing', async () => {
    const { prospect } = await create(a, {
      title: title('Twice'),
      contactId: sellerId,
      propertyTypeId: ids.villa,
      locationId: ids.city,
    });
    const [first, second] = await Promise.all([convert(a, prospect.id), convert(a, prospect.id)]);
    expect(first.listingId).toBe(second.listingId);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    const third = await convert(a, prospect.id);
    expect(third).toMatchObject({ listingId: first.listingId, created: false });
    const [n] = await rows<{ n: number }>(
      sql`select count(*)::int as n from property_privates where agency_id = ${a.agencyId} and seller_contact_id = ${sellerId}
          and property_id = ${first.listingId}`,
    );
    expect(n?.n).toBe(1);
    expect((await as(a, (ctx) => crm.getProspect(ctx, prospect.id))).listingId).toBe(first.listingId);
  });

  it('[S10-07] a prospect without a type or location is refused until they are given; the body may supply them', async () => {
    const { prospect } = await create(a, { title: title('No type') });
    expect(await refusal(convert(a, prospect.id))).toBe('PROSPECT_INCOMPLETE');
    const done = await convert(a, prospect.id, { propertyTypeId: ids.villa, locationId: ids.city });
    expect(done.created).toBe(true);
    expect(done.prospect).toMatchObject({ propertyTypeId: ids.villa, locationId: ids.city, contactId: null });
    const [privates] = await rows<{ seller_contact_id: string | null }>(
      sql`select seller_contact_id from property_privates where property_id = ${done.listingId}`,
    );
    expect(privates?.seller_contact_id).toBeNull();
  });

  it('[S10-07] the conversion stays within the dashboard budget (≤ 10 queries)', async () => {
    const { prospect } = await create(a, {
      title: title('Budget'),
      contactId: sellerId,
      propertyTypeId: ids.villa,
      locationId: ids.city,
      estimatedPrice: { amountCents: 10_000_000, currency: 'EUR' },
    });
    let created = false;
    const count = await countQueries(async () => {
      created = (await convert(a, prospect.id)).created;
    });
    expect(created).toBe(true);
    expect(count - (await setupQueries())).toBeLessThanOrEqual(9);
  });

  it('[S10-07] contact merges move the seller of converted listings through crm.contact.merged, even handled out of order', async () => {
    const contact = async (name: string) =>
      (
        await as(a, (ctx) =>
          crm.createContact(ctx, CreateContactBody.parse({ firstName: name, emails: [`${name}-${RUN}@example.com`] })),
        )
      ).contact.id;
    const [first, middle, last] = [await contact('chain-a'), await contact('chain-b'), await contact('chain-c')];
    const { prospect } = await create(a, {
      title: title('Chained seller'),
      contactId: first,
      propertyTypeId: ids.villa,
      locationId: ids.city,
    });
    const { listingId } = await convert(a, prospect.id);
    const mergeInto = async (survivor: string, duplicate: string) => {
      const { version } = await as(a, (ctx) => crm.getContact(ctx, survivor));
      await as(a, (ctx) => crm.mergeContacts(ctx, survivor, { duplicateId: duplicate, version }));
    };
    await mergeInto(middle, first); // A → B
    await mergeInto(last, middle); // B → C
    // the prospect itself moved with each merge (CONTACT_REFERENCES)
    expect((await as(a, (ctx) => crm.getProspect(ctx, prospect.id))).contactId).toBe(last);

    const events = await rows<{ id: string; type: string; version: number; payload: unknown; created_at: string }>(
      sql`select id, type, version, payload, created_at from outbox_events
           where type = 'crm.contact.merged' and agency_id = ${a.agencyId}
             and payload->>'mergedId' in (${first}, ${middle})
           order by created_at, id`,
    );
    expect(events).toHaveLength(2);
    const job = crm.crmJobs.repointSellerListings;
    const queued: { eventId: string; survivorId: string; mergedId: string }[] = [];
    const spy = vi.spyOn(job, 'enqueue').mockImplementation(async (payload) => {
      const p = job.spec.payload.parse(payload);
      queued.push({ eventId: p.eventId, survivorId: p.survivorId, mergedId: p.mergedId });
      await crm.repointSellerListings(p);
      return { id: 'inline', added: true } as unknown as Awaited<ReturnType<typeof job.enqueue>>;
    });
    crm.registerCrmSubscriptions();
    try {
      const [sub] = defaultSubscribers
        .get('crm.contact.merged', 1)
        .filter((s) => s.name === 'crm.prospects.sellerMerged');
      expect(sub).toBeDefined();
      // delivered out of order: B → C before A → B, then A → B redelivered
      for (const row of [events[1], events[0], events[0]]) {
        if (!row || !sub) continue;
        await sub.handler(sub.def.schema.parse(row.payload), {
          eventId: row.id,
          agencyId: a.agencyId,
          type: row.type,
          version: row.version,
          createdAt: new Date(row.created_at),
          attempt: 1,
        });
      }
    } finally {
      crm.unregisterCrmSubscriptions();
      spy.mockRestore();
    }
    expect(queued).toEqual([
      { eventId: events[1]?.id, survivorId: last, mergedId: middle },
      { eventId: events[0]?.id, survivorId: middle, mergedId: first },
      { eventId: events[0]?.id, survivorId: middle, mergedId: first },
    ]);
    // A's listing names C, the open contact at the end of the chain
    const [privates] = await rows<{ seller_contact_id: string }>(
      sql`select seller_contact_id from property_privates where property_id = ${listingId}`,
    );
    expect(privates?.seller_contact_id).toBe(last);
  });

  it('[S10-07] a closed seller is never put on a listing; an erased one leaves the prospect; a purged listing leaves its prospect', async () => {
    const contact = async (name: string) =>
      (
        await as(a, (ctx) =>
          crm.createContact(ctx, CreateContactBody.parse({ firstName: name, emails: [`${name}-${RUN}@example.com`] })),
        )
      ).contact.id;
    const closed = await contact('closed');
    const p1 = (
      await create(a, {
        title: title('Closed seller'),
        contactId: closed,
        propertyTypeId: ids.villa,
        locationId: ids.city,
      })
    ).prospect;
    await system((tx) => tx.execute(sql`update contacts set deleted_at = now() where id = ${closed}`));
    expect(await refusal(convert(a, p1.id))).toBe('PROSPECT_INCOMPLETE');
    expect((await as(a, (ctx) => crm.getProspect(ctx, p1.id))).contactName).toBeNull();

    // erasure (a hard delete) keeps the prospect and its notes, without the seller (ON DELETE SET NULL (contact_id))
    const erased = await contact('erased');
    const p2 = (await create(a, { title: title('Erased seller'), contactId: erased, confidentialNotes: NOTES }))
      .prospect;
    await system((tx) => tx.execute(sql`delete from contacts where id = ${erased}`));
    expect(await as(a, (ctx) => crm.getProspect(ctx, p2.id))).toMatchObject({
      contactId: null,
      confidentialNotes: NOTES,
    });

    const p3 = (await create(a, { title: title('Purged'), propertyTypeId: ids.villa, locationId: ids.city })).prospect;
    const { listingId } = await convert(a, p3.id);
    expect((await crm.forgetListingProspects({ agencyId: a.agencyId, listingId })).rows).toBe(1);
    expect(await as(a, (ctx) => crm.getProspect(ctx, p3.id))).toMatchObject({ listingId: null, stage: 'LISTED' });
  });

  it('[S10-07] references are checked: unknown property types and locations are refused; no price means no currency', async () => {
    expect(await refusal(create(a, { title: title('Bad type'), propertyTypeId: newId() }))).toBe('VALIDATION_FAILED');
    expect(await refusal(create(a, { title: title('Bad place'), locationId: newId() }))).toBe('VALIDATION_FAILED');
    const { prospect } = await create(a, { title: title('No price') });
    expect(prospect.estimatedPrice).toBeNull();
    const priced = await update(a, prospect.id, {
      version: prospect.version,
      estimatedPrice: { amountCents: 5_000_000, currency: 'GBP' },
    });
    expect(priced.estimatedPrice).toEqual({ amountCents: 5_000_000, currency: 'GBP' });
    const cleared = await update(a, prospect.id, { version: priced.version, estimatedPrice: null });
    expect(cleared.estimatedPrice).toBeNull();
    const [row] = await rows<{ currency: string | null }>(
      sql`select currency from seller_prospects where id = ${prospect.id}`,
    );
    expect(row?.currency).toBeNull();
    // a price without a currency is in the agency's currency (its settings)
    const [agency] = await rows<{ currency: string }>(
      sql`select currency from agency_settings where agency_id = ${a.agencyId}`,
    );
    const defaulted = await update(a, prospect.id, { version: cleared.version, estimatedPrice: { amountCents: 100 } });
    expect(defaulted.estimatedPrice).toEqual({ amountCents: 100, currency: agency?.currency ?? 'EUR' });
    expect(await refusal(update(a, prospect.id, { version: defaulted.version, locationId: newId() }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('confidential notes', () => {
  it('[S10-07] confidential notes are the agency’s members’ only: not staff impersonating, never Client Mode', async () => {
    const { prospect } = await create(a, { title: title('Secret'), confidentialNotes: NOTES });
    // S11-F2: an impersonated read writes an audit row, so the transaction carries the staff member (RLS)
    const impersonated = await as(a, async (ctx) => crm.getProspect(await impersonatedCtx(ctx, STAFF), prospect.id));
    expect(impersonated.id).toBe(prospect.id);
    expect(impersonated.confidentialNotes).toBeNull();
    expect(await refusal(as(a, (ctx) => crm.getProspect({ ...ctx, clientMode: true }, prospect.id)))).toBe('FORBIDDEN');
    expect((await as(a, (ctx) => crm.getProspect(ctx, prospect.id))).confidentialNotes).toBe(NOTES);
    // cleared by a member
    const cleared = await update(a, prospect.id, { version: prospect.version, confidentialNotes: null });
    expect(cleared.confidentialNotes).toBeNull();
  });
});

describe('board, list and by-date views', () => {
  it('[S10-07] the board shows every stage; a drag moves a card between and within stages; Listed only by converting', async () => {
    const one = (await create(a, { title: title('Card one') })).prospect;
    const two = (await create(a, { title: title('Card two') })).prospect;
    let board: Awaited<ReturnType<typeof crm.getProspectBoard>> = { columns: [] };
    const count = await countQueries(async () => {
      board = await as(a, (ctx) => crm.getProspectBoard(ctx, ProspectBoardQuery.parse({ limit: 50 })));
    });
    expect(count - (await setupQueries())).toBeLessThanOrEqual(3);
    expect(board.columns.map((c) => c.stage)).toEqual([
      'NEW',
      'CONTACTED',
      'VALUATION',
      'NEGOTIATION',
      'MANDATE',
      'LISTED',
      'LOST',
    ]);
    const firstNew = board.columns[0]?.items.map((i) => i.id) ?? [];
    // newest first in a fresh column
    expect(firstNew.indexOf(two.id)).toBeLessThan(firstNew.indexOf(one.id));

    const contacted = await move(a, one.id, { version: one.version, stage: 'CONTACTED' });
    expect(contacted.stage).toBe('CONTACTED');
    const second = await move(a, two.id, { version: two.version, stage: 'CONTACTED', afterId: one.id });
    const column = await as(a, (ctx) => crm.listStageProspects(ctx, 'CONTACTED', { limit: 100 }));
    const order = column.items.map((i) => i.id);
    expect(order.indexOf(one.id)).toBe(order.indexOf(two.id) - 1);
    // the same card back to the top of its column
    await move(a, two.id, { version: second.version, stage: 'CONTACTED', afterId: null });
    const again = (await as(a, (ctx) => crm.listStageProspects(ctx, 'CONTACTED', { limit: 100 }))).items.map(
      (i) => i.id,
    );
    expect(again[0]).toBe(two.id);

    expect(await refusal(move(a, one.id, { version: contacted.version, stage: 'LISTED' }))).toBe(
      'PROSPECT_STAGE_INVALID',
    );
    expect(await refusal(move(a, one.id, { version: 1, stage: 'LOST' }))).toBe('VERSION_CONFLICT');
    const listed = await create(a, { title: title('Listed'), propertyTypeId: ids.villa, locationId: ids.city });
    const conv = await convert(a, listed.prospect.id);
    expect(await refusal(move(a, listed.prospect.id, { version: conv.prospect.version, stage: 'NEGOTIATION' }))).toBe(
      'PROSPECT_STAGE_INVALID',
    );
  });

  it('[S10-07] the list (newest first, by stage) and the by-date view (follow-ups in a range, soonest first)', async () => {
    const base = Date.UTC(2031, 2, 10, 9, 0);
    const later = (
      await create(a, { title: title('Later'), nextFollowUpAt: new Date(base + 86_400_000).toISOString() })
    ).prospect;
    const sooner = (await create(a, { title: title('Sooner'), nextFollowUpAt: new Date(base).toISOString() })).prospect;
    const outside = (
      await create(a, { title: title('Outside'), nextFollowUpAt: new Date(base + 40 * 86_400_000).toISOString() })
    ).prospect;
    let page: Awaited<ReturnType<typeof crm.listProspectFollowUps>> = { items: [], nextCursor: null };
    const count = await countQueries(async () => {
      page = await as(a, (ctx) =>
        crm.listProspectFollowUps(
          ctx,
          ProspectFollowUpsQuery.parse({
            from: new Date(base - 86_400_000).toISOString(),
            to: new Date(base + 7 * 86_400_000).toISOString(),
            limit: 1,
          }),
        ),
      );
    });
    expect(count - (await setupQueries())).toBeLessThanOrEqual(1);
    expect(page.items.map((p) => p.id)).toEqual([sooner.id]);
    const next = await as(a, (ctx) =>
      crm.listProspectFollowUps(
        ctx,
        ProspectFollowUpsQuery.parse({
          from: new Date(base - 86_400_000).toISOString(),
          to: new Date(base + 7 * 86_400_000).toISOString(),
          limit: 10,
          cursor: page.nextCursor ?? undefined,
        }),
      ),
    );
    expect(next.items.map((p) => p.id)).toEqual([later.id]);
    expect(next.items.map((p) => p.id)).not.toContain(outside.id);

    const list = await as(a, (ctx) => crm.listProspects(ctx, ListProspectsQuery.parse({ stage: 'NEW', limit: 2 })));
    expect(list.items.map((p) => p.id)).toEqual([outside.id, sooner.id]);
    expect(list.items.every((p) => p.stage === 'NEW')).toBe(true);
    expect(list.nextCursor).not.toBeNull();
    const mine = await as(a, (ctx) => crm.listProspects(ctx, ListProspectsQuery.parse({ assigned: 'me', limit: 1 })));
    expect(mine.items[0]?.assignedUserId).toBe(a.userId);
  });

  it('[S10-07] a create retried with its Idempotency-Key answers the first prospect; another body is refused', async () => {
    const key = `prospect-${RUN}`;
    const first = await create(a, { title: title('Idem') }, { idempotencyKey: key });
    const replay = await create(a, { title: title('Idem') }, { idempotencyKey: key });
    expect(replay).toMatchObject({ replayed: true, prospect: { id: first.prospect.id } });
    expect(await refusal(create(a, { title: title('Other') }, { idempotencyKey: key }))).toBe('IDEMPOTENCY_KEY_REUSED');
    // a seller of another agency is not a contact here
    const theirs = await as(b, (ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Theirs', emails: [`theirs-${RUN}@example.com`] })),
    );
    expect(await refusal(create(a, { title: title('Foreign'), contactId: theirs.contact.id }))).toBe(
      'CONTACT_NOT_FOUND',
    );
  });

  it('[S10-07] reused Idempotency-Key after 24 h → IDEMPOTENCY_KEY_REUSED', async () => {
    const key = `prospect-old-${RUN}`;
    const first = await create(a, { title: title('Stale') }, { idempotencyKey: key });
    await system((tx) =>
      tx.execute(
        sql`update seller_prospects set created_at = now() - interval '48 hours' where id = ${first.prospect.id}`,
      ),
    );
    // the 24 h replay window has passed but the key's unique index has not: a refusal, not a 500
    expect(await refusal(create(a, { title: title('Stale') }, { idempotencyKey: key }))).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
