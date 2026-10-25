import { CreateContactBody, CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem, withTenant } from '@inmolink/db';
import { adminQuery, loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue } from '@inmolink/platform/queue';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as crm from '../../crm';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as mls from '../index';

/**
 * Viewing requests and the terms snapshot (S11-02, PLAN §3 #9): the introducer requests a viewing of its registered
 * client with the target's terms as a snapshot; the owner accepts (and with it the terms), declines or proposes another
 * time; the terms never change after both acceptances (a trigger, every role); unanswered requests expire after the
 * configured days and both sides are notified; the owner never sees the client.
 */

const RUN = newId().slice(-8).toLowerCase();
const DAY_MS = 86_400_000;
const EXPIRY_DAYS = 2;
const keyring = createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' });
const log = createLogger({ service: 'mls-viewings-test', level: 'silent' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('mls.viewings.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** `a` introduces, `b` owns the listings, `c` is a stranger to both. */
let a: Founder;
let b: Founder;
let c: Founder;
let ids: { city: string; villa: string };
let pctListing: string;
let fixedListing: string;
let seq = 0;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
/** A member of `m`'s agency in the AGENT role (not an admin), as `userId`. */
const asAgent = <T>(m: Founder, userId: string, fn: (ctx: Ctx) => Promise<T>) =>
  as(m, (ctx) => fn({ ...ctx, actor: { kind: 'user', userId, role: 'AGENT' } }));
/** As app_owner (what migrations run as): the only role `viewing_terms_guard` lets change a request's terms. */
const asOwnerRole = (statement: string) => adminQuery(`begin; set local role app_owner; ${statement}; commit`);
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) {
      const reason = (err.details as { reason?: string } | undefined)?.reason;
      return reason ? `${err.code}:${reason}` : err.code;
    }
    throw err;
  }
  return 'accepted';
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    // the pg error's SQLSTATE, wherever the wrappers (Drizzle, withSystem) put it
    for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
      if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    }
    return `no sqlstate: ${String(err)}`;
  }
  return undefined;
}

async function listing(commission: unknown, splitBp: number): Promise<string> {
  const { id } = await as(b, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 60_000_000,
        energyRating: 'B',
        commission,
        splitBp,
      }),
    ),
  );
  await as(b, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  return id;
}

/** A client of `a` registered for `listingId`: the registration's id. */
async function registered(listingId: string): Promise<string> {
  seq += 1;
  const contact = (
    await as(a, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({
          firstName: 'Mara',
          lastName: `Viewer${seq}`,
          emails: [`mara-${seq}-${RUN}@example.com`],
        }),
      ),
    )
  ).contact;
  const reg = await mls.registerClient((fn) => as(a, fn), {
    contactId: contact.id,
    target: { kind: 'LISTING', id: listingId },
  });
  return reg.registration.id;
}

const request = (registrationId: string, days = 10, key?: string) =>
  as(a, (ctx) =>
    mls.requestViewing(ctx, { registrationId, proposedStartAt: inDays(days) }, key ? { idempotencyKey: key } : {}),
  );

interface TermsRow {
  status: string;
  commission_bp: number | null;
  commission_fixed_cents: string | null;
  commission_currency: string | null;
  split_bp: number;
  commission_includes_vat: boolean;
  owner_accepted_at: Date | null;
}
const bothRows = async (id: string) => ({
  introducer: (
    await rows<TermsRow>(sql`select status, commission_bp, commission_fixed_cents, commission_currency, split_bp,
      commission_includes_vat, owner_accepted_at from viewing_requests where id = ${id}`)
  )[0],
  owner: (
    await rows<TermsRow>(sql`select status, commission_bp, commission_fixed_cents, commission_currency, split_bp,
      commission_includes_vat, owner_accepted_at from viewing_request_receipts where request_id = ${id}`)
  )[0],
});

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureQueue({ prefix: `test-mls-viewings-${RUN}`, logger: log });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  mls.configureMls({
    keyring,
    fingerprintKey: `test-fingerprint-key-${RUN}-0123456789abcdef`,
    viewingRequestExpiryDays: EXPIRY_DAYS,
  });
  [a, b, c] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  for (const m of [a, b, c]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `mls-vw-${RUN}`,
      translations: name('Viewcountry'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `mls-vw-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `mls-vw-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  pctListing = await listing({ type: 'PCT', basisPoints: 400, includesVat: true }, 6000);
  fixedListing = await listing(
    { type: 'FIXED', amount: { amountCents: 1_500_000, currency: 'EUR' }, includesVat: false },
    4000,
  );
}, 180_000);

afterAll(async () => {
  await closeRateLimit();
  await closeQueues();
  await closeDb();
});

describe('request → accept → scheduled → outcome', () => {
  it('[S11-02] the snapshot stores commission_bp and split_bp (or the fixed amount) and the VAT flag as of acceptance', async () => {
    const created = await request(await registered(pctListing));
    expect(created.replayed).toBe(false);
    const id = created.request.id;
    expect(created.request).toMatchObject({
      side: 'INTRODUCER',
      counterpartAgencyId: b.agencyId,
      status: 'REQUESTED',
      awaiting: 'OWNER',
      terms: { commissionBp: 400, commissionFixed: null, splitBp: 6000, includesVat: true, accepted: false },
    });

    // the owner sees the request and its terms, never the client
    const received = await as(b, (ctx) => mls.getViewingRequest(ctx, id));
    expect(received).toMatchObject({
      side: 'OWNER',
      counterpartAgencyId: a.agencyId,
      registrationId: null,
      contactId: null,
      awaiting: 'OWNER',
    });
    expect(JSON.stringify(received)).not.toMatch(/Mara|example\.com/);
    // the introducer cannot answer its own proposal; a stranger cannot see it
    expect(await refusal(as(a, (ctx) => mls.acceptViewing(ctx, id)))).toBe('VIEWING_REQUEST_STATE:not_awaiting');
    expect(await refusal(as(c, (ctx) => mls.getViewingRequest(ctx, id)))).toBe('VIEWING_REQUEST_NOT_FOUND');

    const accepted = await as(b, (ctx) => mls.acceptViewing(ctx, id));
    expect(accepted).toMatchObject({ status: 'SCHEDULED', awaiting: null, terms: { accepted: true } });
    expect(accepted.terms.ownerAcceptedByUserId).toBe(b.userId);

    // the listing's terms change afterwards: the snapshot does not
    await as(b, async (ctx) =>
      properties.updateListing(
        ctx,
        pctListing,
        UpdateListingBody.parse({
          commission: { type: 'PCT', basisPoints: 300, includesVat: false },
          splitBp: 5000,
          version: (await properties.getListing(ctx, pctListing)).version,
        }),
      ),
    );
    const stored = await bothRows(id);
    for (const r of [stored.introducer, stored.owner]) {
      expect(r).toMatchObject({
        status: 'SCHEDULED',
        commission_bp: 400,
        commission_fixed_cents: null,
        split_bp: 6000,
        commission_includes_vat: true,
      });
      expect(r?.owner_accepted_at).not.toBeNull();
    }
    const doc = await as(a, (ctx) => mls.viewingTerms(ctx, id));
    expect(doc).toMatchObject({ requestId: id, ownerAgencyId: b.agencyId, pdfUrl: null, terms: { accepted: true } });

    // the outcome only after the scheduled time
    expect(await refusal(as(a, (ctx) => mls.recordViewingOutcome(ctx, id, { outcome: 'ATTENDED' })))).toBe(
      'VIEWING_REQUEST_STATE:too_early',
    );
    // move the viewing into the past (app_system: the sync trigger copies it to the owner's row)
    await system((tx) =>
      tx.execute(sql`update viewing_requests set scheduled_at = now() - interval '1 hour',
        proposed_start_at = now() - interval '1 hour' where id = ${id}`),
    );
    const done = await as(b, (ctx) => mls.recordViewingOutcome(ctx, id, { outcome: 'ATTENDED' }));
    expect(done).toMatchObject({ status: 'COMPLETED', outcome: 'ATTENDED' });
    expect((await as(a, (ctx) => mls.getViewingRequest(ctx, id))).status).toBe('COMPLETED');

    // a fixed commission: the amount and its currency, with the split
    const fixed = await request(await registered(fixedListing));
    expect(fixed.request.terms).toMatchObject({
      commissionBp: null,
      commissionFixed: { amountCents: 1_500_000, currency: 'EUR' },
      splitBp: 4000,
      includesVat: false,
    });
    const fixedRows = await bothRows(fixed.request.id);
    expect(fixedRows.owner).toMatchObject({
      commission_fixed_cents: '1500000',
      commission_currency: 'EUR',
      split_bp: 4000,
    });
  });

  it('[S11-02] reschedule and decline: the side awaited answers; the owner proposing a time accepts the terms', async () => {
    const registrationId = await registered(pctListing);
    const proposedStartAt = inDays(10);
    const once = () =>
      as(a, (ctx) =>
        mls.requestViewing(ctx, { registrationId, proposedStartAt }, { idempotencyKey: `vw-key-${RUN}-0001` }),
      );
    const { request: r } = await once();
    // a retry with the same key and body answers the same request; one open request per registration
    const replay = await once();
    expect(replay).toMatchObject({ replayed: true, request: { id: r.id } });
    expect(await refusal(request(registrationId, 11))).toBe('VIEWING_REQUEST_OPEN');

    const moved = await as(b, (ctx) => mls.rescheduleViewing(ctx, r.id, { proposedStartAt: inDays(12) }));
    expect(moved).toMatchObject({ status: 'REQUESTED', awaiting: 'INTRODUCER', terms: { accepted: true } });
    expect(await refusal(as(b, (ctx) => mls.acceptViewing(ctx, r.id)))).toBe('VIEWING_REQUEST_STATE:not_awaiting');
    const agreed = await as(a, (ctx) => mls.acceptViewing(ctx, r.id));
    expect(agreed).toMatchObject({ status: 'SCHEDULED', scheduledAt: moved.proposedStartAt });
    // a proposal after the registration ends is refused
    expect(await refusal(as(a, (ctx) => mls.rescheduleViewing(ctx, r.id, { proposedStartAt: inDays(400) })))).toBe(
      'VALIDATION_FAILED:after_registration',
    );
    const cancelled = await as(a, (ctx) => mls.cancelViewing(ctx, r.id));
    expect(cancelled).toMatchObject({ status: 'CANCELLED', closedBy: 'INTRODUCER' });
    expect((await as(b, (ctx) => mls.getViewingRequest(ctx, r.id))).status).toBe('CANCELLED');

    // a new request for the same registration, declined by the owner
    const again = await request(registrationId, 5);
    const declined = await as(b, (ctx) => mls.declineViewing(ctx, again.request.id));
    expect(declined).toMatchObject({ status: 'DECLINED', closedBy: 'OWNER', terms: { accepted: false } });
    expect(await refusal(as(b, (ctx) => mls.acceptViewing(ctx, again.request.id)))).toBe(
      'VIEWING_REQUEST_STATE:closed',
    );
    // the owner's list shows its copies, the introducer's its requests
    const theirs = await as(b, (ctx) => mls.listReceivedViewingRequests(ctx, { limit: 100 }));
    expect(theirs.items.map((i) => i.id)).toEqual(expect.arrayContaining([r.id, again.request.id]));
    expect(theirs.items.every((i) => i.contactId === null && i.registrationId === null)).toBe(true);
    const mine = await as(a, (ctx) => mls.listViewingRequests(ctx, { limit: 100 }));
    expect(mine.items.find((i) => i.id === r.id)?.registrationId).toBe(registrationId);
  });
});

describe('immutable terms', () => {
  it('[S11-02] the terms snapshot cannot change after both acceptances (DB trigger, every role)', async () => {
    const { request: open } = await request(await registered(pctListing));
    // app_user never writes the terms, on either side (column grants)
    expect(
      await sqlState(
        withTenant({ agencyId: a.agencyId }, (tx) =>
          tx.execute(sql`update viewing_requests set split_bp = 9000 where id = ${open.id}`),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        withTenant({ agencyId: b.agencyId }, (tx) =>
          tx.execute(sql`update viewing_request_receipts set commission_bp = 900 where request_id = ${open.id}`),
        ),
      ),
    ).toBe('42501');
    // nor the owner's acceptance on the introducer's row
    expect(
      await sqlState(
        withTenant({ agencyId: a.agencyId }, (tx) =>
          tx.execute(sql`update viewing_requests set owner_accepted_at = now(), owner_accepted_by = ${a.userId}
            where id = ${open.id}`),
        ),
      ),
    ).toBe('42501');

    await as(b, (ctx) => mls.acceptViewing(ctx, open.id));
    // once both accepted, not even app_system changes them — on either copy
    for (const q of [
      sql`update viewing_requests set commission_bp = commission_bp + 1 where id = ${open.id}`,
      sql`update viewing_requests set split_bp = split_bp + 1 where id = ${open.id}`,
      sql`update viewing_requests set commission_includes_vat = not commission_includes_vat where id = ${open.id}`,
      sql`update viewing_request_receipts set terms_valid_until = now() where request_id = ${open.id}`,
      sql`update viewing_request_receipts set owner_accepted_at = null, owner_accepted_by = null where request_id = ${open.id}`,
    ]) {
      expect(await sqlState(system((tx) => tx.execute(q))), q.queryChunks.map(String).join('')).toBe('23514');
    }
    const stored = await bothRows(open.id);
    const want = {
      commission_bp: open.terms.commissionBp,
      split_bp: open.terms.splitBp,
      commission_includes_vat: open.terms.includesVat,
    };
    expect(stored.introducer).toMatchObject(want);
    expect(stored.owner).toMatchObject(want);
    // the state still moves on (only the terms are frozen)
    expect((await as(a, (ctx) => mls.cancelViewing(ctx, open.id))).status).toBe('CANCELLED');
  });

  it('[S11-02] a request cannot be inserted already accepted (forged 100 % split, owner acceptance)', async () => {
    const registrationId = await registered(pctListing);
    const [reg] = await rows<{ target_id: string }>(
      sql`select target_id from client_registrations where id = ${registrationId}`,
    );
    // app_user (a request path) inserting an already scheduled, owner-accepted row with the whole commission
    const forged = withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) =>
      tx.execute(sql`insert into viewing_requests
        (id, agency_id, owner_agency_id, registration_id, contact_id, target_kind, target_id, proposed_start_at,
         commission_bp, split_bp, commission_includes_vat, terms_valid_until,
         status, awaiting, scheduled_at, owner_accepted_at, owner_accepted_by)
        values (${newId()}, ${a.agencyId}, ${b.agencyId}, ${registrationId}, ${newId()}, 'LISTING', ${reg?.target_id},
                now() + interval '3 days', 400, 10000, true, now() + interval '30 days',
                'SCHEDULED', null, now() + interval '3 days', now(), ${b.userId})`),
    );
    expect(await sqlState(forged)).toBe('42501');
    // and nothing reached the owner
    const copies = await rows<{ n: number }>(sql`select count(*)::int as n from viewing_request_receipts
      where agency_id = ${b.agencyId} and split_bp = 10000`);
    expect(copies[0]?.n).toBe(0);
  });

  it('[S11-02] binding the owner to terms is for its admins or the listing agent; any member may decline', async () => {
    const { request: r } = await request(await registered(pctListing));
    const stranger = newId();
    expect(await refusal(asAgent(b, stranger, (ctx) => mls.acceptViewing(ctx, r.id)))).toBe('FORBIDDEN');
    expect(
      await refusal(asAgent(b, stranger, (ctx) => mls.rescheduleViewing(ctx, r.id, { proposedStartAt: inDays(4) }))),
    ).toBe('FORBIDDEN');
    expect((await as(b, (ctx) => mls.getViewingRequest(ctx, r.id))).terms.accepted).toBe(false);
    // the counterpart's member ids are not shown: the owner sees no introducer user, the introducer no owner user
    const owner = await as(b, (ctx) => mls.getViewingRequest(ctx, r.id));
    expect(owner.terms.introducerAcceptedByUserId).toBeNull();
    const accepted = await as(b, (ctx) => mls.acceptViewing(ctx, r.id));
    expect(accepted.terms.ownerAcceptedByUserId).toBe(b.userId);
    expect((await as(a, (ctx) => mls.getViewingRequest(ctx, r.id))).terms.ownerAcceptedByUserId).toBeNull();
    // once its time has come, a scheduled viewing is not moved any more
    await system((tx) =>
      tx.execute(sql`update viewing_requests set scheduled_at = now() - interval '1 hour' where id = ${r.id}`),
    );
    expect(await refusal(as(a, (ctx) => mls.rescheduleViewing(ctx, r.id, { proposedStartAt: inDays(4) })))).toBe(
      'VIEWING_REQUEST_STATE:too_late',
    );
  });
});

describe('budgets', () => {
  it('[S11-02] requesting and both lists stay within 10 statements', async () => {
    const registrationId = await registered(fixedListing);
    const setup = await countQueries(() => as(a, async () => null));
    const created = await countQueries(() => request(registrationId, 6));
    const mine = await countQueries(() => as(a, (ctx) => mls.listViewingRequests(ctx, { limit: 100 })));
    const theirs = await countQueries(() => as(b, (ctx) => mls.listReceivedViewingRequests(ctx, { limit: 100 })));
    for (const n of [created, mine, theirs]) expect(n - setup).toBeLessThanOrEqual(10);
    expect(mine - setup).toBeLessThanOrEqual(3);
    expect(theirs - setup).toBeLessThanOrEqual(3);
  });
});

describe('expiry', () => {
  it('[S11-02] a scheduled viewing nobody recorded closes when the terms lapse, freeing the registration', async () => {
    const registrationId = await registered(fixedListing);
    const { request: r } = await request(registrationId, 3);
    await as(b, (ctx) => mls.acceptViewing(ctx, r.id));
    await asOwnerRole(
      `update viewing_requests set terms_valid_until = now() - interval '1 minute' where id = '${r.id}'`,
    );
    await mls.expireViewingRequests();
    const stored = await bothRows(r.id);
    expect(stored.introducer?.status).toBe('EXPIRED');
    expect(stored.owner?.status).toBe('EXPIRED');
    // the open-request slot is free again (the registration itself is still valid)
    expect((await request(registrationId, 4)).replayed).toBe(false);
  });

  it('[S11-02] unanswered requests expire after the configured days and notify both sides', async () => {
    const { request: r } = await request(await registered(pctListing), 10);
    // the configured days from the request (the proposal is later)
    expect(Date.parse(r.expiresAt ?? '') - Date.parse(r.createdAt)).toBeGreaterThanOrEqual(
      EXPIRY_DAYS * DAY_MS - 5_000,
    );
    expect(Date.parse(r.expiresAt ?? '') - Date.parse(r.createdAt)).toBeLessThanOrEqual(EXPIRY_DAYS * DAY_MS + 5_000);
    // a proposal sooner than that expires at the proposed time
    const { request: soon } = await request(await registered(fixedListing), 1);
    expect(soon.expiresAt).toBe(soon.proposedStartAt);

    // the configured days pass without an answer
    await system((tx) =>
      tx.execute(sql`update viewing_requests set expires_at = now() - interval '1 minute' where id = ${r.id}`),
    );
    const { expired } = await mls.expireViewingRequests();
    expect(expired).toBeGreaterThanOrEqual(1);
    const stored = await bothRows(r.id);
    expect(stored.introducer?.status).toBe('EXPIRED');
    expect(stored.owner?.status).toBe('EXPIRED');
    expect((await as(b, (ctx) => mls.getViewingRequest(ctx, r.id))).closedBy).toBe('SYSTEM');
    expect(await refusal(as(b, (ctx) => mls.acceptViewing(ctx, r.id)))).toBe('VIEWING_REQUEST_STATE:closed');
    // the one still in time is untouched
    expect((await bothRows(soon.id)).introducer?.status).toBe('REQUESTED');

    // the expiry event notifies both sides (the worker's job, run here directly; a redelivery adds nothing)
    const [event] = await rows<{ id: string; agency_id: string; payload: unknown; created_at: Date }>(sql`
      select id, agency_id, payload, created_at from outbox_events
       where type = 'mls.viewing.changed' and payload->>'requestId' = ${r.id} and payload->>'action' = 'EXPIRED'`);
    expect(event).toBeDefined();
    const payload = mls.mlsEvents.viewingChanged.schema.parse(event?.payload);
    const meta = {
      eventId: event?.id as string,
      agencyId: event?.agency_id as string,
      createdAt: new Date(event?.created_at as Date),
    };
    await mls.notifyViewingChange(payload, meta);
    await mls.notifyViewingChange(payload, meta);
    const notified = await rows<{ agency_id: string; user_id: string; type: string }>(sql`
      select agency_id, user_id, type from notifications where source_key like ${`${meta.eventId}:%`}`);
    expect(notified).toHaveLength(2);
    expect(notified).toEqual(
      expect.arrayContaining([
        { agency_id: a.agencyId, user_id: a.userId, type: 'VIEWING_UPDATED' },
        { agency_id: b.agencyId, user_id: b.userId, type: 'VIEWING_UPDATED' },
      ]),
    );
  });

  it('[S11-02] a new request notifies the owner, an answer the introducer — never with the client', async () => {
    const { request: r } = await request(await registered(pctListing));
    const events = async () =>
      rows<{ id: string; agency_id: string; payload: unknown; created_at: Date }>(sql`
        select id, agency_id, payload, created_at from outbox_events
         where type = 'mls.viewing.changed' and payload->>'requestId' = ${r.id} order by id`);
    await as(b, (ctx) => mls.declineViewing(ctx, r.id));
    for (const e of await events()) {
      await mls.notifyViewingChange(mls.mlsEvents.viewingChanged.schema.parse(e.payload), {
        eventId: e.id,
        agencyId: e.agency_id,
        createdAt: new Date(e.created_at),
      });
    }
    const ids = (await events()).map((e) => e.id);
    const notified = await rows<{ agency_id: string; type: string; params: Record<string, unknown> }>(sql`
      select agency_id, type, params from notifications
       where split_part(source_key, ':', 1) = any(${sql`array[${sql.join(
         ids.map((i) => sql`${i}`),
         sql`, `,
       )}]::text[]`})`);
    expect(notified.map((n) => [n.agency_id, n.type]).sort()).toEqual(
      [
        [b.agencyId, 'VIEWING_REQUESTED'],
        [a.agencyId, 'VIEWING_UPDATED'],
      ].sort(),
    );
    expect(JSON.stringify(notified)).not.toMatch(/Mara|example\.com/);
  });
});

describe('staff reads (S12-F9)', () => {
  it('[S12-F9] impersonated reads of registrations and introducer-side viewing requests write one mls.clientData.read row each; own reads none', async () => {
    const { request: r } = await request(await registered(pctListing));
    const staffUserId = newId();
    /** Runs `fn` as `m` (impersonated by `staffUserId` when asked) and answers the audit rows the request wrote. */
    const auditOf = async (m: Founder, impersonated: boolean, fn: (ctx: Ctx) => Promise<unknown>) => {
      const requestId = newId();
      await withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId, locale: 'en' }, async (ctx) =>
        fn(impersonated ? await impersonatedCtx(ctx, staffUserId) : ctx),
      );
      return rows<{
        type: string;
        impersonated_by: string | null;
        target_type: string | null;
        target_id: string | null;
        metadata: Record<string, unknown>;
      }>(sql`select type, impersonated_by, target_type, target_id, metadata from audit_logs
              where agency_id = ${m.agencyId} and request_id = ${requestId}`);
    };
    const reads: [string, Founder, (ctx: Ctx) => Promise<unknown>, Record<string, unknown>][] = [
      [
        'registrations list',
        a,
        (ctx) => mls.listRegistrations(ctx, { limit: 1, state: 'ACTIVE', kind: 'LISTING' }),
        {
          target_type: null,
          metadata: { resource: 'registrations', view: 'list', count: 1, state: 'ACTIVE', kind: 'LISTING' },
        },
      ],
      [
        'viewing requests list',
        a,
        (ctx) => mls.listViewingRequests(ctx, { limit: 1, kind: 'LISTING' }),
        { target_type: null, metadata: { resource: 'viewingRequests', view: 'list', count: 1, kind: 'LISTING' } },
      ],
      [
        'viewing request get',
        a,
        (ctx) => mls.getViewingRequest(ctx, r.id),
        { target_type: 'viewingRequest', target_id: r.id, metadata: { resource: 'viewingRequests', view: 'get' } },
      ],
    ];
    for (const [name, m, fn, expected] of reads) {
      expect(await auditOf(m, true, fn), name).toEqual([
        expect.objectContaining({ type: 'mls.clientData.read', impersonated_by: staffUserId, ...expected }),
      ]);
      expect(await auditOf(m, false, fn), `${name} (own)`).toEqual([]);
    }
    // The owner's side never holds the client: no row, impersonated or not.
    expect(await auditOf(b, true, (ctx) => mls.getViewingRequest(ctx, r.id))).toEqual([]);
    expect(await auditOf(b, true, (ctx) => mls.listReceivedViewingRequests(ctx, { limit: 5 }))).toEqual([]);
  });
});
