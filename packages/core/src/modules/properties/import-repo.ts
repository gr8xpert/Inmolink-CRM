/**
 * Feed import queries (S6-02, PATTERNS §13): one bulk INSERT into the UNLOGGED staging table
 * (`property_import_staging`, one `batch_id` per batch), then set-based statements — lookup, MERGE … RETURNING merge_action(), children — a fixed
 * handful per batch whatever its size; the batch's staging rows are deleted before its transaction commits. Queries
 * only `@inmolink/db/schema/properties` tables. Runs in the feed run's batch transaction as `app_user` (`withTenant`,
 * RLS): the agency's own rows only.
 */
import type { Tx } from '@inmolink/db';
import { propertyPriceHistories, propertyStatusHistories } from '@inmolink/db/schema/properties';
import { sql } from 'drizzle-orm';

/**
 * One bind parameter for a whole list (a PostgreSQL array literal, every element quoted and escaped), not one per
 * element: a run's references can outnumber the protocol's 65,535 parameters.
 */
export const arrayParam = (values: readonly string[]) =>
  `{${values.map((v) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;

/**
 * One staged feed item (`property_import_staging` columns, snake_case as the recordset reads them). Arrays and the
 * translations are JSON; decimals are strings (exact).
 */
export interface StagingRow {
  ref: string;
  hash: string;
  images_hash: string | null;
  held: readonly string[];
  status: string;
  transaction_type: string;
  price_cents: number | null;
  currency: string;
  price_period: string | null;
  price_on_request: boolean;
  built_m2: string | null;
  plot_m2: string | null;
  terrace_m2: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  year_built: number | null;
  energy_rating: string | null;
  energy_emissions_rating: string | null;
  lat: string | null;
  lng: string | null;
  exact_lat: string | null;
  exact_lng: string | null;
  location_precision: string;
  property_type_id: string | null;
  location_id: string | null;
  country_id: string | null;
  region_id: string | null;
  city_id: string | null;
  feature_ids: readonly string[];
  translations: readonly { locale: string; title: string; description: string | null; slug: string }[];
  new_id: string;
  new_ref: string;
  /** The agency's listing from this source with this reference (`existing`), or nulls/defaults when new. */
  existing_id: string | null;
  live: boolean;
  old_hash: string | null;
  old_images_hash: string | null;
  old_missed: number;
  old_withdrawn: boolean;
  old_conn: string | null;
}

/** Rows per statement at the end of a run (missed counts, withdrawals). */
const RUN_END_CHUNK = 1_000;

/** JSON characters per staging statement (see `stage`). */
const STAGE_CHUNK_BYTES = 8 * 1024 * 1024;

/** The recordset's column definitions: the staging table's types (enums included). */
const RECORDSET = `r(ref text, hash char(64), images_hash char(64), held text[], status listing_status,
  transaction_type transaction_type, price_cents bigint, currency char(3), price_period price_period,
  price_on_request boolean, built_m2 numeric(10,2), plot_m2 numeric(10,2), terrace_m2 numeric(10,2), bedrooms integer,
  bathrooms integer, year_built integer, energy_rating cee_rating, energy_emissions_rating cee_rating,
  lat numeric(9,6), lng numeric(9,6), exact_lat numeric(9,6), exact_lng numeric(9,6),
  location_precision location_precision, property_type_id uuid, location_id uuid, country_id uuid, region_id uuid,
  city_id uuid, feature_ids uuid[], translations jsonb, new_id uuid, new_ref text, existing_id uuid, live boolean,
  old_hash char(64), old_images_hash char(64), old_missed smallint, old_withdrawn boolean, old_conn uuid)`;
const COLUMNS = `ref, hash, images_hash, held, status, transaction_type, price_cents, currency, price_period,
  price_on_request, built_m2, plot_m2, terrace_m2, bedrooms, bathrooms, year_built, energy_rating,
  energy_emissions_rating, lat, lng, exact_lat, exact_lng, location_precision, property_type_id, location_id,
  country_id, region_id, city_id, feature_ids, translations, new_id, new_ref, existing_id, live, old_hash,
  old_images_hash, old_missed, old_withdrawn, old_conn`;

/** The run's constants and this batch's staging key, bound as parameters (never interpolated). */
export interface ImportScope {
  batchId: string;
  agencyId: string;
  runId: string;
  connectionId: string;
  /** `properties.source` of new listings (the connector's format, `KYERO`). */
  source: string;
  /**
   * `property_privates.external_source`: the re-import namespace of feed references — per connection
   * (`KYERO:<connection id>`), so two feeds of one format in an agency never match each other's listings.
   */
  externalSource: string;
}

/**
 * Fills the staging table for this batch: one INSERT … SELECT from a JSON recordset (one bind parameter). Not COPY:
 * PostgreSQL refuses `COPY FROM` into a table under row-level security for a role without BYPASSRLS, and the batch
 * runs as `app_user` (RLS checks every staged row's agency).
 */
export async function stage(tx: Tx, scope: ImportScope, rows: readonly StagingRow[]): Promise<void> {
  // One statement per ≤ STAGE_CHUNK_BYTES of JSON: a batch of long multilingual items stays a few bounded parameters.
  let chunk: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (chunk.length === 0) return;
    await tx.execute(sql`
      insert into property_import_staging (batch_id, agency_id, ${sql.raw(COLUMNS)})
      select ${scope.batchId}::uuid, ${scope.agencyId}::uuid, ${sql.raw(COLUMNS)}
        from jsonb_to_recordset(${`[${chunk.join(',')}]`}::jsonb) as ${sql.raw(RECORDSET)}`);
    chunk = [];
    bytes = 0;
  };
  for (const row of rows) {
    const json = JSON.stringify(row);
    if (bytes + json.length > STAGE_CHUNK_BYTES) await flush();
    chunk.push(json);
    bytes += json.length;
  }
  await flush();
}

/** Deletes this batch's staging rows (the end of the batch; nothing of it outlives the transaction). */
export async function unstage(tx: Tx, scope: ImportScope): Promise<void> {
  await tx.execute(sql`delete from property_import_staging where batch_id = ${scope.batchId}`);
}

export interface ExistingImport {
  ref: string;
  id: string;
  live: boolean;
  hash: string | null;
  imagesHash: string | null;
  missed: number;
  withdrawn: boolean;
  connectionId: string | null;
}

/**
 * The agency's listings from this source with these feed references, and their import state. One statement driven
 * by the reference list (`property_privates_source_ref_uq`, then the listing by primary key): never planned on the
 * statistics of rows this run just wrote.
 */
export async function existingByRefs(tx: Tx, scope: ImportScope, refs: readonly string[]): Promise<ExistingImport[]> {
  if (refs.length === 0) return [];
  const res = await tx.execute(sql`
    select pp.external_ref as ref, pp.property_id as id, p.deleted_at is null as live, pp.import_hash as hash,
           pp.import_images_hash as "imagesHash", pp.import_missed_runs as missed,
           pp.import_withdrawn_at is not null as withdrawn, pp.import_connection_id as "connectionId"
      from property_privates pp
      join properties p on p.id = pp.property_id
     where pp.agency_id = ${scope.agencyId}
       and pp.external_source = ${scope.externalSource}
       and pp.external_ref = any(${arrayParam(refs)}::text[])`);
  return res.rows as unknown as ExistingImport[];
}

/** Records every feed reference of the batch as seen by the run (staged, rejected and failed items alike). */
export async function recordSeen(tx: Tx, scope: ImportScope, extraRefs: readonly string[]): Promise<void> {
  await tx.execute(sql`
    insert into property_import_seen (agency_id, run_id, external_ref)
    select ${scope.agencyId}::uuid, ${scope.runId}::uuid, ref from property_import_staging
     where batch_id = ${scope.batchId}
    union
    select ${scope.agencyId}::uuid, ${scope.runId}::uuid, r from unnest(${arrayParam(extraRefs)}::text[]) r
    on conflict do nothing`);
}

/**
 * New items that cannot be stored: no property type, or no location level matched (the listing row needs both).
 * Removed from staging; an existing listing keeps its own and is only held.
 */
export async function rejectUnplaceable(tx: Tx, scope: ImportScope): Promise<{ ref: string; noType: boolean }[]> {
  const res = await tx.execute(sql`
    delete from property_import_staging
     where batch_id = ${scope.batchId} and existing_id is null and (property_type_id is null or location_id is null)
    returning ref, property_type_id is null as "noType"`);
  return res.rows as { ref: string; noType: boolean }[];
}

/**
 * Which of these new references one of the agency's listings has already (random 8-character refs: practically
 * never). One index probe per reference (`properties_agency_ref_uq`).
 */
export async function takenRefs(tx: Tx, agencyId: string, refs: readonly string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const res = await tx.execute(sql`
    select ref from properties where agency_id = ${agencyId} and ref = any(${arrayParam(refs)}::text[])`);
  return (res.rows as { ref: string }[]).map((r) => r.ref);
}

export interface MergedRow {
  action: 'INSERT' | 'UPDATE';
  id: string;
  ref: string;
  version: number;
  oldStatus: string | null;
  newStatus: string;
  oldPriceCents: string | null;
  newPriceCents: string | null;
  currency: string;
  imagesChanged: boolean;
}

const locked = (field: string) => sql.raw(`'${field}' = any(p.locked_fields)`);

/**
 * The MERGE (PostgreSQL 17+ `RETURNING merge_action()`, 18 `old`/`new`): inserts new listings, updates the live ones
 * whose import hash changed (or that the import withdrew and the feed lists again), and leaves the rest untouched —
 * an unchanged item writes nothing. Agent-locked fields keep their value (PLAN §3 #18); a held item goes DRAFT (a
 * listing on the market only: a sold or rented one keeps that); a PUBLIC listing never loses its CEE rating
 * (PLAN §13). Commission and split are the agency's defaults on insert and never written on update.
 */
export async function mergeListings(
  tx: Tx,
  scope: ImportScope,
  owner: {
    userId: string;
    commissionBp: number | null;
    commissionFixedCents: number | null;
    includesVat: boolean;
    splitBp: number;
  },
): Promise<MergedRow[]> {
  // A held location keeps the listing's own place (its unmatched level is not known yet); a new listing gets the
  // deepest level that matched.
  const keepLocation = sql`(${locked('location')} or s.location_id is null or 'location' = any(s.held))`;
  const heldStatus = sql`case when cardinality(s.held) > 0 and s.status in ('ACTIVE', 'UNDER_OFFER')
    then 'DRAFT'::listing_status else s.status end`;
  const res = await tx.execute(sql`
    merge into properties p
    using (select * from property_import_staging where batch_id = ${scope.batchId}) s on p.id = s.existing_id
    when matched and p.deleted_at is null and (s.old_hash is distinct from s.hash or s.old_withdrawn) then update set
      status = case when ${locked('status')} then p.status else ${heldStatus} end,
      transaction_type = case when ${locked('price')} then p.transaction_type else s.transaction_type end,
      price_cents = case when ${locked('price')} then p.price_cents else s.price_cents end,
      currency = case when ${locked('price')} then p.currency else s.currency end,
      price_period = case when ${locked('price')} then p.price_period else s.price_period end,
      price_on_request = case when ${locked('price')} then p.price_on_request else s.price_on_request end,
      built_m2 = case when ${locked('specs')} then p.built_m2 else s.built_m2 end,
      plot_m2 = case when ${locked('specs')} then p.plot_m2 else s.plot_m2 end,
      terrace_m2 = case when ${locked('specs')} then p.terrace_m2 else s.terrace_m2 end,
      bedrooms = case when ${locked('specs')} then p.bedrooms else s.bedrooms end,
      bathrooms = case when ${locked('specs')} then p.bathrooms else s.bathrooms end,
      year_built = case when ${locked('specs')} then p.year_built else s.year_built end,
      energy_rating = case
        when ${locked('energyRating')} then p.energy_rating
        when p.visibility = 'PUBLIC' and (s.energy_rating is null or s.energy_rating = 'PENDING') then p.energy_rating
        else s.energy_rating end,
      energy_emissions_rating = case when ${locked('energyRating')} then p.energy_emissions_rating
        else s.energy_emissions_rating end,
      lat = case when ${locked('coordinates')} then p.lat else s.lat end,
      lng = case when ${locked('coordinates')} then p.lng else s.lng end,
      location_precision = case when ${locked('coordinates')} then p.location_precision else s.location_precision end,
      property_type_id = case when ${locked('propertyType')} or s.property_type_id is null then p.property_type_id
        else s.property_type_id end,
      location_id = case when ${keepLocation} then p.location_id else s.location_id end,
      country_id = case when ${keepLocation} then p.country_id else s.country_id end,
      region_id = case when ${keepLocation} then p.region_id else s.region_id end,
      city_id = case when ${keepLocation} then p.city_id else s.city_id end,
      version = p.version + 1,
      updated_at = now()
    when not matched and s.existing_id is null then insert (
      id, agency_id, owner_user_id, ref, source, status, transaction_type, price_cents, currency, price_period,
      price_on_request, commission_bp, commission_fixed_cents, commission_includes_vat, split_bp, built_m2, plot_m2,
      terrace_m2, bedrooms, bathrooms, year_built, energy_rating, energy_emissions_rating, lat, lng,
      location_precision, property_type_id, location_id, country_id, region_id, city_id
    ) values (
      s.new_id, ${scope.agencyId}, ${owner.userId}, s.new_ref, ${scope.source}, ${heldStatus}, s.transaction_type,
      s.price_cents, s.currency, s.price_period, s.price_on_request, ${owner.commissionBp}::integer,
      ${owner.commissionFixedCents}::bigint, ${owner.includesVat}, ${owner.splitBp}, s.built_m2, s.plot_m2,
      s.terrace_m2, s.bedrooms, s.bathrooms, s.year_built, s.energy_rating, s.energy_emissions_rating, s.lat, s.lng,
      s.location_precision, s.property_type_id, s.location_id, s.country_id, s.region_id, s.city_id
    )
    returning merge_action() as action, p.id, s.ref, p.version, old.status as "oldStatus", new.status as "newStatus",
      old.price_cents as "oldPriceCents", new.price_cents as "newPriceCents", new.currency,
      s.images_hash is not null and s.images_hash is distinct from s.old_images_hash as "imagesChanged"`);
  return res.rows as unknown as MergedRow[];
}

/** Owner-only import state and the exact pin: inserted for new listings, updated where it moved. Two statements. */
export async function writePrivates(tx: Tx, scope: ImportScope): Promise<void> {
  await tx.execute(sql`
    insert into property_privates (property_id, agency_id, external_source, external_ref, exact_lat, exact_lng,
                                   import_hash, import_images_hash, import_connection_id, import_held)
    select s.new_id, ${scope.agencyId}, ${scope.externalSource}, s.ref, s.exact_lat, s.exact_lng, s.hash, s.images_hash,
           ${scope.connectionId}, nullif(s.held, '{}')
      from property_import_staging s
     where s.batch_id = ${scope.batchId} and s.existing_id is null`);
  await tx.execute(sql`
    update property_privates pp
       set import_hash = s.hash,
           import_images_hash = s.images_hash,
           import_missed_runs = 0,
           import_withdrawn_at = null,
           import_connection_id = ${scope.connectionId},
           import_held = nullif(s.held, '{}'),
           exact_lat = case when (s.old_hash is distinct from s.hash or s.old_withdrawn) and not ${locked('coordinates')}
             then s.exact_lat else pp.exact_lat end,
           exact_lng = case when (s.old_hash is distinct from s.hash or s.old_withdrawn) and not ${locked('coordinates')}
             then s.exact_lng else pp.exact_lng end,
           updated_at = now()
      from property_import_staging s
      join properties p on p.id = s.existing_id
     where s.batch_id = ${scope.batchId}
       and pp.property_id = s.existing_id
       and s.live
       and (s.old_hash is distinct from s.hash or s.old_missed > 0 or s.old_withdrawn
            or s.old_conn is distinct from ${scope.connectionId}::uuid)`);
}

/**
 * Translations and features of the listings the MERGE wrote (`ids`): the feed's locales are upserted (a locked
 * translation — a person fixed it — is never overwritten), the feature set replaced by the feed's matched features.
 * Three statements.
 */
export async function writeContent(
  tx: Tx,
  scope: ImportScope,
  ids: readonly string[],
  features: { listingIds: readonly string[]; featureIds: readonly string[] },
): Promise<void> {
  if (ids.length === 0) return;
  const { agencyId, batchId } = scope;
  const idArray = sql`${arrayParam(ids)}::uuid[]`;
  await tx.execute(sql`
    insert into property_translations (property_id, agency_id, locale, title, description, slug, origin)
    select coalesce(s.existing_id, s.new_id), ${agencyId}, t.locale, t.title, t.description, t.slug, 'HUMAN'
      from property_import_staging s
     cross join lateral jsonb_to_recordset(s.translations) as t(locale text, title text, description text, slug text)
     where s.batch_id = ${batchId} and coalesce(s.existing_id, s.new_id) = any(${idArray})
    on conflict (property_id, locale) do update
       set title = excluded.title, description = excluded.description, slug = excluded.slug, origin = 'HUMAN',
           updated_at = now()
     where not property_translations.locked
       and (property_translations.title, property_translations.description, property_translations.slug)
           is distinct from (excluded.title, excluded.description, excluded.slug)`);
  // The feed's (listing, feature) pairs as two arrays: neither statement is a join planned on the staging table's
  // statistics (always "empty": its rows never outlive a transaction). A feature set the agent locked (PLAN §3 #18)
  // is neither trimmed nor extended by the feed.
  const pairs = sql`unnest(${arrayParam(features.listingIds)}::uuid[], ${arrayParam(features.featureIds)}::uuid[])`;
  await tx.execute(sql`
    delete from property_features f
     where f.property_id = any(${idArray})
       and not exists (select 1 from properties p where p.id = f.property_id and 'features' = any(p.locked_fields))
       and (f.property_id, f.feature_id) not in (select * from ${pairs})`);
  await tx.execute(sql`
    insert into property_features (property_id, agency_id, feature_id)
    select k.pid, ${agencyId}, k.fid
      from ${pairs} as k(pid, fid)
      join properties p on p.id = k.pid
     where not ('features' = any(p.locked_fields))
    on conflict do nothing`);
}

export type StatusHistoryInsert = typeof propertyStatusHistories.$inferInsert;
export type PriceHistoryInsert = typeof propertyPriceHistories.$inferInsert;

/** One INSERT per history table for the whole batch. */
export async function insertHistories(
  tx: Tx,
  statuses: StatusHistoryInsert[],
  prices: PriceHistoryInsert[],
): Promise<void> {
  if (statuses.length > 0) await tx.insert(propertyStatusHistories).values(statuses);
  if (prices.length > 0) await tx.insert(propertyPriceHistories).values(prices);
}

/**
 * The end of a successful run: the connection's listings missing from it count one more missed run (up to `n`);
 * answers the missing ones at `n` or beyond not withdrawn by the import yet (a lowered `n` withdraws at once; sold,
 * rented and status-locked ones are filtered by `withdraw`). Three statements, none a join planned on statistics: the
 * run's seen rows and the listings it just wrote are minutes old, so their statistics say "empty", and a join planned
 * on that rescans one side per row of the other.
 */
export async function countMisses(
  tx: Tx,
  scope: Pick<ImportScope, 'agencyId' | 'runId' | 'connectionId'>,
  n: number,
): Promise<string[]> {
  const missing = await tx.execute(sql`
    select external_ref as ref from property_privates
     where agency_id = ${scope.agencyId} and import_connection_id = ${scope.connectionId}
       and import_withdrawn_at is null
    except
    select external_ref from property_import_seen where run_id = ${scope.runId}`);
  const refs = (missing.rows as { ref: string }[]).map((r) => r.ref);
  if (refs.length === 0) return [];
  const out: string[] = [];
  // ≤ RUN_END_CHUNK rows per statement: a feed that dropped thousands of listings stays under the statement timeout.
  for (let i = 0; i < refs.length; i += RUN_END_CHUNK) {
    const refArray = sql`${arrayParam(refs.slice(i, i + RUN_END_CHUNK))}::text[]`;
    await tx.execute(sql`
      update property_privates
         set import_missed_runs = import_missed_runs + 1, updated_at = now()
       where agency_id = ${scope.agencyId} and import_connection_id = ${scope.connectionId}
         and external_ref = any(${refArray}) and import_missed_runs < ${n}`);
    const due = await tx.execute(sql`
      select property_id as id from property_privates
       where agency_id = ${scope.agencyId} and import_connection_id = ${scope.connectionId}
         and external_ref = any(${refArray}) and import_missed_runs >= ${n} and import_withdrawn_at is null`);
    out.push(...(due.rows as { id: string }[]).map((r) => r.id));
  }
  return out;
}

/**
 * Withdraws these listings: live, on or off the market but not sold, rented or withdrawn already, status not locked.
 * Marks them withdrawn by the import (a feed listing them again brings them back). Two statements.
 */
export async function withdraw(
  tx: Tx,
  agencyId: string,
  ids: readonly string[],
): Promise<{ id: string; version: number; fromStatus: string }[]> {
  const out: { id: string; version: number; fromStatus: string }[] = [];
  for (let i = 0; i < ids.length; i += RUN_END_CHUNK) {
    const res = await tx.execute(sql`
      update properties p
         set status = 'WITHDRAWN', version = p.version + 1, updated_at = now()
       where p.id = any(${arrayParam(ids.slice(i, i + RUN_END_CHUNK))}::uuid[])
         and p.agency_id = ${agencyId}
         and p.deleted_at is null
         and p.status not in ('WITHDRAWN', 'SOLD', 'RENTED')
         and not ${locked('status')}
      returning p.id, p.version, old.status as "fromStatus"`);
    const rows = res.rows as { id: string; version: number; fromStatus: string }[];
    if (rows.length > 0) {
      await tx.execute(sql`
        update property_privates set import_withdrawn_at = now(), updated_at = now()
         where property_id = any(${arrayParam(rows.map((r) => r.id))}::uuid[])`);
    }
    out.push(...rows);
  }
  return out;
}

/** Drops the run's seen references (its end, success or failure). */
export async function deleteSeen(tx: Tx, runId: string): Promise<void> {
  await tx.execute(sql`delete from property_import_seen where run_id = ${runId}`);
}

/** Seen references older than `before` (a crashed run's), `limit` at a time; answers how many went. */
export async function pruneSeen(tx: Tx, before: Date, limit: number): Promise<number> {
  const res = await tx.execute(sql`
    delete from property_import_seen
     where ctid in (select ctid from property_import_seen where created_at < ${before.toISOString()}::timestamptz
                    order by created_at limit ${limit})`);
  return res.rowCount ?? 0;
}

/** The agency's live listings among `ids`, row-locked (the media worker attaching feed images). */
export async function lockLive(tx: Tx, agencyId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute(sql`
    select id from properties
     where id = any(${arrayParam(ids)}::uuid[]) and agency_id = ${agencyId} and deleted_at is null
     order by id
       for update`);
  return (res.rows as { id: string }[]).map((r) => r.id);
}
