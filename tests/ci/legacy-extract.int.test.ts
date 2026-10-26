import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateEnv } from '@inmolink/db/migrate';
import { loadStackEnv } from '@inmolink/db/testing';
import { loadConfig } from '@inmolink/platform/config';
import { openLegacySnapshot } from '@inmolink/platform/legacy-db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureReader, type FixtureReader } from '../../scripts/ci/legacy-fixture';
import { dropDatabase, freshDatabase } from '../../scripts/ci/migrations';
import { assertOutsideRepo, hashOutput, runExtract } from '../../scripts/legacy-migration/extract-lib';

/** Legacy extract (S14-01) against a fixture legacy database (fake data; the real dump is H1). */

const DB = `legacy_fixture_${process.pid}`;
const dirs: string[] = [];
let url = '';
let adminUrl = '';
let reader: FixtureReader | undefined;
let cfg: ReturnType<typeof loadConfig<typeof migrateEnv>>;

const out = () => {
  const d = mkdtempSync(join(tmpdir(), 'inmolink-extract-'));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  loadStackEnv('test');
  cfg = loadConfig(migrateEnv);
  const scoped = await freshDatabase(cfg, DB);
  adminUrl = scoped.DATABASE_URL_ADMIN as string;
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`
    CREATE TABLE agencies (id int PRIMARY KEY, name text);
    CREATE TABLE users (id int PRIMARY KEY, agency_id int, email text);
    CREATE TABLE contacts (id int PRIMARY KEY, agency_id int, name text, created_at timestamptz);
    CREATE TABLE leads (id int PRIMARY KEY, agency_id int, message text);
    CREATE TABLE properties (id int PRIMARY KEY, agency_id int, ref text, price bigint, meta jsonb);
    CREATE TABLE property_images (id int PRIMARY KEY, property_id int, url text);
    CREATE TABLE developments (id int PRIMARY KEY, agency_id int, name text);
    CREATE TABLE development_units (id int PRIMARY KEY, development_id int, ref text);
    CREATE TABLE mystery_log (id int PRIMARY KEY);
    INSERT INTO agencies VALUES (1,'Alpha'),(2,'Beta');
    INSERT INTO users VALUES (1,1,'a@x.test'),(2,2,'b@x.test');
    INSERT INTO contacts SELECT g, 1 + g % 2, 'C' || g, '2020-01-01T00:00:00Z' FROM generate_series(1, 25) g;
    INSERT INTO leads VALUES (1,1,'hi'),(2,2,'yo');
    INSERT INTO properties SELECT g, 1 + g % 2, 'R' || g, 100000000000 + g, '{"z":1,"a":[2]}' FROM generate_series(1, 12) g;
    INSERT INTO property_images SELECT g, 1 + g % 12, 'http://img/' || g FROM generate_series(1, 40) g;
    INSERT INTO developments VALUES (1,1,'Dev');
    INSERT INTO development_units VALUES (1,1,'A1'),(2,1,'A2');
  `);
  await c.end();
  reader = await createFixtureReader(adminUrl, DB);
  url = reader.url;
});

afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (cfg) await dropDatabase(cfg, DB);
  await reader?.drop();
});

describe('legacy extract', () => {
  it('[S14-01] extracts per agency into staging files with an entity inventory', async () => {
    const dir = out();
    const inv = await runExtract({ url, outDir: dir, batchSize: 7 });
    expect(inv.agencies.map((a) => a.agencyId)).toEqual(['1', '2']);
    expect(inv.totals).toMatchObject({
      agencies: 2,
      users: 2,
      contacts: 25,
      properties: 12,
      property_images: 40,
      leads: 2,
      developments: 1,
      development_units: 2,
    });
    const a1 = inv.agencies[0]?.entities;
    expect(a1?.contacts).toMatchObject({ legacyRows: 12, extractedRows: 12 });
    // images follow their property's agency: every extracted image row matches the count in the same snapshot
    expect(a1?.property_images?.extractedRows).toBe(a1?.property_images?.legacyRows);
    expect(
      (inv.agencies[1]?.entities.property_images?.extractedRows ?? 0) + (a1?.property_images?.extractedRows ?? 0),
    ).toBe(40);
    expect(inv.uncoveredTables).toContain('public.mystery_log');
    expect(inv.uncoveredTables).not.toContain('public.contacts');
    const lines = readFileSync(join(dir, 'agency-1', 'properties.ndjson'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(6);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ price: '100000000010', meta: { a: [2], z: 1 } });
    expect(JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8')).totals.contacts).toBe(25);
  });

  it('[S14-01] can be limited to chosen agencies and rejects unknown ones', async () => {
    const inv = await runExtract({ url, outDir: out(), agencyIds: ['2'] });
    expect(inv.agencies).toHaveLength(1);
    expect(inv.totals.contacts).toBe(13);
    await expect(runExtract({ url, outDir: out(), agencyIds: ['99'] })).rejects.toThrow(/unknown legacy agency/);
  });

  it('[S14-01] is repeatable: a second run gives byte-identical staging files', async () => {
    const a = out();
    const b = out();
    await runExtract({ url, outDir: a, batchSize: 5 });
    await runExtract({ url, outDir: b, batchSize: 1000 });
    const ha = await hashOutput(a);
    expect(Object.keys(ha).length).toBeGreaterThan(10);
    expect(await hashOutput(b)).toEqual(ha);
  });

  it('[S14-01] never writes to the legacy database: the connection refuses writes', async () => {
    const snap = await openLegacySnapshot({ url });
    try {
      await expect(snap.query("INSERT INTO agencies VALUES (9,'x')")).rejects.toMatchObject({
        code: 'LEGACY_DB_READ_ONLY',
      });
      await expect(
        snap.query('WITH d AS (DELETE FROM contacts RETURNING id) SELECT count(*) FROM d'),
      ).rejects.toMatchObject({ code: '25006' });
    } finally {
      await snap.close();
    }
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    const n = await c.query(
      'SELECT (SELECT count(*) FROM agencies)::int AS a, (SELECT count(*) FROM contacts)::int AS c',
    );
    await c.end();
    expect(n.rows[0]).toEqual({ a: 2, c: 25 });
  });

  it('[S14-01] refuses an output directory inside the repository and unsafe identifiers', async () => {
    expect(() => assertOutsideRepo(join(import.meta.dirname, 'x'))).toThrow(/outside the repository/);
    await expect(
      runExtract({
        url,
        outDir: out(),
        entities: [{ name: 'agencies', table: 'agencies; drop table users', idColumn: 'id', isAgency: true }],
      }),
    ).rejects.toThrow(/invalid table/);
  });
});
