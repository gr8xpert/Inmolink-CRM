/**
 * dedupe queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, bounded statements.
 * Queries only `@inmolink/db/schema/dedupe` — other modules' tables fail `pnpm check:boundaries`.
 *
 * Signatures, pairs, clusters, decisions and pins are global and worker-only (`withSystem`); R2-03b's clustered-listing,
 * review and dispute tables are the agencies' own (request side under the caller's RLS, worker side `withSystem`).
 * Bigint keys travel as one text parameter (`'{1,-2}'::bigint[]`): JSON has no 64-bit integers.
 */
import type { Tx } from '@inmolink/db';
import {
  dedupeClusters as clusters,
  dedupePairDecisions as decisions,
  dedupeDisputes as disputes,
  dedupeListingClusters as listingClusters,
  dedupeClusterMembers as members,
  dedupePairScores as pairs,
  dedupeCanonicalPins as pins,
  dedupeReviews as reviews,
  dedupeListingSignatures as sigs,
} from '@inmolink/db/schema/dedupe';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';
import type { PairSignals } from './scoring';
import type { Signature } from './signature';

const bigints = (keys: readonly bigint[]) => `{${keys.join(',')}}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One `uuid[]` parameter; every id is checked (an array literal must never take extra elements). */
const uuids = (ids: readonly string[]) => {
  for (const id of ids) if (!UUID.test(id)) throw new Error(`dedupe: not a uuid: ${JSON.stringify(id).slice(0, 40)}`);
  return sql`${`{${[...new Set(ids)].join(',')}}`}::uuid[]`;
};

/**
 * Serialises signature refreshes of these listings across jobs (transaction advisory locks, sorted: no deadlock), so
 * an older job's read can never re-insert a signature a newer job deleted. One statement.
 */
export async function lockListings(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended('dedupe:' || id::text, 0))
      from unnest(${uuids(ids)}) as id order by id`);
}

const parseBigints = (text: string | null): bigint[] =>
  !text || text === '{}'
    ? []
    : text
        .slice(1, -1)
        .split(',')
        .map((v) => BigInt(v));

/**
 * Writes the signatures; a stored one of a newer read-model version is kept, an unchanged one is not touched. Answers
 * the ids inserted or changed. One statement.
 */
export async function upsertSignatures(tx: Tx, rows: readonly Signature[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const json = JSON.stringify(
    rows.map((r) => ({
      listing_id: r.listingId,
      owner_agency_id: r.ownerAgencyId,
      source_version: r.sourceVersion,
      signature_version: r.signatureVersion,
      transaction_type: r.transactionType,
      property_type_id: r.propertyTypeId,
      city_id: r.cityId,
      beds: r.beds,
      baths: r.baths,
      area_m2: r.areaM2,
      price_cents: r.priceCents,
      lat: r.lat,
      lng: r.lng,
      image_keys: bigints(r.imageKeys),
      phashes: bigints(r.phashes),
      block_keys: bigints(r.blockKeys),
    })),
  );
  const res = await tx.execute<{ listing_id: string }>(sql`
    insert into ${sigs} as s (listing_id, owner_agency_id, source_version, signature_version, transaction_type,
                              property_type_id, city_id, beds, baths, area_m2, price_cents, lat, lng, image_keys,
                              phashes, block_keys, updated_at)
    select x.listing_id, x.owner_agency_id, x.source_version, x.signature_version, x.transaction_type,
           x.property_type_id, x.city_id, x.beds, x.baths, x.area_m2, x.price_cents, x.lat, x.lng,
           x.image_keys::bigint[], x.phashes::bigint[], x.block_keys::bigint[], now()
      from jsonb_to_recordset(${json}::jsonb) as x(listing_id uuid, owner_agency_id uuid, source_version int,
           signature_version smallint, transaction_type text, property_type_id uuid, city_id uuid, beds int, baths int,
           area_m2 numeric, price_cents bigint, lat float8, lng float8, image_keys text, phashes text, block_keys text)
    on conflict (listing_id) do update set
      owner_agency_id = excluded.owner_agency_id, source_version = excluded.source_version,
      signature_version = excluded.signature_version, transaction_type = excluded.transaction_type,
      property_type_id = excluded.property_type_id, city_id = excluded.city_id, beds = excluded.beds,
      baths = excluded.baths, area_m2 = excluded.area_m2, price_cents = excluded.price_cents, lat = excluded.lat,
      lng = excluded.lng, image_keys = excluded.image_keys, phashes = excluded.phashes,
      block_keys = excluded.block_keys, updated_at = now()
    where s.source_version <= excluded.source_version
      and (s.source_version, s.signature_version, s.transaction_type, s.property_type_id, s.city_id, s.beds, s.baths,
           s.area_m2, s.price_cents, s.lat, s.lng, s.image_keys, s.phashes, s.block_keys, s.owner_agency_id)
          is distinct from
          (excluded.source_version, excluded.signature_version, excluded.transaction_type, excluded.property_type_id,
           excluded.city_id, excluded.beds, excluded.baths, excluded.area_m2, excluded.price_cents, excluded.lat,
           excluded.lng, excluded.image_keys, excluded.phashes, excluded.block_keys, excluded.owner_agency_id)
    returning s.listing_id`);
  return res.rows.map((r) => r.listing_id);
}

/** A page of stored signatures' listing ids (keyset on the primary key): the orphan sweep's walk. One statement. */
export async function signatureIdsPage(tx: Tx, after: string | null, limit: number): Promise<string[]> {
  const res = await tx.execute<{ listing_id: string }>(sql`
    select listing_id from ${sigs}
     where ${after === null ? sql`true` : sql`listing_id > ${after}::uuid`}
     order by listing_id limit ${limit}`);
  return res.rows.map((r) => r.listing_id);
}

/** Drops these listings' signatures and every pair they are in (two statements). */
export async function deleteListings(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`delete from ${sigs} where listing_id = any(${uuids(ids)})`);
  await tx.execute(sql`delete from ${pairs} where listing_a = any(${uuids(ids)}) or listing_b = any(${uuids(ids)})`);
}

export interface SignatureRow extends Signature {}

/** These listings' stored signatures (by primary key). One statement. */
export async function signaturesOf(tx: Tx, ids: readonly string[]): Promise<Map<string, SignatureRow>> {
  if (ids.length === 0) return new Map();
  const res = await tx.execute<{
    listing_id: string;
    owner_agency_id: string;
    source_version: number;
    signature_version: number;
    transaction_type: string;
    property_type_id: string;
    city_id: string | null;
    beds: number | null;
    baths: number | null;
    area_m2: string | null;
    price_cents: string | null;
    lat: number | null;
    lng: number | null;
    image_keys: string;
    phashes: string;
    block_keys: string;
  }>(sql`
    select listing_id, owner_agency_id, source_version, signature_version, transaction_type, property_type_id,
           city_id, beds, baths, area_m2, price_cents, lat, lng, image_keys::text, phashes::text, block_keys::text
      from ${sigs} where listing_id = any(${uuids(ids)})`);
  return new Map(
    res.rows.map((r) => [
      r.listing_id,
      {
        listingId: r.listing_id,
        ownerAgencyId: r.owner_agency_id,
        sourceVersion: r.source_version,
        signatureVersion: r.signature_version,
        transactionType: r.transaction_type,
        propertyTypeId: r.property_type_id,
        cityId: r.city_id,
        beds: r.beds,
        baths: r.baths,
        areaM2: r.area_m2 === null ? null : Number(r.area_m2),
        priceCents: r.price_cents === null ? null : Number(r.price_cents),
        lat: r.lat,
        lng: r.lng,
        imageKeys: parseBigints(r.image_keys),
        phashes: parseBigints(r.phashes),
        blockKeys: parseBigints(r.block_keys),
      },
    ]),
  );
}

/**
 * Each key's postings: how many signatures hold it, counted up to `cap + 1` (a key past `cap` is common: a logo, a
 * placeholder, a dense tower's cell), and — `withIds` — the listings holding a key that is not common. One statement;
 * each key is one GIN probe reading at most `cap + 1` heap rows, and counting and candidate lookup share it.
 */
export async function keyPostings(
  tx: Tx,
  keys: readonly bigint[],
  cap: number,
  withIds: boolean,
): Promise<Map<bigint, { n: number; ids: string[] }>> {
  if (keys.length === 0) return new Map();
  const res = await tx.execute<{ key: string; n: number; ids: string | null }>(sql`
    select k.key::text as key, cardinality(x.ids) as n,
           case when ${withIds} and cardinality(x.ids) <= ${cap} then array_to_string(x.ids, ',') end as ids
      from unnest(${bigints([...new Set(keys)])}::bigint[]) as k(key)
      cross join lateral (
        -- offset 0: an optimisation fence, so the probe runs once a key (not once per reference to ids)
        select array(select s.listing_id from ${sigs} s where s.block_keys @> array[k.key] limit ${cap + 1}) as ids
        offset 0
      ) x`);
  return new Map(res.rows.map((r) => [BigInt(r.key), { n: r.n, ids: r.ids ? r.ids.split(',') : [] }]));
}

export interface StoredPair {
  listingA: string;
  listingB: string;
  score: number;
  signals: PairSignals;
  scorerVersion: number;
  versionA: number;
  versionB: number;
}

/**
 * The stored pairs of each listing, its `perListing` best from either side (PK on listing_a, index on listing_b). A
 * pair of two listings of the batch can come twice; the caller keys them. One statement, bounded.
 */
export async function pairsOf(tx: Tx, ids: readonly string[], perListing: number): Promise<StoredPair[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute<{
    listing_a: string;
    listing_b: string;
    score: number;
    signals: PairSignals;
    scorer_version: number;
    version_a: number;
    version_b: number;
  }>(sql`
    select x.listing_a, x.listing_b, x.score, x.signals, x.scorer_version, x.version_a, x.version_b
      from unnest(${uuids(ids)}) as i(id)
      cross join lateral (
        (select listing_a, listing_b, score, signals, scorer_version, version_a, version_b
           from ${pairs} where listing_a = i.id order by score desc limit ${perListing})
        union all
        (select listing_a, listing_b, score, signals, scorer_version, version_a, version_b
           from ${pairs} where listing_b = i.id order by score desc limit ${perListing})
      ) x`);
  return res.rows.map((r) => ({
    listingA: r.listing_a,
    listingB: r.listing_b,
    score: Number(r.score),
    signals: r.signals,
    scorerVersion: r.scorer_version,
    versionA: r.version_a,
    versionB: r.version_b,
  }));
}

export interface PairRow extends StoredPair {
  agencyA: string;
  agencyB: string;
}

/**
 * Writes scored pairs (`listing_a < listing_b`); an unchanged pair is not touched (`computed_at` stays: the re-score
 * of the same inputs is a no-op), and a score from older signatures never overwrites a newer one. One statement.
 */
export async function upsertPairs(tx: Tx, rows: readonly PairRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const json = JSON.stringify(
    rows.map((r) => ({
      a: r.listingA,
      b: r.listingB,
      aa: r.agencyA,
      ab: r.agencyB,
      score: r.score,
      signals: r.signals,
      sv: r.scorerVersion,
      va: r.versionA,
      vb: r.versionB,
    })),
  );
  const res = await tx.execute(sql`
    insert into ${pairs} as p (listing_a, listing_b, agency_a, agency_b, score, signals, scorer_version, version_a,
                               version_b, computed_at)
    select x.a, x.b, x.aa, x.ab, x.score, x.signals, x.sv, x.va, x.vb, now()
      from jsonb_to_recordset(${json}::jsonb) as x(a uuid, b uuid, aa uuid, ab uuid, score real, signals jsonb,
           sv smallint, va int, vb int)
    on conflict (listing_a, listing_b) do update set
      agency_a = excluded.agency_a, agency_b = excluded.agency_b, score = excluded.score, signals = excluded.signals,
      scorer_version = excluded.scorer_version, version_a = excluded.version_a, version_b = excluded.version_b,
      computed_at = now()
    where p.version_a <= excluded.version_a and p.version_b <= excluded.version_b
      and (p.agency_a, p.agency_b, p.score, p.signals, p.scorer_version, p.version_a, p.version_b)
          is distinct from
          (excluded.agency_a, excluded.agency_b, excluded.score, excluded.signals, excluded.scorer_version,
           excluded.version_a, excluded.version_b)`);
  return res.rowCount ?? 0;
}

/** Deletes these pairs (`[listing_a, listing_b]`, ordered). One statement. */
export async function deletePairs(tx: Tx, keys: readonly (readonly [string, string])[]): Promise<void> {
  if (keys.length === 0) return;
  const json = JSON.stringify(keys.map(([a, b]) => ({ a, b })));
  await tx.execute(sql`
    delete from ${pairs} p using jsonb_to_recordset(${json}::jsonb) as x(a uuid, b uuid)
     where p.listing_a = x.a and p.listing_b = x.b`);
}

/* ------------------------------------------------------------------ worker: clusters (global) */

/**
 * Serialises the recluster pass (one transaction advisory lock for every cluster): two passes never place one listing
 * in two clusters or rewrite a cluster from stale members. A pass is a few bounded statements; the lock is held to the
 * end of its transaction.
 */
export async function lockClusters(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('dedupe:clusters', 0))`);
}

export interface MemberRow {
  listingId: string;
  clusterId: string;
  ownerAgencyId: string;
  rank: number;
  via: 'AUTO' | 'CONFIRMED';
}

/** R2-03c: these listings' own cluster rows (the ones in a cluster). Primary key probes, one statement. */
export async function membershipOf(
  tx: Tx,
  ids: readonly string[],
): Promise<{ listingId: string; clusterId: string; rank: number }[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute<{ listing_id: string; cluster_id: string; rank: number }>(sql`
    select m.listing_id, m.cluster_id, m.rank from ${members} m where m.listing_id = any(${uuids(ids)})`);
  return res.rows.map((r) => ({ listingId: r.listing_id, clusterId: r.cluster_id, rank: r.rank }));
}

/** Every member of the clusters these listings are in (PK, then the cluster index). One statement. */
export async function clusterMatesOf(tx: Tx, ids: readonly string[]): Promise<MemberRow[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute<{
    listing_id: string;
    cluster_id: string;
    owner_agency_id: string;
    rank: number;
    via: 'AUTO' | 'CONFIRMED';
  }>(sql`
    select m.listing_id, m.cluster_id, m.owner_agency_id, m.rank, m.via from ${members} m
     where m.cluster_id in (select x.cluster_id from ${members} x where x.listing_id = any(${uuids(ids)}))`);
  return res.rows.map((r) => ({
    listingId: r.listing_id,
    clusterId: r.cluster_id,
    ownerAgencyId: r.owner_agency_id,
    rank: r.rank,
    via: r.via,
  }));
}

/**
 * The listings these listings link to: stored pairs ≥ `min` (from either side) and confirmed pairs. Two index probes
 * per id (PK / `listing_b` index of each table), one statement.
 */
export async function linkedListingsOf(tx: Tx, ids: readonly string[], min: number): Promise<string[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute<{ id: string }>(sql`
    with i(id) as (select unnest(${uuids(ids)}))
    select p.listing_b as id from ${pairs} p join i on p.listing_a = i.id where p.score >= ${min}
    union select p.listing_a from ${pairs} p join i on p.listing_b = i.id where p.score >= ${min}
    union select d.listing_b from ${decisions} d join i on d.listing_a = i.id where d.decision = 'CONFIRMED'
    union select d.listing_a from ${decisions} d join i on d.listing_b = i.id where d.decision = 'CONFIRMED'`);
  return res.rows.map((r) => r.id);
}

/** Stored pairs with both listings among `ids` (PK range per id, the other side filtered). One statement. */
export async function pairsAmong(
  tx: Tx,
  ids: readonly string[],
): Promise<{ a: string; b: string; score: number; signals: PairSignals }[]> {
  if (ids.length < 2) return [];
  const res = await tx.execute<{ listing_a: string; listing_b: string; score: number; signals: PairSignals }>(sql`
    select listing_a, listing_b, score, signals from ${pairs}
     where listing_a = any(${uuids(ids)}) and listing_b = any(${uuids(ids)})`);
  return res.rows.map((r) => ({ a: r.listing_a, b: r.listing_b, score: Number(r.score), signals: r.signals }));
}

export interface DecisionRow {
  a: string;
  b: string;
  decision: 'CONFIRMED' | 'NOT_DUPLICATE';
}

/** Decided pairs touching these listings (from either side). One statement. */
export async function decisionsTouching(tx: Tx, ids: readonly string[]): Promise<DecisionRow[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute<{ listing_a: string; listing_b: string; decision: 'CONFIRMED' | 'NOT_DUPLICATE' }>(sql`
    select listing_a, listing_b, decision from ${decisions} where listing_a = any(${uuids(ids)})
    union select listing_a, listing_b, decision from ${decisions} where listing_b = any(${uuids(ids)})`);
  return res.rows.map((r) => ({ a: r.listing_a, b: r.listing_b, decision: r.decision }));
}

/** Records decided pairs (`a < b`): a `NOT_DUPLICATE` replaces a `CONFIRMED`, never the other way round. One statement. */
export async function upsertDecisions(
  tx: Tx,
  rows: readonly (DecisionRow & { source: 'REVIEW' | 'DISPUTE'; agencyId: string | null })[],
): Promise<void> {
  if (rows.length === 0) return;
  const json = JSON.stringify(rows.map((r) => ({ a: r.a, b: r.b, d: r.decision, s: r.source, g: r.agencyId })));
  await tx.execute(sql`
    insert into ${decisions} as x (listing_a, listing_b, decision, source, decided_by_agency_id, decided_at)
    select r.a, r.b, r.d, r.s, r.g, now()
      from jsonb_to_recordset(${json}::jsonb) as r(a uuid, b uuid, d text, s text, g uuid)
     order by r.a, r.b
    on conflict (listing_a, listing_b) do update set
      decision = excluded.decision, source = excluded.source, decided_by_agency_id = excluded.decided_by_agency_id,
      decided_at = now()
    where x.decision = 'CONFIRMED' and excluded.decision = 'NOT_DUPLICATE'`);
}

/** Staff pins of these listings (epoch ms). One statement. */
export async function pinsOf(tx: Tx, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: pins.listingId, at: pins.pinnedAt })
    .from(pins)
    .where(inArray(pins.listingId, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.at.getTime()]));
}

/**
 * Pins a listing canonical (an upheld dispute): the latest staff decision wins — the pins of the other listings named
 * (its cluster mates now) are removed and this one is (re)stamped now. Two statements.
 */
export async function insertPin(tx: Tx, listingId: string, disputeId: string, mates: readonly string[]): Promise<void> {
  const others = mates.filter((m) => m !== listingId);
  if (others.length > 0) await tx.delete(pins).where(inArray(pins.listingId, others));
  await tx
    .insert(pins)
    .values({ listingId, disputeId })
    .onConflictDoUpdate({ target: pins.listingId, set: { disputeId, pinnedAt: sql`now()` } });
}

/** Removes a decided review the worker could not apply (its pair is no longer a candidate). One statement. */
export async function deleteReview(tx: Tx, id: string): Promise<void> {
  await tx.delete(reviews).where(eq(reviews.id, id));
}

/** These clusters' stored flags (the recluster pass's change check). One statement. */
export async function clusterFlags(tx: Tx, ids: readonly string[]): Promise<Map<string, boolean>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: clusters.id, flagged: clusters.flagged })
    .from(clusters)
    .where(inArray(clusters.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.flagged]));
}

export interface ClusterWrite {
  id: string;
  flagged: boolean;
  members: { id: string; ownerAgencyId: string; via: 'AUTO' | 'CONFIRMED' }[];
}

/**
 * Replaces clusters: `drop` (gone, members with them: FK cascade), then the members of `write` rewritten in rank order
 * (the clusters upserted, their old members removed first). Four statements at most.
 */
export async function writeClusters(tx: Tx, drop: readonly string[], write: readonly ClusterWrite[]): Promise<void> {
  const gone = [...new Set([...drop, ...write.map((c) => c.id)])];
  if (gone.length > 0) {
    await tx.execute(sql`delete from ${members} where cluster_id = any(${uuids(gone)})`);
  }
  if (drop.length > 0) await tx.execute(sql`delete from ${clusters} where id = any(${uuids(drop)})`);
  if (write.length === 0) return;
  const json = JSON.stringify(
    write.map((c) => ({ id: c.id, canonical: c.members[0]?.id, size: c.members.length, flagged: c.flagged })),
  );
  await tx.execute(sql`
    insert into ${clusters} as c (id, canonical_listing_id, size, flagged, created_at, updated_at)
    select x.id, x.canonical, x.size, x.flagged, now(), now()
      from jsonb_to_recordset(${json}::jsonb) as x(id uuid, canonical uuid, size smallint, flagged boolean)
     order by x.id
    on conflict (id) do update set canonical_listing_id = excluded.canonical_listing_id, size = excluded.size,
      flagged = excluded.flagged, updated_at = now()`);
  const rows = JSON.stringify(
    write.flatMap((c) => c.members.map((m, rank) => ({ l: m.id, c: c.id, g: m.ownerAgencyId, r: rank, v: m.via }))),
  );
  await tx.execute(sql`
    insert into ${members} (listing_id, cluster_id, owner_agency_id, rank, via)
    select x.l, x.c, x.g, x.r, x.v
      from jsonb_to_recordset(${rows}::jsonb) as x(l uuid, c uuid, g uuid, r smallint, v text)
     order by x.l`);
}

/** Members of these clusters, canonical first (staff console; staff read the table). One statement. */
export async function membersOfClusters(tx: Tx, ids: readonly string[]): Promise<MemberRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      listingId: members.listingId,
      clusterId: members.clusterId,
      ownerAgencyId: members.ownerAgencyId,
      rank: members.rank,
      via: members.via,
    })
    .from(members)
    .where(inArray(members.clusterId, [...new Set(ids)]))
    .orderBy(members.clusterId, members.rank);
  return rows.map((r) => ({ ...r, via: r.via as MemberRow['via'] }));
}

/* ------------------------------------------------------------------ worker: the agencies' projections */

/**
 * Rewrites the agencies' clustered-listing rows of these listings (`drop`: no longer clustered; `write`: their
 * cluster, rank and members now; `created_at` kept). Two statements at most.
 */
export async function writeListingClusters(
  tx: Tx,
  drop: readonly string[],
  write: readonly {
    agencyId: string;
    listingId: string;
    clusterId: string;
    rank: number;
    via: string;
    memberIds: string[];
  }[],
): Promise<void> {
  if (drop.length > 0) await tx.execute(sql`delete from ${listingClusters} where listing_id = any(${uuids(drop)})`);
  if (write.length === 0) return;
  const json = JSON.stringify(
    write.map((w) => ({ g: w.agencyId, l: w.listingId, c: w.clusterId, r: w.rank, v: w.via, m: w.memberIds })),
  );
  await tx.execute(sql`
    insert into ${listingClusters} as t (agency_id, listing_id, cluster_id, rank, via, member_ids, created_at, updated_at)
    select x.g, x.l, x.c, x.r, x.v, array(select jsonb_array_elements_text(x.m))::uuid[], now(), now()
      from jsonb_to_recordset(${json}::jsonb) as x(g uuid, l uuid, c uuid, r smallint, v text, m jsonb)
     order by x.l
    on conflict (listing_id) do update set agency_id = excluded.agency_id, cluster_id = excluded.cluster_id,
      rank = excluded.rank, via = excluded.via, member_ids = excluded.member_ids, updated_at = now()`);
}

export interface ReviewPairRow {
  a: string;
  b: string;
  agencyA: string;
  agencyB: string;
  score: number;
  signals: PairSignals;
}

/** The stored pairs of these listings, each one's `perListing` best from either side. One statement, bounded. */
export async function reviewPairsOf(tx: Tx, ids: readonly string[], perListing: number): Promise<ReviewPairRow[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute<{
    listing_a: string;
    listing_b: string;
    agency_a: string;
    agency_b: string;
    score: number;
    signals: PairSignals;
  }>(sql`
    select distinct x.listing_a, x.listing_b, x.agency_a, x.agency_b, x.score, x.signals
      from unnest(${uuids(ids)}) as i(id)
      cross join lateral (
        (select listing_a, listing_b, agency_a, agency_b, score, signals
           from ${pairs} where listing_a = i.id order by score desc limit ${perListing})
        union all
        (select listing_a, listing_b, agency_a, agency_b, score, signals
           from ${pairs} where listing_b = i.id order by score desc limit ${perListing})
      ) x`);
  return res.rows.map((r) => ({
    a: r.listing_a,
    b: r.listing_b,
    agencyA: r.agency_a,
    agencyB: r.agency_b,
    score: Number(r.score),
    signals: r.signals,
  }));
}

export interface PendingReviewRow {
  id: string;
  agencyId: string;
  listingId: string;
  otherListingId: string;
  score: number;
}

/** Pending review rows touching these listings, every agency's (worker). Two index probes per id, one statement. */
export async function pendingReviewsTouching(tx: Tx, ids: readonly string[]): Promise<PendingReviewRow[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute<{
    id: string;
    agency_id: string;
    listing_id: string;
    other_listing_id: string;
    score: number;
  }>(sql`
    select id, agency_id, listing_id, other_listing_id, score from ${reviews}
     where status = 'PENDING' and listing_id = any(${uuids(ids)})
    union
    select id, agency_id, listing_id, other_listing_id, score from ${reviews}
     where status = 'PENDING' and other_listing_id = any(${uuids(ids)})`);
  return res.rows.map((r) => ({
    id: r.id,
    agencyId: r.agency_id,
    listingId: r.listing_id,
    otherListingId: r.other_listing_id,
    score: Number(r.score),
  }));
}

/**
 * Writes pending reviews (worker): new rows inserted, a pending one's score refreshed; a decided row is never touched
 * (the agency's decision stands). One statement.
 */
export async function upsertPendingReviews(
  tx: Tx,
  rows: readonly {
    id: string;
    agencyId: string;
    listingId: string;
    otherListingId: string;
    score: number;
    signals: PairSignals;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  const json = JSON.stringify(
    rows.map((r) => ({ i: r.id, g: r.agencyId, l: r.listingId, o: r.otherListingId, s: r.score, x: r.signals })),
  );
  await tx.execute(sql`
    insert into ${reviews} as r (id, agency_id, listing_id, other_listing_id, score, signals, status, created_at,
                                 updated_at)
    select x.i, x.g, x.l, x.o, x.s, x.x, 'PENDING', now(), now()
      from jsonb_to_recordset(${json}::jsonb) as x(i uuid, g uuid, l uuid, o uuid, s real, x jsonb)
     order by x.g, x.l, x.o
    on conflict (agency_id, listing_id, other_listing_id) do update set score = excluded.score,
      signals = excluded.signals, updated_at = now()
    where r.status = 'PENDING' and (r.score, r.signals) is distinct from (excluded.score, excluded.signals)`);
}

/** Removes pending reviews (worker: the pair is gone, decided or clustered). One statement. */
export async function deletePendingReviews(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`delete from ${reviews} where status = 'PENDING' and id = any(${uuids(ids)})`);
}

/** One review row, any agency's (worker: applying a decision). One statement. */
export async function reviewById(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: reviews.id,
      agencyId: reviews.agencyId,
      listingId: reviews.listingId,
      otherListingId: reviews.otherListingId,
      status: reviews.status,
    })
    .from(reviews)
    .where(eq(reviews.id, id));
  return row ?? null;
}

/** Whether these two listings have a stored pair now (worker). One statement (PK). */
export async function pairStored(tx: Tx, a: string, b: string): Promise<boolean> {
  const [x, y] = a < b ? [a, b] : [b, a];
  const res = await tx.execute(sql`select 1 from ${pairs} where listing_a = ${x}::uuid and listing_b = ${y}::uuid`);
  return res.rows.length > 0;
}

/* ------------------------------------------------------------------ request: the review queue (tenant) */

export interface ReviewQueueRow {
  id: string;
  listingId: string;
  otherListingId: string;
  score: number;
  signals: PairSignals;
  status: string;
  decidedAt: Date | null;
  createdAt: Date;
  atUs: string;
}

/** The agency's reviews of one status, newest first (keyset on `(created_at, id)`, `limit + 1` rows). One statement. */
export async function reviewQueuePage(
  tx: Tx,
  q: { agencyId: string; status: string; cursor?: KeysetCursor | undefined; limit: number },
): Promise<ReviewQueueRow[]> {
  const rows = await tx
    .select({
      id: reviews.id,
      listingId: reviews.listingId,
      otherListingId: reviews.otherListingId,
      score: reviews.score,
      signals: reviews.signals,
      status: reviews.status,
      decidedAt: reviews.decidedAt,
      createdAt: reviews.createdAt,
      atUs: keysetStamp(reviews.createdAt),
    })
    .from(reviews)
    .where(
      and(
        eq(reviews.agencyId, q.agencyId),
        eq(reviews.status, q.status),
        keysetAfterRaw(reviews.createdAt, reviews.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(reviews.createdAt, reviews.id, 'desc'))
    .limit(q.limit + 1);
  return rows.map((r) => ({ ...r, score: Number(r.score), signals: r.signals as PairSignals }));
}

/** One of the agency's reviews, locked until the transaction ends. One statement. */
export async function lockReview(tx: Tx, agencyId: string, id: string) {
  const [row] = await tx
    .select({
      id: reviews.id,
      listingId: reviews.listingId,
      otherListingId: reviews.otherListingId,
      status: reviews.status,
    })
    .from(reviews)
    .where(and(eq(reviews.agencyId, agencyId), eq(reviews.id, id)))
    .for('update');
  return row ?? null;
}

/** A member's decision on a pending review (its status, who, when). One statement. */
export async function decideReview(
  tx: Tx,
  agencyId: string,
  id: string,
  status: 'CONFIRMED' | 'NOT_DUPLICATE',
  userId: string,
): Promise<boolean> {
  const rows = await tx
    .update(reviews)
    .set({ status, decidedByUserId: userId, decidedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(reviews.agencyId, agencyId), eq(reviews.id, id), eq(reviews.status, 'PENDING')))
    .returning({ id: reviews.id });
  return rows.length > 0;
}

/* ------------------------------------------------------------------ request: clustered listings, disputes (tenant) */

export interface ListingClusterRow {
  listingId: string;
  clusterId: string;
  rank: number;
  via: string;
  memberIds: string[];
  createdAt: Date;
  atUs: string;
}

const listingClusterColumns = {
  listingId: listingClusters.listingId,
  clusterId: listingClusters.clusterId,
  rank: listingClusters.rank,
  via: listingClusters.via,
  memberIds: listingClusters.memberIds,
  createdAt: listingClusters.createdAt,
  atUs: keysetStamp(listingClusters.createdAt),
};

/** The agency's clustered listings, newest first (keyset on `(created_at, listing_id)`, `limit + 1`). One statement. */
export function listingClustersPage(
  tx: Tx,
  q: { agencyId: string; cursor?: KeysetCursor | undefined; limit: number },
): Promise<ListingClusterRow[]> {
  return tx
    .select(listingClusterColumns)
    .from(listingClusters)
    .where(
      and(
        eq(listingClusters.agencyId, q.agencyId),
        keysetAfterRaw(listingClusters.createdAt, listingClusters.listingId, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(listingClusters.createdAt, listingClusters.listingId, 'desc'))
    .limit(q.limit + 1);
}

/** One of the agency's clustered listings (PK). One statement. */
export async function listingClusterOf(tx: Tx, agencyId: string, listingId: string) {
  const [row] = await tx
    .select(listingClusterColumns)
    .from(listingClusters)
    .where(and(eq(listingClusters.agencyId, agencyId), eq(listingClusters.listingId, listingId)));
  return row ?? null;
}

const disputeColumns = {
  id: disputes.id,
  agencyId: disputes.agencyId,
  listingId: disputes.listingId,
  clusterId: disputes.clusterId,
  kind: disputes.kind,
  reason: disputes.reason,
  status: disputes.status,
  resolutionNote: disputes.resolutionNote,
  createdAt: disputes.createdAt,
  resolvedAt: disputes.resolvedAt,
  atUs: keysetStamp(disputes.createdAt),
};
export type DisputeRow = {
  id: string;
  agencyId: string;
  listingId: string;
  clusterId: string;
  kind: string;
  reason: string;
  status: string;
  resolutionNote: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  atUs: string;
};

/** The agency's open disputes of these listings. One statement (partial unique index). */
export async function openDisputesOf(tx: Tx, agencyId: string, listingIds: readonly string[]) {
  if (listingIds.length === 0) return [];
  return tx
    .select({ id: disputes.id, listingId: disputes.listingId, kind: disputes.kind })
    .from(disputes)
    .where(
      and(
        eq(disputes.agencyId, agencyId),
        eq(disputes.status, 'OPEN'),
        inArray(disputes.listingId, [...new Set(listingIds)]),
      ),
    );
}

/** A member opens a dispute (`OPEN`); null when the listing has an open one already. One statement. */
export async function insertDispute(
  tx: Tx,
  row: {
    id: string;
    agencyId: string;
    listingId: string;
    clusterId: string;
    kind: string;
    reason: string;
    openedByUserId: string;
  },
): Promise<DisputeRow | null> {
  const [inserted] = await tx
    .insert(disputes)
    .values({ ...row, status: 'OPEN' })
    .onConflictDoNothing({ target: disputes.listingId, where: sql`${disputes.status} = 'OPEN'` })
    .returning(disputeColumns);
  return inserted ?? null;
}

/** The agency's disputes, newest first (keyset, `limit + 1`). One statement. */
export function disputesPage(
  tx: Tx,
  q: { agencyId: string; cursor?: KeysetCursor | undefined; limit: number },
): Promise<DisputeRow[]> {
  return tx
    .select(disputeColumns)
    .from(disputes)
    .where(and(eq(disputes.agencyId, q.agencyId), keysetAfterRaw(disputes.createdAt, disputes.id, q.cursor, 'desc')))
    .orderBy(...keysetOrderRaw(disputes.createdAt, disputes.id, 'desc'))
    .limit(q.limit + 1);
}

/* ------------------------------------------------------------------ staff: disputes */

/** Every agency's disputes of one status, oldest first (staff; keyset, `limit + 1`). One statement. */
export function staffDisputesPage(
  tx: Tx,
  q: { status: string; cursor?: KeysetCursor | undefined; limit: number },
): Promise<DisputeRow[]> {
  return tx
    .select(disputeColumns)
    .from(disputes)
    .where(and(eq(disputes.status, q.status), keysetAfterRaw(disputes.createdAt, disputes.id, q.cursor, 'asc')))
    .orderBy(...keysetOrderRaw(disputes.createdAt, disputes.id, 'asc'))
    .limit(q.limit + 1);
}

/** One dispute, any agency's (staff: locked until the transaction ends; worker: plain read). One statement. */
export async function disputeById(tx: Tx, id: string, forUpdate = false): Promise<DisputeRow | null> {
  const q = tx.select(disputeColumns).from(disputes).where(eq(disputes.id, id));
  const [row] = await (forUpdate ? q.for('update') : q);
  return row ?? null;
}

/** Staff resolve an open dispute (status, who, when, the note). One statement. */
export async function resolveDispute(
  tx: Tx,
  id: string,
  r: { status: 'UPHELD' | 'REJECTED'; userId: string; note: string },
): Promise<DisputeRow | null> {
  const [row] = await tx
    .update(disputes)
    .set({
      status: r.status,
      resolvedByUserId: r.userId,
      resolutionNote: r.note,
      resolvedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(disputes.id, id), eq(disputes.status, 'OPEN')))
    .returning(disputeColumns);
  return row ?? null;
}

/** The owners of these listings' stored signatures (a live listing has one). One statement (PK). */
export async function signatureOwnersOf(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const res = await tx.execute<{ listing_id: string; owner_agency_id: string }>(sql`
    select listing_id, owner_agency_id from ${sigs} where listing_id = any(${uuids(ids)})`);
  return new Map(res.rows.map((r) => [r.listing_id, r.owner_agency_id]));
}
