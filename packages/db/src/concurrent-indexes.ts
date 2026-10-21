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
