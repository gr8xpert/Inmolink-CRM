import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@inmolink/platform/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb } from '../test/test-db';
import { closeDb } from './client';
import {
  buildConcurrentIndexes,
  CONCURRENT_INDEXES,
  DROPPED_INDEXES,
  dropConcurrentIndexes,
} from './concurrent-indexes';
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

  it('[S6-F3] an index a pending migration creates without IF NOT EXISTS is left to that migration', async () => {
    const table = `s6f3_probe_${newId().slice(-8)}`;
    const name = `${table}_x_idx`;
    // A migrations folder whose journal has an applied entry (0069's time) and a pending one (far in the future).
    const folder = mkdtempSync(join(tmpdir(), 's6f3-'));
    mkdirSync(join(folder, 'meta'));
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string; when: number }[];
    };
    const applied = journal.entries.find((e) => e.tag === '0069_give_to_get');
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ entries: [applied, { tag: '9999_pending', when: 9_999_999_999_999 }] }),
    );
    const ix = (declaredBy: string) => [{ name, table, definition: `ON "${table}" ("x")`, declaredBy }];
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN });
    await client.connect();
    try {
      await client.query(`create temporary table "${table}" (x int)`);
      const built: string[] = [];
      const log = { info: (o: { index?: string }) => built.push(o.index ?? '') } as never;
      await buildConcurrentIndexes(client, log, ix('9999_pending'), folder);
      expect(built).toEqual([]);
      await buildConcurrentIndexes(client, log, ix('0069_give_to_get'), folder);
      expect(built).toEqual([name]);
      expect(CONCURRENT_INDEXES.map((i) => i.name)).toContain('properties_agency_network_idx');
    } finally {
      await client.end();
      rmSync(folder, { recursive: true, force: true });
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

  /** A folder whose journal has one applied entry (0069's time) and one pending (far in the future). */
  function journalFolder(): string {
    const folder = mkdtempSync(join(tmpdir(), 's7f13-'));
    mkdirSync(join(folder, 'meta'));
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string; when: number }[];
    };
    const applied = journal.entries.find((e) => e.tag === '0069_give_to_get');
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ entries: [applied, { tag: '9999_pending', when: 9_999_999_999_999 }] }),
    );
    return folder;
  }

  /** Runs `fn` with a normal (not temporary) table, so CONCURRENTLY really runs; dropped afterwards. */
  async function withTable(fn: (client: pg.Client, table: string) => Promise<void>): Promise<void> {
    const table = `s7f13_probe_${newId().slice(-8)}`;
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN });
    await client.connect();
    try {
      await client.query(`create table "${table}" (x int)`);
      await fn(client, table);
    } finally {
      await client.query(`drop table if exists "${table}"`);
      await client.end();
    }
  }

  const exists = async (client: pg.Client, name: string) =>
    (await client.query('select to_regclass($1) as ix', [name])).rows[0].ix !== null;

  it('[S7-F13] the drop list drops a listed index concurrently and skips a missing one', async () => {
    const folder = journalFolder();
    try {
      await withTable(async (client, table) => {
        const name = `${table}_x_idx`;
        await client.query(`create index "${name}" on "${table}" (x)`);
        const dropped: string[] = [];
        const log = { info: (o: { index?: string }) => dropped.push(o.index ?? '') } as never;
        const list = [
          { name, after: '0069_give_to_get' },
          { name: `${table}_missing_idx`, after: '0069_give_to_get' },
          // a table of that name is not an index: left alone
          { name: table, after: '0069_give_to_get' },
        ];
        await dropConcurrentIndexes(client, log, list, folder);
        await dropConcurrentIndexes(client, log, list, folder);
        expect(dropped).toEqual([name]);
        expect(await exists(client, name)).toBe(false);
        expect(await exists(client, table)).toBe(true);
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('[S7-F13] an invalid index (an interrupted concurrent build) is dropped too', async () => {
    const folder = journalFolder();
    try {
      await withTable(async (client, table) => {
        const name = `${table}_u_idx`;
        await client.query(`insert into "${table}" values (1), (1)`);
        await expect(client.query(`create unique index concurrently "${name}" on "${table}" (x)`)).rejects.toThrow();
        const invalid = await client.query('select indisvalid from pg_index where indexrelid = to_regclass($1)', [
          name,
        ]);
        expect(invalid.rows).toEqual([{ indisvalid: false }]);
        const log = { info: () => {} } as never;
        await dropConcurrentIndexes(client, log, [{ name, after: '0069_give_to_get' }], folder);
        expect(await exists(client, name)).toBe(false);
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('[S7-F13] the drop waits until the migration that replaces the index is applied', async () => {
    const folder = journalFolder();
    try {
      await withTable(async (client, table) => {
        const name = `${table}_x_idx`;
        await client.query(`create index "${name}" on "${table}" (x)`);
        const log = { info: () => {} } as never;
        await dropConcurrentIndexes(client, log, [{ name, after: '9999_pending' }], folder);
        expect(await exists(client, name)).toBe(true);
        await dropConcurrentIndexes(client, log, [{ name, after: '0069_give_to_get' }]); // no folder: nothing is known applied
        expect(await exists(client, name)).toBe(true);
        await dropConcurrentIndexes(client, log, [{ name, after: '0069_give_to_get' }], folder);
        expect(await exists(client, name)).toBe(false);
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('[S11-F8] the 0122 portal indexes are built concurrently from now on, left to 0122 until it is applied', () => {
    for (const name of ['portal_listing_sync_live_idx', 'agency_portal_connections_lane_idx']) {
      expect(CONCURRENT_INDEXES.find((i) => i.name === name)).toMatchObject({
        name,
        declaredBy: '0122_s10_f4_portal_secrets',
      });
    }
  });

  it('[S7-F13] no index is on both the build list and the drop list', () => {
    const built = new Set(CONCURRENT_INDEXES.map((i) => i.name));
    for (const ix of DROPPED_INDEXES) expect(built.has(ix.name)).toBe(false);
  });

  it('[S7-F13] a migration declares each dropped index with IF EXISTS (a no-op once the migrator dropped it)', () => {
    const all = readdirSync(MIGRATIONS_FOLDER)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(MIGRATIONS_FOLDER, f), 'utf8'))
      .join(' ');
    for (const ix of DROPPED_INDEXES) expect(all).toContain(`DROP INDEX IF EXISTS "${ix.name}";`);
  });

  it('[S13-F8] the 16 date_trunc keyset indexes are gone, properties keeps at most 21 non-unique indexes, the raw ones remain', async () => {
    const dropped = DROPPED_INDEXES.filter((i) => i.after === '0152_s12_f20_raw_keyset').map((i) => i.name);
    expect(dropped).toHaveLength(16);
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN });
    await client.connect();
    try {
      const names = (await client.query<{ indexname: string }>('select indexname from pg_indexes')).rows.map(
        (r) => r.indexname,
      );
      for (const n of dropped) {
        expect(names).not.toContain(n);
        expect(names).toContain(n.replace(/_idx$/, '_raw_idx'));
      }
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from pg_indexes where tablename = 'properties' and indexdef not like 'CREATE UNIQUE%'`,
      );
      expect(rows[0]?.n).toBeLessThanOrEqual(21);
    } finally {
      await client.end();
    }
  });
});
