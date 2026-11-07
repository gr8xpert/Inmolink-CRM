import { type AdminQuery, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { listingEventKeyTiers, listingMatchKeys, profileMatchKeys, profileProbeKeys } from '../match-keys';
import {
  type ListingMatchProbe,
  listingToProfilesQuery,
  type MatchProfileRow,
  narrowProfileToListingsQuery,
  type ProfileMatchProbe,
  profileToListingsQuery,
} from '../repo';

/**
 * R2-02f's rewritten candidate statements, on a small fixture in one rolled-back transaction (the dense-market plans are
 * `tests/perf/matching-storm.int.test.ts`): the place tiers of the listing → profiles probe lose no profile and read none
 * twice, and the per-profile narrow statement finds exactly what the shared lateral (R2-02b's statement, kept for broad
 * profiles) finds at every filter's edge.
 */

const dialect = new PgDialect();
const run = async (q: AdminQuery, statement: SQL) => {
  const query = dialect.sqlToQuery(statement);
  return q<{ id?: string; l_id: string }>(query.sql, query.params);
};

const OWNER = newId();
const OTHER = newId();
const [COUNTRY, REGION, CITY, AREA, AREA2] = [newId(), newId(), newId(), newId(), newId()];
const TYPE = newId();
const [F1, F2, F3, F4] = [newId(), newId(), newId(), newId()];

async function agencies(q: AdminQuery): Promise<void> {
  await q('set local session_replication_role = replica');
  await q(
    `insert into agencies (agency_id, kind, status, name) values ($1, 'AGENCY', 'VERIFIED', 'Owner'),
            ($2, 'AGENCY', 'VERIFIED', 'Other')`,
    [OWNER, OTHER],
  );
}

describe('matching storm statements (R2-02f)', () => {
  it('[R2-02f] a listing reaches the profiles of its area, city and region once each, and never one matched before', async () => {
    await setupTestDb('worker');
    const profile = (locationIds: string[]) => ({ id: newId(), locationIds });
    const area = profile([AREA]);
    const city = profile([CITY]);
    const region = profile([REGION]);
    const both = profile([AREA, CITY]);
    const elsewhere = profile([AREA2]);
    const matched = profile([CITY]);
    const all = [area, city, region, both, elsewhere, matched];
    const listingId = newId();
    const found = await withAdminRollback(['client_profiles', 'client_profile_matches', 'agencies'], async (q) => {
      await agencies(q);
      for (const p of all) {
        await q(
          `insert into client_profiles (id, agency_id, contact_id, mode, transaction_type, location_ids, match_keys)
           values ($1, $2, $3, 'REVIEW', 'SALE', $4::uuid[], $5::text[])`,
          [
            p.id,
            OTHER,
            newId(),
            p.locationIds,
            profileMatchKeys({ agencyId: OTHER, transactionType: 'SALE', locationIds: p.locationIds }),
          ],
        );
      }
      await q(
        `insert into client_profile_matches (id, agency_id, profile_id, listing_id, listing_agency_id, listing_version,
           profile_version, hard_score, boost_score, total_score, explanation, status)
         values ($1, $2, $3, $4, $5, 1, 1, 1, 0, 1, '{}', 'PENDING_REVIEW')`,
        [newId(), OTHER, matched.id, listingId, OWNER],
      );
      await q('set local role app_system');
      const locationIds = [COUNTRY, REGION, CITY, AREA];
      const probe: ListingMatchProbe = {
        listingId,
        agencyId: OWNER,
        version: 2,
        transactionType: 'SALE',
        propertyTypeId: TYPE,
        locationIds,
        featureIds: [],
        priceCents: 30_000_000,
        beds: 3,
        baths: 2,
        areaM2: 120,
        shareScope: 'ALL',
        preferredAgencyIds: [],
        tiers: listingEventKeyTiers({ ownerAgencyId: OWNER, transactionType: 'SALE', locationIds, network: true }),
        network: true,
        vector: null,
        model: null,
      };
      return (await run(q, listingToProfilesQuery([probe], 200))).map((r) => r.id);
    });
    expect([...found].sort()).toEqual([area.id, city.id, region.id, both.id].sort());
  });

  it('[R2-02f] the per-profile statement finds what the shared lateral finds, at every filter edge', async () => {
    await setupTestDb('worker');
    const MAX = 100_000_000;
    // listings: [price, features, owner, share, preferred, beds, baths, area]
    type L = { price: number | null; f: string[]; owner: string; share: 'ALL' | 'PREFERRED'; pref: string[] };
    const base: L = { price: 50_000_000, f: [F1, F2, F3, F4], owner: OTHER, share: 'ALL', pref: [] };
    const listings: (L & { id: string; beds: number | null; baths: number | null; area: number | null })[] = [
      { ...base, price: (MAX / 10) * 11 }, // exactly 10 % over the maximum: a near miss that passes
      { ...base, price: (MAX / 10) * 11 + 1 }, // one cent more: out
      { ...base, price: MAX / 2 }, // at the minimum
      { ...base, price: MAX / 2 - 1 }, // under it
      { ...base, price: null }, // price on request
      { ...base, f: [F1, F2, F3] }, // 3 of 4 must-haves: one may miss
      { ...base, f: [F1, F2] }, // 2 of 4: out
      { ...base, f: [] },
      { ...base, owner: OWNER, share: 'PREFERRED' as const }, // another agency's? no: its own, PREFERRED does not matter
      { ...base, share: 'PREFERRED' as const, pref: [OWNER] }, // preferred by the owner of the listing for the profile's agency
      { ...base, share: 'PREFERRED' as const, pref: [newId()] }, // preferred for someone else: out
    ].map((l, i) => ({
      ...l,
      id: newId(),
      beds: i % 3 === 0 ? null : 2 + (i % 3),
      baths: 1 + (i % 2),
      area: 80 + 10 * i,
    }));
    // the profiles' agency is OWNER here; listings of OTHER reach it when shared
    const criteria: Omit<MatchProfileRow, 'id' | 'agencyId' | 'mode' | 'version'>[] = [
      {
        transactionType: 'SALE',
        propertyTypeIds: [TYPE],
        locationIds: [CITY],
        featureIds: [F1, F2, F3, F4],
        priceMinCents: MAX / 2,
        priceMaxCents: MAX,
        bedsMin: 3,
        bathsMin: 2,
        areaMinM2: 90,
        areaMaxM2: 150,
      },
      {
        transactionType: null,
        propertyTypeIds: [],
        locationIds: [CITY],
        featureIds: [],
        priceMinCents: null,
        priceMaxCents: null,
        bedsMin: null,
        bathsMin: null,
        areaMinM2: null,
        areaMaxM2: null,
      },
      {
        transactionType: 'SALE',
        propertyTypeIds: [newId(), TYPE],
        locationIds: [REGION],
        featureIds: [F1, F2, F3],
        priceMinCents: null,
        priceMaxCents: MAX,
        bedsMin: 2,
        bathsMin: null,
        areaMinM2: null,
        areaMaxM2: 120,
      },
      {
        transactionType: 'RENT_LONG_TERM',
        propertyTypeIds: [],
        locationIds: [CITY],
        featureIds: [],
        priceMinCents: null,
        priceMaxCents: null,
        bedsMin: null,
        bathsMin: null,
        areaMinM2: null,
        areaMaxM2: null,
      },
    ];
    const probes: ProfileMatchProbe[] = criteria.map((c) => {
      const p = { ...c, id: newId(), agencyId: OWNER, mode: 'REVIEW' as const, version: 1 };
      return { ...p, keys: profileProbeKeys(p, true) };
    });
    const results = await withAdminRollback(['matching_listing_facts', 'agencies'], async (q) => {
      await agencies(q);
      for (const l of listings) {
        const locationIds = [COUNTRY, REGION, CITY, AREA];
        await q(
          `insert into matching_listing_facts (listing_id, agency_id, version, transaction_type, property_type_id,
             location_ids, feature_ids, price_cents, beds, baths, area_m2, share_scope, preferred_agency_ids,
             match_keys, updated_at)
           values ($1, $2, 1, 'SALE', $3, $4::uuid[], $5::uuid[], $6, $7, $8, $9, $10, $11::uuid[], $12::text[],
                   now() - interval '1 hour')`,
          [
            l.id,
            l.owner,
            TYPE,
            locationIds,
            l.f,
            l.price,
            l.beds,
            l.baths,
            l.area,
            l.share,
            l.pref,
            listingMatchKeys({ ownerAgencyId: l.owner, transactionType: 'SALE', locationIds, network: true }),
          ],
        );
      }
      await q('set local role app_system');
      const out: { lateral: string[]; narrow: string[]; since: string[]; lateralSince: string[] }[] = [];
      const since = new Date(Date.now() - 2 * 3_600_000);
      for (const p of probes) {
        const ids = async (s: SQL) => (await run(q, s)).map((r) => r.l_id).sort();
        out.push({
          lateral: await ids(profileToListingsQuery([p], 200)),
          narrow: await ids(narrowProfileToListingsQuery(p, 200)),
          lateralSince: await ids(profileToListingsQuery([p], 200, { since })),
          since: await ids(narrowProfileToListingsQuery(p, 200, { since })),
        });
      }
      return out;
    });
    for (const r of results) {
      expect(r.narrow).toEqual(r.lateral);
      expect(r.since).toEqual(r.lateralSince);
    }
    const at = (i: number) => listings[i]?.id as string;
    // the strict profile: the 10 % tolerance and the minimum to the cent, 1 must-have of 4 may miss, sharing
    const strict = results[0]?.narrow ?? [];
    expect(strict).not.toContain(at(1));
    expect(strict).not.toContain(at(3));
    expect(strict).not.toContain(at(4));
    expect(strict).not.toContain(at(6));
    expect(strict).not.toContain(at(10));
    // the open profile sees every shared listing, never the one preferred for someone else
    expect(results[1]?.narrow).toHaveLength(listings.length - 1);
    expect(results[1]?.narrow).not.toContain(at(10));
    // another transaction: nothing
    expect(results[3]?.narrow).toEqual([]);
  });
});
