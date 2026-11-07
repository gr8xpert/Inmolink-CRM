import { CreateContactBody, CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withSystem, withTenant } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { isAppError } from '@inmolink/platform/errors';
import { configureESign } from '@inmolink/platform/esign';
import { fakeESign } from '@inmolink/platform/esign/testing';
import { invalidateFlags, setFlag, setFlagOverride } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, StaffCtx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as crm from '../../crm';
import * as documents from '../../documents';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as mls from '../index';

/**
 * The deal room (R2-04a, PLAN §3 #10): a deal of an accepted viewing request, both parties' copies kept in step by the
 * database, the commission computed by the database from the terms snapshot (held to `commissionOf` to the cent), the
 * stages forward only, the completion handshake, and completed deals immutable for every role but staff mediation
 * (audited for both agencies). Every query is scoped to this file's agencies and deals.
 */

const RUN = newId().slice(-8).toLowerCase();
const DAY_MS = 86_400_000;
const keyring = createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('mls.deals.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** `a` introduces, `b` owns the listings, `c` is a stranger to both. */
let a: Founder;
let b: Founder;
let c: Founder;
let ids: { city: string; villa: string };
let pctListing: string;
let fixedListing: string;
let dataOps: string;
let support: string;
let seq = 0;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const asAgent = <T>(m: Founder, userId: string, fn: (ctx: Ctx) => Promise<T>) =>
  as(m, (ctx) => fn({ ...ctx, actor: { kind: 'user', userId, role: 'AGENT' } }));
const asStaff = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'mls deals int test' }, fn);
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
const eur = (amountCents: number) => ({ amountCents, currency: 'EUR' });

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

/** A viewing request of a fresh client of `a` for `listingId`; accepted by the owner unless `accept` is false. */
async function viewing(listingId: string, accept = true): Promise<string> {
  seq += 1;
  const contact = (
    await as(a, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({
          firstName: 'Dea',
          lastName: `Buyer${seq}`,
          emails: [`dea-${seq}-${RUN}@example.com`],
        }),
      ),
    )
  ).contact;
  const reg = await mls.registerClient((fn) => as(a, fn), {
    contactId: contact.id,
    target: { kind: 'LISTING', id: listingId },
  });
  const req = await as(a, (ctx) =>
    mls.requestViewing(ctx, { registrationId: reg.registration.id, proposedStartAt: inDays(5) }),
  );
  if (accept) await as(b, (ctx) => mls.acceptViewing(ctx, req.request.id));
  return req.request.id;
}

interface CopyRow {
  agency_id: string;
  party: string;
  stage: string;
  price_cents: string;
  commission_bp: number | null;
  split_bp: number;
  commission_total_cents: string;
  introducer_share_cents: string;
  owner_share_cents: string;
  owner_confirmed_at: Date | null;
  introducer_confirmed_at: Date | null;
  completed_at: Date | null;
  mediation_reason: string | null;
}
const copies = (id: string) =>
  rows<CopyRow>(sql`select agency_id, party, stage, price_cents, commission_bp, split_bp, commission_total_cents,
    introducer_share_cents, owner_share_cents, owner_confirmed_at, introducer_confirmed_at, completed_at, mediation_reason
    from deals where id = ${id} and agency_id in (${a.agencyId}, ${b.agencyId}) order by party`);

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  mls.configureMls({
    keyring,
    fingerprintKey: `test-fingerprint-key-${RUN}-0123456789abcdef`,
    viewingRequestExpiryDays: 3,
  });
  [a, b, c] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  for (const m of [a, b, c]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  dataOps = (await createStaffUser('STAFF_DATA_OPS')).userId;
  support = (await createStaffUser('STAFF_SUPPORT')).userId;
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `mls-dl-${RUN}`,
      translations: name('Dealcountry'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `mls-dl-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `mls-dl-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  pctListing = await listing({ type: 'PCT', basisPoints: 350, includesVat: true }, 6000);
  fixedListing = await listing(
    { type: 'FIXED', amount: { amountCents: 1_500_000, currency: 'EUR' }, includesVat: false },
    4000,
  );
}, 180_000);

afterAll(async () => {
  await closeRateLimit();
  await closeDb();
});

describe('[R2-04a] opening a deal', () => {
  it('[R2-04a] a deal comes from an accepted viewing only, carries its terms snapshot and has both parties’ copies', async () => {
    const pending = await viewing(pctListing, false);
    expect(
      await refusal(as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: pending, price: eur(58_000_000) }))),
    ).toBe('DEAL_VIEWING_NOT_ELIGIBLE');
    expect(
      await refusal(as(c, (ctx) => mls.openDeal(ctx, { viewingRequestId: pending, price: eur(58_000_000) }))),
    ).toBe('VIEWING_REQUEST_NOT_FOUND');

    const vr = await viewing(pctListing);
    const opened = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(58_000_001) }));
    expect(opened.created).toBe(true);
    expect(opened.deal).toMatchObject({
      party: 'INTRODUCER',
      counterpartAgencyId: b.agencyId,
      stage: 'OFFER',
      viewingRequestId: vr,
      target: { kind: 'LISTING', id: pctListing },
      terms: { commissionBp: 350, commissionFixed: null, splitBp: 6000, includesVat: true },
    });
    // 3.5 % of 580,000.01 € = 2,030,000.035 cents → 2,030,000; 60 % of it to the introducer
    expect(opened.deal.commission).toEqual({
      totalCents: 2_030_000,
      introducerShareCents: 1_218_000,
      ownerShareCents: 812_000,
      currency: 'EUR',
      includesVat: true,
    });
    expect(opened.deal.commission).toMatchObject(
      mls.commissionOf(58_000_001, { commissionBp: 350, commissionFixedCents: null, splitBp: 6000 }),
    );

    // the owner's copy, in step; a stranger sees nothing
    const owner = await as(b, (ctx) => mls.getDeal(ctx, opened.deal.id));
    expect(owner).toMatchObject({
      party: 'OWNER',
      counterpartAgencyId: a.agencyId,
      commission: opened.deal.commission,
    });
    expect(await refusal(as(c, (ctx) => mls.getDeal(ctx, opened.deal.id)))).toBe('DEAL_NOT_FOUND');
    expect((await copies(opened.deal.id)).map((r) => r.party)).toEqual(['INTRODUCER', 'OWNER']);

    // one live deal per viewing: a repeat from either side answers it
    const again = await as(b, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(1) }));
    expect(again).toMatchObject({ created: false, deal: { id: opened.deal.id, party: 'OWNER' } });
    const listed = await as(b, (ctx) => mls.listDeals(ctx, { limit: 100 }));
    expect(listed.items.map((d) => d.id)).toContain(opened.deal.id);

    // audited and announced
    const audit = await rows<{ n: string }>(
      sql`select count(*) as n from audit_logs where type = 'mls.deal.opened' and target_id = ${opened.deal.id}`,
    );
    expect(Number(audit[0]?.n)).toBe(1);
  });

  it('[R2-04a] the database copies the terms from the viewing request whatever an insert says', async () => {
    const vr = await viewing(pctListing);
    const id = newId();
    await withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) =>
      tx.execute(sql`insert into deals (agency_id, id, party, peer_agency_id, viewing_request_id, target_kind, target_id,
        commission_bp, split_bp, commission_includes_vat, terms_at, stage, price_cents, currency)
        values (${a.agencyId}, ${id}, 'INTRODUCER', ${b.agencyId}, ${vr}, 'LISTING', ${newId()}, 10000, 10000, false,
        now(), 'OFFER', 100000000, 'EUR')`),
    );
    for (const r of await copies(id)) {
      expect(r).toMatchObject({ commission_bp: 350, split_bp: 6000, commission_total_cents: '3500000' });
    }
    // forged state at insert, or a viewing between other agencies: refused
    expect(
      await sqlState(
        withTenant({ agencyId: c.agencyId, userId: c.userId }, (tx) =>
          tx.execute(sql`insert into deals (agency_id, id, party, peer_agency_id, viewing_request_id, target_kind,
            target_id, split_bp, commission_bp, commission_includes_vat, terms_at, stage, price_cents, currency)
            values (${c.agencyId}, ${newId()}, 'INTRODUCER', ${b.agencyId}, ${vr}, 'LISTING', ${pctListing}, 0, 1, false,
            now(), 'OFFER', 1, 'EUR')`),
        ),
      ),
    ).toBe('42501');
  });

  it('[R2-04a] a fixed commission is the total, in its own currency; the owner side binds by its admins or the listing agent', async () => {
    const vr = await viewing(fixedListing);
    expect(
      await refusal(
        as(b, (ctx) =>
          mls.openDeal(ctx, { viewingRequestId: vr, price: { amountCents: 50_000_000, currency: 'GBP' } }),
        ),
      ),
    ).toBe('VALIDATION_FAILED:commission_currency');
    // a member of the owner agency who is not the listing's agent may not bind it
    expect(
      await refusal(asAgent(b, newId(), (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(50_000_000) }))),
    ).toBe('FORBIDDEN');
    const { deal } = await as(b, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(50_000_000) }));
    expect(deal.commission).toEqual({
      totalCents: 1_500_000,
      introducerShareCents: 600_000,
      ownerShareCents: 900_000,
      currency: 'EUR',
      includesVat: false,
    });
  });

  it('[R2-04a] the database computes the commission like commissionOf, to the cent (property, seeded)', async () => {
    let state = 0x2041a;
    const next = (n: number) => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return Math.floor((state / 4_294_967_296) * n);
    };
    const cases = Array.from({ length: 400 }, (_, i) => {
      const fixed = i % 4 === 3;
      return {
        price: 1 + next(10_000_000_000_000),
        bp: fixed ? null : 1 + next(10_000),
        fixed: fixed ? 1 + next(100_000_000_000) : null,
        split: next(10_001),
      };
    });
    // written as the system in a transaction rolled back at the end: the generated columns, nothing else kept
    const got = await system(async (tx) => {
      const out: { total: string; intro: string; own: string }[] = [];
      await tx
        .transaction(async (sp) => {
          for (const k of cases) {
            const res = await sp.execute(sql`insert into deals (agency_id, id, party, peer_agency_id,
              viewing_request_id, target_kind, target_id, commission_bp, commission_fixed_cents, commission_currency,
              split_bp, commission_includes_vat, terms_at, stage, price_cents, currency)
              values (${c.agencyId}, ${newId()}, 'OWNER', ${a.agencyId}, ${newId()}, 'LISTING', ${newId()}, ${k.bp},
              ${k.fixed}, ${k.fixed === null ? null : 'EUR'}, ${k.split}, false, now(), 'OFFER', ${k.price}, 'EUR')
              returning commission_total_cents as total, introducer_share_cents as intro, owner_share_cents as own`);
            out.push(res.rows[0] as { total: string; intro: string; own: string });
          }
          throw new Error('rollback');
        })
        .catch((err: unknown) => {
          if (!(err instanceof Error && err.message === 'rollback')) throw err;
        });
      return out;
    });
    expect(got).toHaveLength(cases.length);
    cases.forEach((k, i) => {
      const want = mls.commissionOf(k.price, { commissionBp: k.bp, commissionFixedCents: k.fixed, splitBp: k.split });
      expect(
        { total: Number(got[i]?.total), intro: Number(got[i]?.intro), own: Number(got[i]?.own) },
        JSON.stringify(k),
      ).toEqual({ total: want.totalCents, intro: want.introducerShareCents, own: want.ownerShareCents });
    });
  });
});

describe('[R2-04a] stages and the handshake', () => {
  it('[R2-04a] stages move forward only; a price change clears the handshake; both confirmations complete the deal', async () => {
    const vr = await viewing(pctListing);
    const { deal } = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(60_000_000) }));
    const id = deal.id;
    expect((await as(b, (ctx) => mls.advanceDeal(ctx, id, { stage: 'ARRAS' }))).stage).toBe('ARRAS');
    expect(await refusal(as(a, (ctx) => mls.advanceDeal(ctx, id, { stage: 'RESERVATION' })))).toBe(
      'DEAL_STATE:backwards',
    );
    // the guard refuses it too, for a party's direct write
    expect(
      await sqlState(
        withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) =>
          tx.execute(sql`update deals set stage = 'OFFER' where agency_id = ${a.agencyId} and id = ${id}`),
        ),
      ),
    ).toBe('23514');
    // a party confirms only its own side, as itself
    expect(
      await sqlState(
        withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) =>
          tx.execute(sql`update deals set owner_confirmed_at = now(), owner_confirmed_by = ${a.userId}
            where agency_id = ${a.agencyId} and id = ${id}`),
        ),
      ),
    ).toBe('42501');
    // nor completes it alone
    expect(
      await sqlState(
        withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) =>
          tx.execute(sql`update deals set stage = 'COMPLETION', completed_at = now()
            where agency_id = ${a.agencyId} and id = ${id}`),
        ),
      ),
    ).toBe('23514');

    const confirmed = await as(a, (ctx) => mls.confirmDeal(ctx, id, { price: eur(60_000_000) }));
    expect(confirmed.introducerConfirmedAt).not.toBeNull();
    expect(confirmed.allowedActions).toContain('WITHDRAW');
    expect((await as(b, (ctx) => mls.getDeal(ctx, id))).introducerConfirmedAt).toBe(confirmed.introducerConfirmedAt);

    // the owner changes the price: the introducer's confirmation is gone, the commission follows
    const repriced = await as(b, (ctx) => mls.setDealPrice(ctx, id, { price: eur(59_500_000) }));
    expect(repriced).toMatchObject({ introducerConfirmedAt: null, ownerConfirmedAt: null });
    expect(repriced.commission.totalCents).toBe(2_082_500);
    expect(await refusal(as(a, (ctx) => mls.confirmDeal(ctx, id, { price: eur(60_000_000) })))).toBe(
      'DEAL_STATE:price_changed',
    );

    await as(a, (ctx) => mls.confirmDeal(ctx, id, { price: eur(59_500_000) }));
    const done = await as(b, (ctx) => mls.confirmDeal(ctx, id, { price: eur(59_500_000) }));
    // R2-04c: a closed deal takes one move from a binding member: a dispute
    expect(done).toMatchObject({ stage: 'COMPLETION', allowedActions: ['DISPUTE'] });
    expect(done.completedAt).not.toBeNull();
    for (const r of await copies(id)) {
      expect(r).toMatchObject({ stage: 'COMPLETION', commission_total_cents: '2082500' });
      expect(r.completed_at).not.toBeNull();
    }
    const audit = await rows<{ type: string; agency_id: string }>(
      sql`select type, agency_id from audit_logs where target_id = ${id} and type like 'mls.deal.%' order by type`,
    );
    expect(audit.map((r) => r.type)).toEqual(
      expect.arrayContaining(['mls.deal.completed', 'mls.deal.confirmed', 'mls.deal.priceChanged']),
    );
  });

  it('[R2-04a] either party closes an open deal as fallen through; a new deal of the viewing may follow', async () => {
    const vr = await viewing(pctListing);
    const { deal } = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(60_000_000) }));
    // any member may close it (an AGENT role here)
    const closed = await asAgent(b, b.userId, (ctx) =>
      mls.fallThroughDeal(ctx, deal.id, { reason: 'Mortgage refused' }),
    );
    expect(closed).toMatchObject({ stage: 'FELL_THROUGH', closedBy: 'OWNER', fellThroughReason: 'Mortgage refused' });
    expect(await refusal(as(a, (ctx) => mls.advanceDeal(ctx, deal.id, { stage: 'ARRAS' })))).toBe('DEAL_STATE:closed');
    const second = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(55_000_000) }));
    expect(second.created).toBe(true);
    expect(second.deal.id).not.toBe(deal.id);
  });
});

describe('[R2-04a] completed deals are immutable except via audited staff mediation', () => {
  it('[R2-04a] no party and no system role changes a completed deal; staff mediation does, audited for both agencies', async () => {
    const vr = await viewing(pctListing);
    const { deal } = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(40_000_000) }));
    await as(a, (ctx) => mls.confirmDeal(ctx, deal.id, { price: eur(40_000_000) }));
    await as(b, (ctx) => mls.confirmDeal(ctx, deal.id, { price: eur(40_000_000) }));

    // the services refuse every move
    expect(await refusal(as(a, (ctx) => mls.setDealPrice(ctx, deal.id, { price: eur(1) })))).toBe('DEAL_STATE:closed');
    expect(await refusal(as(b, (ctx) => mls.withdrawDealConfirmation(ctx, deal.id)))).toBe('DEAL_STATE:closed');
    expect(await refusal(as(b, (ctx) => mls.fallThroughDeal(ctx, deal.id, { reason: 'x' })))).toBe('DEAL_STATE:closed');
    // and the database refuses it to a party, a worker, or a delete
    for (const agencyId of [a.agencyId, b.agencyId]) {
      const userId = agencyId === a.agencyId ? a.userId : b.userId;
      expect(
        await sqlState(
          withTenant({ agencyId, userId }, (tx) =>
            tx.execute(sql`update deals set price_cents = 1 where agency_id = ${agencyId} and id = ${deal.id}`),
          ),
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          withTenant({ agencyId, userId }, (tx) =>
            tx.execute(sql`delete from deals where agency_id = ${agencyId} and id = ${deal.id}`),
          ),
        ),
      ).toBe('42501');
    }
    expect(
      await sqlState(system((tx) => tx.execute(sql`update deals set price_cents = 1 where id = ${deal.id}`))),
    ).toBe('23514');
    expect((await copies(deal.id)).every((r) => r.price_cents === '40000000')).toBe(true);

    // support staff read it, may not mediate; data ops mediate with a reason
    const seen = await asStaff(support, (ctx) => mls.getStaffDeal(ctx, deal.id));
    expect(seen).toMatchObject({
      ownerAgency: { id: b.agencyId },
      introducerAgency: { id: a.agencyId },
      stage: 'COMPLETION',
    });
    expect(
      await refusal(asStaff(support, (ctx) => mls.mediateDeal(ctx, deal.id, { reason: 'x', price: eur(39_000_000) }))),
    ).toBe('FORBIDDEN');
    const mediated = await asStaff(dataOps, (ctx) =>
      mls.mediateDeal(ctx, deal.id, { reason: 'Notary deed shows 390,000 €', price: eur(39_000_000) }),
    );
    expect(mediated).toMatchObject({
      stage: 'COMPLETION',
      price: eur(39_000_000),
      mediationReason: 'Notary deed shows 390,000 €',
      commission: { totalCents: 1_365_000, introducerShareCents: 819_000, ownerShareCents: 546_000 },
    });
    for (const r of await copies(deal.id)) {
      expect(r).toMatchObject({
        stage: 'COMPLETION',
        price_cents: '39000000',
        commission_total_cents: '1365000',
        mediation_reason: 'Notary deed shows 390,000 €',
      });
    }
    // the parties see the mediation; still immutable for them
    expect((await as(a, (ctx) => mls.getDeal(ctx, deal.id))).mediationReason).toBe('Notary deed shows 390,000 €');
    expect(await refusal(as(a, (ctx) => mls.setDealPrice(ctx, deal.id, { price: eur(1) })))).toBe('DEAL_STATE:closed');

    const audit = await rows<{ agency_id: string; actor_kind: string; actor_user_id: string }>(
      sql`select agency_id, actor_kind, actor_user_id from audit_logs
        where type = 'staff.mls.dealMediated' and target_id = ${deal.id} order by agency_id`,
    );
    expect(audit.map((r) => r.agency_id).sort()).toEqual([a.agencyId, b.agencyId].sort());
    expect(audit.every((r) => r.actor_kind === 'staff' && r.actor_user_id === dataOps)).toBe(true);

    // staff reopen it: the handshake starts again
    const reopened = await asStaff(dataOps, (ctx) =>
      mls.mediateDeal(ctx, deal.id, { reason: 'Completion contested', stage: 'ARRAS' }),
    );
    expect(reopened).toMatchObject({
      stage: 'ARRAS',
      completedAt: null,
      ownerConfirmedAt: null,
      introducerConfirmedAt: null,
    });
    expect((await as(b, (ctx) => mls.getDeal(ctx, deal.id))).allowedActions).toContain('CONFIRM');
  });

  it('[R2-04a] a reopened fall-through needs a new handshake; a party never mediates nor writes the peer’s copy', async () => {
    const vr = await viewing(pctListing);
    const { deal } = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(30_000_000) }));
    await as(a, (ctx) => mls.confirmDeal(ctx, deal.id, { price: eur(30_000_000) }));
    // a party writing a mediation, or the other agency's copy, directly
    expect(
      await sqlState(
        withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) =>
          tx.execute(sql`update deals set mediation_reason = 'x', mediated_by = ${a.userId}, mediated_at = now()
            where agency_id = ${a.agencyId} and id = ${deal.id}`),
        ),
      ),
    ).toBe('42501');
    const peerWrite = await withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) =>
      tx.execute(sql`update deals set price_cents = 1 where agency_id = ${b.agencyId} and id = ${deal.id}`),
    );
    expect(peerWrite.rowCount).toBe(0);
    // a backdated stage time or confirmation is overwritten by the database's clock
    await withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) =>
      tx.execute(sql`update deals set stage_at = '2001-01-01', introducer_confirmed_at = '2001-01-01'
        where agency_id = ${a.agencyId} and id = ${deal.id}`),
    );
    const [stamped] = await rows<{ stage_at: string; introducer_confirmed_at: string }>(
      sql`select stage_at, introducer_confirmed_at from deals where agency_id = ${b.agencyId} and id = ${deal.id}`,
    );
    expect(new Date(stamped?.stage_at ?? 0).getUTCFullYear()).toBeGreaterThan(2001);
    expect(new Date(stamped?.introducer_confirmed_at ?? 0).getUTCFullYear()).toBeGreaterThan(2001);

    await as(b, (ctx) => mls.fallThroughDeal(ctx, deal.id, { reason: 'Buyer withdrew' }));
    const reopened = await asStaff(dataOps, (ctx) =>
      mls.mediateDeal(ctx, deal.id, { reason: 'Buyer came back', stage: 'ARRAS' }),
    );
    expect(reopened).toMatchObject({
      stage: 'ARRAS',
      fellThroughAt: null,
      closedBy: null,
      introducerConfirmedAt: null,
      ownerConfirmedAt: null,
    });
    // the owner's confirmation alone does not complete it (the introducer's earlier one is gone)
    expect((await as(b, (ctx) => mls.confirmDeal(ctx, deal.id, { price: eur(30_000_000) }))).stage).toBe('ARRAS');
  });

  it('[R2-04a] staff impersonating a member never open or confirm a deal in the agency’s name', async () => {
    const vr = await viewing(pctListing);
    const staffId = newId();
    expect(
      await refusal(
        as(a, async (ctx) =>
          mls.openDeal(await impersonatedCtx(ctx, staffId), { viewingRequestId: vr, price: eur(30_000_000) }),
        ),
      ),
    ).toBe('FORBIDDEN');
    const { deal } = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(30_000_000) }));
    expect(
      await refusal(
        as(b, async (ctx) => mls.confirmDeal(await impersonatedCtx(ctx, staffId), deal.id, { price: eur(30_000_000) })),
      ),
    ).toBe('FORBIDDEN');
    // reading is allowed
    expect((await as(b, async (ctx) => mls.getDeal(await impersonatedCtx(ctx, staffId), deal.id))).id).toBe(deal.id);
  });
});

describe('[R2-04c] disputes → staff mediation', () => {
  const dealEvents = (dealId: string, action: string) =>
    rows<{ agency_id: string; payload: { by: string } }>(
      sql`select agency_id, payload from outbox_events
        where type = 'mls.deal.changed' and payload->>'dealId' = ${dealId} and payload->>'action' = ${action}`,
    );

  it('[R2-04c] a party raises a dispute, also on a completed deal; one open per agency; only its agency reads it', async () => {
    const vr = await viewing(pctListing);
    const { deal } = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(41_000_000) }));
    await as(a, (ctx) => mls.confirmDeal(ctx, deal.id, { price: eur(41_000_000) }));
    await as(b, (ctx) => mls.confirmDeal(ctx, deal.id, { price: eur(41_000_000) }));

    const opened = await as(a, (ctx) =>
      mls.openDealDispute(ctx, deal.id, { reason: 'Commission share paid short by 2,000 EUR' }),
    );
    expect(opened).toMatchObject({ dealId: deal.id, status: 'OPEN', resolutionNote: null });
    expect(await refusal(as(a, (ctx) => mls.openDealDispute(ctx, deal.id, { reason: 'again' })))).toBe(
      'DEAL_DISPUTE_STATE:open',
    );
    // the owner may raise its own; a stranger has no deal to dispute
    await as(b, (ctx) => mls.openDealDispute(ctx, deal.id, { reason: 'Paid in full' }));
    expect(await refusal(as(c, (ctx) => mls.openDealDispute(ctx, deal.id, { reason: 'x' })))).toBe('DEAL_NOT_FOUND');

    // each party lists its own dispute only (RLS): the other party never reads the text
    const mine = await as(a, (ctx) => mls.listDealDisputes(ctx, deal.id));
    expect(mine.items.map((d) => d.reason)).toEqual(['Commission share paid short by 2,000 EUR']);
    const theirs = await as(b, (ctx) => mls.listDealDisputes(ctx, deal.id));
    expect(theirs.items.map((d) => d.reason)).toEqual(['Paid in full']);
    const direct = await withTenant({ agencyId: b.agencyId, userId: b.userId }, (tx) =>
      tx.execute(sql`select id from deal_disputes where id = ${opened.id}`),
    );
    expect(direct.rows).toEqual([]);
    // a member never resolves a dispute
    expect(
      await sqlState(
        withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) =>
          tx.execute(sql`update deal_disputes set status = 'RESOLVED' where id = ${opened.id}`),
        ),
      ),
    ).toBe('42501');

    // the other party is told one was raised (by the raising side), audited without the text
    expect((await dealEvents(deal.id, 'DISPUTED')).map((e) => [e.agency_id, e.payload.by]).sort()).toEqual(
      [
        [a.agencyId, 'INTRODUCER'],
        [b.agencyId, 'OWNER'],
      ].sort(),
    );
    const [audit] = await rows<{ metadata: Record<string, unknown> }>(
      sql`select metadata from audit_logs where type = 'mls.deal.disputed' and target_id = ${opened.id}`,
    );
    expect(audit?.metadata).toMatchObject({ dealId: deal.id, party: 'INTRODUCER', stage: 'COMPLETION' });
    expect(JSON.stringify(audit?.metadata)).not.toContain('2,000');

    // the notice: the raising side's event tells the other party's members (with the raising agency's name), never the text
    const [ev] = await rows<{ id: string; agency_id: string; payload: unknown; created_at: Date }>(
      sql`select id, agency_id, payload, created_at from outbox_events
        where type = 'mls.deal.changed' and payload->>'dealId' = ${deal.id} and payload->>'action' = 'DISPUTED'
          and agency_id = ${a.agencyId}`,
    );
    if (!ev) throw new Error('no DISPUTED event');
    await mls.notifyDealChange(mls.mlsEvents.dealChanged.schema.parse(ev.payload), {
      eventId: ev.id,
      agencyId: ev.agency_id,
      createdAt: new Date(ev.created_at),
    });
    const told = await rows<{ agency_id: string; params: Record<string, unknown> }>(
      sql`select agency_id, params from notifications where source_key like ${`${ev.id}:%`}`,
    );
    expect(told.map((n) => n.agency_id)).toEqual([b.agencyId]);
    expect(told[0]?.params).toMatchObject({ action: expect.stringMatching(/^(DISPUTED|UPDATED)$/) });
    expect(JSON.stringify(told)).not.toContain('2,000');
  });

  it('[R2-04c] binding members only, never impersonated; the owner side by its admins or the listing agent', async () => {
    const vr = await viewing(pctListing);
    const { deal } = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(42_000_000) }));
    const stranger = newId();
    expect(await refusal(asAgent(b, stranger, (ctx) => mls.openDealDispute(ctx, deal.id, { reason: 'x' })))).toBe(
      'FORBIDDEN',
    );
    expect(
      await refusal(
        as(a, async (ctx) => mls.openDealDispute(await impersonatedCtx(ctx, newId()), deal.id, { reason: 'x' })),
      ),
    ).toBe('FORBIDDEN');
    // an agent who is not the listing's sees no DISPUTE among its moves; the admin does
    expect((await asAgent(b, stranger, (ctx) => mls.getDeal(ctx, deal.id))).allowedActions).toEqual([]);
    expect((await as(b, (ctx) => mls.getDeal(ctx, deal.id))).allowedActions).toContain('DISPUTE');
  });

  it('[R2-04c] staff read the queue; data ops resolve with a note the raising agency reads, audited and told', async () => {
    const vr = await viewing(fixedListing);
    const { deal } = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(50_000_000) }));
    const d = await as(a, (ctx) => mls.openDealDispute(ctx, deal.id, { reason: 'Owner stopped answering' }));

    // the queue (oldest first, every agency): ours is in it, with the raising agency and its side
    let found: Awaited<ReturnType<typeof mls.listStaffDealDisputes>>['items'][number] | undefined;
    let cursor: string | undefined;
    for (let i = 0; i < 50 && !found; i += 1) {
      const page = await asStaff(support, (ctx) =>
        mls.listStaffDealDisputes(ctx, { status: 'OPEN', limit: 100, ...(cursor ? { cursor } : {}) }),
      );
      found = page.items.find((x) => x.id === d.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(found).toMatchObject({ agency: { id: a.agencyId }, party: 'INTRODUCER', dealStage: 'OFFER' });
    const ofDeal = await asStaff(support, (ctx) => mls.listStaffDisputesOfDeal(ctx, deal.id));
    expect(ofDeal.items.map((x) => x.id)).toEqual([d.id]);

    // support reads, may not resolve; data ops resolve once
    expect(await refusal(asStaff(support, (ctx) => mls.resolveDealDispute(ctx, d.id, { note: 'x' })))).toBe(
      'FORBIDDEN',
    );
    const note = 'Spoke to both agencies; the arras is signed Monday';
    const resolved = await asStaff(dataOps, (ctx) => mls.resolveDealDispute(ctx, d.id, { note }));
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolutionNote: note });
    expect(await refusal(asStaff(dataOps, (ctx) => mls.resolveDealDispute(ctx, d.id, { note: 'again' })))).toBe(
      'DEAL_DISPUTE_STATE:resolved',
    );
    expect(await refusal(asStaff(dataOps, (ctx) => mls.resolveDealDispute(ctx, newId(), { note: 'x' })))).toBe(
      'DEAL_DISPUTE_NOT_FOUND',
    );

    const [mine] = (await as(a, (ctx) => mls.listDealDisputes(ctx, deal.id))).items;
    expect(mine).toMatchObject({ status: 'RESOLVED', resolutionNote: note });
    // a new dispute may follow a resolved one
    await as(a, (ctx) => mls.openDealDispute(ctx, deal.id, { reason: 'Still nothing' }));

    const audit = await rows<{ agency_id: string; actor_kind: string; actor_user_id: string; metadata: unknown }>(
      sql`select agency_id, actor_kind, actor_user_id, metadata from audit_logs
        where type = 'staff.mls.dealDisputeResolved' and target_id = ${d.id}`,
    );
    expect(audit).toEqual([
      expect.objectContaining({ agency_id: a.agencyId, actor_kind: 'staff', actor_user_id: dataOps }),
    ]);
    expect(JSON.stringify(audit[0]?.metadata)).not.toContain('arras');
    expect((await dealEvents(deal.id, 'DISPUTE_RESOLVED')).map((e) => [e.agency_id, e.payload.by])).toEqual([
      [a.agencyId, 'STAFF'],
    ]);
  });

  it('[R2-04c] the database stamps a dispute’s creation, moves it OPEN → RESOLVED only, and staff resolve as themselves', async () => {
    const vr = await viewing(pctListing);
    const { deal } = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(43_000_000) }));
    const id = newId();
    await withTenant({ agencyId: a.agencyId, userId: a.userId }, (tx) =>
      tx.execute(sql`insert into deal_disputes (id, agency_id, deal_id, reason, opened_by_user_id, created_at)
        values (${id}, ${a.agencyId}, ${deal.id}, 'backdated', ${a.userId}, '2001-01-01')`),
    );
    const [row] = await rows<{ created_at: Date }>(sql`select created_at from deal_disputes where id = ${id}`);
    expect(new Date(row?.created_at ?? 0).getUTCFullYear()).toBeGreaterThan(2001);
    // staff resolving in someone else's name, or rewriting the reason
    expect(
      await sqlState(
        asStaff(dataOps, (ctx) =>
          ctx.tx.execute(sql`update deal_disputes set status = 'RESOLVED', resolved_by_user_id = ${newId()},
            resolution_note = 'x', resolved_at = now() where id = ${id}`),
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        asStaff(dataOps, (ctx) =>
          ctx.tx.execute(sql`update deal_disputes set status = 'RESOLVED', resolved_by_user_id = ${dataOps},
            resolution_note = 'x', resolved_at = now(), reason = 'rewritten' where id = ${id}`),
        ),
      ),
    ).toBe('42501'); // staff hold no grant on the reason at all
    await asStaff(dataOps, (ctx) => mls.resolveDealDispute(ctx, id, { note: 'done' }));
    // a resolved dispute never reopens, not even for a worker
    expect(
      await sqlState(
        system((tx) =>
          tx.execute(sql`update deal_disputes set status = 'OPEN', resolved_by_user_id = null, resolution_note = null,
            resolved_at = null where id = ${id}`),
        ),
      ),
    ).toBe('23514');

    // agency erasure blanks the texts and keeps the rows
    const erased = await mls.eraseAgencyDealDisputes({ agencyId: a.agencyId });
    expect(erased.rows).toBeGreaterThan(0);
    const after = await rows<{ reason: string; resolution_note: string | null; status: string }>(
      sql`select reason, resolution_note, status from deal_disputes where id = ${id}`,
    );
    expect(after).toEqual([
      { reason: mls.ERASED_DISPUTE_TEXT, resolution_note: mls.ERASED_DISPUTE_TEXT, status: 'RESOLVED' },
    ]);
    let more = erased.more;
    while (more) more = (await mls.eraseAgencyDealDisputes({ agencyId: a.agencyId })).more;
    expect((await mls.eraseAgencyDealDisputes({ agencyId: a.agencyId })).rows).toBe(0);
  });
});

describe('[R2-05a] the deal’s collaboration agreement', () => {
  it('[R2-05a] a party makes it from the deal as the database keeps it; strangers, flag-off agencies and fallen-through deals cannot', async () => {
    await withSystem('mls.deals.test', async (tx) => {
      await setFlag(tx, documents.FORMS_FLAG, { enabled: false });
      await setFlagOverride(tx, documents.FORMS_FLAG, a.agencyId, true);
    });
    invalidateFlags();
    try {
      const vr = await viewing(pctListing);
      const { deal } = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(58_000_001) }));
      const { form, replayed } = await as(a, (ctx) =>
        mls.createDealCollaborationAgreement(ctx, deal.id, { locale: 'en' }),
      );
      expect(replayed).toBe(false);
      expect(form).toMatchObject({ template: 'COLLABORATION_AGREEMENT', dealId: deal.id, status: 'PENDING' });
      const [row] = await rows<{ data: unknown }>(sql`select data from form_documents where id = ${form.id}`);
      expect(documents.FormData.parse(row?.data)).toMatchObject({
        template: 'COLLABORATION_AGREEMENT',
        dealId: deal.id,
        party: 'INTRODUCER',
        price: eur(58_000_001),
        terms: { commissionBp: 350, commissionFixed: null, splitBp: 6000, includesVat: true },
        commission: { totalCents: 2_030_000, introducerShareCents: 1_218_000, ownerShareCents: 812_000 },
      });
      const html = (await documents.formDocumentHtml(form.id))?.html ?? '';
      for (const amount of ['€580,000.01', '€20,300.00', '€12,180.00', '€8,120.00']) expect(html).toContain(amount);

      expect(await refusal(as(c, (ctx) => mls.createDealCollaborationAgreement(ctx, deal.id, {})))).toBe(
        'DEAL_NOT_FOUND',
      );
      expect(await refusal(as(b, (ctx) => mls.createDealCollaborationAgreement(ctx, deal.id, {})))).toBe(
        'FORMS_NOT_ENABLED',
      );
      await as(a, (ctx) => mls.fallThroughDeal(ctx, deal.id, { reason: 'Mortgage refused' }));
      expect(await refusal(as(a, (ctx) => mls.createDealCollaborationAgreement(ctx, deal.id, {})))).toBe('DEAL_STATE');
    } finally {
      await withSystem('mls.deals.test', async (tx) => {
        await tx.execute(sql`delete from form_documents where agency_id = ${a.agencyId}`);
        await setFlagOverride(tx, documents.FORMS_FLAG, a.agencyId, null);
      });
      invalidateFlags();
    }
  });
});

describe('[R2-05c] the deal’s collaboration agreement signers', () => {
  it('[R2-05c] each party’s deal members are the only signers the deal’s signature request takes; strangers read none', async () => {
    await withSystem('mls.deals.test', async (tx) => {
      for (const f of [documents.FORMS_FLAG, documents.ESIGN_FLAG]) {
        await setFlag(tx, f, { enabled: false });
        // c (a stranger to the deal) has the flags on too: what it is refused is the deal
        for (const m of [a, c]) await setFlagOverride(tx, f, m.agencyId, true);
      }
    });
    invalidateFlags();
    configureESign(fakeESign());
    try {
      const vr = await viewing(pctListing);
      const { deal } = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: vr, price: eur(41_000_000) }));
      // the introducer's member who asked for the viewing; the owner's listing agent (each its founder here)
      const signers = await as(a, (ctx) => mls.dealSigners(ctx, deal.id));
      expect(signers.ownRole).toBe('introducerAgency');
      expect(signers.own[0]).toMatchObject({ userId: a.userId, email: a.email, dealMember: true });
      // the other agency's member is named, its login address masked
      expect(signers.counterpart[0]).toMatchObject({
        userId: b.userId,
        email: mls.maskEmail(b.email),
        dealMember: true,
      });
      expect(signers.counterpart[0]?.email).toMatch(/^.\*\*\*@example\.com$/);
      expect(signers.counterpart.map((s) => s.userId)).not.toContain(a.userId);
      // a stranger reads nothing: neither through the service nor the definer itself
      expect(await refusal(as(c, (ctx) => mls.dealSigners(ctx, deal.id)))).toBe('DEAL_NOT_FOUND');
      const direct = await as(
        c,
        async (ctx) => (await ctx.tx.execute(sql`select * from deal_signers(${deal.id}::uuid)`)).rows,
      );
      expect(direct).toEqual([]);
      // b's flags are off
      expect(await refusal(as(b, (ctx) => mls.dealSigners(ctx, deal.id)))).toBe('FORMS_NOT_ENABLED');

      const { form } = await as(a, (ctx) => mls.createDealCollaborationAgreement(ctx, deal.id, { locale: 'en' }));
      await system((tx) =>
        tx.execute(sql`update form_documents set status = 'READY', sha256 = ${'a'.repeat(64)}, size_bytes = 1000,
                         rendered_at = now() where id = ${form.id}`),
      );
      const ask = (counterpartUserId: string, formId = form.id) =>
        as(a, (ctx) =>
          mls.createDealSignatureRequest(ctx, deal.id, { formId, ownUserId: a.userId, counterpartUserId }),
        );
      // the requester cannot name a stranger as the other agency's signatory, nor its own agency's member there
      expect(await refusal(ask(c.userId))).toBe('SIGNERS_INVALID:party_member');
      expect(await refusal(ask(a.userId))).toBe('SIGNERS_INVALID:party_member');
      const { request } = await ask(b.userId);
      // names and addresses are the database's
      expect(request.signers.map((s) => [s.role, s.email])).toEqual([
        ['introducerAgency', a.email],
        ['ownerAgency', b.email],
      ]);
      // the generic forms endpoint does not take a collaboration agreement (only from its deal)
      expect(
        await refusal(
          as(a, (ctx) =>
            documents.createSignatureRequest(ctx, form.id, {
              signers: [
                { name: 'Intro', email: a.email, role: 'introducerAgency' },
                { name: 'Owner', email: b.email, role: 'ownerAgency' },
              ],
            }),
          ),
        ),
      ).toBe('SIGNERS_INVALID:deal');
      // while one agreement is out for signature, no other is made or sent (two could end up signed)
      expect(await refusal(as(a, (ctx) => mls.createDealCollaborationAgreement(ctx, deal.id, {})))).toBe(
        'AGREEMENT_IN_SIGNATURE',
      );
      const second = newId();
      await system((tx) =>
        tx.execute(sql`insert into form_documents (id, agency_id, template, locale, template_version, status, label,
                         deal_id, data, sha256, size_bytes, rendered_at, created_by_user_id)
                       select ${second}, agency_id, template, locale, template_version, 'READY', label, deal_id, data,
                              ${'b'.repeat(64)}, 1000, now(), created_by_user_id
                         from form_documents where id = ${form.id}`),
      );
      expect(await refusal(ask(b.userId, second))).toBe('AGREEMENT_IN_SIGNATURE');
      // a new request for the same agreement replaces the open one
      expect((await ask(b.userId)).request.id).not.toBe(request.id);
      // fallen through: the signers are no longer offered
      await as(a, (ctx) => mls.fallThroughDeal(ctx, deal.id, { reason: 'Buyer withdrew' }));
      expect(await refusal(as(a, (ctx) => mls.dealSigners(ctx, deal.id)))).toBe('DEAL_STATE');
    } finally {
      await withSystem('mls.deals.test', async (tx) => {
        await tx.execute(sql`delete from form_documents where agency_id = ${a.agencyId}`);
        for (const f of [documents.FORMS_FLAG, documents.ESIGN_FLAG]) {
          for (const m of [a, c]) await setFlagOverride(tx, f, m.agencyId, null);
        }
      });
      invalidateFlags();
    }
  });
});
