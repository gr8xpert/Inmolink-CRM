import type { Tx } from '@inmolink/db';
import {
  clientProfileEmbeddings,
  clientProfileMatches,
  clientProfiles,
  matchingListingFacts,
  matchingListingStates,
  savedSearchAlerts,
  savedSearches,
} from '@inmolink/db/schema/matching';
import { NIL_UUID as NIL } from '@inmolink/platform/tenancy';
import { and, asc, eq, gt, inArray, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';
import { profileMatchKeys } from './match-keys';

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
 * skipped (`saved_search_alerts_dedupe_uq`). S13-F9: a saved search gets at most `dailyCap` alerts in 24 hours — its
 * recent count is read once per search in the batch (≤ `dailyCap` index entries of
 * `saved_search_alerts_search_created_idx`), the rest of the batch's alerts for it are dropped. Answers how many were
 * written now, and their agencies.
 */
export async function insertAlerts(
  tx: Tx,
  alerts: readonly NewAlert[],
  dailyCap: number,
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
    with x as (
      select x.*, row_number() over (partition by x.saved_search_id order by x.id) as rn
        from jsonb_to_recordset(${json}::jsonb) as x(id uuid, agency_id uuid, user_id uuid, saved_search_id uuid,
               listing_id uuid, kind text, dedupe_key int, ref text, price_cents bigint, previous_price_cents bigint)),
    recent as (
      select s.saved_search_id,
             (select count(*) from (
                select 1 from ${savedSearchAlerts} a
                 where a.saved_search_id = s.saved_search_id and a.created_at >= now() - interval '1 day'
                 limit ${dailyCap}) c) as n
        from (select distinct saved_search_id from x) s)
    insert into ${savedSearchAlerts}
      (id, agency_id, user_id, saved_search_id, listing_id, kind, dedupe_key, ref, price_cents, previous_price_cents)
    select x.id, x.agency_id, x.user_id, x.saved_search_id, x.listing_id, x.kind, x.dedupe_key, x.ref, x.price_cents,
           x.previous_price_cents
      from x join recent r on r.saved_search_id = x.saved_search_id
     where r.n + x.rn <= ${dailyCap}
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

/* ------------------------------------------------------------------ client-profile embeddings (R2-01b, worker) */

/** Orphan vectors one backfill page drops at most. */
export const ORPHAN_DELETE_CAP = 5_000;

export interface ProfileSource {
  id: string;
  version: number;
  mode: string;
  transactionType: string | null;
  propertyTypeIds: string[];
  locationIds: string[];
  featureIds: string[];
  bedsMin: number | null;
  bathsMin: number | null;
  areaMinM2: number | null;
  areaMaxM2: number | null;
  wishes: string | null;
}

/** These profiles of `agencyId` (only the columns the text is built from; price is never read). */
export async function profileSources(tx: Tx, agencyId: string, ids: readonly string[]): Promise<ProfileSource[]> {
  if (ids.length === 0) return [];
  const p = clientProfiles;
  const rows = await tx
    .select({
      id: p.id,
      version: p.version,
      mode: p.mode,
      transactionType: p.transactionType,
      propertyTypeIds: p.propertyTypeIds,
      locationIds: p.locationIds,
      featureIds: p.featureIds,
      bedsMin: p.bedsMin,
      bathsMin: p.bathsMin,
      areaMinM2: p.areaMinM2,
      areaMaxM2: p.areaMaxM2,
      wishes: p.wishes,
    })
    .from(p)
    .where(and(eq(p.agencyId, agencyId), inArray(p.id, [...ids])));
  return rows;
}

/**
 * The next `window` profile ids of an agency after `after` (`client_profiles_agency_id_uq` order); `active`: only
 * profiles not OFF (the match sweep).
 */
export async function profileWindow(
  tx: Tx,
  p: { agencyId: string; after: string | null; window: number; active?: boolean },
): Promise<string[]> {
  const t = clientProfiles;
  const rows = await tx
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.agencyId, p.agencyId),
        p.after === null ? undefined : gt(t.id, p.after),
        p.active ? sql`${t.mode} <> 'OFF'` : undefined,
      ),
    )
    .orderBy(asc(t.agencyId), asc(t.id))
    .limit(p.window);
  return rows.map((r) => r.id);
}

/** What is stored for these profiles: each embedding's hash. */
export async function profileEmbeddingHashes(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const e = clientProfileEmbeddings;
  const rows = await tx
    .select({ profileId: e.profileId, contentHash: e.contentHash })
    .from(e)
    .where(inArray(e.profileId, [...ids]));
  return new Map(rows.map((r) => [r.profileId, r.contentHash]));
}

/** Unchanged text: the rows move on to the profile's version (never back); the vector stays. One statement. */
export async function touchProfileEmbeddings(
  tx: Tx,
  rows: readonly { profileId: string; version: number }[],
): Promise<void> {
  if (rows.length === 0) return;
  const ids = sql`array[${sql.join(
    rows.map((r) => sql`${r.profileId}`),
    sql`, `,
  )}]::uuid[]`;
  const versions = sql`array[${sql.join(
    rows.map((r) => sql`${r.version}`),
    sql`, `,
  )}]::int[]`;
  await tx.execute(sql`
    update ${clientProfileEmbeddings} e
       set source_version = c.version, updated_at = now()
      from unnest(${ids}, ${versions}) as c(profile_id, version)
     where e.profile_id = c.profile_id and e.source_version < c.version`);
}

export interface ProfileEmbeddingRow {
  profileId: string;
  ownerAgencyId: string;
  embedding: number[];
  model: string;
  contentHash: string;
  sourceVersion: number;
}

/**
 * Writes new vectors; a row written from a newer profile version is kept (two jobs of one profile finishing out of
 * order). The same version may be rewritten: a taxonomy rename or a model switch changes the text, not the version.
 * Answers the rows written.
 */
export async function upsertProfileEmbeddings(tx: Tx, rows: readonly ProfileEmbeddingRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const e = clientProfileEmbeddings;
  const written = await tx
    .insert(e)
    .values(rows.map((r) => ({ ...r })))
    .onConflictDoUpdate({
      target: e.profileId,
      set: {
        ownerAgencyId: sql`excluded.owner_agency_id`,
        embedding: sql`excluded.embedding`,
        model: sql`excluded.model`,
        contentHash: sql`excluded.content_hash`,
        sourceVersion: sql`excluded.source_version`,
        embeddedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`excluded.source_version >= ${e.sourceVersion}`,
    })
    .returning({ profileId: e.profileId });
  return written.length;
}

/** Drops the embeddings of these profiles of `agencyId` (gone, or `mode` OFF). Answers the rows deleted. */
export async function deleteProfileEmbeddings(tx: Tx, agencyId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const e = clientProfileEmbeddings;
  const res = await tx
    .delete(e)
    .where(and(eq(e.ownerAgencyId, agencyId), inArray(e.profileId, [...ids])))
    .returning({ profileId: e.profileId });
  return res.length;
}

/**
 * The backfill's orphan sweep: drops the agency's embeddings in the window `(after, upTo]` (`upTo` null: to the end)
 * whose profile no longer exists (`client_profile_embeddings_owner_idx`, a primary-key probe each), at most
 * `ORPHAN_DELETE_CAP` a call (`.claude/rules/database.md`: batches ≤ 5,000) — any more go with the next day's walk.
 * Answers the rows deleted.
 */
export async function deleteOrphanProfileEmbeddings(
  tx: Tx,
  p: { agencyId: string; after: string | null; upTo: string | null },
): Promise<number> {
  const res = await tx.execute(sql`
    delete from ${clientProfileEmbeddings}
     where profile_id in (
       select e.profile_id from ${clientProfileEmbeddings} e
        where e.owner_agency_id = ${p.agencyId}
          ${p.after === null ? sql`` : sql`and e.profile_id > ${p.after}`}
          ${p.upTo === null ? sql`` : sql`and e.profile_id <= ${p.upTo}`}
          and not exists (select 1 from ${clientProfiles} c where c.id = e.profile_id and c.agency_id = ${p.agencyId})
        order by e.profile_id
        limit ${ORPHAN_DELETE_CAP})`);
  return res.rowCount ?? 0;
}

/* ------------------------------------------------------------------ client profiles (R2-02a, requests) */

export interface ClientProfileRow {
  id: string;
  contactId: string;
  mode: string;
  frequency: string;
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
  wishes: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ClientProfileFields = Omit<ClientProfileRow, 'id' | 'contactId' | 'version' | 'createdAt' | 'updatedAt'>;

const profileColumns = {
  id: clientProfiles.id,
  contactId: clientProfiles.contactId,
  mode: clientProfiles.mode,
  frequency: clientProfiles.frequency,
  transactionType: clientProfiles.transactionType,
  propertyTypeIds: clientProfiles.propertyTypeIds,
  locationIds: clientProfiles.locationIds,
  featureIds: clientProfiles.featureIds,
  priceMinCents: clientProfiles.priceMinCents,
  priceMaxCents: clientProfiles.priceMaxCents,
  bedsMin: clientProfiles.bedsMin,
  bathsMin: clientProfiles.bathsMin,
  areaMinM2: clientProfiles.areaMinM2,
  areaMaxM2: clientProfiles.areaMaxM2,
  wishes: clientProfiles.wishes,
  version: clientProfiles.version,
  createdAt: clientProfiles.createdAt,
  updatedAt: clientProfiles.updatedAt,
};

/** One profile of the agency (primary key). */
export async function clientProfileOf(tx: Tx, agencyId: string, id: string): Promise<ClientProfileRow | null> {
  const [row] = await tx
    .select(profileColumns)
    .from(clientProfiles)
    .where(and(eq(clientProfiles.agencyId, agencyId), eq(clientProfiles.id, id)));
  return row ?? null;
}

/** A page of the contact's profiles, oldest first (`client_profiles_contact_idx`, raw keyset): `limit + 1` rows. */
export function clientProfilesOfContact(
  tx: Tx,
  agencyId: string,
  contactId: string,
  page: { limit: number; cursor?: KeysetCursor | undefined },
): Promise<(ClientProfileRow & { atUs: string })[]> {
  return tx
    .select({ ...profileColumns, atUs: keysetStamp(clientProfiles.createdAt) })
    .from(clientProfiles)
    .where(
      and(
        eq(clientProfiles.agencyId, agencyId),
        eq(clientProfiles.contactId, contactId),
        keysetAfterRaw(clientProfiles.createdAt, clientProfiles.id, page.cursor, 'asc'),
      ),
    )
    .orderBy(...keysetOrderRaw(clientProfiles.createdAt, clientProfiles.id, 'asc'))
    .limit(page.limit + 1);
}

/**
 * A profile of the contact, unless it has `max` already (one statement: the count over `client_profiles_contact_idx`
 * and the insert). Null at the limit.
 */
export async function insertClientProfile(
  tx: Tx,
  s: ClientProfileFields & { agencyId: string; id: string; contactId: string; max: number },
): Promise<ClientProfileRow | null> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into ${clientProfiles}
      (id, agency_id, contact_id, mode, frequency, transaction_type, property_type_ids, location_ids, feature_ids,
       price_min_cents, price_max_cents, beds_min, baths_min, area_min_m2, area_max_m2, wishes, match_keys)
    select ${s.id}::uuid, ${s.agencyId}::uuid, ${s.contactId}::uuid, ${s.mode}, ${s.frequency}, ${s.transactionType},
           ${uuids(s.propertyTypeIds)}, ${uuids(s.locationIds)}, ${uuids(s.featureIds)},
           ${s.priceMinCents}::bigint, ${s.priceMaxCents}::bigint, ${s.bedsMin}::int, ${s.bathsMin}::int,
           ${s.areaMinM2}::numeric, ${s.areaMaxM2}::numeric, ${s.wishes}, ${texts(profileMatchKeys(s))}
     where (select count(*) from ${clientProfiles} n
             where n.agency_id = ${s.agencyId} and n.contact_id = ${s.contactId}) < ${s.max}
    returning id`);
  if (result.rows.length === 0) return null;
  return clientProfileOf(tx, s.agencyId, s.id);
}

/** The profile replaced at `version` (its version moves on). Null: no such profile, or another version. */
export async function updateClientProfile(
  tx: Tx,
  agencyId: string,
  id: string,
  version: number,
  s: ClientProfileFields,
): Promise<ClientProfileRow | null> {
  const [row] = await tx
    .update(clientProfiles)
    .set({
      ...s,
      matchKeys: profileMatchKeys({ ...s, agencyId }),
      version: sql`${clientProfiles.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(clientProfiles.agencyId, agencyId), eq(clientProfiles.id, id), eq(clientProfiles.version, version)))
    .returning(profileColumns);
  return row ?? null;
}

/** Deletes the profile; answers whether it existed. */
export async function deleteClientProfile(tx: Tx, agencyId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(clientProfiles)
    .where(and(eq(clientProfiles.agencyId, agencyId), eq(clientProfiles.id, id)))
    .returning({ id: clientProfiles.id });
  return rows.length > 0;
}

/**
 * R2-02a, the `SUBJECT` data export: a page of the contact's profiles by id (`client_profiles_contact_idx` filters the
 * contact's few rows). Under the caller's RLS.
 */
export function subjectClientProfiles(
  tx: Tx,
  p: { agencyId: string; contactId: string; afterId: string | null; limit: number },
): Promise<ClientProfileRow[]> {
  return tx
    .select(profileColumns)
    .from(clientProfiles)
    .where(
      and(
        eq(clientProfiles.agencyId, p.agencyId),
        eq(clientProfiles.contactId, p.contactId),
        p.afterId ? gt(clientProfiles.id, p.afterId) : undefined,
      ),
    )
    .orderBy(asc(clientProfiles.id))
    .limit(p.limit);
}

/* ------------------------------------------------------------------ client profiles (R2-02a, contact merge / erasure) */

/**
 * A contact merge: up to `limit` profiles of `fromId` name `toId` (their version moves on). Answers the moved ids
 * (`client_profiles_contact_idx`).
 */
export async function repointClientProfiles(
  tx: Tx,
  p: { agencyId: string; fromId: string; toId: string; limit: number },
): Promise<string[]> {
  const res = await tx.execute<{ id: string }>(sql`
    update ${clientProfiles} set contact_id = ${p.toId}, version = version + 1, updated_at = now()
     where agency_id = ${p.agencyId}
       and id in (select id from ${clientProfiles}
                   where agency_id = ${p.agencyId} and contact_id = ${p.fromId} limit ${p.limit})
    returning id`);
  return (res.rows as { id: string }[]).map((r) => r.id);
}

/** A contact erasure: up to `limit` profiles of these contacts deleted. Answers their ids. */
export async function deleteContactsClientProfiles(
  tx: Tx,
  p: { agencyId: string; contactIds: readonly string[]; limit: number },
): Promise<string[]> {
  if (p.contactIds.length === 0) return [];
  const res = await tx.execute<{ id: string }>(sql`
    delete from ${clientProfiles}
     where agency_id = ${p.agencyId}
       and id in (select id from ${clientProfiles}
                   where agency_id = ${p.agencyId} and contact_id = any(${uuids(p.contactIds)}) limit ${p.limit})
    returning id`);
  return (res.rows as { id: string }[]).map((r) => r.id);
}

/* ------------------------------------------------------------------ match engine (R2-02b, worker) */

/** A live listing as the match engine sees it (`matching_listing_facts`, from its read model). */
export interface ListingFactsRow {
  listingId: string;
  agencyId: string;
  version: number;
  transactionType: string;
  propertyTypeId: string;
  locationIds: string[];
  featureIds: string[];
  priceCents: number | null;
  beds: number | null;
  baths: number | null;
  areaM2: number | null;
  shareScope: 'ALL' | 'PREFERRED';
  preferredAgencyIds: string[];
  matchKeys: string[];
}

const factsJson = (rows: readonly ListingFactsRow[]) =>
  JSON.stringify(
    rows.map((r) => ({
      listing_id: r.listingId,
      agency_id: r.agencyId,
      version: r.version,
      transaction_type: r.transactionType,
      property_type_id: r.propertyTypeId,
      location_ids: r.locationIds,
      feature_ids: r.featureIds,
      price_cents: r.priceCents,
      beds: r.beds,
      baths: r.baths,
      area_m2: r.areaM2,
      share_scope: r.shareScope,
      preferred_agency_ids: r.preferredAgencyIds,
      match_keys: r.matchKeys,
    })),
  );

/** Writes these listings' facts (one statement, rows in id order); never moves a row back to an older version. */
export async function upsertListingFacts(tx: Tx, rows: readonly ListingFactsRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`
    insert into ${matchingListingFacts} (listing_id, agency_id, version, transaction_type, property_type_id,
      location_ids, feature_ids, price_cents, beds, baths, area_m2, share_scope, preferred_agency_ids, match_keys)
    select listing_id, agency_id, version, transaction_type, property_type_id, location_ids, feature_ids, price_cents,
           beds, baths, area_m2, share_scope, preferred_agency_ids, match_keys
      from jsonb_to_recordset(${factsJson(rows)}::jsonb) as x(listing_id uuid, agency_id uuid, version int,
             transaction_type text, property_type_id uuid, location_ids uuid[], feature_ids uuid[], price_cents bigint,
             beds int, baths int, area_m2 numeric, share_scope text, preferred_agency_ids uuid[], match_keys text[])
     order by listing_id
    on conflict (listing_id) do update
      set agency_id = excluded.agency_id, version = excluded.version, transaction_type = excluded.transaction_type,
          property_type_id = excluded.property_type_id, location_ids = excluded.location_ids,
          feature_ids = excluded.feature_ids, price_cents = excluded.price_cents, beds = excluded.beds,
          baths = excluded.baths, area_m2 = excluded.area_m2, share_scope = excluded.share_scope,
          preferred_agency_ids = excluded.preferred_agency_ids, match_keys = excluded.match_keys, updated_at = now()
      where excluded.version > ${matchingListingFacts.version}
         or (excluded.version = ${matchingListingFacts.version}
             and (excluded.match_keys, excluded.share_scope, excluded.preferred_agency_ids, excluded.price_cents,
                  excluded.feature_ids, excluded.location_ids)
                 is distinct from (${matchingListingFacts.matchKeys}, ${matchingListingFacts.shareScope},
                  ${matchingListingFacts.preferredAgencyIds}, ${matchingListingFacts.priceCents},
                  ${matchingListingFacts.featureIds}, ${matchingListingFacts.locationIds}))`);
}

/** Drops these listings' facts (no longer ACTIVE, or no read model): the engine offers them no more. */
export async function deleteListingFacts(tx: Tx, listingIds: readonly string[]): Promise<void> {
  if (listingIds.length === 0) return;
  await tx.execute(sql`delete from ${matchingListingFacts} where listing_id = any(${uuids(listingIds)})`);
}

/** A client profile as the match engine reads it (criteria, mode, version; never the wishes). */
export interface MatchProfileRow {
  id: string;
  agencyId: string;
  mode: 'REVIEW' | 'AUTO_SEND';
  version: number;
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
}

/** The listing side of a candidate pair. */
export type MatchListingRow = Omit<ListingFactsRow, 'matchKeys' | 'shareScope' | 'preferredAgencyIds'>;

/** A candidate pair from either direction: the profile, the listing, their cosine similarity (null: no vectors). */
export interface MatchCandidateRow {
  profile: MatchProfileRow;
  listing: MatchListingRow;
  similarity: number | null;
}

/**
 * The hard filters with their tolerances (`explain.ts`): profile `p` against listing `l`, both with their tables'
 * column names. Places are implied by the shared match key; transaction is too, re-checked as it is free.
 */
const hardFilters = sql.raw(`
       (p.transaction_type is null or p.transaction_type = l.transaction_type)
   and (cardinality(p.property_type_ids) = 0 or l.property_type_id = any(p.property_type_ids))
   and (p.price_min_cents is null or l.price_cents >= p.price_min_cents)
   and (p.price_max_cents is null or l.price_cents * 10 <= p.price_max_cents * 11)
   and (p.beds_min is null or l.beds >= p.beds_min)
   and (p.baths_min is null or l.baths >= p.baths_min)
   and (p.area_min_m2 is null or l.area_m2 >= p.area_min_m2)
   and (p.area_max_m2 is null or l.area_m2 <= p.area_max_m2)
   and (cardinality(p.feature_ids) = 0
        or cardinality(array(select unnest(p.feature_ids) except select unnest(l.feature_ids)))
           <= cardinality(p.feature_ids) / 4)`);

const profileCols = sql.raw(`p.id, p.agency_id, p.mode, p.version, p.transaction_type, p.property_type_ids,
       p.location_ids, p.feature_ids, p.price_min_cents, p.price_max_cents, p.beds_min, p.baths_min, p.area_min_m2,
       p.area_max_m2`);

const listingCols = sql.raw(`l.listing_id as l_id, l.agency_id as l_agency_id, l.version as l_version,
       l.transaction_type as l_transaction_type, l.property_type_id as l_property_type_id,
       l.location_ids as l_location_ids, l.feature_ids as l_feature_ids, l.price_cents as l_price_cents,
       l.beds as l_beds, l.baths as l_baths, l.area_m2 as l_area_m2`);

type RawProfile = {
  id: string;
  agency_id: string;
  mode: 'REVIEW' | 'AUTO_SEND';
  version: number;
  transaction_type: string | null;
  property_type_ids: string[] | string;
  location_ids: string[] | string;
  feature_ids: string[] | string;
  price_min_cents: string | number | null;
  price_max_cents: string | number | null;
  beds_min: number | null;
  baths_min: number | null;
  area_min_m2: string | number | null;
  area_max_m2: string | number | null;
};

type RawCandidate = RawProfile & {
  l_id: string;
  l_agency_id: string;
  l_version: number;
  l_transaction_type: string;
  l_property_type_id: string;
  l_location_ids: string[] | string;
  l_feature_ids: string[] | string;
  l_price_cents: string | number | null;
  l_beds: number | null;
  l_baths: number | null;
  l_area_m2: string | number | null;
  similarity: string | number | null;
};

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
/** Arrays from a recordset may come back as `{…}` literals: accept both shapes (uuid elements never need quoting). */
const arr = (v: string[] | string | null): string[] =>
  v === null ? [] : Array.isArray(v) ? v : v === '{}' ? [] : v.slice(1, -1).split(',');

function toProfile(r: RawProfile): MatchProfileRow {
  return {
    id: r.id,
    agencyId: r.agency_id,
    mode: r.mode,
    version: r.version,
    transactionType: r.transaction_type,
    propertyTypeIds: arr(r.property_type_ids),
    locationIds: arr(r.location_ids),
    featureIds: arr(r.feature_ids),
    priceMinCents: num(r.price_min_cents),
    priceMaxCents: num(r.price_max_cents),
    bedsMin: r.beds_min,
    bathsMin: r.baths_min,
    areaMinM2: num(r.area_min_m2),
    areaMaxM2: num(r.area_max_m2),
  };
}

function toCandidate(r: RawCandidate): MatchCandidateRow {
  return {
    profile: toProfile(r),
    listing: {
      listingId: r.l_id,
      agencyId: r.l_agency_id,
      version: r.l_version,
      transactionType: r.l_transaction_type,
      propertyTypeId: r.l_property_type_id,
      locationIds: arr(r.l_location_ids),
      featureIds: arr(r.l_feature_ids),
      priceCents: num(r.l_price_cents),
      beds: r.l_beds,
      baths: r.l_baths,
      areaM2: num(r.l_area_m2),
    },
    similarity: num(r.similarity),
  };
}

/** A changed listing as the listing → profiles query probes it. */
export interface ListingMatchProbe extends Omit<ListingFactsRow, 'matchKeys'> {
  /** `listingMatchKeys`, with `network` = on the network, not hidden, its owner listed. */
  keys: string[];
  network: boolean;
  /** Its vector (halfvec text, read from the database) and model, when embedded. */
  vector: string | null;
  model: string | null;
}

/** Listings probed per statement. */
export const LISTING_PROBE_CHUNK = 5;
/** Profiles read per listing at most, per event (≤ 100 × 500 candidates a job; the nightly sweep finds any beyond). */
export const PROFILES_PER_LISTING = 500;

/**
 * The listing → profiles direction (R2-02b, one `search.listings.changed` batch): the active profiles (any agency)
 * sharing a key with each listing — `client_profiles_match_keys_idx` (GIN, partial on `mode <> 'OFF'`) — that pass the
 * hard filters, may see it (its own agency's, or on the network and shared with that agency: scope ALL or preferred)
 * and have no match with it yet (`client_profile_matches_pair_uq`); at most `perListing` a listing. With the profile's
 * vector's similarity to the listing's (same model), else null. Exported for the plan tests.
 */
export function listingToProfilesQuery(probes: readonly ListingMatchProbe[], perListing: number): SQL {
  const json = JSON.stringify(
    probes.map((p) => ({
      listing_id: p.listingId,
      agency_id: p.agencyId,
      version: p.version,
      keys: p.keys,
      transaction_type: p.transactionType,
      property_type_id: p.propertyTypeId,
      location_ids: p.locationIds,
      feature_ids: p.featureIds,
      price_cents: p.priceCents,
      beds: p.beds,
      baths: p.baths,
      area_m2: p.areaM2,
      network: p.network,
      share_all: p.shareScope === 'ALL',
      preferred: p.preferredAgencyIds,
      vec: p.vector,
      model: p.model,
    })),
  );
  return sql`
    select c.*, ${listingCols},
           case when l.vec is null then null
                else (select 1 - (e.embedding <=> l.vec::halfvec) from ${clientProfileEmbeddings} e
                       where e.profile_id = c.id and e.model = l.model) end as similarity
      from jsonb_to_recordset(${json}::jsonb) as l(listing_id uuid, agency_id uuid, version int, keys text[],
             transaction_type text, property_type_id uuid, location_ids uuid[], feature_ids uuid[], price_cents bigint,
             beds int, baths int, area_m2 numeric, network boolean, share_all boolean, preferred uuid[], vec text,
             model text)
      cross join lateral (
        select ${profileCols}
          from ${clientProfiles} p
         where p.match_keys && l.keys and p.mode <> 'OFF'
           and ${hardFilters}
           and (p.agency_id = l.agency_id or (l.network and (l.share_all or p.agency_id = any(l.preferred))))
           and not exists (select 1 from ${clientProfileMatches} m
                            where m.profile_id = p.id and m.listing_id = l.listing_id)
         limit ${perListing}) c`;
}

export async function listingToProfiles(
  tx: Tx,
  probes: readonly ListingMatchProbe[],
  options: { chunk?: number; perListing?: number } = {},
): Promise<MatchCandidateRow[]> {
  const chunk = options.chunk ?? LISTING_PROBE_CHUNK;
  const all: MatchCandidateRow[] = [];
  for (let i = 0; i < probes.length; i += chunk) {
    const q = listingToProfilesQuery(probes.slice(i, i + chunk), options.perListing ?? PROFILES_PER_LISTING);
    all.push(...(await tx.execute<RawCandidate>(q)).rows.map(toCandidate));
  }
  return all;
}

/** A profile as the profile → listings query probes it. */
export interface ProfileMatchProbe extends MatchProfileRow {
  /** `profileProbeKeys`: network keys only while its agency takes part in the network. */
  keys: string[];
}

/**
 * Broad profiles (no place, or only countries) read the `BROAD_WINDOW` most recently written facts
 * (`matching_listing_facts_updated_idx`, one bounded walk shared by the statement's profiles) instead of their keys'
 * GIN entries, which would be most of the catalogue.
 */
export const BROAD_WINDOW = 2_000;

/** Profiles probed per statement. */
export const PROFILE_PROBE_CHUNK = 20;
/** Listings read per profile and run at most (the newest first). */
export const LISTINGS_PER_PROFILE = 200;

/**
 * The profile → listings direction (R2-02b, a profile's change and the nightly sweep): per profile, the newest live
 * listings (`matching_listing_facts`, from read models) sharing one of its keys (`…_match_keys_idx`, GIN) that pass
 * the hard filters, that it may see (its agency's own, or shared with it: scope ALL or it is preferred) and that it has
 * no match with yet — at most `perProfile`. Similarity is the caller's (listing vectors are search's); so is the
 * owners' standing (listed). Exported for the plan tests.
 */
export function profileToListingsQuery(
  probes: readonly ProfileMatchProbe[],
  perProfile: number,
  options: { broad?: boolean; since?: Date | null } = {},
): SQL {
  const json = JSON.stringify(
    probes.map((p) => ({
      id: p.id,
      agency_id: p.agencyId,
      mode: p.mode,
      version: p.version,
      keys: p.keys,
      transaction_type: p.transactionType,
      property_type_ids: p.propertyTypeIds,
      location_ids: p.locationIds,
      feature_ids: p.featureIds,
      price_min_cents: p.priceMinCents,
      price_max_cents: p.priceMaxCents,
      beds_min: p.bedsMin,
      baths_min: p.bathsMin,
      area_min_m2: p.areaMinM2,
      area_max_m2: p.areaMaxM2,
    })),
  );
  // broad: the newest-written window, materialized once; narrow: the profile's keys' GIN entries (since: the sweep)
  const source = options.broad ? sql`recent` : sql`${matchingListingFacts}`;
  const recent = options.broad
    ? sql`with recent as materialized (
        select listing_id, agency_id, version, transaction_type, property_type_id, location_ids, feature_ids, price_cents,
               beds, baths, area_m2, share_scope, preferred_agency_ids, match_keys
          from ${matchingListingFacts} order by updated_at desc limit ${BROAD_WINDOW})`
    : sql``;
  const since =
    !options.broad && options.since ? sql`and l.updated_at >= ${options.since.toISOString()}::timestamptz` : sql``;
  return sql`${recent}
    select ${profileCols}, c.*, null::float8 as similarity
      from jsonb_to_recordset(${json}::jsonb) as p(id uuid, agency_id uuid, mode text, version int, keys text[],
             transaction_type text, property_type_ids uuid[], location_ids uuid[], feature_ids uuid[],
             price_min_cents bigint, price_max_cents bigint, beds_min int, baths_min int, area_min_m2 numeric,
             area_max_m2 numeric)
      cross join lateral (
        select ${listingCols}
          from ${source} l
         where l.match_keys && p.keys ${since}
           and ${hardFilters}
           and (l.agency_id = p.agency_id or l.share_scope = 'ALL' or p.agency_id = any(l.preferred_agency_ids))
           and not exists (select 1 from ${clientProfileMatches} m
                            where m.profile_id = p.id and m.listing_id = l.listing_id)
         order by l.listing_id desc
         limit ${perProfile}) c`;
}

export async function profileToListings(
  tx: Tx,
  probes: readonly ProfileMatchProbe[],
  options: { chunk?: number; perProfile?: number; broad?: boolean; since?: Date | null } = {},
): Promise<MatchCandidateRow[]> {
  const chunk = options.chunk ?? PROFILE_PROBE_CHUNK;
  const all: MatchCandidateRow[] = [];
  for (let i = 0; i < probes.length; i += chunk) {
    const q = profileToListingsQuery(probes.slice(i, i + chunk), options.perProfile ?? LISTINGS_PER_PROFILE, options);
    all.push(...(await tx.execute<RawCandidate>(q)).rows.map(toCandidate));
  }
  return all;
}

/** These profiles of the agency that are active (`mode` not OFF): the engine's columns only (never the wishes). */
export async function activeMatchProfiles(
  tx: Tx,
  agencyId: string,
  ids: readonly string[],
): Promise<MatchProfileRow[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute<RawProfile>(sql`
    select ${profileCols} from ${clientProfiles} p
     where p.agency_id = ${agencyId} and p.id = any(${uuids(ids)}) and p.mode <> 'OFF'`);
  return res.rows.map(toProfile);
}

/** These profiles' vectors (halfvec text) and models. */
export async function profileVectors(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, { model: string; vector: string }>> {
  if (ids.length === 0) return new Map();
  const e = clientProfileEmbeddings;
  const rows = await tx
    .select({ profileId: e.profileId, model: e.model, vector: sql<string>`${e.embedding}::text` })
    .from(e)
    .where(inArray(e.profileId, [...ids]));
  return new Map(rows.map((r) => [r.profileId, { model: r.model, vector: r.vector }]));
}

export interface NewMatch {
  id: string;
  agencyId: string;
  profileId: string;
  listingId: string;
  listingAgencyId: string;
  listingVersion: number;
  profileVersion: number;
  hardScore: number;
  semanticScore: number | null;
  boostScore: number;
  totalScore: number;
  explanation: unknown;
  status: 'PENDING_REVIEW' | 'QUEUED';
}

/**
 * Writes the matches (one statement, in key order); a profile and listing matched before — whatever that match's status,
 * dismissed included — is skipped (`client_profile_matches_pair_uq`): a client never gets a listing twice. Answers how
 * many were written, per profile agency.
 */
/** Matches written per statement (each ≈ 1 KB of JSON). */
export const MATCH_INSERT_CHUNK = 1_000;

export async function insertMatches(tx: Tx, rows: readonly NewMatch[]): Promise<{ agencyId: string; n: number }[]> {
  const counts = new Map<string, number>();
  for (let i = 0; i < rows.length; i += MATCH_INSERT_CHUNK) {
    for (const w of await insertMatchChunk(tx, rows.slice(i, i + MATCH_INSERT_CHUNK))) {
      counts.set(w.agencyId, (counts.get(w.agencyId) ?? 0) + w.n);
    }
  }
  return [...counts].map(([agencyId, n]) => ({ agencyId, n }));
}

async function insertMatchChunk(tx: Tx, rows: readonly NewMatch[]): Promise<{ agencyId: string; n: number }[]> {
  if (rows.length === 0) return [];
  const json = JSON.stringify(
    rows.map((r) => ({
      id: r.id,
      agency_id: r.agencyId,
      profile_id: r.profileId,
      listing_id: r.listingId,
      listing_agency_id: r.listingAgencyId,
      listing_version: r.listingVersion,
      profile_version: r.profileVersion,
      hard_score: r.hardScore,
      semantic_score: r.semanticScore,
      boost_score: r.boostScore,
      total_score: r.totalScore,
      explanation: r.explanation,
      status: r.status,
    })),
  );
  const res = await tx.execute<{ agency_id: string; n: number }>(sql`
    with w as (
      insert into ${clientProfileMatches} (id, agency_id, profile_id, listing_id, listing_agency_id, listing_version,
        profile_version, hard_score, semantic_score, boost_score, total_score, explanation, status)
      select id, agency_id, profile_id, listing_id, listing_agency_id, listing_version, profile_version, hard_score,
             semantic_score, boost_score, total_score, explanation, status
        from jsonb_to_recordset(${json}::jsonb) as x(id uuid, agency_id uuid, profile_id uuid, listing_id uuid,
               listing_agency_id uuid, listing_version int, profile_version int, hard_score real, semantic_score real,
               boost_score real, total_score real, explanation jsonb, status text)
       order by profile_id, listing_id
      on conflict (profile_id, listing_id) do nothing
      returning agency_id)
    select agency_id as "agencyId", count(*)::int as n from w group by agency_id`);
  return res.rows as unknown as { agencyId: string; n: number }[];
}

/**
 * R2-02b: profiles of these written before their match keys existed (R2-02a) get them (`profileMatchKeys`); two
 * statements at most, the read only when some lack keys. Answers how many were keyed.
 */
export async function keyUnkeyedProfiles(tx: Tx, agencyId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await tx.execute<{ id: string; transaction_type: string | null; location_ids: string[] | string }>(sql`
    select id, transaction_type, location_ids from ${clientProfiles}
     where agency_id = ${agencyId} and id = any(${uuids(ids)}) and cardinality(match_keys) = 0`);
  if (res.rows.length === 0) return 0;
  const json = JSON.stringify(
    res.rows.map((r) => ({
      id: r.id,
      keys: profileMatchKeys({ agencyId, transactionType: r.transaction_type, locationIds: arr(r.location_ids) }),
    })),
  );
  const done = await tx.execute(sql`
    update ${clientProfiles} p set match_keys = x.keys
      from jsonb_to_recordset(${json}::jsonb) as x(id uuid, keys text[])
     where p.agency_id = ${agencyId} and p.id = x.id and cardinality(p.match_keys) = 0`);
  return done.rowCount ?? 0;
}
