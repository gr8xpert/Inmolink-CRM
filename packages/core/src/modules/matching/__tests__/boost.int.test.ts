import {
  type CreateClientProfileBody,
  CreateContactBody,
  CreateListingBody,
  UpdateListingBody,
} from '@inmolink/contracts';
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
import * as crm from '../../crm';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as matching from '../index';

/**
 * The learned boost (R2-02c) on the real test database: a client's likes on a selection of the profile's contact and
 * a member's dismissals move the profile's affinity summary; the engine adds the bounded boost to similar listings'
 * totals and explains it; unlikes take likes back; the summary goes with the profile (delete, contact erasure, agency
 * erasure) and moves with it on a contact merge; events become one job each.
 */

const RUN = newId().slice(-8).toLowerCase();
const L = FALLBACK_CONTENT_LOCALE;
const code = (s: string) => `${s}-bo-${RUN}`;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('matching.boost.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let o: Founder;
let ids: { city: string; villa: string; flat: string; pool: string };

const as = <T>(f: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId(), locale: 'en' }, fn);

/** An ACTIVE listing of `f` in the city, shared to ALL, with a pool. */
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
  return id;
}

const matchListing = async (f: Founder, id: string) => {
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  return matching.matchListingsToProfiles({ agencyId: f.agencyId, listingIds: [id] });
};

async function contact(f: Founder): Promise<string> {
  return as(
    f,
    async (ctx) =>
      (await crm.createContact(ctx, CreateContactBody.parse({ firstName: `Buyer ${newId().slice(-6)}` }))).contact.id,
  );
}

async function profile(f: Founder, contactId: string, extra: Partial<CreateClientProfileBody> = {}): Promise<string> {
  const body: CreateClientProfileBody = {
    mode: 'REVIEW',
    frequency: 'DAILY',
    transactionType: 'SALE',
    propertyTypeIds: [ids.villa, ids.flat],
    locationIds: [ids.city],
    priceMaxCents: 90_000_000,
    ...extra,
  };
  return (await as(f, (ctx) => matching.createClientProfile(ctx, contactId, body))).id;
}

/** A selection of `f` for the contact (rows only: the page is S12-04's). */
async function selection(f: Founder, contactId: string): Promise<string> {
  const id = newId();
  await rows(sql`insert into selections (id, agency_id, created_by, contact_id, title, locale, token_hash, token_hint)
                  values (${id}, ${f.agencyId}, ${f.userId}, ${contactId}, 'For you', ${L}, ${`h-${id}`}, 'abcd')`);
  return id;
}

/** The client likes (or unlikes) an item on the selection's page, then the worker's job runs. */
async function react(f: Founder, selectionId: string, targetId: string, kind: 'LIKE' | 'UNLIKE') {
  await rows(sql`insert into selection_interactions (id, agency_id, selection_id, kind, target_id)
                  values (${newId()}, ${f.agencyId}, ${selectionId}, ${kind}, ${targetId})`);
  return matching.recordSelectionFeedback({ agencyId: f.agencyId, selectionId, targetId });
}

const affinityRows = (profileId: string) =>
  rows<{ key: number; likes: number; dislikes: number }>(
    sql`select u.k as key, u.l as likes, u.d as dislikes
          from client_profile_affinities, unnest(keys, likes, dislikes) as u(k, l, d)
         where profile_id = ${profileId} order by u.k`,
  );
const feedbackRows = (profileId: string) =>
  rows<{ listing_id: string; signal: string }>(
    sql`select listing_id, signal from client_profile_feedback where profile_id = ${profileId}`,
  );
const matchRow = async (profileId: string, listingId: string) =>
  (
    await rows<{
      id: string;
      hard_score: number;
      boost_score: number;
      total_score: number;
      explanation: matching.MatchExplanation;
    }>(sql`select id, hard_score, boost_score, total_score, explanation from client_profile_matches
            where profile_id = ${profileId} and listing_id = ${listingId}`)
  )[0];

beforeAll(async () => {
  await setupTestDb('worker');
  o = await createFounder();
  await setAgencyStatus(o.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (x: string) => [{ locale: L, name: `${x} ${RUN}`, slug: code(x.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: name('Boostland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: name('Boostshire'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: name('Boostton'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: code('g'), sort: 0, translations: name('Homes') });
    const type = (k: string) =>
      taxonomy.createPropertyType(tx, { groupId: group, key: code(k), sort: 0, translations: name(k) });
    const fg = await taxonomy.createFeatureGroup(tx, { key: code('fg'), sort: 0, translations: name('Outdoor') });
    const pool = await taxonomy.createFeature(tx, {
      groupId: fg,
      key: code('pool'),
      sort: 0,
      icon: 'pool',
      translations: name('Pool'),
    });
    return { city, villa: await type('Villa'), flat: await type('Flat'), pool };
  });
}, 240_000);

afterAll(async () => {
  await closeDb();
});

describe('learned boost (R2-02c)', () => {
  it('[R2-02c] no feedback gives boost 0; likes raise similar listings and explain it; an unlike takes it back', async () => {
    const liker = await contact(o);
    const P = await profile(o, liker);
    const Q = await profile(o, await contact(o)); // no feedback
    const A = await listing(o);
    await matchListing(o, A);
    expect((await matchRow(Q, A))?.boost_score).toBe(0);
    expect((await matchRow(Q, A))?.explanation.boost).toBeUndefined();

    const sel = await selection(o, liker);
    expect(await react(o, sel, A, 'LIKE')).toMatchObject({ profiles: 1 });
    expect(await feedbackRows(P)).toEqual([{ listing_id: A, signal: 'LIKE' }]);
    const summary = await affinityRows(P);
    expect(summary.map((r) => r.key)).toEqual(
      expect.arrayContaining([
        matching.affinityKey('propertyType', ids.villa),
        matching.affinityKey('location', ids.city),
        matching.affinityKey('features', ids.pool),
      ]),
    );
    expect(summary.every((r) => r.likes === 1 && r.dislikes === 0)).toBe(true);
    // the same like again (a redelivered event, a second click): nothing moves
    expect(await react(o, sel, A, 'LIKE')).toMatchObject({ profiles: 0 });
    expect(await affinityRows(P)).toEqual(summary);

    // a similar listing: P's total carries the boost, Q's does not; the explanation says why
    const B = await listing(o, { priceCents: 52_000_000 });
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', [B]));
    // R2-02b's statements + one for the batch's summaries
    let queries = 0;
    queries = await countQueries(async () => {
      await matching.matchListingsToProfiles({ agencyId: o.agencyId, listingIds: [B] });
    });
    expect(queries).toBeLessThanOrEqual(12);
    const p = await matchRow(P, B);
    const q = await matchRow(Q, B);
    expect(p?.boost_score).toBeGreaterThan(0);
    expect(p?.boost_score).toBeLessThanOrEqual(matching.MAX_BOOST);
    expect(q?.boost_score).toBe(0);
    expect((p?.total_score ?? 0) - (q?.total_score ?? 0)).toBeCloseTo(p?.boost_score ?? 0, 4);
    expect(p?.explanation.boost?.liked).toEqual(['propertyType', 'location', 'features', 'price']);
    expect(matching.explanationText(p?.explanation as matching.MatchExplanation, 'en').lines).toContain(
      'Similar to listings the client liked (type, area, features, price range)',
    );

    // the client takes the like back: the summary is empty again
    expect(await react(o, sel, A, 'UNLIKE')).toMatchObject({ profiles: 1 });
    expect(await feedbackRows(P)).toEqual([]);
    expect(await affinityRows(P)).toEqual([]);

    // out of order: a like and its unlike both written before either job runs — the client's last word (unlike) wins
    await rows(sql`insert into selection_interactions (id, agency_id, selection_id, kind, target_id)
                    values (${newId()}, ${o.agencyId}, ${sel}, 'LIKE', ${A})`);
    await rows(sql`insert into selection_interactions (id, agency_id, selection_id, kind, target_id)
                    values (${newId()}, ${o.agencyId}, ${sel}, 'UNLIKE', ${A})`);
    for (let i = 0; i < 2; i++) {
      expect(await matching.recordSelectionFeedback({ agencyId: o.agencyId, selectionId: sel, targetId: A })).toEqual({
        profiles: 0,
        truncated: false,
      });
    }
    expect(await affinityRows(P)).toEqual([]);
    // two selections of the contact: the latest word across both decides
    const sel2 = await selection(o, liker);
    expect(await react(o, sel2, A, 'LIKE')).toMatchObject({ profiles: 1 });
    expect(await react(o, sel, A, 'UNLIKE')).toMatchObject({ profiles: 1 });
    expect(await affinityRows(P)).toEqual([]);
    // two jobs of one profile at once serialize on its lock: one like, counted once
    await rows(sql`insert into selection_interactions (id, agency_id, selection_id, kind, target_id)
                    values (${newId()}, ${o.agencyId}, ${sel2}, 'LIKE', ${A})`);
    const both = await Promise.all([
      matching.recordSelectionFeedback({ agencyId: o.agencyId, selectionId: sel, targetId: A }),
      matching.recordSelectionFeedback({ agencyId: o.agencyId, selectionId: sel2, targetId: A }),
    ]);
    expect(both.map((r) => r.profiles).sort()).toEqual([0, 1]);
    expect((await affinityRows(P)).every((r) => r.likes === 1)).toBe(true);
    expect(await react(o, sel, A, 'UNLIKE')).toMatchObject({ profiles: 1 });
    // a selection without a contact, or of another agency: nothing
    const stranger = await createFounder();
    expect(
      await matching.recordSelectionFeedback({ agencyId: stranger.agencyId, selectionId: sel, targetId: A }),
    ).toMatchObject({ profiles: 0 });
  });

  it('[R2-02c] dismissals lower similar listings; a like after a dismissal replaces it', async () => {
    const P = await profile(o, await contact(o));
    const C = await listing(o, { propertyTypeId: ids.flat });
    await matchListing(o, C);
    const m = await matchRow(P, C);
    // not dismissed (yet): nothing learned
    expect(await matching.recordDismissalFeedback({ agencyId: o.agencyId, matchId: m?.id as string })).toMatchObject({
      profiles: 0,
    });
    await rows(sql`update client_profile_matches set status = 'DISMISSED', updated_at = now() where id = ${m?.id}`);
    expect(await matching.recordDismissalFeedback({ agencyId: o.agencyId, matchId: m?.id as string })).toMatchObject({
      profiles: 1,
    });
    expect(await feedbackRows(P)).toEqual([{ listing_id: C, signal: 'DISLIKE' }]);
    expect((await affinityRows(P)).every((r) => r.likes === 0 && r.dislikes === 1)).toBe(true);

    const D = await listing(o, { propertyTypeId: ids.flat, priceCents: 51_000_000 });
    await matchListing(o, D);
    const d = await matchRow(P, D);
    expect(d?.boost_score).toBeLessThan(0);
    expect(d?.boost_score).toBeGreaterThanOrEqual(-matching.MAX_BOOST);
    expect(d?.explanation.boost?.disliked).toContain('propertyType');
    expect(matching.explanationText(d?.explanation as matching.MatchExplanation, 'es').lines).toContain(
      'Parecido a inmuebles que el cliente descartó (tipo, zona, características, rango de precio)',
    );
    // the client then likes the dismissed listing: the latest signal wins, the dislike is taken back
    const sel = await selection(
      o,
      (await rows<{ contact_id: string }>(sql`select contact_id from client_profiles where id = ${P}`))[0]
        ?.contact_id as string,
    );
    expect(await react(o, sel, C, 'LIKE')).toMatchObject({ profiles: 1 });
    expect(await feedbackRows(P)).toEqual([{ listing_id: C, signal: 'LIKE' }]);
    expect((await affinityRows(P)).every((r) => r.likes === 1 && r.dislikes === 0)).toBe(true);
    // a late re-run of the (older) dismissal does not replace the newer like
    expect(await matching.recordDismissalFeedback({ agencyId: o.agencyId, matchId: m?.id as string })).toEqual({
      profiles: 0,
    });
    expect(await feedbackRows(P)).toEqual([{ listing_id: C, signal: 'LIKE' }]);
    // a dismissal, then the match restored (R2-02d emits the same event): the dislike is taken back
    await rows(sql`update client_profile_matches set status = 'DISMISSED', updated_at = now() where id = ${d?.id}`);
    expect(await matching.recordDismissalFeedback({ agencyId: o.agencyId, matchId: d?.id as string })).toEqual({
      profiles: 1,
    });
    expect(await feedbackRows(P)).toEqual(expect.arrayContaining([{ listing_id: D, signal: 'DISLIKE' }]));
    await rows(
      sql`update client_profile_matches set status = 'PENDING_REVIEW', updated_at = now() where id = ${d?.id}`,
    );
    expect(await matching.recordDismissalFeedback({ agencyId: o.agencyId, matchId: d?.id as string })).toEqual({
      profiles: 1,
    });
    expect(await feedbackRows(P)).toEqual([{ listing_id: C, signal: 'LIKE' }]);
  });

  it('[R2-02c] the summary moves on contact merge and is removed by contact erasure, profile delete and agency erasure', async () => {
    const A = await listing(o);
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', [A]));
    await matching.refreshListingFacts([A]);
    // merge: the closed contact's profile (and its summary) now belongs to the survivor; the survivor's likes reach it
    const closed = await contact(o);
    const survivor = await contact(o);
    const P = await profile(o, closed);
    await react(o, await selection(o, closed), A, 'LIKE');
    const before = await affinityRows(P);
    expect(before.length).toBeGreaterThan(0);
    await matching.repointClientProfiles({ agencyId: o.agencyId, survivorId: survivor, mergedId: closed });
    expect(await affinityRows(P)).toEqual(before);
    const A2 = await listing(o, { priceCents: 70_000_000 });
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', [A2]));
    await matching.refreshListingFacts([A2]);
    expect(await react(o, await selection(o, survivor), A2, 'LIKE')).toMatchObject({ profiles: 1 });
    // contact erasure: the profiles go, and their feedback and summary with them
    await matching.eraseContactProfiles({ agencyId: o.agencyId, contactIds: [survivor] });
    expect(await affinityRows(P)).toEqual([]);
    expect(await feedbackRows(P)).toEqual([]);

    // profile delete
    const c2 = await contact(o);
    const P2 = await profile(o, c2);
    await react(o, await selection(o, c2), A, 'LIKE');
    expect((await affinityRows(P2)).length).toBeGreaterThan(0);
    await as(o, (ctx) => matching.deleteClientProfile(ctx, P2));
    expect(await affinityRows(P2)).toEqual([]);
    expect(await feedbackRows(P2)).toEqual([]);

    // agency erasure (its saved-searches step takes the profiles)
    const leaving = await createFounder();
    await setAgencyStatus(leaving.agencyId, 'VERIFIED');
    const c3 = await contact(leaving);
    const P3 = await profile(leaving, c3);
    const own = await listing(leaving);
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', [own]));
    await matching.refreshListingFacts([own]);
    expect(await react(leaving, await selection(leaving, c3), own, 'LIKE')).toMatchObject({ profiles: 1 });
    for (let i = 0; i < 10 && (await matching.deleteAgencySavedSearches({ agencyId: leaving.agencyId })).more; i++);
    const [left] = await rows<{ f: number; a: number }>(sql`select
        (select count(*) from client_profile_feedback where agency_id = ${leaving.agencyId})::int as f,
        (select count(*) from client_profile_affinities where agency_id = ${leaving.agencyId})::int as a`);
    expect(left).toEqual({ f: 0, a: 0 });
    expect(await affinityRows(P3)).toEqual([]);
  });

  it('[R2-02c] likes / unlikes and dismissals become one job per event; views and enquiries none', async () => {
    const queued: unknown[] = [];
    const s1 = vi.spyOn(matching.feedbackJobs.selectionFeedback, 'enqueue').mockImplementation(async (p) => {
      queued.push(p);
      return { id: 'test' };
    });
    const s2 = vi.spyOn(matching.feedbackJobs.dismissalFeedback, 'enqueue').mockImplementation(async (p) => {
      queued.push(p);
      return { id: 'test' };
    });
    matching.registerMatchingSubscriptions();
    const meta = (type: string) => ({
      eventId: newId(),
      agencyId: o.agencyId,
      type,
      version: 1,
      createdAt: new Date(),
      attempt: 1,
    });
    const [sel, target, match] = [newId(), newId(), newId()];
    try {
      for (const s of defaultSubscribers.get('presentations.selection.interacted', 1)) {
        if (s.name !== 'matching.boost.selection') continue;
        for (const kind of ['VIEW', 'LIKE', 'ENQUIRE', 'UNLIKE']) {
          await s.handler(
            { selectionId: sel, interactionId: newId(), kind, targetId: kind === 'VIEW' ? null : target } as never,
            meta('presentations.selection.interacted'),
          );
        }
      }
      for (const s of defaultSubscribers.get('matching.clientProfileMatch.dismissed', 1)) {
        if (s.name !== 'matching.boost.dismissal') continue;
        await s.handler(
          { matchId: match, profileId: newId(), listingId: newId() } as never,
          meta('matching.clientProfileMatch.dismissed'),
        );
      }
    } finally {
      matching.unregisterMatchingSubscriptions();
      s1.mockRestore();
      s2.mockRestore();
    }
    expect(queued).toEqual([
      { eventId: expect.any(String), agencyId: o.agencyId, selectionId: sel, targetId: target },
      { eventId: expect.any(String), agencyId: o.agencyId, selectionId: sel, targetId: target },
      { eventId: expect.any(String), agencyId: o.agencyId, matchId: match },
    ]);
    expect(matching.feedbackJobs.selectionFeedback.spec.jobId?.(queued[0] as never)).toMatch(/^pfb-s:/);
    expect(matching.feedbackJobs.dismissalFeedback.spec.jobId?.(queued[2] as never)).toMatch(/^pfb-d:/);
  });
});
