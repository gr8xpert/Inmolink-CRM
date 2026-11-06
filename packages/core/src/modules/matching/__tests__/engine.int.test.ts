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
 * The client-profile match engine (R2-02b) on the real test database: a listing's read-model change matched to the
 * profiles that may see it (own agency, network shared with it), never twice (re-run, re-change, dismissal), OFF
 * profiles and closed networks skipped, REVIEW → PENDING_REVIEW and AUTO_SEND → QUEUED, the profile → listings
 * direction and the sweep's windows, the semantic score from raw vectors, and the event → job wiring.
 */

const RUN = newId().slice(-8).toLowerCase();
const L = FALLBACK_CONTENT_LOCALE;
const code = (s: string) => `${s}-me-${RUN}`;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('matching.engine.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** o: owns the listings · b, c: network agencies (verified, within grace) · u: unverified (network closed). */
let o: Founder;
let b: Founder;
let c: Founder;
let u: Founder;
let ids: { city: string; elsewhere: string; villa: string; pool: string; garden: string };
const P: Record<string, string> = {};

const as = <T>(f: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId(), locale: 'en' }, fn);

const version = async (id: string) => (await as(o, (ctx) => properties.getListing(ctx, id))).version;
const update = async (id: string, change: Partial<UpdateListingBody>) =>
  as(o, async (ctx) =>
    properties.updateListing(ctx, id, UpdateListingBody.parse({ ...change, version: await version(id) })),
  );

/** An ACTIVE listing of `o` in the city (SHARED to ALL unless told otherwise), with a pool. */
async function listing(
  body: Partial<CreateListingBody> = {},
  change: Partial<UpdateListingBody> = {},
): Promise<string> {
  const { id } = await as(o, (ctx) =>
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
  await as(o, async (ctx) =>
    properties.setListingFeatures(ctx, id, { featureIds: [ids.pool], version: await version(id) } as never),
  );
  await update(id, { status: 'ACTIVE', visibility: 'SHARED', shareScope: 'ALL', ...change });
  return id;
}

const rebuild = (listingIds: string[]) => system((tx) => search.rebuildReadModels(tx, 'LISTING', listingIds));
const matchListing = async (id: string) => {
  await rebuild([id]);
  return matching.matchListingsToProfiles({ agencyId: o.agencyId, listingIds: [id] });
};

async function profile(f: Founder, extra: Partial<CreateClientProfileBody> = {}): Promise<string> {
  const contact = await as(
    f,
    async (ctx) =>
      (await crm.createContact(ctx, CreateContactBody.parse({ firstName: `Buyer ${newId().slice(-6)}` }))).contact,
  );
  const body: CreateClientProfileBody = {
    mode: 'REVIEW',
    frequency: 'DAILY',
    transactionType: 'SALE',
    propertyTypeIds: [ids.villa],
    locationIds: [ids.city],
    featureIds: [ids.pool],
    priceMaxCents: 60_000_000,
    bedsMin: 3,
    wishes: 'Sea view',
    ...extra,
  };
  return (await as(f, (ctx) => matching.createClientProfile(ctx, contact.id, body))).id;
}

/** This file's profiles' matches of `listingId`: profile key → status. */
async function matchesOf(listingId: string): Promise<Record<string, string>> {
  const list = await rows<{ profile_id: string; status: string }>(sql`
    select profile_id, status from client_profile_matches where listing_id = ${listingId}`);
  const out: Record<string, string> = {};
  for (const [key, id] of Object.entries(P)) {
    const m = list.find((r) => r.profile_id === id);
    if (m) out[key] = m.status;
  }
  return out;
}

const pairCount = (profileId: string, listingId: string) =>
  rows<{ n: number }>(
    sql`select count(*)::int as n from client_profile_matches where profile_id = ${profileId} and listing_id = ${listingId}`,
  ).then((r) => r[0]?.n ?? 0);

beforeAll(async () => {
  await setupTestDb('worker');
  [o, b, c, u] = await Promise.all([createFounder(), createFounder(), createFounder(), createFounder()]);
  for (const f of [o, b, c]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (x: string) => [{ locale: L, name: `${x} ${RUN}`, slug: code(x.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: name('Matchland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: name('Matchshire'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: name('Matchton'),
    });
    const elsewhere = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('el'),
      translations: name('Farton'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: code('g'), sort: 0, translations: name('Homes') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('villa'),
      sort: 0,
      translations: name('Villa'),
    });
    const fg = await taxonomy.createFeatureGroup(tx, { key: code('fg'), sort: 0, translations: name('Outdoor') });
    const feature = (k: string) =>
      taxonomy.createFeature(tx, { groupId: fg, key: code(k), sort: 0, icon: 'pool', translations: name(k) });
    return { city, elsewhere, villa, pool: await feature('Pool'), garden: await feature('Garden') };
  });
  P.own = await profile(o);
  P.auto = await profile(b, { mode: 'AUTO_SEND' });
  P.off = await profile(b, { mode: 'OFF' });
  P.closed = await profile(u);
  P.far = await profile(c, { locationIds: [ids.elsewhere] });
  P.cheap = await profile(c, { priceMaxCents: 40_000_000 });
  P.tight = await profile(c, { priceMaxCents: 47_000_000 });
}, 240_000);

afterAll(async () => {
  await closeDb();
});

describe('client profile match engine (R2-02b)', () => {
  it('[R2-02b] a listing change matches the profiles that may see it: REVIEW → pending, AUTO_SEND → queued, OFF skipped', async () => {
    const L1 = await listing();
    const r = await matchListing(L1);
    expect(await matchesOf(L1)).toEqual({ own: 'PENDING_REVIEW', auto: 'QUEUED', tight: 'PENDING_REVIEW' });
    expect(r.matched).toBe(3);
    // facts written from the read model
    const [facts] = await rows<{ share_scope: string; price_cents: string }>(
      sql`select share_scope, price_cents from matching_listing_facts where listing_id = ${L1}`,
    );
    expect(facts).toEqual({ share_scope: 'ALL', price_cents: '50000000' });
    // the stored explanation: 6% over the tight budget, every other criterion met; neutral semantic score
    const [tight] = await rows<{
      explanation: matching.MatchExplanation;
      semantic_score: number | null;
      total_score: number;
    }>(
      sql`select explanation, semantic_score, total_score from client_profile_matches
           where profile_id = ${P.tight} and listing_id = ${L1}`,
    );
    expect(tight?.explanation).toMatchObject({
      unsatisfied: ['price'],
      priceDeltaPct: 6,
      mustHaves: { met: 1, total: 1 },
    });
    expect(tight?.semantic_score).toBeNull();
    expect(matching.explanationText(tight?.explanation as matching.MatchExplanation, 'en').lines).toContain(
      '6% over budget',
    );
  });

  it('[R2-02b] never twice: a re-run, a listing re-change and a dismissal write no pair again', async () => {
    const L2 = await listing();
    await matchListing(L2);
    expect((await matching.matchListingsToProfiles({ agencyId: o.agencyId, listingIds: [L2] })).matched).toBe(0);
    await update(L2, { priceCents: 45_000_000 });
    expect((await matchListing(L2)).matched).toBe(0);
    await rows(sql`update client_profile_matches set status = 'DISMISSED'
                    where profile_id = ${P.auto} and listing_id = ${L2}`);
    await update(L2, { priceCents: 46_000_000 });
    expect((await matchListing(L2)).matched).toBe(0);
    expect(
      (await matching.matchProfilesToListings({ agencyId: b.agencyId, profileIds: [P.auto as string] })).matched,
    ).toBe(0);
    expect(await pairCount(P.auto as string, L2)).toBe(1);
    expect((await matchesOf(L2)).auto).toBe('DISMISSED');
  });

  it('[R2-02b] visibility: no private listing, PREFERRED only to the preferred, no unlisted owner, no closed network', async () => {
    // PRIVATE: no read model, no facts, nobody — not even the owner's own profile
    const priv = await listing({}, { visibility: 'PRIVATE' });
    await matchListing(priv);
    expect(await matchesOf(priv)).toEqual({});
    expect(await rows(sql`select 1 from matching_listing_facts where listing_id = ${priv}`)).toEqual([]);
    // PREFERRED with nobody preferred: the owner's profile only
    const pref = await listing({}, { shareScope: 'PREFERRED' });
    await matchListing(pref);
    expect(await matchesOf(pref)).toEqual({ own: 'PENDING_REVIEW' });
    // the profile → listings direction keeps to the same rule
    await matching.matchProfilesToListings({ agencyId: b.agencyId, profileIds: [P.auto as string] });
    await matching.matchProfilesToListings({ agencyId: u.agencyId, profileIds: [P.closed as string] });
    expect(await pairCount(P.auto as string, pref)).toBe(0);
    expect(await pairCount(P.auto as string, priv)).toBe(0);
    expect(await rows(sql`select 1 from client_profile_matches where profile_id = ${P.closed}`)).toEqual([]);
    // stale facts (a sharing-only change raises no listings event): the read model decides, b still gets nothing
    await rows(sql`update matching_listing_facts set share_scope = 'ALL' where listing_id = ${pref}`);
    await matching.matchProfilesToListings({ agencyId: b.agencyId, profileIds: [P.auto as string] });
    expect(await pairCount(P.auto as string, pref)).toBe(0);
    // a withdrawn listing loses its facts
    await update(pref, { status: 'WITHDRAWN' });
    await matchListing(pref);
    expect(await rows(sql`select 1 from matching_listing_facts where listing_id = ${pref}`)).toEqual([]);
  });

  it('[R2-02b] an unlisted (suspended) owner’s listings reach only its own profiles', async () => {
    const s = await createFounder();
    await setAgencyStatus(s.agencyId, 'VERIFIED');
    const contactOf = await profile(s);
    const { id } = await withMemberCtx(
      { userId: s.userId, agencyId: s.agencyId, requestId: newId(), locale: 'en' },
      async (ctx) => {
        const created = await properties.createListing(
          ctx,
          CreateListingBody.parse({
            propertyTypeId: ids.villa,
            locationId: ids.city,
            priceCents: 50_000_000,
            bedrooms: 4,
            energyRating: 'B',
            commission: { type: 'PCT', basisPoints: 500, includesVat: false },
            splitBp: 5000,
          }),
        );
        return created;
      },
    );
    const asS = <T>(fn: (ctx: Ctx) => Promise<T>) =>
      withMemberCtx({ userId: s.userId, agencyId: s.agencyId, requestId: newId(), locale: 'en' }, fn);
    const v = async () => (await asS((ctx) => properties.getListing(ctx, id))).version;
    await asS(async (ctx) =>
      properties.setListingFeatures(ctx, id, { featureIds: [ids.pool], version: await v() } as never),
    );
    await asS(async (ctx) =>
      properties.updateListing(
        ctx,
        id,
        UpdateListingBody.parse({ status: 'ACTIVE', visibility: 'SHARED', shareScope: 'ALL', version: await v() }),
      ),
    );
    await setAgencyStatus(s.agencyId, 'SUSPENDED');
    await rebuild([id]);
    await matching.matchListingsToProfiles({ agencyId: s.agencyId, listingIds: [id] });
    await matching.matchProfilesToListings({ agencyId: b.agencyId, profileIds: [P.auto as string] });
    expect(await pairCount(P.auto as string, id)).toBe(0);
    expect(await pairCount(contactOf, id)).toBe(1);
  });

  it('[R2-02b] a new profile finds existing listings (profile → listings), and a profile change event queues one job', async () => {
    const L3 = await listing({ priceCents: 30_000_000 });
    await matchListing(L3);
    expect(await pairCount(P.cheap as string, L3)).toBe(1);
    const late = await profile(b, { mode: 'AUTO_SEND' });
    let matched = 0;
    const queries = await countQueries(async () => {
      matched = (await matching.matchProfilesToListings({ agencyId: b.agencyId, profileIds: [late] })).matched;
    });
    expect(await pairCount(late, L3)).toBe(1);
    expect(matched).toBeGreaterThanOrEqual(1);
    // R2-02b's 12 + the profiles' affinity summaries (R2-02c)
    expect(queries).toBeLessThanOrEqual(13);

    const queued: unknown[] = [];
    const spy = vi.spyOn(matching.clientMatchJobs.matchProfilesToListings, 'enqueue').mockImplementation(async (p) => {
      queued.push(p);
      return { id: 'test' };
    });
    const listingSpy = vi
      .spyOn(matching.clientMatchJobs.matchListingsToProfiles, 'enqueue')
      .mockImplementation(async (p) => {
        queued.push(p);
        return { id: 'test' };
      });
    matching.registerMatchingSubscriptions();
    try {
      const meta = (type: string) => ({
        eventId: newId(),
        agencyId: b.agencyId,
        type,
        version: 1,
        createdAt: new Date(),
        attempt: 1,
      });
      for (const s of defaultSubscribers.get('matching.clientProfiles.changed', 1)) {
        if (s.name === 'matching.clientProfileMatches.profiles') {
          await s.handler(
            { agencyId: b.agencyId, profileIds: [late] } as never,
            meta('matching.clientProfiles.changed'),
          );
        }
      }
      for (const s of defaultSubscribers.get('search.listings.changed', 1)) {
        if (s.name === 'matching.clientProfileMatches.listings') {
          await s.handler({ listingIds: [L3] } as never, meta('search.listings.changed'));
        }
      }
    } finally {
      matching.unregisterMatchingSubscriptions();
      spy.mockRestore();
      listingSpy.mockRestore();
    }
    expect(queued).toEqual([
      { eventId: expect.any(String), agencyId: b.agencyId, profileIds: [late] },
      { eventId: expect.any(String), agencyId: b.agencyId, listingIds: [L3] },
    ]);
    expect(matching.clientMatchJobs.matchProfilesToListings.spec.jobId?.(queued[0] as never)).toMatch(/^pmatch-p:/);
    expect(matching.clientMatchJobs.matchListingsToProfiles.spec.jobId?.(queued[1] as never)).toMatch(/^pmatch-l:/);
  });

  it('[R2-02b] the sweep walks an agency’s profiles in windows and matches what events missed', async () => {
    const L4 = await listing({ priceCents: 35_000_000 });
    // facts only (as if the event's match was lost): the sweep finds it
    await rebuild([L4]);
    await matching.refreshListingFacts([L4]);
    const w = await system(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`select id from client_profiles where agency_id = ${c.agencyId} order by id`,
          )
        ).rows,
    );
    expect(w.length).toBe(3);
    const first = await matching.profileMatchWindow({ agencyId: c.agencyId, after: null, window: 2 });
    expect(first).toMatchObject({ profiles: 2, next: w[1]?.id });
    const second = await matching.profileMatchWindow({ agencyId: c.agencyId, after: first.next, window: 2 });
    expect(second).toMatchObject({ profiles: 1, next: null });
    expect(await pairCount(P.cheap as string, L4)).toBe(1);
    expect(await pairCount(P.far as string, L4)).toBe(0);
    // a re-run of the sweep adds nothing
    expect((await matching.profileMatchWindow({ agencyId: c.agencyId, after: null })).matched).toBe(0);
    // facts older than the sweep's look-back are not re-read (two days)
    const later = Date.now() + 3 * 86_400_000;
    const old = await listing({ priceCents: 36_000_000 });
    await rebuild([old]);
    await matching.refreshListingFacts([old]);
    expect((await matching.profileMatchWindow({ agencyId: c.agencyId, after: null, nowMs: later })).matched).toBe(0);
    expect(await pairCount(P.cheap as string, old)).toBe(0);
    // a profile written before match keys existed gets them in its window
    await rows(sql`update client_profiles set match_keys = '{}' where id = ${P.far}`);
    await matching.profileMatchWindow({ agencyId: c.agencyId, after: null });
    const [keyed] = await rows<{ match_keys: string[] }>(
      sql`select match_keys from client_profiles where id = ${P.far}`,
    );
    expect(keyed?.match_keys).toEqual(
      matching.profileMatchKeys({ agencyId: c.agencyId, transactionType: 'SALE', locationIds: [ids.elsewhere] }),
    );
    // the sweep job queues one window walk per agency (spread), ids per run day
    expect(matching.matchWindowKey({ run: '2026-11-06', agencyId: c.agencyId, after: null })).toBe(
      `pmatch-w.2026-11-06.${c.agencyId}.start`,
    );
  });

  it('[R2-02b] a broad profile (anywhere) is left out of listing events and matched from its side', async () => {
    const wide = await profile(b, { locationIds: [] });
    const L6 = await listing({ priceCents: 41_000_000 });
    await matchListing(L6);
    expect(await pairCount(wide, L6)).toBe(0);
    await matching.matchProfilesToListings({ agencyId: b.agencyId, profileIds: [wide] });
    expect(await pairCount(wide, L6)).toBe(1);
  });

  it('[R2-02b] the semantic score is used when both vectors exist (same model), neutral otherwise', async () => {
    const L5 = await listing({ priceCents: 49_000_000 });
    await rebuild([L5]);
    const vec = (x: number) => `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : x)).join(',')}]`;
    await rows(sql`insert into listing_embeddings (target_id, owner_agency_id, embedding, model, content_hash,
                     source_version, source_updated_at)
                   values (${L5}, ${o.agencyId}, ${vec(0)}::halfvec, 'fake-embed', 'h', 1, now())`);
    await rows(sql`insert into client_profile_embeddings (profile_id, owner_agency_id, embedding, model, content_hash,
                     source_version)
                   values (${P.own}, ${o.agencyId}, ${vec(0)}::halfvec, 'fake-embed', 'h', 1),
                          (${P.auto}, ${b.agencyId}, ${vec(0)}::halfvec, 'other-model', 'h', 1)
                   on conflict (profile_id) do update set embedding = excluded.embedding, model = excluded.model`);
    await matching.matchListingsToProfiles({ agencyId: o.agencyId, listingIds: [L5] });
    const got = await rows<{ profile_id: string; semantic_score: number | null; total_score: number }>(sql`
      select profile_id, semantic_score, total_score from client_profile_matches
       where listing_id = ${L5} and profile_id = any(${`{${P.own},${P.auto}}`}::uuid[])`);
    const own = got.find((g) => g.profile_id === P.own);
    const auto = got.find((g) => g.profile_id === P.auto);
    expect(own?.semantic_score).toBeCloseTo(1, 2);
    expect(own?.total_score).toBeCloseTo(1, 2);
    // another model's vector is not comparable: neutral
    expect(auto?.semantic_score).toBeNull();
    expect(auto?.total_score).toBeCloseTo(0.85, 2);

    // the profile → listings direction asks search for the same similarity
    const late = await profile(o);
    await rows(sql`insert into client_profile_embeddings (profile_id, owner_agency_id, embedding, model, content_hash,
                     source_version) values (${late}, ${o.agencyId}, ${vec(0)}::halfvec, 'fake-embed', 'h', 1)`);
    await matching.matchProfilesToListings({ agencyId: o.agencyId, profileIds: [late] });
    const [mine] = await rows<{ semantic_score: number | null }>(
      sql`select semantic_score from client_profile_matches where profile_id = ${late} and listing_id = ${L5}`,
    );
    expect(mine?.semantic_score).toBeCloseTo(1, 2);
    await rows(
      sql`delete from client_profile_embeddings where profile_id = any(${`{${P.own},${P.auto},${late}}`}::uuid[])`,
    );
    await rows(sql`delete from listing_embeddings where target_id = ${L5}`);
  });
});
