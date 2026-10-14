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
});
