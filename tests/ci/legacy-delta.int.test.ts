import { migrateEnv } from '@inmolink/db/migrate';
import { loadStackEnv } from '@inmolink/db/testing';
import { loadConfig } from '@inmolink/platform/config';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDatabase, freshDatabase } from '../../scripts/ci/migrations';
import { openLegacyDeltaReader } from '../../scripts/legacy-migration/delta-lib';

/** Legacy delta reader (S14-04) against a fixture legacy database (fake data; the real schema is H1). */

const DB = `legacy_delta_fixture_${process.pid}`;
let url = '';
let cfg: ReturnType<typeof loadConfig<typeof migrateEnv>>;

const all = async (it: AsyncIterable<readonly unknown[]> | undefined) => {
  const out: unknown[] = [];
  if (it) for await (const b of it) out.push(...b);
  return out;
};

beforeAll(async () => {
  loadStackEnv('test');
  cfg = loadConfig(migrateEnv);
  url = (await freshDatabase(cfg, DB)).DATABASE_URL_ADMIN as string;
  const c = new pg.Client({ connectionString: url });
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
});

afterAll(async () => {
  if (cfg) await dropDatabase(cfg, DB);
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
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const n = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM agencies');
      expect(n.rows[0]?.n).toBe(2);
    } finally {
      await c.end();
    }
  });
});
