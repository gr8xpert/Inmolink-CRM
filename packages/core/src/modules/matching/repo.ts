import type { Tx } from '@inmolink/db';
import { matchingListingStates, savedSearchAlerts, savedSearches } from '@inmolink/db/schema/matching';
import { NIL_UUID as NIL } from '@inmolink/platform/tenancy';
import { and, asc, eq, type SQL, sql } from 'drizzle-orm';

/**
 * matching queries (PATTERNS §5). Takes `tx`, selects only the columns it needs. Queries only
 * `@inmolink/db/schema/matching`. Request paths read the member's own saved searches under RLS; the worker reads and
 * writes as `app_system`.
 */

/* ------------------------------------------------------------------ saved searches */

export interface SavedSearchRow {
  id: string;
  name: string;
  scope: string;
  frequency: string;
  alertNew: boolean;
  alertPriceDrop: boolean;
  alertBackOnMarket: boolean;
  transactionType: string | null;
  propertyTypeIds: string[];
  locationIds: string[];
  featureIds: string[];
  priceMinCents: number | null;
  priceMaxCents: number | null;
  bedsMin: number | null;
  bathsMin: number | null;
  areaMinM2: number | null;
  areaMaxM2: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SavedSearchFields = Omit<SavedSearchRow, 'id' | 'createdAt' | 'updatedAt'> & { matchKeys: string[] };

const columns = {
  id: savedSearches.id,
  name: savedSearches.name,
  scope: savedSearches.scope,
  frequency: savedSearches.frequency,
  alertNew: savedSearches.alertNew,
  alertPriceDrop: savedSearches.alertPriceDrop,
  alertBackOnMarket: savedSearches.alertBackOnMarket,
  transactionType: savedSearches.transactionType,
  propertyTypeIds: savedSearches.propertyTypeIds,
  locationIds: savedSearches.locationIds,
  featureIds: savedSearches.featureIds,
  priceMinCents: savedSearches.priceMinCents,
  priceMaxCents: savedSearches.priceMaxCents,
  bedsMin: savedSearches.bedsMin,
  bathsMin: savedSearches.bathsMin,
  areaMinM2: savedSearches.areaMinM2,
  areaMaxM2: savedSearches.areaMaxM2,
  createdAt: savedSearches.createdAt,
  updatedAt: savedSearches.updatedAt,
};

const mine = (agencyId: string, userId: string, id?: string): SQL | undefined =>
  and(
    eq(savedSearches.agencyId, agencyId),
    eq(savedSearches.userId, userId),
    ...(id === undefined ? [] : [eq(savedSearches.id, id)]),
  );

/** The member's saved searches, oldest first (`saved_searches_user_idx`), at most `max`. */
export function savedSearchesOf(tx: Tx, agencyId: string, userId: string, max: number): Promise<SavedSearchRow[]> {
  return tx
    .select(columns)
    .from(savedSearches)
    .where(mine(agencyId, userId))
    .orderBy(asc(savedSearches.createdAt), asc(savedSearches.id))
    .limit(max);
}

export async function savedSearchOf(
  tx: Tx,
  agencyId: string,
  userId: string,
  id: string,
): Promise<SavedSearchRow | null> {
  const [row] = await tx
    .select(columns)
    .from(savedSearches)
    .where(mine(agencyId, userId, id));
  return row ?? null;
}

const uuids = (v: readonly string[]) =>
  v.length === 0
    ? sql`'{}'::uuid[]`
    : sql`array[${sql.join(
        v.map((x) => sql`${x}`),
        sql`, `,
      )}]::uuid[]`;
const texts = (v: readonly string[]) =>
  sql`array[${sql.join(
    v.map((x) => sql`${x}`),
    sql`, `,
  )}]::text[]`;

/**
 * A saved search of the member, unless they have `max` already (one statement: the count and the insert). Null at
 * the limit.
 */
export async function insertSavedSearch(
  tx: Tx,
  s: SavedSearchFields & { agencyId: string; id: string; userId: string; max: number },
): Promise<SavedSearchRow | null> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into ${savedSearches}
      (id, agency_id, user_id, name, scope, frequency, alert_new, alert_price_drop, alert_back_on_market,
       transaction_type, property_type_ids, location_ids, feature_ids, price_min_cents, price_max_cents, beds_min,
       baths_min, area_min_m2, area_max_m2, match_keys)
    select ${s.id}::uuid, ${s.agencyId}::uuid, ${s.userId}::uuid, ${s.name}, ${s.scope}, ${s.frequency},
           ${s.alertNew}, ${s.alertPriceDrop}, ${s.alertBackOnMarket}, ${s.transactionType},
           ${uuids(s.propertyTypeIds)}, ${uuids(s.locationIds)}, ${uuids(s.featureIds)},
           ${s.priceMinCents}::bigint, ${s.priceMaxCents}::bigint, ${s.bedsMin}::int, ${s.bathsMin}::int,
           ${s.areaMinM2}::numeric, ${s.areaMaxM2}::numeric, ${texts(s.matchKeys)}
     where (select count(*) from ${savedSearches} n
             where n.agency_id = ${s.agencyId} and n.user_id = ${s.userId}) < ${s.max}
    returning id`);
  if (result.rows.length === 0) return null;
  return savedSearchOf(tx, s.agencyId, s.userId, s.id);
}

/** The member's saved search replaced (null: not theirs). */
export async function updateSavedSearch(
  tx: Tx,
  agencyId: string,
  userId: string,
  id: string,
  s: SavedSearchFields,
): Promise<SavedSearchRow | null> {
  const [row] = await tx
    .update(savedSearches)
    .set({ ...s, updatedAt: sql`now()` })
    .where(mine(agencyId, userId, id))
    .returning(columns);
  return row ?? null;
}

/** Deletes the member's saved search (its alerts go with it). False: not theirs. */
export async function deleteSavedSearch(tx: Tx, agencyId: string, userId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(savedSearches)
    .where(mine(agencyId, userId, id))
    .returning({ id: savedSearches.id });
  return rows.length > 0;
}

/* ------------------------------------------------------------------ listing states (worker) */

/** The last state matching saw of these listings (PK probes), locked against a concurrent job's write. */
export async function statesFor(
  tx: Tx,
  listingIds: readonly string[],
): Promise<Map<string, { status: string; priceCents: number | null; version: number }>> {
  if (listingIds.length === 0) return new Map();
  const res = await tx.execute<{ listing_id: string; status: string; price_cents: string | null; version: number }>(sql`
    select listing_id, status, price_cents, version from ${matchingListingStates}
     where listing_id = any(${uuids(listingIds)}) for update`);
  return new Map(
    res.rows.map((r) => [
      r.listing_id,
      { status: r.status, priceCents: r.price_cents === null ? null : Number(r.price_cents), version: r.version },
    ]),
  );
}

export interface StateRow {
  listingId: string;
  agencyId: string;
  status: string;
  priceCents: number | null;
  version: number;
}

/** Writes the states seen now (one statement); never moves a state back to an older version. */
export async function upsertStates(tx: Tx, rows: readonly StateRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`
    insert into ${matchingListingStates} (listing_id, agency_id, status, price_cents, version)
    select listing_id, agency_id, status, price_cents, version
      from jsonb_to_recordset(${JSON.stringify(rows.map((r) => ({ listing_id: r.listingId, agency_id: r.agencyId, status: r.status, price_cents: r.priceCents, version: r.version })))}::jsonb)
        as x(listing_id uuid, agency_id uuid, status text, price_cents bigint, version int)
    on conflict (listing_id) do update
      set status = excluded.status, price_cents = excluded.price_cents, version = excluded.version, updated_at = now()
      where excluded.version >= ${matchingListingStates.version}
        and (excluded.status, excluded.price_cents, excluded.version)
            is distinct from (${matchingListingStates.status}, ${matchingListingStates.priceCents}, ${matchingListingStates.version})`);
}

/** Marks these seen listings GONE (no read model any more): only rows that exist (one statement). */
export async function markGone(tx: Tx, listingIds: readonly string[]): Promise<void> {
  if (listingIds.length === 0) return;
  await tx.execute(sql`
    update ${matchingListingStates} set status = 'GONE', updated_at = now()
     where listing_id = any(${uuids(listingIds)}) and status <> 'GONE'`);
}

/** Writes the states of listings matching has not seen yet (backfill, one statement); answers how many. */
export async function insertMissingStates(tx: Tx, rows: readonly StateRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const json = JSON.stringify(
    rows.map((r) => ({
      listing_id: r.listingId,
      agency_id: r.agencyId,
      status: r.status,
      price_cents: r.priceCents,
      version: r.version,
    })),
  );
  const res = await tx.execute(sql`
    insert into ${matchingListingStates} (listing_id, agency_id, status, price_cents, version)
    select listing_id, agency_id, status, price_cents, version
      from jsonb_to_recordset(${json}::jsonb)
        as x(listing_id uuid, agency_id uuid, status text, price_cents bigint, version int)
    on conflict (listing_id) do nothing`);
  return res.rowCount ?? 0;
}

/* ------------------------------------------------------------------ match keys (worker) */

export interface KeyedSearch {
  id: string;
  agencyId: string;
  scope: string;
  transactionType: string | null;
  locationIds: string[];
  matchKeys: string[];
}

/** The agency's saved searches with their keys (`saved_searches_user_idx` prefix; ≤ members × 50). */
export async function searchesOfAgency(tx: Tx, agencyId: string): Promise<KeyedSearch[]> {
  return tx
    .select({
      id: savedSearches.id,
      agencyId: savedSearches.agencyId,
      scope: savedSearches.scope,
      transactionType: savedSearches.transactionType,
      locationIds: savedSearches.locationIds,
      matchKeys: savedSearches.matchKeys,
    })
    .from(savedSearches)
    .where(eq(savedSearches.agencyId, agencyId));
}

/** Rewrites these searches' keys (one statement); answers how many changed. */
export async function setMatchKeys(tx: Tx, rows: readonly { id: string; keys: string[] }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await tx.execute(sql`
    update ${savedSearches} s set match_keys = x.keys
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(id uuid, keys text[])
     where s.id = x.id and s.match_keys is distinct from x.keys`);
  return res.rowCount ?? 0;
}

/** Agencies with saved searches after `after` (a loose scan of `saved_searches_user_idx`), at most `limit`. */
export async function agenciesWithSearches(tx: Tx, after: string | null, limit: number): Promise<string[]> {
  const res = await tx.execute<{ agency_id: string }>(sql`
    with recursive a as (
      (select agency_id from ${savedSearches}
        where agency_id > coalesce(${after}::uuid, ${NIL}::uuid)
        order by agency_id limit 1)
      union all
      select (select agency_id from ${savedSearches} x where x.agency_id > a.agency_id order by x.agency_id limit 1)
        from a where a.agency_id is not null)
    select agency_id from a where agency_id is not null limit ${limit}`);
  return res.rows.map((r) => r.agency_id);
}

/* ------------------------------------------------------------------ matching (worker) */

/** One changed listing as the matching query probes it. */
export interface ListingProbe {
  listingId: string;
  ownerAgencyId: string;
  kind: 'NEW' | 'PRICE_DROP' | 'BACK_ON_MARKET';
  /** `listingKeys`: the owner's own searches, and the network's when other agencies may see it. */
  keys: string[];
  transactionType: string;
  locationIds: string[];
  propertyTypeId: string;
  featureIds: string[];
  /** Null: price on request (matches no price bound). */
  priceCents: number | null;
  beds: number | null;
  baths: number | null;
  areaM2: number | null;
  /** Other agencies may see it (on the network, not hidden, its owner listed). */
  network: boolean;
  shareAll: boolean;
  preferredAgencyIds: string[];
}

export type Candidate = {
  listingId: string;
  savedSearchId: string;
  agencyId: string;
  userId: string;
  frequency: 'INSTANT' | 'DAILY';
};

/**
 * Listings probed per statement (perf review: no row cap that could cut matches short). A statement answers every
 * match of its listings; a batch of 100 is twenty statements, each bounded by the searches that may see 5 listings (~3 ms a listing at the
 * scale seed, tests/perf/saved-search-matching).
 */
export const PROBE_CHUNK = 5;

/**
 * Every saved search these changed listings match (S5-06), any agency. The listings come in as a `jsonb_to_recordset`; each probes `saved_searches_match_keys_idx` (GIN,
 * `match_keys && keys`) with its keys — its owner's own searches for its transaction type, and, only when other
 * agencies may see it, the network searches for its transaction type at one of its places (or any, anywhere) — so a
 * search of another agency's own stock, or of a place it is not in, is never read. The remaining criteria (places
 * and transaction of own searches, types, features, ranges, the alert kind, sharing) are checked on those candidates
 * only. Exported for the plan tests.
 */
export function matchQuery(probes: readonly ListingProbe[]): SQL {
  const json = JSON.stringify(
    probes.map((p) => ({
      listing_id: p.listingId,
      owner: p.ownerAgencyId,
      kind: p.kind,
      keys: p.keys,
      transaction_type: p.transactionType,
      location_ids: p.locationIds,
      property_type_id: p.propertyTypeId,
      feature_ids: p.featureIds,
      price_cents: p.priceCents,
      beds: p.beds,
      baths: p.baths,
      area_m2: p.areaM2,
      network: p.network,
      share_all: p.shareAll,
      preferred: p.preferredAgencyIds,
    })),
  );
  return sql`
    select l.listing_id as "listingId", s.id as "savedSearchId", s.agency_id as "agencyId", s.user_id as "userId",
           s.frequency
      from jsonb_to_recordset(${json}::jsonb) as l(listing_id uuid, owner uuid, kind text, keys text[],
             transaction_type text, location_ids uuid[], property_type_id uuid, feature_ids uuid[], price_cents bigint,
             beds int, baths int, area_m2 numeric, network boolean, share_all boolean, preferred uuid[])
      join ${savedSearches} s on s.match_keys && l.keys and s.frequency <> 'OFF'
     where case l.kind when 'NEW' then s.alert_new when 'PRICE_DROP' then s.alert_price_drop
                       else s.alert_back_on_market end
       and (s.transaction_type is null or s.transaction_type = l.transaction_type)
       and (cardinality(s.location_ids) = 0 or s.location_ids && l.location_ids)
       and (cardinality(s.property_type_ids) = 0 or l.property_type_id = any(s.property_type_ids))
       and s.feature_ids <@ l.feature_ids
       and (s.price_min_cents is null or l.price_cents >= s.price_min_cents)
       and (s.price_max_cents is null or l.price_cents <= s.price_max_cents)
       and (s.beds_min is null or l.beds >= s.beds_min)
       and (s.baths_min is null or l.baths >= s.baths_min)
       and (s.area_min_m2 is null or l.area_m2 >= s.area_min_m2)
       and (s.area_max_m2 is null or l.area_m2 <= s.area_max_m2)
       and case when s.agency_id = l.owner then s.scope <> 'NETWORK'
                else s.scope <> 'OWN' and l.network and (l.share_all or s.agency_id = any(l.preferred)) end`;
}

/** Every saved search these listings match, `chunk` listings per statement (no cap on the matches). */
export async function matchCandidates(
  tx: Tx,
  probes: readonly ListingProbe[],
  chunk: number = PROBE_CHUNK,
): Promise<Candidate[]> {
  const all: Candidate[] = [];
  for (let i = 0; i < probes.length; i += chunk) {
    all.push(...(await tx.execute<Candidate>(matchQuery(probes.slice(i, i + chunk)))).rows);
  }
  return all;
}

/* ------------------------------------------------------------------ alerts (worker) */

export interface NewAlert {
  id: string;
  agencyId: string;
  userId: string;
  savedSearchId: string;
  listingId: string;
  kind: string;
  dedupeKey: number;
  ref: string;
  priceCents: number | null;
  previousPriceCents: number | null;
}

/**
 * Writes the alerts, waiting to be sent (one statement); a saved search, listing, kind and state alerted already is
 * skipped (`saved_search_alerts_dedupe_uq`). Answers how many were written now, and their agencies.
 */
export async function insertAlerts(
  tx: Tx,
  alerts: readonly NewAlert[],
): Promise<{ written: number; agencies: string[] }> {
  if (alerts.length === 0) return { written: 0, agencies: [] };
  const json = JSON.stringify(
    alerts.map((a) => ({
      id: a.id,
      agency_id: a.agencyId,
      user_id: a.userId,
      saved_search_id: a.savedSearchId,
      listing_id: a.listingId,
      kind: a.kind,
      dedupe_key: a.dedupeKey,
      ref: a.ref,
      price_cents: a.priceCents,
      previous_price_cents: a.previousPriceCents,
    })),
  );
  const res = await tx.execute<{ agency_id: string }>(sql`
    insert into ${savedSearchAlerts}
      (id, agency_id, user_id, saved_search_id, listing_id, kind, dedupe_key, ref, price_cents, previous_price_cents)
    select id, agency_id, user_id, saved_search_id, listing_id, kind, dedupe_key, ref, price_cents, previous_price_cents
      from jsonb_to_recordset(${json}::jsonb) as x(id uuid, agency_id uuid, user_id uuid, saved_search_id uuid,
             listing_id uuid, kind text, dedupe_key int, ref text, price_cents bigint, previous_price_cents bigint)
    on conflict (saved_search_id, listing_id, kind, dedupe_key) do nothing
    returning agency_id`);
  return { written: res.rows.length, agencies: [...new Set(res.rows.map((r) => r.agency_id))] };
}

/**
 * Agencies with alerts waiting to be sent, after `after` (a loose index scan over `saved_search_alerts_pending_idx`:
 * one probe per agency, however many alerts wait), at most `limit`; with `olderThan`, only alerts written before it.
 */
export async function pendingAgencies(
  tx: Tx,
  after: string | null,
  limit: number,
  olderThan: Date | null = null,
): Promise<string[]> {
  const age = olderThan ? sql`and created_at < ${olderThan.toISOString()}::timestamptz` : sql``;
  const res = await tx.execute<{ agency_id: string }>(sql`
    with recursive a as (
      (select agency_id from ${savedSearchAlerts}
        where notified_at is null ${age} and agency_id > coalesce(${after}::uuid, ${NIL}::uuid)
        order by agency_id limit 1)
      union all
      select (select agency_id from ${savedSearchAlerts} x
               where x.notified_at is null ${age} and x.agency_id > a.agency_id order by x.agency_id limit 1)
        from a where a.agency_id is not null)
    select agency_id from a where agency_id is not null limit ${limit}`);
  return res.rows.map((r) => r.agency_id);
}

export type ClaimedAlert = {
  savedSearchId: string;
  userId: string;
  name: string;
  scope: string;
  frequency: string;
  listingId: string;
  kind: string;
  ref: string;
};

/**
 * Claims the agency's alerts waiting to be sent whose saved search has one of `frequencies` (at most `limit`, one
 * statement): marks them notified and answers them with their saved search. `skip locked`: a concurrent run takes
 * other rows.
 */
export async function claimPending(
  tx: Tx,
  agencyId: string,
  frequencies: readonly string[],
  limit: number,
): Promise<ClaimedAlert[]> {
  const res = await tx.execute<ClaimedAlert>(sql`
    with c as (
      select a.id from ${savedSearchAlerts} a join ${savedSearches} s on s.id = a.saved_search_id
       where a.agency_id = ${agencyId} and a.notified_at is null
         and s.frequency = any(${`{${frequencies.join(',')}}`}::text[])
       order by a.saved_search_id, a.id limit ${limit} for update of a skip locked),
    u as (
      update ${savedSearchAlerts} a set notified_at = now() from c where a.id = c.id
      returning a.saved_search_id, a.listing_id, a.kind, a.ref, a.created_at, a.id)
    select u.saved_search_id as "savedSearchId", s.user_id as "userId", s.name, s.scope, s.frequency,
           u.listing_id as "listingId", u.kind, u.ref
      from u join ${savedSearches} s on s.id = u.saved_search_id
     order by s.user_id, u.saved_search_id, u.created_at, u.id`);
  return res.rows;
}

/** Deletes alerts older than `before` (at most `limit`, one statement); answers how many. */
export async function pruneAlerts(tx: Tx, before: Date, limit: number): Promise<number> {
  const res = await tx.execute(sql`
    delete from ${savedSearchAlerts} where id in (
      select id from ${savedSearchAlerts} where created_at < ${before.toISOString()}::timestamptz limit ${limit})`);
  return res.rowCount ?? 0;
}

/** Deletes the states of listings gone before `before` (at most `limit`, one statement); answers how many. */
export async function pruneGoneStates(tx: Tx, before: Date, limit: number): Promise<number> {
  const res = await tx.execute(sql`
    delete from ${matchingListingStates} where listing_id in (
      select listing_id from ${matchingListingStates}
       where status = 'GONE' and updated_at < ${before.toISOString()}::timestamptz limit ${limit})`);
  return res.rowCount ?? 0;
}
