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

/** Data changes in migrations from this one on are checked for FORCE RLS (S17-F43; earlier ones ran on empty tables). */
export const RLS_DATA_CHECK_FROM = 184;

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

/** A function or trigger body runs later, as another role: not a data change of the migration itself. */
const FUNCTION_BODY = /create\s+(?:or\s+replace\s+)?function\b[\s\S]*?(\$[a-z_]*\$)[\s\S]*?\1/gi;
/** A trigger definition names its events (`before insert or update on t`): no data change either. */
const TRIGGER_DEF = /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\b[^;]*/gi;
const DATA_CHANGE = /(?<!\bon\s)\b(?:insert\s+into|update|delete\s+from)\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const LIFTED = /alter\s+table\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s+no\s+force\s+row\s+level\s+security/gi;

/**
 * S17-F43: FORCE RLS hides a tenant or catalog table's rows from `app_owner`, which runs the migrations and has no
 * policy, so a data change in a migration finds nothing and succeeds without an error (0182 did). It must lift FORCE
 * for that table inside the migration and restore it (0062, 0063, 0183). A table without RLS carries the usual waiver.
 */
export function checkMigrationRlsData(sql: string): MigrationViolation[] {
  const out: MigrationViolation[] = [];
  for (const { text, waived } of statements(sql)) {
    if (waived) continue;
    const body = text.replace(FUNCTION_BODY, '').replace(TRIGGER_DEF, '');
    const lifted = new Set([...body.matchAll(LIFTED)].map((m) => (m[1] as string).toLowerCase()));
    for (const m of body.matchAll(DATA_CHANGE)) {
      const name = (m[1] as string).toLowerCase();
      if (name === 'set' || lifted.has(name)) continue;
      out.push({
        statement: body.replace(/\s+/g, ' ').trim(),
        reason: `data change on ${name} without lifting FORCE RLS: finds no rows as app_owner, without an error`,
      });
    }
  }
  return out;
}
