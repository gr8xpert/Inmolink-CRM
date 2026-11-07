import { type AdminQuery, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { listingEventKeyTiers, profileProbeKeys } from '../../packages/core/src/modules/matching/match-keys';
import {
  type ListingMatchProbe,
  listingToProfilesQuery,
  narrowProfileToListingsQuery,
  PROFILES_PER_LISTING,
} from '../../packages/core/src/modules/matching/repo';

/**
 * The match engine's hot statements in a dense market (R2-02f; the full storm is `pnpm perf:matching-storm`, the numbers
 * in STATUS): 200,000 active client profiles of 1,000 agencies on one coast — a region, 25 cities (the busiest about a
 * fifth of everything), 4 areas each — and 20,000 listing facts, seeded in one rolled-back transaction.
 *
 * - listing → profiles: a listing of the busiest city fills its 200 candidates from the profiles of its own area; the
 *   city's and the region's GIN entries (tens of thousands) are never read;
 * - profile → listings: a region-level profile (most of the stock shares its key) walks the facts' primary key newest
 *   first and stops at 200; a profile of one quiet area takes its few GIN entries instead — the planner chooses, per
 *   profile.
 */

const AGENCIES = 1_000;
const PROFILES = 200_000;
const FACTS = 20_000;
const CITIES = 25;
/** Synthetic ids: `57025f<ns>-…` (the storm script's are `57024f`). */
const id = (ns: number, expr: string) =>
  `('57025f${ns.toString(16).padStart(2, '0')}-0000-4000-8000-' || lpad(to_hex((${expr})::bigint), 12, '0'))::uuid`;
const idJs = (ns: number, i: number) =>
  `57025f${ns.toString(16).padStart(2, '0')}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const AG = 1;
const LOC = 2;
const TYPE = 3;
const PROFILE = 5;
const LISTING = 6;
const COUNTRY = 0;
const REGION = 1;
const CITY0 = 16;
const AREA0 = 256;
const city = (r: string) => `${CITY0} + least(${CITIES - 1}, floor(${CITIES} * power(${r}, 2)))`;
const area = (r: string, k: string) => `${AREA0} + least(${CITIES - 1}, floor(${CITIES} * power(${r}, 2))) * 4 + ${k}`;

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

async function seed(q: AdminQuery): Promise<void> {
  await q('set local session_replication_role = replica');
  // the same market every run (the candidate counts are asserted)
  await q('select setseed(0.42)');
  await q(
    `insert into agencies (agency_id, kind, status, name, give_to_get_exempt)
     select ${id(AG, 'i')}, 'AGENCY', 'VERIFIED', 'Dense ' || i, true from generate_series(0, ${AGENCIES - 1}) i`,
  );
  await q(
    `insert into matching_listing_facts (listing_id, agency_id, version, transaction_type, property_type_id,
       location_ids, feature_ids, price_cents, beds, baths, area_m2, share_scope, match_keys)
     select ${id(LISTING, 'i')}, ${id(AG, 'a')}, 1, 'SALE', ${id(TYPE, 'floor(random() * 6)')}, locs, '{}',
            exp(ln(15000000) + random() * ln(40))::bigint, 1 + floor(random() * 6)::int, 1 + floor(random() * 4)::int,
            100, 'ALL',
            array(select k from (select 'a:' || ${id(AG, 'a')} || ':' || t || ':' || l as k
                                   from unnest(array['SALE', '*']) t, unnest(locs::text[] || array['*']) l
                                 union select 'n:' || t || ':' || l
                                   from unnest(array['SALE', '*']) t, unnest(locs::text[] || array['*']) l) s)
       from (select i, floor(random() * ${AGENCIES})::int as a, r,
                    array[${id(LOC, `${COUNTRY}`)}, ${id(LOC, `${REGION}`)}, ${id(LOC, city('r'))},
                          ${id(LOC, area('r', 'floor(random() * 4)::int'))}] as locs
               from (select i, random() as r from generate_series(0, ${FACTS - 1}) i) g) f`,
  );
  // profiles: 10 % the region, 55 % one city, 35 % one area; a type for most, a budget for many
  await q(
    `insert into client_profiles (id, agency_id, contact_id, mode, transaction_type, property_type_ids, location_ids,
       price_max_cents, beds_min, match_keys)
     select ${id(PROFILE, 'i')}, ag, gen_random_uuid(), case when i % 2 = 0 then 'REVIEW' else 'AUTO_SEND' end, 'SALE',
            case when i % 10 < 3 then '{}'::uuid[] else array[${id(TYPE, 'i % 6')}] end, array[loc],
            case when i % 10 < 7 then exp(ln(20000000) + random() * ln(25))::bigint end,
            case when i % 10 < 6 then 1 + i % 4 end,
            array['a:' || ag || ':SALE:' || loc, 'n:SALE:' || loc]
       from (select i, ${id(AG, `i % ${AGENCIES}`)} as ag,
                    case when r < 0.10 then ${id(LOC, `${REGION}`)}
                         when r < 0.65 then ${id(LOC, city('random()'))}
                         else ${id(LOC, area('random()', 'floor(random() * 4)::int'))} end as loc
               from (select i, random() as r from generate_series(0, ${PROFILES - 1}) i) g) p`,
  );
  for (const t of ['client_profiles', 'matching_listing_facts']) await q(`analyze ${t}`);
  await q(`select gin_clean_pending_list('client_profiles_match_keys_idx'::regclass)`);
  await q(`select gin_clean_pending_list('matching_listing_facts_match_keys_idx'::regclass)`);
  await q('set local role app_system');
  await q('set local jit = off');
}

/** Warm, then the median of three runs (per-node timing off: its clock calls cost more than the query). */
async function measure(q: AdminQuery, statement: SQL): Promise<{ ms: number; nodes: PlanNode[] }> {
  const query = new PgDialect().sqlToQuery(statement);
  await q(`explain (analyze, format json) ${query.sql}`, query.params);
  const runs: { 'Execution Time': number; Plan: PlanNode }[] = [];
  for (let r = 0; r < 3; r++) {
    const out = await q(`explain (analyze, buffers, timing off, format json) ${query.sql}`, query.params);
    runs.push((Object.values(out[0] ?? {})[0] as { 'Execution Time': number; Plan: PlanNode }[])[0] as never);
  }
  const plan = runs.sort((a, b) => a['Execution Time'] - b['Execution Time'])[1] as (typeof runs)[number];
  const nodes: PlanNode[] = [];
  const walk = (n: PlanNode) => {
    nodes.push(n);
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(plan.Plan);
  return { ms: plan['Execution Time'], nodes };
}

const seqScan = (nodes: PlanNode[], table: string) =>
  nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table);

describe('matching storm statements in a dense market', () => {
  it('[R2-02f] dense market: a listing fills its candidates from its own area; a profile change is planned for its keys', async () => {
    await setupTestDb('worker');
    const r = await withAdminRollback(['client_profiles', 'matching_listing_facts', 'agencies'], async (q) => {
      await seed(q);
      const facts = await q<{
        listing_id: string;
        agency_id: string;
        location_ids: string[];
        property_type_id: string;
        price_cents: string;
        beds: number;
        baths: number;
      }>(
        `select listing_id, agency_id, location_ids, property_type_id, price_cents, beds, baths
           from matching_listing_facts
          where listing_id between '${idJs(LISTING, 0)}' and '${idJs(LISTING, FACTS)}'
            and location_ids[3] = '${idJs(LOC, CITY0)}' and price_cents < 60000000
          order by listing_id limit 5`,
      );
      const probes: ListingMatchProbe[] = facts.map((f) => ({
        listingId: f.listing_id,
        agencyId: f.agency_id,
        version: 2,
        transactionType: 'SALE',
        propertyTypeId: f.property_type_id,
        locationIds: f.location_ids,
        featureIds: [],
        priceCents: Number(f.price_cents),
        beds: f.beds,
        baths: f.baths,
        areaM2: 100,
        shareScope: 'ALL',
        preferredAgencyIds: [],
        tiers: listingEventKeyTiers({
          ownerAgencyId: f.agency_id,
          transactionType: 'SALE',
          locationIds: f.location_ids,
          network: true,
        }),
        network: true,
        vector: null,
        model: null,
      }));
      const listing = await measure(q, listingToProfilesQuery(probes, PROFILES_PER_LISTING));
      const profile = async (loc: number) => {
        const [p] = await q<{
          id: string;
          agency_id: string;
          property_type_ids: string[];
          location_ids: string[];
          price_max_cents: string | null;
          beds_min: number | null;
        }>(
          `select id, agency_id, property_type_ids, location_ids, price_max_cents, beds_min from client_profiles
            where id between '${idJs(PROFILE, 0)}' and '${idJs(PROFILE, PROFILES)}'
              and location_ids = array['${idJs(LOC, loc)}'::uuid] and price_max_cents is null
            order by id limit 1`,
        );
        if (!p) throw new Error(`no profile at ${loc}`);
        const row = {
          id: p.id,
          agencyId: p.agency_id,
          mode: 'REVIEW' as const,
          version: 1,
          transactionType: 'SALE',
          propertyTypeIds: p.property_type_ids,
          locationIds: p.location_ids,
          featureIds: [],
          priceMinCents: null,
          priceMaxCents: null,
          bedsMin: p.beds_min,
          bathsMin: null,
          areaMinM2: null,
          areaMaxM2: null,
        };
        return { ...row, keys: profileProbeKeys(row, true) };
      };
      const dense = await measure(q, narrowProfileToListingsQuery(await profile(REGION), 200));
      // the quietest area: the last city's last area
      const sparse = await measure(q, narrowProfileToListingsQuery(await profile(AREA0 + (CITIES - 1) * 4 + 3), 200));
      return { listing, dense, sparse };
    });
    // listing → profiles: the area tier only, the city's and the region's bitmaps are never built
    const heaps = r.listing.nodes.filter((n) => n['Node Type'] === 'Bitmap Heap Scan');
    const executed = heaps.filter((n) => Number(n['Actual Loops'] ?? 0) > 0);
    const candidates = Number(r.listing.nodes[0]?.['Actual Rows'] ?? 0);
    console.info(
      `[R2-02f] listing → profiles, ${PROFILES} profiles, 5 listings of the busiest city: ${candidates} candidates, ` +
        `${executed.length} of ${heaps.length} tiers read, ${r.listing.ms.toFixed(1)} ms; profile → listings, ${FACTS} ` +
        `facts: region-level ${r.dense.ms.toFixed(1)} ms, quiet area ${r.sparse.ms.toFixed(1)} ms`,
    );
    expect(seqScan(r.listing.nodes, 'client_profiles')).toBe(false);
    expect(candidates).toBe(5 * PROFILES_PER_LISTING);
    expect(heaps).toHaveLength(3);
    expect(executed).toHaveLength(1);
    // five listings in one statement (≈ 15–65 ms on a test box): a generous bound, the plan shape above is the check
    expect(r.listing.ms).toBeLessThan(250);
    // profile → listings: the planner walks the newest facts for a dense key, the GIN entries for a sparse one
    const kinds = (nodes: PlanNode[]) => nodes.map((n) => `${n['Node Type']}:${n['Index Name'] ?? ''}`);
    expect(seqScan(r.dense.nodes, 'matching_listing_facts')).toBe(false);
    expect(seqScan(r.sparse.nodes, 'matching_listing_facts')).toBe(false);
    expect(kinds(r.dense.nodes)).toContain('Index Scan:matching_listing_facts_pkey');
    expect(r.dense.nodes.find((n) => n['Index Name'] === 'matching_listing_facts_pkey')?.['Scan Direction']).toBe(
      'Backward',
    );
    expect(kinds(r.sparse.nodes)).toContain('Bitmap Index Scan:matching_listing_facts_match_keys_idx');
    expect(r.dense.ms).toBeLessThan(20);
    expect(r.sparse.ms).toBeLessThan(20);
  }, 600_000);
});
