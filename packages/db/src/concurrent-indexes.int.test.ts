import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@inmolink/platform/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb } from '../test/test-db';
import { closeDb } from './client';
import { buildConcurrentIndexes, CONCURRENT_INDEXES } from './concurrent-indexes';
import { MIGRATIONS_FOLDER } from './migrate';

beforeAll(() => setupTestDb('script'), 120_000);
afterAll(() => closeDb());

describe('buildConcurrentIndexes', () => {
  it('[S5-F2] builds a missing index outside a transaction, skips a valid one and a table not created yet', async () => {
    // A temporary table: session-local, never seen by the RLS guard or a parallel suite.
    const table = `s5f2_probe_${newId().slice(-8)}`;
    const name = `${table}_deleted_idx`;
    const ixs = [
      { name, table, definition: `ON "${table}" USING btree ("deleted_at") WHERE "deleted_at" is not null` },
      { name: `${table}_later_idx`, table: `${table}_later`, definition: `ON "${table}_later" ("x")` },
    ];
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN });
    await client.connect();
    try {
      await client.query(`create temporary table "${table}" (id int, deleted_at timestamptz)`);
      const built: string[] = [];
      const log = { info: (o: { index?: string }) => built.push(o.index ?? '') } as never;
      await buildConcurrentIndexes(client, log, ixs);
      await buildConcurrentIndexes(client, log, ixs);
      expect(built).toEqual([name]);
      const { rows } = await client.query<{ valid: boolean; def: string }>(
        `select i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as def
           from pg_index i where i.indexrelid = to_regclass($1)`,
        [name],
      );
      expect(rows).toEqual([{ valid: true, def: expect.stringContaining('WHERE (deleted_at IS NOT NULL)') }]);
    } finally {
      await client.end();
    }
  });

  it('[S5-F2] every concurrent index is declared by a migration that is a no-op once it exists', () => {
    const all = readdirSync(MIGRATIONS_FOLDER)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(MIGRATIONS_FOLDER, f), 'utf8'))
      .join('\n');
    for (const ix of CONCURRENT_INDEXES) {
      expect(all).toContain(`CREATE INDEX IF NOT EXISTS "${ix.name}" ${ix.definition};`);
    }
  });
});
