import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@inmolink/platform/logger';
import type pg from 'pg';

/**
 * Indexes on large tables built `CONCURRENTLY` (S5-F2, `.claude/rules/database.md`). The drizzle migrator applies
 * pending migrations in one transaction, where `CREATE INDEX CONCURRENTLY` cannot run; so `pnpm db:migrate` builds
 * these first, outside it, without blocking writes, and the migration that declares one says
 * `CREATE INDEX IF NOT EXISTS` (a no-op then) behind a `migration-check: allow` waiver. On a fresh database the
 * table does not exist yet: the step skips it and the migration builds it on the empty table.
 *
 * `definition` is what follows the index name, exactly as drizzle-kit generated it. `declaredBy` names the migration
 * that first created the index without `IF NOT EXISTS` (a pre-launch waiver, S6-F3): until it is applied the step
 * leaves the index to it — building it first would make that migration fail.
 */
export interface ConcurrentIndex {
  name: string;
  table: string;
  definition: string;
  declaredBy?: string;
}

export const CONCURRENT_INDEXES: readonly ConcurrentIndex[] = [
  {
    name: 'properties_deleted_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("deleted_at") WHERE "properties"."deleted_at" is not null`,
  },
  {
    name: 'listing_overrides_target_idx',
    table: 'listing_overrides',
    definition: `ON "listing_overrides" USING btree ("target_kind","target_id")`,
  },
  {
    // give-to-get (S5-05): built in 0069 while `properties` was empty in production; imports fill it from S6-02
    name: 'properties_agency_network_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("agency_id") WHERE "properties"."visibility" <> 'PRIVATE' and "properties"."status" = 'ACTIVE' and "properties"."deleted_at" is null and "properties"."network_hidden_at" is null`,
    declaredBy: '0069_give_to_get',
  },
  {
    // the end of a feed run (S6-02): a connection's listings missing from the run. Its columns arrive in 0080, which
    // builds it (pre-launch, `property_privates` is small); from then on a rebuild runs concurrently
    name: 'property_privates_import_connection_idx',
    table: 'property_privates',
    definition: `ON "property_privates" USING btree ("agency_id","import_connection_id","external_ref") WHERE "property_privates"."import_connection_id" is not null`,
    declaredBy: '0080_feed_loader',
  },
  {
    // a contact merge (S10-07): the agency's listings whose seller was the closed contact
    name: 'property_privates_seller_idx',
    table: 'property_privates',
    definition: `ON "property_privates" USING btree ("agency_id","seller_contact_id") WHERE "property_privates"."seller_contact_id" is not null`,
  },
  {
    // staff import health (S6-08): the last 24 h of runs, index-only; feed_runs grows to millions of rows
    name: 'feed_runs_finished_at_idx',
    table: 'feed_runs',
    definition: `ON "feed_runs" USING btree ("finished_at","state","error_code","created_at","started_at") WHERE "feed_runs"."finished_at" is not null`,
    declaredBy: '0085_s6_08_health_indexes',
  },
  {
    // staff import health (S6-08): the latest failed runs
    name: 'feed_runs_failed_finished_idx',
    table: 'feed_runs',
    definition: `ON "feed_runs" USING btree ("finished_at") WHERE "feed_runs"."state" = 'FAILED'`,
    declaredBy: '0085_s6_08_health_indexes',
  },
  {
    // `/v2/sitemap` (S7-03): an agency's own documents in public-code order
    name: 'listing_search_docs_owner_code_idx',
    table: 'listing_search_docs',
    definition: `ON "listing_search_docs" USING btree ("owner_agency_id","public_code") WHERE "listing_search_docs"."public_code" is not null`,
  },
  {
    // `/v2/developments/{ref}/units` (S7-F6): a development's units in the developer's order
    name: 'listing_search_docs_development_ref_idx',
    table: 'listing_search_docs',
    definition: `ON "listing_search_docs" USING btree ("development_id","ref","target_id") WHERE "listing_search_docs"."development_id" is not null`,
  },
  {
    // The website fallback's minimum-commission probe (S7-F10, `search_commission_floor`): index-only
    name: 'listing_search_commissions_floor_idx',
    table: 'listing_search_commissions',
    definition: `ON "listing_search_commissions" USING btree ("target_id","commission_bp")`,
  },
  {
    // The website fallback's area sort and area bands, compared as float8 (S7-F11: statistics under RLS)
    name: 'listing_search_docs_area_f8_idx',
    table: 'listing_search_docs',
    definition: `ON "listing_search_docs" USING btree (("area_m2"::float8),"target_id")`,
  },
  {
    // portal selection (S9-01): an agency's live PUBLIC listings in id order, keyset-paged per connection
    name: 'properties_agency_export_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("agency_id","id") WHERE "properties"."status" = 'ACTIVE' and "properties"."visibility" = 'PUBLIC' and "properties"."deleted_at" is null`,
  },
  {
    // the push lane's live listings of a connection (S10-F4): portal_listing_sync grows with every pushed listing.
    // 0122 built it on a small table; from then on a rebuild runs concurrently (S11-F8)
    name: 'portal_listing_sync_live_idx',
    table: 'portal_listing_sync',
    definition: `ON "portal_listing_sync" USING btree ("agency_id","connection_id","property_id") WHERE "portal_listing_sync"."remote_id" is not null and "portal_listing_sync"."state" <> 'WITHDRAWN'`,
    declaredBy: '0122_s10_f4_portal_secrets',
  },
  {
    // the nightly portal lanes (S10-F4): enabled connections hashed per agency, by their nightly mark (S11-F8)
    name: 'agency_portal_connections_lane_idx',
    table: 'agency_portal_connections',
    definition: `ON "agency_portal_connections" USING btree (hashtext("agency_id"::text),"agency_id","nightly_at") WHERE "agency_portal_connections"."enabled" and "agency_portal_connections"."revoked_at" is null`,
    declaredBy: '0122_s10_f4_portal_secrets',
  },
  {
    // S12-F20: the listings list, newest/oldest, raw keyset (the cursor an index condition under RLS)
    name: 'properties_agency_created_raw_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("agency_id","created_at","id")`,
  },
  {
    // S12-F20: the list filtered by a region subtree, raw keyset (the cursor an index condition under RLS)
    name: 'properties_agency_region_raw_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("agency_id","region_id","created_at","id")`,
  },
  {
    // S12-F20: the list filtered by a city subtree, raw keyset (the cursor an index condition under RLS)
    name: 'properties_agency_city_raw_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("agency_id","city_id","created_at","id")`,
  },
  {
    // S12-F20: the list filtered by an area, raw keyset (the cursor an index condition under RLS)
    name: 'properties_agency_location_raw_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("agency_id","location_id","created_at","id")`,
  },
  {
    // S12-F20: the list filtered by status, raw keyset (the cursor an index condition under RLS)
    name: 'properties_agency_status_raw_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("agency_id","status_code","created_at","id") WHERE "properties"."deleted_at" is null`,
  },
  {
    // S12-F20: the list filtered by a country subtree, raw keyset (the cursor an index condition under RLS)
    name: 'properties_agency_country_raw_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("agency_id","country_id","created_at","id")`,
  },
  {
    // S12-F20: an agent's own listings, raw keyset (the cursor an index condition under RLS)
    name: 'properties_agency_owner_raw_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("agency_id","owner_user_id","created_at","id")`,
  },
  {
    // S12-F20: the list sorted by last change, raw keyset (the cursor an index condition under RLS)
    name: 'properties_agency_updated_raw_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("agency_id","updated_at","id")`,
  },
  {
    // S12-F20: the restorable listings, raw keyset (the cursor an index condition under RLS)
    name: 'properties_agency_deleted_raw_idx',
    table: 'properties',
    definition: `ON "properties" USING btree ("agency_id","created_at","id") WHERE "properties"."deleted_at" is not null`,
  },
  {
    // S12-F20: a folder's bookmarks, raw keyset (the cursor an index condition under RLS)
    name: 'listing_bookmarks_folder_created_raw_idx',
    table: 'listing_bookmarks',
    definition: `ON "listing_bookmarks" USING btree ("agency_id","folder_id","created_at","id")`,
  },
  {
    // S12-F20: a connection's run history, raw keyset (the cursor an index condition under RLS)
    name: 'feed_runs_connection_created_raw_idx',
    table: 'feed_runs',
    definition: `ON "feed_runs" USING btree ("connection_id","created_at","id")`,
  },
  {
    // S13-F8: contact imports and notes, raw keyset
    name: 'contact_imports_agency_created_raw_idx',
    table: 'contact_imports',
    definition: `ON "contact_imports" USING btree ("agency_id","created_at","id")`,
  },
  {
    name: 'contact_notes_contact_created_raw_idx',
    table: 'contact_notes',
    definition: `ON "contact_notes" USING btree ("agency_id","contact_id","created_at","id")`,
  },
];

/** Whether the migration `tag` of `folder` is applied (the drizzle migrator's journal time is in its table). */
async function applied(client: pg.ClientBase, folder: string, tag: string): Promise<boolean> {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  const entry = journal.entries.find((e) => e.tag === tag);
  if (!entry) throw new Error(`concurrent index: migration ${tag} is not in the journal`);
  const table = await client.query<{ present: boolean }>(
    `select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
  );
  if (table.rows[0]?.present !== true) return false;
  const { rows } = await client.query<{ applied: boolean }>(
    'select exists (select 1 from drizzle.__drizzle_migrations where created_at >= $1) as applied',
    [entry.when],
  );
  return rows[0]?.applied === true;
}

/**
 * Builds each missing index of `indexes` concurrently (autocommit `client`, never inside a transaction). An
 * invalid one — a concurrent build interrupted earlier — is dropped and built again.
 */
export async function buildConcurrentIndexes(
  client: pg.ClientBase,
  log: Pick<Logger, 'info'>,
  indexes: readonly ConcurrentIndex[] = CONCURRENT_INDEXES,
  folder?: string,
): Promise<void> {
  for (const ix of indexes) {
    const { rows } = await client.query<{ table: string | null; valid: boolean | null }>(
      `select to_regclass(quote_ident($1))::text as table,
              (select i.indisvalid from pg_index i where i.indexrelid = to_regclass(quote_ident($2))) as valid`,
      [ix.table, ix.name],
    );
    const state = rows[0];
    if (!state?.table || state.valid === true) continue;
    if (ix.declaredBy && !(folder && (await applied(client, folder, ix.declaredBy)))) continue;
    if (state.valid === false) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${ix.name}"`);
    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${ix.name}" ${ix.definition}`);
    log.info({ index: ix.name }, 'index built concurrently');
  }
}

/**
 * Indexes dropped `CONCURRENTLY` (S7-F13, the contract step of expand/contract): a plain `DROP INDEX` takes an
 * ACCESS EXCLUSIVE lock on the table inside the migrator's transaction. `pnpm db:migrate` drops these first,
 * outside it; the migration that declares the drop says `DROP INDEX IF EXISTS` (a no-op then). A missing index is
 * skipped, and an invalid one (an interrupted concurrent build) is dropped like any other.
 *
 * `after` names the migration that replaces the index (the expand step): the drop waits until it is applied, so
 * one deploy never expands and contracts at once.
 */
export interface DroppedIndex {
  name: string;
  after: string;
}

export const DROPPED_INDEXES: readonly DroppedIndex[] = [
  // the pre-S7-F11 area index on the `numeric` column; every app version runs the float8 one (area_f8_idx) now
  { name: 'listing_search_docs_area_idx', after: '0104_s7_f11_area_statistics' },
  // S13-F8 (S12-F20b): the 16 date_trunc keyset indexes; every app version runs the raw ones (0152) now
  { name: 'agencies_created_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'data_export_jobs_agency_created_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'developments_agency_created_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'staff_impersonations_agency_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'feed_connections_agency_created_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'feed_runs_connection_created_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'listing_bookmarks_folder_created_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'properties_agency_created_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'properties_agency_region_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'properties_agency_city_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'properties_agency_location_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'properties_agency_status_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'properties_agency_country_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'properties_agency_owner_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'properties_agency_updated_idx', after: '0152_s12_f20_raw_keyset' },
  { name: 'properties_agency_deleted_idx', after: '0152_s12_f20_raw_keyset' },
];

/** Drops each listed index that exists and whose `after` migration is applied, concurrently (autocommit `client`). */
export async function dropConcurrentIndexes(
  client: pg.ClientBase,
  log: Pick<Logger, 'info'>,
  indexes: readonly DroppedIndex[] = DROPPED_INDEXES,
  folder?: string,
): Promise<void> {
  for (const ix of indexes) {
    // Only an index: a table or view of that name is none of this step's business.
    const { rows } = await client.query<{ present: boolean }>(
      `select exists (select 1 from pg_class where oid = to_regclass(quote_ident($1)) and relkind in ('i', 'I')) as present`,
      [ix.name],
    );
    if (rows[0]?.present !== true) continue;
    if (!(folder && (await applied(client, folder, ix.after)))) continue;
    await client.query(`set lock_timeout = '30s'`);
    try {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${ix.name}"`);
    } finally {
      await client.query('reset lock_timeout');
    }
    log.info({ index: ix.name }, 'index dropped concurrently');
  }
}
