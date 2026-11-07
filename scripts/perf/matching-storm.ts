// pnpm perf:matching-storm seed    [--test | --staging] [--agencies N] [--profiles N] [--facts N] [--changes N]
//                                  [--past-matches N]
// pnpm perf:matching-storm run     [--test | --staging] [--changes N] [--concurrency N] [--out file.json]
// pnpm perf:matching-storm plans   [--test | --staging] [--out file.json]
// pnpm perf:matching-storm reset   [--test | --staging]     (the storm's matches go, so `run` can be repeated)
// pnpm perf:matching-storm cleanup [--test | --staging]     (everything the seed wrote goes)
//
// R2-02f, the client-profile matching storm (R2-02 acceptance: 10k listing changes vs 1M profiles in < 10 min). Not
// the S16-01 saved-search storm (`storm.ts matching`, which drives the whole outbox → read model → event path through
// the listing service): this one measures the match engine itself, on a synthetic Costa del Sol market seeded in set-
// based SQL (`generate_series`, never row by row and never through vitest — big seeds crash vitest forks on Windows):
//
// - seed: `--agencies` synthetic agencies (80 % on the Costa del Sol, 20 % noise on the Costa Blanca; 1 in 10 not listed
//   in the directory; all give-to-get exempt), a two-region taxonomy (25 + 20 cities, 4 areas each; the busiest cities
//   Zipf-weighted), `--profiles` client profiles spread evenly over the agencies (30 % OFF, 45 % REVIEW, 25 % AUTO_SEND;
//   5 % anywhere, 5 % a country, 8 % a region, 52 % 1–3 cities, 30 % 1–3 areas; mostly sales; types, budgets, bedroom
//   minimums and must-haves mixed), affinity summaries for 1 in 5 active profiles (half at 40, half at the 128-key
//   cap), `--facts` listing facts (owners Zipf-weighted; 70 % shared with ALL) and `--past-matches` older matches; the
//   first `--changes` listings also get a read model one version on with a 1 % price drop — the change.
// - run: those changed listings through `matching.matchListingsToProfiles` — the `matching.matchListingsToProfiles`
//   job's own entry point, one call per `search.listings.changed` event (its owner's listings, ≤ 100 an event, as the
//   read-model rebuild batches them) — `--concurrency` at a time (the pool's slots; distinct agencies, as the group
//   key allows). Reports wall time, per-event p50 / p95 / max, matches written and INSTANT deliveries that would be
//   queued (profiles with new `QUEUED` matches; counted, not enqueued: nothing is sent).
// - plans: `EXPLAIN (ANALYZE, BUFFERS)` of the hot statements on the seeded data: the listing → profiles probe (5
//   listings of the busiest city), the profile → listings probe of a profile change (a region-level and a city
//   profile, a quiet area's) and of a sweep window, the broad window and the affinity read (500 profiles, all with
//   feedback); JIT off, as the engine runs them.
//
// Synthetic ids all start with `57024f` (namespace in the next two hex digits), so reset and cleanup delete by id
// range. Never in production (`assertLoadTarget`); on staging run it against the staging stack (`--staging`) — see
// docs/runbooks/load-suite.md › Client-profile matching storm.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as matching from '@inmolink/core/modules/matching';
import { closeDb, configureDb, dbEnv, type Tx, withSystem, withSystemClient } from '@inmolink/db';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { type SQL, sql } from 'drizzle-orm';
import pg from 'pg';
import { listingEventKeyTiers, profileProbeKeys } from '../../packages/core/src/modules/matching/match-keys';
import {
  type ListingMatchProbe,
  listingToProfilesQuery,
  type MatchProfileRow,
  narrowProfileToListingsQuery,
  profileToListingsQuery,
} from '../../packages/core/src/modules/matching/repo';
import { readStackEnv } from '../ops/stack-env';
import { assertLoadTarget } from './load-sites';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    test: { type: 'boolean', default: false },
    staging: { type: 'boolean', default: false },
    agencies: { type: 'string' },
    profiles: { type: 'string' },
    facts: { type: 'string' },
    changes: { type: 'string' },
    'past-matches': { type: 'string' },
    concurrency: { type: 'string' },
    out: { type: 'string' },
  },
});

const scenario = positionals[0];
if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) {
    if (v !== undefined) process.env[k] ??= v;
  }
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'perf:matching-storm', level: process.env.LOG_LEVEL ?? 'warn' });

const int = (name: string, v: string | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
};

/* ------------------------------------------------------------------ synthetic ids */

/** Namespaces (the two hex digits after `57024f`). */
const NS = { agency: 1, location: 2, type: 3, feature: 4, profile: 5, listing: 6, match: 8 } as const;
/** A synthetic uuid in SQL: `57024f<ns>-0000-4000-8000-<i as 12 hex digits>`. */
const sid = (ns: number, expr: string) =>
  `('57024f${ns.toString(16).padStart(2, '0')}-0000-4000-8000-' || lpad(to_hex((${expr})::bigint), 12, '0'))::uuid`;
const sidJs = (ns: number, i: number) =>
  `57024f${ns.toString(16).padStart(2, '0')}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const lo = (ns: number) => `'${sidJs(ns, 0)}'::uuid`;
const hi = (ns: number) => `'57024f${ns.toString(16).padStart(2, '0')}-0000-4000-8000-ffffffffffff'::uuid`;
const inNs = (col: string, ns: number) => `${col} between ${lo(ns)} and ${hi(ns)}`;

/** Taxonomy: country 0, regions 1 (Costa del Sol) and 2 (Costa Blanca), cities and their areas. */
const CDS_CITIES = 25;
const CB_CITIES = 20;
const CITY0 = { cds: 16, cb: 64 };
const AREA0 = { cds: 256, cb: 512 };
const TYPES = 8;
const FEATURES = 30;

/* ------------------------------------------------------------------ seed */

/** Rows per seed statement (one transaction each). */
const SEED_CHUNK = 100_000;

async function execSql(reason: string, text: string): Promise<number> {
  return withSystemClient(reason, async (c) => {
    await c.query(`set local statement_timeout = '30min'`);
    const r = await c.query(text);
    return r.rowCount ?? 0;
  });
}

async function chunked(label: string, total: number, build: (from: number, to: number) => string): Promise<void> {
  const t0 = performance.now();
  let n = 0;
  for (let from = 0; from < total; from += SEED_CHUNK) {
    n += await execSql(`perf:matching-storm seed ${label}`, build(from, Math.min(total, from + SEED_CHUNK) - 1));
  }
  console.log(`  ${label}: ${n} rows in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

/** City and area of a place draw (`r`: uniform 0–1, `k`: 0–3) in a region (`cds`: a boolean SQL expression). */
const cityOf = (cds: string, r: string) =>
  `case when ${cds} then ${sid(NS.location, `${CITY0.cds} + least(${CDS_CITIES - 1}, floor(${CDS_CITIES} * power(${r}, 2)))`)}
        else ${sid(NS.location, `${CITY0.cb} + least(${CB_CITIES - 1}, floor(${CB_CITIES} * power(${r}, 2)))`)} end`;
const areaOf = (cds: string, r: string, k: string) =>
  `case when ${cds} then ${sid(NS.location, `${AREA0.cds} + least(${CDS_CITIES - 1}, floor(${CDS_CITIES} * power(${r}, 2))) * 4 + ${k}`)}
        else ${sid(NS.location, `${AREA0.cb} + least(${CB_CITIES - 1}, floor(${CB_CITIES} * power(${r}, 2))) * 4 + ${k}`)} end`;
const typeOf = (r: string) => sid(NS.type, `least(${TYPES - 1}, floor(${TYPES} * power(${r}, 1.5)))`);
const featureOf = (r: string) => sid(NS.feature, `least(${FEATURES - 1}, floor(${FEATURES} * power(${r}, 1.3)))`);

async function seed(): Promise<void> {
  const A = int('agencies', values.agencies, 5_000);
  const P = int('profiles', values.profiles, 1_000_000);
  const F = int('facts', values.facts, 200_000);
  const C = Math.min(F, int('changes', values.changes, 10_000));
  const M = int('past-matches', values['past-matches'], 500_000);
  const cdsAgencies = Math.floor(A * 0.8);
  const perAgency = Math.max(1, Math.floor(P / A));
  console.log(`seeding: ${A} agencies, ${P} profiles, ${F} facts (${C} changed), ${M} past matches`);

  await execSql(
    'perf:matching-storm seed agencies',
    `insert into agencies (agency_id, kind, status, name, languages, give_to_get_exempt, onboarded_at)
     select ${sid(NS.agency, 'i')}, 'AGENCY', case when i % 10 = 9 then 'PENDING' else 'VERIFIED' end::agency_status,
            'Storm R2-02f ' || i, '{en,es}', true, now()
       from generate_series(0, ${A - 1}) i
     on conflict do nothing`,
  );
  // the directory rows (listed = VERIFIED: 1 in 10 not listed) come from the agencies trigger
  // taxonomy: the country, two regions, their cities and four areas a city (parents first)
  await execSql(
    'perf:matching-storm seed taxonomy',
    `insert into locations (id, parent_id, level, depth)
     select ${sid(NS.location, '0')}, null, 'COUNTRY', 1
     union all select ${sid(NS.location, 'r')}, ${sid(NS.location, '0')}, 'REGION', 2 from generate_series(1, 2) r
     on conflict do nothing`,
  );
  await execSql(
    'perf:matching-storm seed taxonomy',
    `insert into locations (id, parent_id, level, depth)
     select ${sid(NS.location, `${CITY0.cds} + c`)}, ${sid(NS.location, '1')}, 'CITY', 3
       from generate_series(0, ${CDS_CITIES - 1}) c
     union all select ${sid(NS.location, `${CITY0.cb} + c`)}, ${sid(NS.location, '2')}, 'CITY', 3
       from generate_series(0, ${CB_CITIES - 1}) c
     on conflict do nothing`,
  );
  await execSql(
    'perf:matching-storm seed taxonomy',
    `insert into locations (id, parent_id, level, depth)
     select ${sid(NS.location, `${AREA0.cds} + c * 4 + k`)}, ${sid(NS.location, `${CITY0.cds} + c`)}, 'AREA', 4
       from generate_series(0, ${CDS_CITIES - 1}) c, generate_series(0, 3) k
     union all select ${sid(NS.location, `${AREA0.cb} + c * 4 + k`)}, ${sid(NS.location, `${CITY0.cb} + c`)}, 'AREA', 4
       from generate_series(0, ${CB_CITIES - 1}) c, generate_series(0, 3) k
     on conflict do nothing`,
  );

  // listing facts: owners Zipf-weighted (feed agencies hold most stock), the place in the owner's region
  await chunked(
    'facts',
    F,
    (from, to) => `
    with b as (
      select i, least(${A - 1}, floor(${A} * power(random(), 1.6)))::int as a, random() as r_city,
             floor(random() * 4)::int as k, random() as r_type, random() as r_tx, random() as r_price,
             random() as r_beds, random() as r_baths, random() as r_m2, random() as r_share, random() as r_nf,
             random() < 0.05 as hidden
        from generate_series(${from}, ${to}) i
    ), c as (
      select b.*, a < ${cdsAgencies} as cds,
             case when r_tx < 0.85 then 'SALE' when r_tx < 0.95 then 'RENT_LONG_TERM' else 'RENT_SHORT_TERM' end as tx
        from b
    ), d as (
      select c.*, ${sid(NS.agency, 'a')} as owner, ${sid(NS.location, '0')} as country,
             case when cds then ${sid(NS.location, '1')} else ${sid(NS.location, '2')} end as region,
             ${cityOf('cds', 'r_city')} as city, ${areaOf('cds', 'r_city', 'k')} as area
        from c
    )
    insert into matching_listing_facts (listing_id, agency_id, version, transaction_type, property_type_id, location_ids,
      feature_ids, price_cents, beds, baths, area_m2, share_scope, preferred_agency_ids, match_keys, updated_at)
    select ${sid(NS.listing, 'i')}, owner, 1, tx, ${typeOf('r_type')}, array[country, region, city, area],
           array(select distinct ${featureOf('random() + 0 * g')} from generate_series(1, floor(r_nf * 9)::int) g
                  order by 1),
           case when tx = 'SALE' then exp(ln(15000000) + r_price * ln(40))::bigint
                else exp(ln(80000) + r_price * ln(8))::bigint end,
           1 + floor(r_beds * 6)::int, 1 + floor(r_baths * 4)::int, round((50 + r_m2 * 550)::numeric, 2),
           case when r_share < 0.7 then 'ALL' else 'PREFERRED' end,
           case when r_share < 0.7 then '{}'::uuid[]
                else array(select ${sid(NS.agency, `floor(random() * ${A}) + 0 * g`)} from generate_series(1, 3 + 0 * i) g) end,
           array(select k from (
                   select 'a:' || owner || ':' || t || ':' || l as k
                     from unnest(array[tx, '*']) t, unnest(array[country::text, region::text, city::text, area::text, '*']) l
                   union
                   select 'n:' || t || ':' || l
                     from unnest(array[tx, '*']) t, unnest(array[country::text, region::text, city::text, area::text, '*']) l
                    where not hidden) s order by k collate "C"),
           now() - (i % 1000) * interval '1 hour'
      from d
    on conflict do nothing`,
  );

  // the changed listings' read models: version 2, the price 1 % lower (one locale, as most of the stock)
  await chunked(
    'read models',
    C,
    (from, to) => `
    insert into listing_read_models (target_id, locale, kind, agency_id, public, status, version, card, detail, etag,
      share_scope, preferred_agency_ids, network_hidden)
    select f.listing_id, 'en', 'LISTING', f.agency_id, true, 'ACTIVE', 2,
           jsonb_build_object('id', f.listing_id, 'kind', 'LISTING', 'ref', 'STORM-' || g.i, 'title', 'STORM-' || g.i,
             'slug', f.listing_id, 'status', 'ACTIVE', 'transactionType', f.transaction_type, 'geo', null,
             'cover', null, 'imageCount', 0, 'plotM2', null, 'builtM2', f.area_m2, 'bedrooms', f.beds,
             'bathrooms', f.baths, 'developmentId', null, 'portalText', null, 'textLocale', null,
             'portalTerraceM2', null,
             'propertyType', jsonb_build_object('id', f.property_type_id, 'name', 'Type', 'slug', 'type'),
             'price', jsonb_build_object('amountCents', (f.price_cents * 99) / 100, 'currency', 'EUR',
                                         'onRequest', false, 'period', null),
             'place', jsonb_build_object(
               'country', jsonb_build_object('id', f.location_ids[1], 'name', 'Spain', 'slug', 'spain'),
               'region', jsonb_build_object('id', f.location_ids[2], 'name', 'Region', 'slug', 'region'),
               'city', jsonb_build_object('id', f.location_ids[3], 'name', 'City', 'slug', 'city'),
               'area', jsonb_build_object('id', f.location_ids[4], 'name', 'Area', 'slug', 'area'))),
           jsonb_build_object('description', null, 'features',
             coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', 'F', 'slug', 'f'))
                         from unnest(f.feature_ids) x), '[]'::jsonb)),
           'storm-' || g.i, f.share_scope, f.preferred_agency_ids, not (f.match_keys && array['n:*:*'])
      from generate_series(${from}, ${to}) g(i)
      join matching_listing_facts f on f.listing_id = ${sid(NS.listing, 'g.i')}
    on conflict do nothing`,
  );

  // client profiles: evenly over the agencies, in their region
  await chunked(
    'profiles',
    P,
    (from, to) => `
    with b as (
      select i, least(${A - 1}, i / ${perAgency})::int as a, random() as r_mode, random() as r_freq, random() as r_tx,
             random() as r_place, random() as r_n, random() as r_types, random() as r_price, random() as r_min,
             random() as r_beds, random() as r_baths, random() as r_m2, random() as r_feat
        from generate_series(${from}, ${to}) i
    ), c as (
      select b.*, a < ${cdsAgencies} as cds, ${sid(NS.agency, 'a')} as agency,
             case when r_tx < 0.80 then 'SALE' when r_tx < 0.95 then 'RENT_LONG_TERM' else null end as tx
        from b
    ), d as (
      select c.*,
             case when r_place < 0.05 then '{}'::uuid[]
                  when r_place < 0.10 then array[${sid(NS.location, '0')}]
                  when r_place < 0.18 then array[case when cds then ${sid(NS.location, '1')} else ${sid(NS.location, '2')} end]
                  when r_place < 0.70 then array(select distinct ${cityOf('cds', 'random() + 0 * g')}
                                                   from generate_series(0, floor(r_n * 3)::int) g)
                  else array(select distinct ${areaOf('cds', 'random() + 0 * g', 'floor(random() * 4)::int')}
                               from generate_series(0, floor(r_n * 3)::int) g) end as places,
             case when tx = 'RENT_LONG_TERM' then exp(ln(100000) + r_price * ln(6))::bigint
                  else exp(ln(20000000) + r_price * ln(25))::bigint end as pmax
        from c
    )
    insert into client_profiles (id, agency_id, contact_id, mode, frequency, transaction_type, property_type_ids,
      location_ids, feature_ids, price_min_cents, price_max_cents, beds_min, baths_min, area_min_m2, match_keys,
      created_at, updated_at)
    select ${sid(NS.profile, 'i')}, agency, gen_random_uuid(),
           case when r_mode < 0.30 then 'OFF' when r_mode < 0.75 then 'REVIEW' else 'AUTO_SEND' end,
           case when r_freq < 0.4 then 'INSTANT' when r_freq < 0.8 then 'DAILY' else 'WEEKLY' end,
           tx,
           case when r_types < 0.30 then '{}'::uuid[]
                else array(select distinct ${typeOf('random() + 0 * g')} from generate_series(0, floor(r_types * 2)::int) g) end,
           places,
           case when r_feat < 0.65 then '{}'::uuid[]
                else array(select distinct ${featureOf('random() + 0 * g')} from generate_series(0, least(2, floor((r_feat - 0.65) / 0.35 * 3))::int) g) end,
           case when r_min < 0.4 then pmax / 2 else null end,
           case when r_min < 0.8 then pmax else null end,
           case when r_beds < 0.7 then 1 + floor(r_beds * 4)::int else null end,
           case when r_baths < 0.3 then 1 + floor(r_baths * 6)::int else null end,
           case when r_m2 < 0.2 then round((60 + r_m2 * 1000)::numeric, 2) else null end,
           array(select k from (
                   select 'a:' || agency || ':' || coalesce(tx, '*') || ':' || l as k
                     from unnest(case when cardinality(places) = 0 then array['*'] else places::text[] end) l
                   union
                   select 'n:' || coalesce(tx, '*') || ':' || l
                     from unnest(case when cardinality(places) = 0 then array['*'] else places::text[] end) l) s
                 order by k collate "C"),
           now() - (i % 4320) * interval '1 hour', now() - (i % 4320) * interval '1 hour'
      from d
    on conflict do nothing`,
  );

  // affinity summaries: 1 in 5 active profiles, half at 40 keys, half at the 128-key cap
  await chunked(
    'affinities',
    P,
    (from, to) => `
    insert into client_profile_affinities (profile_id, agency_id, keys, likes, dislikes)
    select p.id, p.agency_id, s.keys, array_fill(1, array[cardinality(s.keys)]),
           array_fill(0, array[cardinality(s.keys)])
      from client_profiles p
      cross join lateral (
        select array(select distinct (random() * 2147483647 + 0 * g)::int
                       from generate_series(1, case when (('x' || right(p.id::text, 8))::bit(32)::int) % 10 = 0 then 40 else 128 end) g
                      order by 1) as keys) s
     where p.id between ${sid(NS.profile, from.toString())} and ${sid(NS.profile, to.toString())}
       and p.mode <> 'OFF' and (('x' || right(p.id::text, 8))::bit(32)::int) % 5 = 0
    on conflict do nothing`,
  );

  // past matches: random pairs of profiles and the unchanged listings (the pair index at its working size)
  if (M > 0 && F > C) {
    await chunked(
      'past matches',
      M,
      (from, to) => `
      with pairs as (
        select g.i, floor(random() * ${P})::int as p, ${C} + floor(random() * ${F - C})::int as l
          from generate_series(${from}, ${to}) g(i)
      )
      insert into client_profile_matches (id, agency_id, profile_id, listing_id, listing_agency_id, listing_version,
        profile_version, hard_score, semantic_score, boost_score, total_score, explanation, status, created_at, updated_at)
      select ${sid(NS.match, 'pairs.i')}, p.agency_id, p.id, f.listing_id, f.agency_id, 1, 1, 0.9, null, 0, 0.78,
             '{"v": 1, "criteria": [{"ok": true, "key": "transaction", "score": 1}, {"ok": true, "key": "propertyType", "score": 1}, {"ok": true, "key": "location", "score": 1}, {"ok": true, "key": "price", "score": 1}, {"ok": true, "key": "bedrooms", "score": 1}], "satisfied": ["transaction", "propertyType", "location", "price", "bedrooms"], "unsatisfied": [], "priceDeltaPct": -7, "priceOnRequest": false}'::jsonb,
             case when pairs.i % 4 = 0 then 'SENT' when pairs.i % 4 = 1 then 'DISMISSED' else 'PENDING_REVIEW' end,
             now() - (pairs.i % 2000) * interval '1 hour', now() - (pairs.i % 2000) * interval '1 hour'
        from pairs
        join client_profiles p on p.id = ${sid(NS.profile, 'pairs.p')}
        join matching_listing_facts f on f.listing_id = ${sid(NS.listing, 'pairs.l')}
      on conflict do nothing`,
    );
  }
  await maintain();
}

/** VACUUM ANALYZE of the seeded tables (flushes the GIN pending lists): needs the table owner — the admin URL. */
async function maintain(): Promise<void> {
  const url = process.env.DATABASE_URL_ADMIN;
  if (!url) {
    console.log('  DATABASE_URL_ADMIN unset: run VACUUM ANALYZE on the matching tables before measuring');
    return;
  }
  const t0 = performance.now();
  const c = new pg.Client({ connectionString: url, application_name: 'perf:matching-storm' });
  await c.connect();
  try {
    for (const t of [
      'client_profiles',
      'matching_listing_facts',
      'client_profile_matches',
      'client_profile_affinities',
      'listing_read_models',
      'agencies',
      'agency_directory',
      'locations',
    ]) {
      await c.query(`vacuum (analyze) ${t}`);
    }
  } finally {
    await c.end();
  }
  console.log(`  vacuum analyze: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

/* ------------------------------------------------------------------ run */

interface StormEvent {
  agencyId: string;
  listingIds: string[];
}

/** The changed listings as `search.listings.changed` events: per owner, ≤ 100 an event (the rebuild's batches). */
async function stormEvents(limit: number): Promise<StormEvent[]> {
  const rows = await withSystem(
    'perf:matching-storm events',
    async (tx) =>
      (
        await tx.execute<{ agency_id: string; target_id: string }>(
          sql.raw(`select agency_id, target_id from listing_read_models
                  where ${inNs('target_id', NS.listing)} and locale = 'en' and version = 2
                  order by target_id limit ${limit}`),
        )
      ).rows,
  );
  const byOwner = new Map<string, string[]>();
  for (const r of rows) byOwner.set(r.agency_id, [...(byOwner.get(r.agency_id) ?? []), r.target_id]);
  const events: StormEvent[] = [];
  for (const [agencyId, ids] of byOwner) {
    for (let i = 0; i < ids.length; i += 100) events.push({ agencyId, listingIds: ids.slice(i, i + 100) });
  }
  // interleave the agencies (the dispatcher shares fairly between them)
  return events.sort((a, b) => a.listingIds.length - b.listingIds.length || (a.agencyId < b.agencyId ? -1 : 1));
}

/** R2-02 acceptance: 10k listing changes processed in under 10 minutes (linear in the changes when fewer are run). */
const STORM_BUDGET_MS = 10 * 60_000;

const pct = (sorted: readonly number[], p: number) =>
  sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0);

async function run(): Promise<object> {
  const changes = int('changes', values.changes, 10_000);
  const concurrency = Math.max(1, int('concurrency', values.concurrency, 1));
  const events = await stormEvents(changes);
  const listings = events.reduce((s, e) => s + e.listingIds.length, 0);
  const profiles = await withSystem('perf:matching-storm count', async (tx) =>
    Number(
      (
        await tx.execute<{ n: string }>(
          sql.raw(`select count(*) as n from client_profiles where ${inNs('id', NS.profile)} and mode <> 'OFF'`),
        )
      ).rows[0]?.n ?? 0,
    ),
  );
  console.log(
    `storm: ${listings} listing changes in ${events.length} events vs ${profiles} active profiles, ${concurrency} at a time`,
  );
  const times: number[] = [];
  const perListing: number[] = [];
  let candidates = 0;
  let matched = 0;
  let queuedEntries = 0;
  const queuedProfiles = new Set<string>();
  let next = 0;
  const t0 = performance.now();
  const slot = async () => {
    while (next < events.length) {
      const e = events[next++];
      if (!e) break;
      const s = performance.now();
      const r = await matching.matchListingsToProfiles(e);
      const ms = performance.now() - s;
      times.push(ms);
      perListing.push(ms / e.listingIds.length);
      candidates += r.candidates;
      matched += r.matched;
      queuedEntries += r.queued.length;
      for (const q of r.queued) queuedProfiles.add(q.profileId);
      if (times.length % 100 === 0) {
        console.log(`  ${times.length}/${events.length} events, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, slot));
  const wallMs = performance.now() - t0;
  const sorted = [...times].sort((a, b) => a - b);
  const sortedL = [...perListing].sort((a, b) => a - b);
  const report = {
    listings,
    events: events.length,
    activeProfiles: profiles,
    concurrency,
    wallMs: Math.round(wallMs),
    eventMs: { p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted.at(-1) ?? 0 },
    msPerListing: { mean: wallMs / Math.max(1, listings), p50: pct(sortedL, 50), p95: pct(sortedL, 95) },
    candidates,
    matched,
    deliveriesQueued: { entries: queuedEntries, profiles: queuedProfiles.size },
    extrapolated10kMs: Math.round((wallMs / Math.max(1, listings)) * 10_000),
    budgetMs: STORM_BUDGET_MS,
  };
  console.log(JSON.stringify(report, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v), 2));
  const pass = report.extrapolated10kMs <= STORM_BUDGET_MS;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}: 10k changes ${(report.extrapolated10kMs / 1000).toFixed(0)} s (budget ${STORM_BUDGET_MS / 1000} s)`,
  );
  if (!pass) process.exitCode = 1;
  return report;
}

/* ------------------------------------------------------------------ plans */

async function explain(tx: Tx, label: string, q: SQL): Promise<{ label: string; ms: number; plan: string }> {
  const res = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (analyze, buffers) ${q}`);
  const plan = res.rows.map((r) => r['QUERY PLAN']).join('\n');
  const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? Number.NaN);
  const seq = [...plan.matchAll(/Seq Scan on (\w+)/g)].map((m) => m[1]);
  console.log(`\n=== ${label}: ${ms} ms${seq.length ? ` · Seq Scan on ${seq.join(', ')}` : ''}\n${plan}`);
  return { label, ms, plan };
}

interface RawFacts {
  listing_id: string;
  agency_id: string;
  version: number;
  transaction_type: string;
  property_type_id: string;
  location_ids: string[];
  feature_ids: string[];
  price_cents: string | null;
  beds: number | null;
  baths: number | null;
  area_m2: string | null;
  share_scope: 'ALL' | 'PREFERRED';
  preferred_agency_ids: string[];
}

const PROFILE_COLS = `id, agency_id as "agencyId", mode, version, transaction_type as "transactionType",
  property_type_ids as "propertyTypeIds", location_ids as "locationIds", feature_ids as "featureIds",
  price_min_cents::float8 as "priceMinCents", price_max_cents::float8 as "priceMaxCents", beds_min as "bedsMin",
  baths_min as "bathsMin", area_min_m2::float8 as "areaMinM2", area_max_m2::float8 as "areaMaxM2"`;

async function plans(): Promise<object> {
  const out: { label: string; ms: number; plan: string }[] = [];
  await withSystem(
    'perf:matching-storm plans',
    async (tx) => {
      // listing → profiles: 5 listings of the busiest city (the event direction's statement)
      const facts = (
        await tx.execute<RawFacts>(
          sql.raw(`select listing_id, agency_id, version, transaction_type, property_type_id, location_ids, feature_ids,
                        price_cents, beds, baths, area_m2, share_scope, preferred_agency_ids
                   from matching_listing_facts
                  where ${inNs('listing_id', NS.listing)} and location_ids[3] = '${sidJs(NS.location, CITY0.cds)}'
                    and transaction_type = 'SALE' and share_scope = 'ALL'
                  order by listing_id desc limit 5`),
        )
      ).rows;
      const probes: ListingMatchProbe[] = facts.map((f) => {
        const row = {
          listingId: f.listing_id,
          agencyId: f.agency_id,
          version: f.version,
          transactionType: f.transaction_type,
          propertyTypeId: f.property_type_id,
          locationIds: f.location_ids,
          featureIds: f.feature_ids,
          priceCents: f.price_cents === null ? null : Number(f.price_cents),
          beds: f.beds,
          baths: f.baths,
          areaM2: f.area_m2 === null ? null : Number(f.area_m2),
          shareScope: f.share_scope,
          preferredAgencyIds: f.preferred_agency_ids,
        };
        return {
          ...row,
          tiers: listingEventKeyTiers({
            ownerAgencyId: f.agency_id,
            transactionType: f.transaction_type,
            locationIds: f.location_ids,
            network: true,
          }),
          network: true,
          vector: null,
          model: null,
        };
      });
      out.push(
        await explain(
          tx,
          'listing → profiles, 1 listing of the busiest city',
          listingToProfilesQuery(probes.slice(0, 1), 500),
        ),
      );
      out.push(
        await explain(tx, 'listing → profiles, 5 listings of the busiest city', listingToProfilesQuery(probes, 500)),
      );

      const profilesOf = async (where: string, limit: number) =>
        (
          await tx.execute<MatchProfileRow>(
            sql.raw(`select ${PROFILE_COLS} from client_profiles
                    where ${inNs('id', NS.profile)} and mode <> 'OFF' and ${where} order by id limit ${limit}`),
          )
        ).rows.map((p) => ({ ...p, keys: profileProbeKeys(p, true) }));
      const one = async (where: string) => {
        const [p] = await profilesOf(where, 1);
        if (!p) throw new Error(`no seeded profile where ${where}`);
        return p;
      };
      const sale = `transaction_type = 'SALE' and cardinality(location_ids) = 1`;
      const region = `${sale} and location_ids[1] = '${sidJs(NS.location, 1)}'`;
      const city = `${sale} and location_ids[1] = '${sidJs(NS.location, CITY0.cds)}'`;
      const area = `${sale} and location_ids[1] = '${sidJs(NS.location, AREA0.cds + 5 * 4 + 2)}' and beds_min >= 3`;
      const since = new Date(Date.now() - 2 * 86_400_000);
      out.push(
        await explain(
          tx,
          'profile change: a region-level profile',
          narrowProfileToListingsQuery(await one(region), 200),
        ),
      );
      out.push(
        await explain(
          tx,
          'profile change: a profile of the busiest city',
          narrowProfileToListingsQuery(await one(city), 200),
        ),
      );
      out.push(
        await explain(
          tx,
          'profile change: a profile of a quiet area',
          narrowProfileToListingsQuery(await one(area), 200),
        ),
      );
      out.push(
        await explain(
          tx,
          'sweep window: a region-level profile, facts of the last 2 days',
          narrowProfileToListingsQuery(await one(region), 200, { since }),
        ),
      );
      out.push(
        await explain(
          tx,
          'broad: 20 profiles anywhere',
          profileToListingsQuery(await profilesOf(`cardinality(location_ids) = 0`, 20), 200, { broad: true }),
        ),
      );
      // the affinity read at its worst: 500 profiles, all with a summary
      out.push(
        await explain(
          tx,
          'affinities: 500 profiles, all with feedback',
          sql.raw(`select profile_id, keys, likes, dislikes from client_profile_affinities
                  where profile_id = any(array(select profile_id from client_profile_affinities
                                                where ${inNs('profile_id', NS.profile)} order by profile_id desc limit 500))`),
        ),
      );
    },
    { jit: false },
  );
  console.log('\n--- summary');
  for (const p of out) console.log(`${p.ms.toFixed(1).padStart(8)} ms  ${p.label}`);
  return out;
}

/* ------------------------------------------------------------------ reset / cleanup */

const DELETE_CHUNK = 50_000;

/** Deletes `table`'s synthetic rows by `col` in id-range chunks (each its own transaction). */
async function deleteRange(table: string, col: string, ns: number, extra = ''): Promise<number> {
  let n = 0;
  for (;;) {
    const d = await execSql(
      `perf:matching-storm cleanup ${table}`,
      `delete from ${table} where ctid = any(array(select ctid from ${table} where ${inNs(col, ns)} ${extra}
                                                    limit ${DELETE_CHUNK}))`,
    );
    n += d;
    if (d < DELETE_CHUNK) break;
  }
  console.log(`  ${table}: ${n}`);
  return n;
}

async function reset(): Promise<void> {
  // the storm's matches: every match of a synthetic profile that is not a seeded past match
  await deleteRange('client_profile_matches', 'profile_id', NS.profile, `and not (${inNs('id', NS.match)})`);
}

async function cleanup(): Promise<void> {
  await deleteRange('client_profile_matches', 'profile_id', NS.profile);
  // anything the engine wrote for synthetic listings to real profiles (none expected: other agencies' profiles never
  // share a key with the synthetic places)
  await deleteRange('client_profile_matches', 'listing_id', NS.listing);
  await deleteRange('client_profile_affinities', 'profile_id', NS.profile);
  await deleteRange('client_profiles', 'id', NS.profile);
  await deleteRange('listing_read_models', 'target_id', NS.listing);
  await deleteRange('matching_listing_facts', 'listing_id', NS.listing);
  await execSql(
    'perf:matching-storm cleanup locations',
    `delete from locations where ${inNs('id', NS.location)} and level = 'AREA'`,
  );
  await execSql(
    'perf:matching-storm cleanup locations',
    `delete from locations where ${inNs('id', NS.location)} and level = 'CITY'`,
  );
  await execSql(
    'perf:matching-storm cleanup locations',
    `delete from locations where ${inNs('id', NS.location)} and level = 'REGION'`,
  );
  await execSql('perf:matching-storm cleanup locations', `delete from locations where ${inNs('id', NS.location)}`);
  await deleteRange('agency_directory', 'agency_id', NS.agency);
  await deleteRange('agencies', 'agency_id', NS.agency);
  await maintain();
}

/* ------------------------------------------------------------------ main */

let pass = false;
try {
  if (!['seed', 'run', 'plans', 'reset', 'cleanup'].includes(scenario ?? '')) {
    throw new Error('usage: matching-storm seed|run|plans|reset|cleanup [--test|--staging] …');
  }
  assertLoadTarget(process.env, values.staging);
  await configureDb(loadConfigOrExit(dbEnv), { logger: log });
  let report: object | null = null;
  if (scenario === 'seed') await seed();
  else if (scenario === 'run') report = await run();
  else if (scenario === 'plans') report = await plans();
  else if (scenario === 'reset') await reset();
  else await cleanup();
  if (report && values.out) writeFileSync(values.out, JSON.stringify(report, null, 2));
  pass = process.exitCode !== 1;
} catch (err) {
  console.error(err);
} finally {
  await closeDb();
  process.exitCode = pass ? 0 : 1;
}
