import type { Logger } from '@inmolink/platform/logger';
import type pg from 'pg';

/**
 * Indexes on large tables built `CONCURRENTLY` (S5-F2, `.claude/rules/database.md`). The drizzle migrator applies
 * pending migrations in one transaction, where `CREATE INDEX CONCURRENTLY` cannot run; so `pnpm db:migrate` builds
 * these first, outside it, without blocking writes, and the migration that declares one says
 * `CREATE INDEX IF NOT EXISTS` (a no-op then) behind a `migration-check: allow` waiver. On a fresh database the
 * table does not exist yet: the step skips it and the migration builds it on the empty table.
 *
 * `definition` is what follows the index name, exactly as drizzle-kit generated it.
 */
export const CONCURRENT_INDEXES: readonly { name: string; table: string; definition: string }[] = [
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
];

/**
 * Builds each missing index of `indexes` concurrently (autocommit `client`, never inside a transaction). An
 * invalid one — a concurrent build interrupted earlier — is dropped and built again.
 */
export async function buildConcurrentIndexes(
  client: pg.ClientBase,
  log: Pick<Logger, 'info'>,
  indexes = CONCURRENT_INDEXES,
): Promise<void> {
  for (const ix of indexes) {
    const { rows } = await client.query<{ table: string | null; valid: boolean | null }>(
      `select to_regclass(quote_ident($1))::text as table,
              (select i.indisvalid from pg_index i where i.indexrelid = to_regclass(quote_ident($2))) as valid`,
      [ix.table, ix.name],
    );
    const state = rows[0];
    if (!state?.table || state.valid === true) continue;
    if (state.valid === false) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${ix.name}"`);
    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${ix.name}" ${ix.definition}`);
    log.info({ index: ix.name }, 'index built concurrently');
  }
}
