/**
 * Migration check (S4-F2, `.claude/rules/database.md`): no long locks or unbatched rewrites on large tables. The
 * migrator applies pending migrations in one transaction, where `CREATE INDEX CONCURRENTLY` cannot run; so a
 * generated migration that builds an index on a large table, or rewrites its rows in one statement, is refused.
 * Build such an index outside the migrator (`create index concurrently`, a runbook step) and backfill in batches of
 * ≤ 5,000 rows in a script or job. A statement that is safe anyway (the table is still small in production, before
 * imports) carries a reviewed waiver on the line before it: `-- migration-check: allow <reason>`.
 */

/** Tables that grow with listings, media or history: millions of rows at 5,000 agencies (PLAN §1). */
export const LARGE_TABLES: readonly string[] = [
  'properties',
  'property_privates',
  'property_translations',
  'property_features',
  'property_media',
  'property_price_histories',
  'property_status_histories',
  'property_tags',
  'listing_bookmarks',
  'listing_overrides',
  'media_objects',
  'listing_documents',
  'units',
  'unit_price_histories',
  'outbox_events',
  'audit_logs',
  'legacy_id_maps',
];

/** Migrations up to this one predate the check (applied; never edited). */
export const MIGRATION_CHECK_FROM = 63;

export interface MigrationViolation {
  statement: string;
  reason: string;
}

const WAIVER = /--\s*migration-check:\s*allow\s+\S/;

/** Splits drizzle-kit SQL into statements, each with the comment lines right before it. */
function statements(sql: string): { text: string; waived: boolean }[] {
  return sql
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const lines = chunk.split(/\r?\n/);
      const waived = lines.some((l) => WAIVER.test(l));
      const text = lines.filter((l) => !l.trim().startsWith('--')).join('\n');
      return { text, waived };
    });
}

const table = (name: string) => `(?:"?public"?\\.)?"?${name}"?(?![\\w"])`;

/** What `sql` (one migration file) does that the check refuses. */
export function checkMigrationSql(sql: string, large: readonly string[] = LARGE_TABLES): MigrationViolation[] {
  const out: MigrationViolation[] = [];
  for (const { text, waived } of statements(sql)) {
    if (waived) continue;
    const flat = text.replace(/\s+/g, ' ').trim();
    for (const name of large) {
      const t = table(name);
      if (new RegExp(`^create (unique )?index (?!concurrently)[^;]* on ${t}`, 'i').test(flat)) {
        out.push({ statement: flat, reason: `index on large table ${name} built inside the migration transaction` });
      } else if (
        new RegExp(`\\bupdate ${t} `, 'i').test(flat) ||
        new RegExp(`\\bdelete from ${t}`, 'i').test(flat) ||
        new RegExp(`\\binsert into ${t}[^;]*\\bselect\\b`, 'i').test(flat)
      ) {
        out.push({ statement: flat, reason: `unbatched backfill of large table ${name}` });
      }
    }
  }
  return out;
}
