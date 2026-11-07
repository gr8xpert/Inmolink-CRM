/**
 * dedupe queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, bounded statements.
 * Queries only `@inmolink/db/schema/dedupe` — other modules' tables fail `pnpm check:boundaries`.
 *
 * Worker-only (`withSystem`): both tables are global and read by no tenant role. Bigint keys travel as one text
 * parameter (`'{1,-2}'::bigint[]`): JSON has no 64-bit integers.
 */
import type { Tx } from '@inmolink/db';
import { dedupePairScores as pairs, dedupeListingSignatures as sigs } from '@inmolink/db/schema/dedupe';
import { sql } from 'drizzle-orm';
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
