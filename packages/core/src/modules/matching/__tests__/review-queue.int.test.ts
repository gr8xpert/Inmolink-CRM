import {
  type CreateClientProfileBody,
  CreateContactBody,
  CreateListingBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, type Tx, withSystem, withTenant } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as crm from '../../crm';
import * as presentations from '../../presentations';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as matching from '../index';

/**
 * The review queue (R2-02d) on the real test database: the engine's PENDING_REVIEW matches listed newest first by
 * cursor (agency-wide, per contact, per profile) with card, score and explanation in the member's language; approve
 * puts the listing into a selection for the contact (an open draft reused) and sends nothing; dismiss and restore
 * emit `matching.clientProfileMatch.dismissed` in their transaction and R2-02c's job adds / takes back the dislike; a
 * listing that can no longer be offered is marked EXPIRED and left out; other agencies, partners, Client Mode and
 * impersonating staff are refused, and members cannot plant or rewrite a match in SQL.
 */

const RUN = newId().slice(-8).toLowerCase();
const L = FALLBACK_CONTENT_LOCALE;
const code = (s: string) => `${s}-rq-${RUN}`;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('matching.review.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let o: Founder;
let net: Founder;
let ids: { city: string; villa: string; pool: string };

const as = <T>(f: Founder, fn: (ctx: Ctx) => Promise<T>, locale: 'en' | 'es' = 'en') =>
  withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId(), locale }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    if (err instanceof ZodError) return 'ZOD';
    throw err;
  }
  return 'none';
}

async function member(agencyId: string, role: string): Promise<Founder> {
  const userId = newId();
  const email = `rq-${role.toLowerCase()}-${userId}@example.com`;
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${userId}, ${email}, 'x', ${role}, 'en', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${agencyId}, ${userId}, ${role}, ${role}, ${email})`);
  });
  return { userId, agencyId, email, password: 'x' };
}

/** An ACTIVE listing of `f` in the city, shared to ALL, with a pool; its read model built and matched. */
async function listing(f: Founder, body: Partial<CreateListingBody> = {}): Promise<string> {
  const version = async (id: string) => (await as(f, (ctx) => properties.getListing(ctx, id))).version;
  const { id } = await as(f, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 50_000_000,
        bedrooms: 4,
        energyRating: 'B',
        commission: { type: 'PCT', basisPoints: 500, includesVat: false },
        splitBp: 5000,
        ...body,
      }),
    ),
  );
  await as(f, async (ctx) =>
    properties.setListingFeatures(ctx, id, { featureIds: [ids.pool], version: await version(id) } as never),
  );
  await as(f, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope: 'ALL',
        version: await version(id),
      }),
    ),
  );
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  await matching.matchListingsToProfiles({ agencyId: f.agencyId, listingIds: [id] });
  return id;
}

/** The listing becomes PRIVATE (its read model goes): no agency may offer it any more. */
async function hide(f: Founder, id: string): Promise<void> {
  const { version } = await as(f, (ctx) => properties.getListing(ctx, id));
  await as(f, (ctx) => properties.updateListing(ctx, id, UpdateListingBody.parse({ visibility: 'PRIVATE', version })));
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
}

const contact = async (f: Founder, firstName = `Buyer ${newId().slice(-6)}`) =>
  (await as(f, (ctx) => crm.createContact(ctx, CreateContactBody.parse({ firstName, language: 'es' })))).contact.id;

async function profile(f: Founder, contactId: string, extra: Partial<CreateClientProfileBody> = {}): Promise<string> {
  return (
    await as(f, (ctx) =>
      matching.createClientProfile(ctx, contactId, {
        mode: 'REVIEW',
        frequency: 'DAILY',
        transactionType: 'SALE',
        propertyTypeIds: [ids.villa],
        locationIds: [ids.city],
        priceMaxCents: 90_000_000,
        ...extra,
      }),
    )
  ).id;
}

const matchOf = async (profileId: string, listingId: string) =>
  (
    await rows<{ id: string; status: string; selection_id: string | null; updated_at: Date }>(
      sql`select id, status, selection_id, updated_at from client_profile_matches
           where profile_id = ${profileId} and listing_id = ${listingId}`,
    )
  )[0] as { id: string; status: string; selection_id: string | null; updated_at: Date };

const dismissEvents = (matchId: string) =>
  rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
    where type = 'matching.clientProfileMatch.dismissed' and payload->>'matchId' = ${matchId}`).then(
    (r) => r[0]?.n ?? 0,
  );

const feedbackOf = (profileId: string) =>
  rows<{ listing_id: string; signal: string }>(
    sql`select listing_id, signal from client_profile_feedback where profile_id = ${profileId}`,
  );

beforeAll(async () => {
  await setupTestDb('worker');
  presentations.configurePresentations({
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
    publicBaseUrl: 'https://sites.example',
  });
  [o, net] = await Promise.all([createFounder(), createFounder()]);
  for (const f of [o, net]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (x: string) => [{ locale: L, name: `${x} ${RUN}`, slug: code(x.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: name('Queueland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: name('Queueshire'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: name('Queueton'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: code('g'), sort: 0, translations: name('Homes') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('villa'),
      sort: 0,
      translations: name('Villa'),
    });
    const fg = await taxonomy.createFeatureGroup(tx, { key: code('fg'), sort: 0, translations: name('Outdoor') });
    const pool = await taxonomy.createFeature(tx, {
      groupId: fg,
      key: code('pool'),
      sort: 0,
      icon: 'pool',
      translations: name('Pool'),
    });
    return { city, villa, pool };
  });
}, 240_000);

afterAll(async () => {
  await closeDb();
});

describe('review queue (R2-02d)', () => {
  it('[R2-02d] the queue pages newest first by cursor (agency, contact, profile) with card, score and explanation; ≤ 10 statements', async () => {
    const c = await contact(o, 'Ana');
    const P = await profile(o, c);
    const other = await profile(o, await contact(o)); // another contact's profile, matched by the same listings
    const A = await listing(o);
    const B = await listing(o, { priceCents: 95_000_000 }); // 6% over budget: still a match, "over budget" explained
    const C = await listing(net); // a network listing shared with o
    for (const l of [A, B, C]) expect((await matchOf(P, l))?.status).toBe('PENDING_REVIEW');

    const first = await as(o, (ctx) => matching.listClientProfileMatches(ctx, { profileId: P, limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await as(o, (ctx) =>
      matching.listClientProfileMatches(ctx, { profileId: P, limit: 2, cursor: first.nextCursor ?? undefined }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((m) => m.card.id))).toEqual(new Set([A, B, C]));
    // newest first
    const created = all.map((m) => m.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    const b = all.find((m) => m.card.id === B);
    expect(b).toMatchObject({
      profileId: P,
      contact: { id: c, firstName: 'Ana' },
      status: 'PENDING_REVIEW',
      network: false,
    });
    expect(b?.score).toBeGreaterThanOrEqual(matching.MATCH_MIN_TOTAL);
    expect(b?.explanation.reasons).toEqual(
      expect.arrayContaining([
        { key: 'price', ok: false, text: '6% over budget' },
        { key: 'location', ok: true, text: 'In a wanted area' },
      ]),
    );
    expect(b?.card).not.toHaveProperty('portalText');
    expect(all.find((m) => m.card.id === C)?.network).toBe(true);
    // the member's language
    const es = await as(o, (ctx) => matching.listClientProfileMatches(ctx, { profileId: P, limit: 100 }), 'es');
    expect(es.items.find((m) => m.card.id === B)?.explanation.reasons).toContainEqual({
      key: 'price',
      ok: false,
      text: '6 % por encima del presupuesto',
    });
    // per contact and agency-wide hold the same matches; another contact's profile is not in the contact's view
    expect((await matchOf(other, A))?.status).toBe('PENDING_REVIEW');
    const byContact = await as(o, (ctx) => matching.listClientProfileMatches(ctx, { contactId: c, limit: 100 }));
    expect(byContact.items.map((m) => m.profileId).every((p) => p === P)).toBe(true);
    expect(byContact.items).toHaveLength(3);
    const agency = await as(o, (ctx) => matching.listClientProfileMatches(ctx, { limit: 100 }));
    expect(agency.items.map((m) => m.profileId)).toEqual(expect.arrayContaining([P, other]));
    // the query budget (dashboard list: ≤ 10, no N+1)
    for (const q of [{ limit: 100 }, { contactId: c, limit: 100 }, { profileId: P, limit: 100 }]) {
      const n = await as(o, (ctx) => countQueries(() => matching.listClientProfileMatches(ctx, q)));
      expect(n).toBeLessThanOrEqual(6);
    }
    expect(await refusal(as(o, (ctx) => matching.listClientProfileMatches(ctx, { contactId: c, profileId: P })))).toBe(
      'ZOD',
    );
  });

  it('[R2-02d] approve adds the listing to a selection for the contact (an open draft reused) and sends nothing', async () => {
    const c = await contact(o);
    const P = await profile(o, c);
    const [A, B, D] = [await listing(o), await listing(o), await listing(o)];
    const since = new Date();
    const ma = await matchOf(P, A);
    const first = await as(o, (ctx) => matching.approveClientProfileMatch(ctx, ma.id));
    expect(first).toMatchObject({ id: ma.id, status: 'APPROVED', selectionId: expect.any(String) });
    expect(await matchOf(P, A)).toMatchObject({ status: 'APPROVED', selection_id: first.selectionId });
    const sel = await as(o, (ctx) => presentations.getSelection(ctx, first.selectionId as string));
    // in the client's language (the contact's `es`), for the contact, with the listing; never viewed
    expect(sel).toMatchObject({
      contactId: c,
      locale: 'es',
      title: 'Inmuebles seleccionados para usted',
      status: 'LIVE',
    });
    expect(sel.items.map((i) => i.targetId)).toEqual([A]);
    // approving again is refused (no longer pending)
    expect(await refusal(as(o, (ctx) => matching.approveClientProfileMatch(ctx, ma.id)))).toBe(
      'CLIENT_PROFILE_MATCH_STATE',
    );
    // the next approval goes into the same draft
    const second = await as(o, async (ctx) => matching.approveClientProfileMatch(ctx, (await matchOf(P, B)).id));
    expect(second.selectionId).toBe(first.selectionId);
    expect(
      (await as(o, (ctx) => presentations.getSelection(ctx, first.selectionId as string))).items.map((i) => i.targetId),
    ).toEqual([A, B]);
    // once the client has opened it, it is no longer a draft: a new selection
    await rows(sql`insert into selection_interactions (id, agency_id, selection_id, kind)
                    values (${newId()}, ${o.agencyId}, ${first.selectionId}, 'VIEW')`);
    const third = await as(o, async (ctx) => matching.approveClientProfileMatch(ctx, (await matchOf(P, D)).id));
    expect(third.selectionId).not.toBe(first.selectionId);
    // within the dashboard budget
    const [F] = [await listing(o)];
    const counted = await as(o, async (ctx) => {
      const mf = await matchOf(P, F);
      return countQueries(() => matching.approveClientProfileMatch(ctx, mf.id));
    });
    expect(counted).toBeLessThanOrEqual(10);
    // nothing was sent: no e-mail, notification or message was queued by the approvals
    const sent = await rows<{ type: string }>(sql`select type from outbox_events
      where agency_id = ${o.agencyId} and created_at >= ${since}
        and (type like 'notifications.%' or type like 'email.%' or type like '%.sent' or type like 'presentations.%')`);
    expect(sent).toEqual([]);
  });

  it('[R2-02d] two approvals for one contact at once end in one draft holding both listings', async () => {
    const c = await contact(o);
    const P = await profile(o, c);
    const [A, B] = [await listing(o), await listing(o)];
    const [ma, mb] = [await matchOf(P, A), await matchOf(P, B)];
    const [ra, rb] = await Promise.all([
      as(o, (ctx) => matching.approveClientProfileMatch(ctx, ma.id)),
      as(o, (ctx) => matching.approveClientProfileMatch(ctx, mb.id)),
    ]);
    expect(ra.selectionId).toBe(rb.selectionId);
    const sel = await as(o, (ctx) => presentations.getSelection(ctx, ra.selectionId as string));
    expect(sel.items.map((i) => i.targetId).sort()).toEqual([A, B].sort());
  });

  it('[R2-02d] dismiss emits the event in its transaction and the dislike lands (R2-02c job)', async () => {
    const P = await profile(o, await contact(o));
    const A = await listing(o);
    const m = await matchOf(P, A);
    const moved = await as(o, (ctx) => matching.dismissClientProfileMatch(ctx, m.id));
    expect(moved).toEqual({ id: m.id, status: 'DISMISSED', selectionId: null });
    const after = await matchOf(P, A);
    expect(after.status).toBe('DISMISSED');
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(m.updated_at).getTime());
    expect(await dismissEvents(m.id)).toBe(1);
    // a rolled-back dismissal emits nothing
    const B = await listing(o);
    const mb = await matchOf(P, B);
    await expect(
      as(o, async (ctx) => {
        await matching.dismissClientProfileMatch(ctx, mb.id);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await matchOf(P, B)).status).toBe('PENDING_REVIEW');
    expect(await dismissEvents(mb.id)).toBe(0);
    // the feedback job (R2-02c) records the dislike
    expect(await matching.recordDismissalFeedback({ agencyId: o.agencyId, matchId: m.id })).toEqual({ profiles: 1 });
    expect(await feedbackOf(P)).toEqual([{ listing_id: A, signal: 'DISLIKE' }]);
    // dismissed: in the dismissed view, not the pending one; approve / dismiss refused
    const pending = await as(o, (ctx) => matching.listClientProfileMatches(ctx, { profileId: P }));
    expect(pending.items.map((i) => i.id)).toEqual([mb.id]);
    const dismissed = await as(o, (ctx) =>
      matching.listClientProfileMatches(ctx, { profileId: P, status: 'DISMISSED' }),
    );
    expect(dismissed.items.map((i) => i.id)).toEqual([m.id]);
    for (const move of [matching.approveClientProfileMatch, matching.dismissClientProfileMatch]) {
      expect(await refusal(as(o, (ctx) => move(ctx, m.id)))).toBe('CLIENT_PROFILE_MATCH_STATE');
    }
  });

  it('[R2-02d] restore puts a dismissed match back in the queue, emits the event and the dislike is taken back', async () => {
    const P = await profile(o, await contact(o));
    const A = await listing(o);
    const m = await matchOf(P, A);
    await as(o, (ctx) => matching.dismissClientProfileMatch(ctx, m.id));
    await matching.recordDismissalFeedback({ agencyId: o.agencyId, matchId: m.id });
    expect(await feedbackOf(P)).toHaveLength(1);
    expect(await refusal(as(o, (ctx) => matching.restoreClientProfileMatch(ctx, newId())))).toBe(
      'CLIENT_PROFILE_MATCH_NOT_FOUND',
    );
    expect(await as(o, (ctx) => matching.restoreClientProfileMatch(ctx, m.id))).toEqual({
      id: m.id,
      status: 'PENDING_REVIEW',
      selectionId: null,
    });
    expect(await dismissEvents(m.id)).toBe(2);
    expect(await matching.recordDismissalFeedback({ agencyId: o.agencyId, matchId: m.id })).toEqual({ profiles: 1 });
    expect(await feedbackOf(P)).toEqual([]);
    expect(await refusal(as(o, (ctx) => matching.restoreClientProfileMatch(ctx, m.id)))).toBe(
      'CLIENT_PROFILE_MATCH_STATE',
    );
    // a dismissed match whose listing can no longer be offered stays dismissed (and out of the list)
    await as(o, (ctx) => matching.dismissClientProfileMatch(ctx, m.id));
    await hide(o, A);
    expect(await refusal(as(o, (ctx) => matching.restoreClientProfileMatch(ctx, m.id)))).toBe(
      'CLIENT_PROFILE_MATCH_EXPIRED',
    );
    expect((await matchOf(P, A)).status).toBe('DISMISSED');
    const dismissed = await as(o, (ctx) =>
      matching.listClientProfileMatches(ctx, { profileId: P, status: 'DISMISSED' }),
    );
    expect(dismissed.items).toEqual([]);
  });

  it('[R2-02d] a listing that can no longer be offered is left out; an own one is marked EXPIRED (list and approve)', async () => {
    const P = await profile(o, await contact(o));
    const [A, B, E] = [await listing(o), await listing(o), await listing(o)];
    const N = await listing(net);
    await hide(o, A);
    // the list leaves it out and expires it, within the query budget
    const n = await as(o, (ctx) =>
      countQueries(async () => {
        const page = await matching.listClientProfileMatches(ctx, { profileId: P, limit: 100 });
        expect(page.items.map((i) => i.card.id).sort()).toEqual([B, E, N].sort());
      }),
    );
    expect(n).toBeLessThanOrEqual(7);
    expect((await matchOf(P, A)).status).toBe('EXPIRED');
    // approving an own listing withdrawn since: the match is closed instead
    await hide(o, E);
    const me = await matchOf(P, E);
    expect(await as(o, (ctx) => matching.approveClientProfileMatch(ctx, me.id))).toEqual({
      id: me.id,
      status: 'EXPIRED',
      selectionId: null,
    });
    expect((await matchOf(P, E)).status).toBe('EXPIRED');
    expect(await refusal(as(o, (ctx) => matching.dismissClientProfileMatch(ctx, me.id)))).toBe(
      'CLIENT_PROFILE_MATCH_STATE',
    );
    // the network owner stops sharing: left out and refused, but not closed (it may share again)
    const { version } = await as(net, (ctx) => properties.getListing(ctx, N));
    await as(net, (ctx) =>
      properties.updateListing(ctx, N, UpdateListingBody.parse({ shareScope: 'PREFERRED', version })),
    );
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', [N]));
    const mn = await matchOf(P, N);
    const page = await as(o, (ctx) => matching.listClientProfileMatches(ctx, { profileId: P, limit: 100 }));
    expect(page.items.map((i) => i.card.id)).toEqual([B]);
    expect(await refusal(as(o, (ctx) => matching.approveClientProfileMatch(ctx, mn.id)))).toBe(
      'CLIENT_PROFILE_MATCH_EXPIRED',
    );
    expect((await matchOf(P, N)).status).toBe('PENDING_REVIEW');
    // shared again: back in the queue
    const again = (await as(net, (ctx) => properties.getListing(ctx, N))).version;
    await as(net, (ctx) =>
      properties.updateListing(ctx, N, UpdateListingBody.parse({ shareScope: 'ALL', version: again })),
    );
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', [N]));
    const back = await as(o, (ctx) => matching.listClientProfileMatches(ctx, { profileId: P, limit: 100 }));
    expect(back.items.map((i) => i.card.id).sort()).toEqual([B, N].sort());
  });

  it('[R2-02d] another agency, a partner, Client Mode and impersonating staff are refused; SQL cannot plant or rewrite a match', async () => {
    const c = await contact(o);
    const P = await profile(o, c);
    const A = await listing(o);
    const m = await matchOf(P, A);
    // another agency's member: not found, and nothing of o in its queue
    expect(
      (await as(net, (ctx) => matching.listClientProfileMatches(ctx, { limit: 100 }))).items.map((i) => i.id),
    ).not.toContain(m.id);
    expect(await refusal(as(net, (ctx) => matching.listClientProfileMatches(ctx, { profileId: P })))).toBe(
      'CLIENT_PROFILE_NOT_FOUND',
    );
    expect(await refusal(as(net, (ctx) => matching.listClientProfileMatches(ctx, { contactId: c })))).toBe(
      'CONTACT_NOT_FOUND',
    );
    for (const move of [
      matching.approveClientProfileMatch,
      matching.dismissClientProfileMatch,
      matching.restoreClientProfileMatch,
    ]) {
      expect(await refusal(as(net, (ctx) => move(ctx, m.id)))).toBe('CLIENT_PROFILE_MATCH_NOT_FOUND');
    }
    // a partner, Client Mode, staff impersonating the member
    const partner = await member(o.agencyId, 'PARTNER');
    expect(await refusal(as(partner, (ctx) => matching.listClientProfileMatches(ctx, {})))).toBe('FORBIDDEN');
    expect(await refusal(as(partner, (ctx) => matching.dismissClientProfileMatch(ctx, m.id)))).toBe('FORBIDDEN');
    expect(await refusal(as(o, (ctx) => matching.listClientProfileMatches({ ...ctx, clientMode: true }, {})))).toBe(
      'FORBIDDEN',
    );
    expect(
      await refusal(
        as(o, async (ctx) => matching.approveClientProfileMatch(await impersonatedCtx(ctx, newId()), m.id)),
      ),
    ).toBe('FORBIDDEN');
    expect((await matchOf(P, A)).status).toBe('PENDING_REVIEW');
    // as app_user: no insert, no score rewrite, no move outside the review's, no delete
    const sqlState = async (q: ReturnType<typeof sql>) => {
      try {
        await withTenant({ agencyId: o.agencyId, userId: o.userId }, (tx) => tx.execute(q));
        return 'ok';
      } catch (err) {
        return (err as { code?: string; cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
      }
    };
    expect(
      await sqlState(sql`insert into client_profile_matches (id, agency_id, profile_id, listing_id, listing_agency_id,
        listing_version, profile_version, hard_score, total_score, explanation, status)
        values (${newId()}, ${o.agencyId}, ${P}, ${newId()}, ${o.agencyId}, 1, 1, 1, 1, '{}', 'PENDING_REVIEW')`),
    ).toBe('42501');
    expect(await sqlState(sql`update client_profile_matches set total_score = 1 where id = ${m.id}`)).toBe('42501');
    expect(await sqlState(sql`update client_profile_matches set status = 'SENT' where id = ${m.id}`)).toBe('42501');
    expect(await sqlState(sql`update client_profile_matches set status = 'APPROVED' where id = ${m.id}`)).toBe('42501');
    // an approval naming a selection the agency does not have (another agency's, or none)
    expect(
      await sqlState(
        sql`update client_profile_matches set status = 'APPROVED', selection_id = ${newId()} where id = ${m.id}`,
      ),
    ).toBe('42501');
    expect(await sqlState(sql`delete from client_profile_matches where id = ${m.id}`)).toBe('42501');
    expect((await matchOf(P, A)).status).toBe('PENDING_REVIEW');
  });
});
