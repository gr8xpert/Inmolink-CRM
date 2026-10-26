import { migrateEnv } from '@inmolink/db/migrate';
import { loadStackEnv } from '@inmolink/db/testing';
import { loadConfig } from '@inmolink/platform/config';
import { LegacyDbError, legacyDbConnections, openLegacySnapshot } from '@inmolink/platform/legacy-db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureReader, type FixtureReader } from '../../scripts/ci/legacy-fixture';
import { dropDatabase, freshDatabase } from '../../scripts/ci/migrations';
import { openLegacyDeltaReader } from '../../scripts/legacy-migration/delta-lib';

/** Legacy delta reader (S14-04) against a fixture legacy database (fake data; the real schema is H1). */

const DB = `legacy_delta_fixture_${process.pid}`;
let url = '';
let adminUrl = '';
let reader: FixtureReader | undefined;
let cfg: ReturnType<typeof loadConfig<typeof migrateEnv>>;

const all = async (it: AsyncIterable<readonly unknown[]> | undefined) => {
  const out: unknown[] = [];
  if (it) for await (const b of it) out.push(...b);
  return out;
};

beforeAll(async () => {
  loadStackEnv('test');
  cfg = loadConfig(migrateEnv);
  adminUrl = (await freshDatabase(cfg, DB)).DATABASE_URL_ADMIN as string;
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`
    CREATE TABLE agencies (id int PRIMARY KEY, name text);
    CREATE TABLE users (id int PRIMARY KEY, agency_id int, email text, updated_at timestamptz);
    CREATE TABLE contacts (id int PRIMARY KEY, agency_id int, name text); -- no timestamp: read whole
    CREATE TABLE leads (id int PRIMARY KEY, agency_id int, message text, updated_at timestamptz);
    CREATE TABLE properties (id int PRIMARY KEY, agency_id int, ref text, price bigint, updated_at timestamptz);
    CREATE TABLE property_images (id int PRIMARY KEY, property_id int, url text);
    CREATE TABLE developments (id int PRIMARY KEY, agency_id int, name text);
    CREATE TABLE development_units (id int PRIMARY KEY, development_id int, ref text);
    INSERT INTO agencies VALUES (1,'Alpha'),(2,'Beta');
    INSERT INTO contacts SELECT g, 1 + g % 2, 'C' || g FROM generate_series(1, 9) g;
    INSERT INTO properties SELECT g, 1 + g % 2, 'R' || g, 100000 + g,
      CASE WHEN g IN (3, 5) THEN '2026-10-01T10:30:00Z'::timestamptz ELSE '2026-10-01T08:00:00Z'::timestamptz END
      FROM generate_series(1, 12) g;
  `);
  await c.end();
  reader = await createFixtureReader(adminUrl, DB);
  url = reader.url;
});

afterAll(async () => {
  if (cfg) await dropDatabase(cfg, DB);
  await reader?.drop();
});

describe('legacy delta reader', () => {
  it('[S14-04] reads rows changed since the watermark by updated_at, whole tables without one', async () => {
    const reader = await openLegacyDeltaReader({ url, legacyAgencyId: '2', pageSize: 2 });
    try {
      expect(reader.modes).toMatchObject({ listings: 'timestamp', users: 'timestamp', contacts: 'full' });
      expect(reader.snapshotAt).toBeInstanceOf(Date);
      // Agency 2 owns the odd ids; 3 and 5 changed after 10:00.
      const changed = (await all(reader.changed('listings', new Date('2026-10-01T10:00:00Z'))?.batches(1))) as {
        id: number;
        price: string;
      }[];
      expect(changed.map((r) => r.id)).toEqual([3, 5]);
      expect(changed[0]).toMatchObject({ ref: 'R3', price: '100003' }); // bigint as the extract writes it
      expect(changed[0]).not.toHaveProperty('__key');
      // No watermark yet: every row.
      expect(await all(reader.changed('listings', null)?.batches(10))).toHaveLength(6);
      // A table without the timestamp column: every row of the agency, whatever the watermark.
      expect(await all(reader.changed('contacts', new Date('2026-10-01T10:00:00Z'))?.batches(10))).toHaveLength(5);
      // The deletion check: every listing id of the agency, keyset-paged.
      expect(await all(reader.listingIds())).toEqual(['1', '11', '3', '5', '7', '9']);
    } finally {
      await reader.close();
    }
  });

  it('[S14-04] the legacy connection is read-only and the agency id is validated', async () => {
    await expect(openLegacyDeltaReader({ url, legacyAgencyId: "1'; drop table agencies; --" })).rejects.toThrow(
      /unsafe legacy agency id/,
    );
    const reader = await openLegacyDeltaReader({ url, legacyAgencyId: '1' });
    await reader.close();
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      const n = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM agencies');
      expect(n.rows[0]?.n).toBe(2);
    } finally {
      await c.end();
    }
  });
  it('[S15-F4] the adapter refuses writes: non-SELECT statements never leave, the server refuses the rest', async () => {
    const snap = await openLegacySnapshot({ url });
    try {
      await expect(snap.query("INSERT INTO agencies VALUES (9, 'x')")).rejects.toBeInstanceOf(LegacyDbError);
      await expect(snap.query('SELECT 1; DELETE FROM contacts')).rejects.toMatchObject({ code: 'LEGACY_DB_READ_ONLY' });
      // A write hidden in a WITH is refused by the read-only transaction (25006).
      await expect(
        snap.query('WITH d AS (DELETE FROM contacts RETURNING id) SELECT count(*) FROM d'),
      ).rejects.toMatchObject({ code: '25006' });
    } finally {
      await snap.close();
    }
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    const n = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts');
    await c.end();
    expect(n.rows[0]?.n).toBe(9);
  });

  it('[S15-F4] the adapter streams through a cursor in batches and bounds statements by a timeout', async () => {
    const snap = await openLegacySnapshot({ url, statementTimeoutMs: 1_000 });
    try {
      const sizes: number[] = [];
      for await (const rows of snap.stream('SELECT id FROM properties WHERE id > $1 ORDER BY id', [2], 4)) {
        sizes.push(rows.length);
      }
      expect(sizes).toEqual([4, 4, 2]);
      await expect(snap.query('SELECT pg_sleep(3)')).rejects.toMatchObject({ code: '57014' });
    } finally {
      await snap.close();
    }
  });

  it('[S15-F4] errors carry the SQLSTATE only: no row data, no credentials', async () => {
    const snap = await openLegacySnapshot({ url });
    try {
      const err = await snap.query("SELECT 'secret-row-value'::int").catch((e: unknown) => e as LegacyDbError);
      expect(err).toBeInstanceOf(LegacyDbError);
      expect(`${(err as Error).message} ${(err as Error).stack}`).not.toContain('secret-row-value');
    } finally {
      await snap.close();
    }
    const bad = url.replace(/\/[^/]*$/, '/no_such_db');
    const failure = await openLegacySnapshot({ url: bad }).catch((e: unknown) => e as LegacyDbError);
    expect(failure).toBeInstanceOf(LegacyDbError);
    expect(String((failure as Error).message)).not.toContain('no_such_db');
    expect(legacyDbConnections()).toBe(0); // the slot of a failed open is freed
  });

  it('[S15-F4] at most maxConnections snapshots are open at once', async () => {
    const a = await openLegacySnapshot({ url, maxConnections: 1 });
    let second = false;
    const pending = openLegacySnapshot({ url, maxConnections: 1 }).then((s) => {
      second = true;
      return s;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(second).toBe(false);
    await a.close();
    const b = await pending;
    expect(second).toBe(true);
    await b.close();
    expect(legacyDbConnections()).toBe(0);
  });
  it('[S15-F4] a privileged login is refused: superuser, pg_signal_backend members', async () => {
    await expect(openLegacySnapshot({ url: adminUrl })).rejects.toMatchObject({
      code: 'LEGACY_DB_ROLE_NOT_SELECT_ONLY',
    });
    const role = `legacy_signal_${process.pid}`;
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query(`DROP ROLE IF EXISTS ${role}`);
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'sig-pass' NOSUPERUSER`);
      await c.query(`GRANT pg_signal_backend TO ${role}`);
      await c.query(`GRANT CONNECT ON DATABASE ${DB} TO ${role}`);
      const u = new URL(adminUrl);
      u.username = role;
      u.password = 'sig-pass';
      await expect(openLegacySnapshot({ url: u.toString() })).rejects.toMatchObject({
        code: 'LEGACY_DB_ROLE_NOT_SELECT_ONLY',
      });
      expect(legacyDbConnections()).toBe(0);
    } finally {
      await c.query(`DROP OWNED BY ${role}`).catch(() => {});
      await c.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await c.end();
    }
  });

  it('[S15-F4] URL options and timeouts cannot override the adapter, whose limits are set in the transaction', async () => {
    for (const q of [
      '?options=-c%20statement_timeout%3D0',
      '?statement_timeout=0',
      '?idle_in_transaction_session_timeout=0',
    ]) {
      await expect(openLegacySnapshot({ url: `${url}${q}` })).rejects.toMatchObject({ code: 'LEGACY_DB_BAD_URL' });
    }
    const snap = await openLegacySnapshot({ url, statementTimeoutMs: 1_500, idleInTransactionTimeoutMs: 20_000 });
    try {
      const [row] = await snap.query<{ a: string; b: string }>(
        "SELECT current_setting('statement_timeout') AS a, current_setting('idle_in_transaction_session_timeout') AS b",
      );
      expect(row).toEqual({ a: '1500ms', b: '20s' });
    } finally {
      await snap.close();
    }
  });

  it('[S15-F4] a failed open frees its slot, a busy pool times out, and errors never quote the URL', async () => {
    const secretUrl = 'postgres://reader:topsecret-pass@[not-a-host/legacy';
    for (let i = 0; i < 3; i++) {
      const err = await openLegacySnapshot({ url: secretUrl, maxConnections: 1 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LegacyDbError);
      expect(`${(err as Error).message} ${(err as Error).stack}`).not.toContain('topsecret-pass');
      await expect(
        openLegacySnapshot({ url: url.replace(/\/[^/?]*$/, '/no_such_db'), maxConnections: 1 }),
      ).rejects.toBeInstanceOf(LegacyDbError);
    }
    expect(legacyDbConnections()).toBe(0);
    const held = await openLegacySnapshot({ url, maxConnections: 1 });
    await expect(openLegacySnapshot({ url, maxConnections: 1, acquireTimeoutMs: 200 })).rejects.toMatchObject({
      code: 'LEGACY_DB_BUSY',
    });
    await held.close();
    const good = await openLegacySnapshot({ url, maxConnections: 1, acquireTimeoutMs: 2_000 });
    await good.close();
    expect(legacyDbConnections()).toBe(0);
  });

  it('[S15-F4] cursor statements take parameters only through $n: quotes and missing indexes are refused', async () => {
    const snap = await openLegacySnapshot({ url });
    try {
      const drain = async (sql: string, params: unknown[]) => {
        for await (const _ of snap.stream(sql, params, 5)) {
          // drain
        }
      };
      await expect(drain("SELECT id FROM properties WHERE ref = 'R$1'", ['x'])).rejects.toMatchObject({
        code: 'LEGACY_DB_BAD_PARAM',
      });
      await expect(drain('SELECT id FROM properties WHERE id > $2', [1])).rejects.toMatchObject({
        code: 'LEGACY_DB_BAD_PARAM',
      });
      // A hostile string value stays a literal.
      const hits: unknown[] = [];
      for await (const rows of snap.stream(
        'SELECT id FROM properties WHERE ref = $1',
        ["R1'; DROP TABLE agencies; --"],
        5,
      ))
        hits.push(...rows);
      expect(hits).toEqual([]);
    } finally {
      await snap.close();
    }
  });
});
