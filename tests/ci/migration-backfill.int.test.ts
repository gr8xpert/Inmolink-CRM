import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_FOLDER, migrateEnv, runMigrations } from '@inmolink/db/migrate';
import { loadStackEnv } from '@inmolink/db/testing';
import { loadConfig } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDatabase, freshDatabase } from '../../scripts/ci/migrations';

/**
 * Data backfills in migrations (S2-F3): a throwaway database is migrated to just before the backfill, rows
 * the backfill must change (and must not) are inserted, then the rest of the migrations run.
 */

interface Journal {
  entries: { idx: number; tag: string }[];
}

const DB = `migtest_backfill_${process.pid}`;
const dirs: string[] = [];
let cfg: ReturnType<typeof loadConfig<typeof migrateEnv>>;
const quiet = { info: () => {} };
const BACKFILL = '0033_agency_commission_defaults';
const RUN = newId().slice(-8);

/** The migrations folder cut just before the migration tagged `tag` (journal entries and SQL files). */
function migrationsBefore(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'inmolink-backfill-'));
  dirs.push(dir);
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const file = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(file, 'utf8')) as Journal;
  const at = journal.entries.findIndex((x) => x.tag === tag);
  if (at < 0) throw new Error(`no migration ${tag}`);
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(file, JSON.stringify(journal, null, 2));
  return dir;
}

async function asAdmin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe('migration backfills', () => {
  beforeAll(() => {
    loadStackEnv('test');
    cfg = loadConfig(migrateEnv);
  });
  afterAll(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    if (cfg) await dropDatabase(cfg, DB);
  });

  it('[S2-F3] 0033: a NULL-commission settings row becomes 500 bp with a 5000 bp split; a set one is kept', async () => {
    const db = await freshDatabase(cfg, DB);
    await runMigrations(db, quiet, migrationsBefore(BACKFILL));
    const unset = newId();
    const fixed = newId();
    await asAdmin(db.DATABASE_URL_ADMIN as string, async (c) => {
      await c.query(
        `insert into agencies (agency_id, kind, name) values ($1, 'AGENCY', 'Unset'), ($2, 'AGENCY', 'Fixed')`,
        [unset, fixed],
      );
      await c.query(`insert into agency_settings (agency_id, enabled_locales) values ($1, '{es}')`, [unset]);
      await c.query(
        `insert into agency_settings (agency_id, enabled_locales, default_commission_type, default_commission_fixed_cents, default_commission_currency)
         values ($1, '{es}', 'FIXED', 300000, 'EUR')`,
        [fixed],
      );
    });

    await runMigrations(db, quiet);

    const rows = await asAdmin(db.DATABASE_URL_ADMIN as string, async (c) => {
      const r = await c.query<{
        agency_id: string;
        type: string;
        bp: number | null;
        cents: string | null;
        split: number;
      }>(
        `select agency_id, default_commission_type as type, default_commission_bp as bp,
                default_commission_fixed_cents::text as cents, default_split_bp as split
           from agency_settings where agency_id = any($1::uuid[])`,
        [[unset, fixed]],
      );
      return new Map(r.rows.map((x) => [x.agency_id, x]));
    });
    expect(rows.get(unset)).toMatchObject({ type: 'PCT', bp: 500, cents: null, split: 5000 });
    expect(rows.get(fixed)).toMatchObject({ type: 'FIXED', bp: null, cents: '300000', split: 5000 });
  });
  it('[S17-F4] keys flagged for the legacy query parameter are revoked before the flag is dropped', async () => {
    const db = await freshDatabase(cfg, DB);
    await runMigrations(db, quiet, migrationsBefore('0181_s17_f4_drop_legacy_query_key'));
    const agency = newId();
    const [flagged, flaggedRevoked, plain] = [newId(), newId(), newId()];
    const earlier = '2026-10-01T00:00:00.000Z';
    await asAdmin(db.DATABASE_URL_ADMIN as string, async (c) => {
      await c.query(`insert into agencies (agency_id, kind, name) values ($1, 'AGENCY', 'Legacy keys')`, [agency]);
      await c.query(
        `insert into api_keys (id, agency_id, name, kind, prefix, key_hash, scopes, created_by, legacy_query_key, revoked_at)
         values ($1, $4, 'flagged', 'SECRET', $6, 'h1', '{listings:read}', $4, true, null),
                ($2, $4, 'flagged, revoked', 'SECRET', $7, 'h2', '{listings:read}', $4, true, $5),
                ($3, $4, 'plain', 'SECRET', $8, 'h3', '{listings:read}', $4, false, null)`,
        [flagged, flaggedRevoked, plain, agency, earlier, `p1${RUN}`, `p2${RUN}`, `p3${RUN}`],
      );
    });

    await runMigrations(db, quiet);

    const rows = await asAdmin(db.DATABASE_URL_ADMIN as string, async (c) => {
      const cols = await c.query(
        `select 1 from information_schema.columns where table_name = 'api_keys' and column_name = 'legacy_query_key'`,
      );
      expect(cols.rowCount).toBe(0);
      const r = await c.query<{ id: string; revoked_at: Date | null }>(
        'select id, revoked_at from api_keys where id = any($1::uuid[])',
        [[flagged, flaggedRevoked, plain]],
      );
      return new Map(r.rows.map((x) => [x.id, x.revoked_at]));
    });
    expect(rows.get(flagged)).toBeInstanceOf(Date);
    expect(rows.get(flaggedRevoked)?.toISOString()).toBe(earlier);
    expect(rows.get(plain)).toBeNull();
  });
});
