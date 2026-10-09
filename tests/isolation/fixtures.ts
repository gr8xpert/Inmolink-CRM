import { closeDb, mergeRegistries, registry, type TenantRegistry } from '@inmolink/db';
import { runRls } from '@inmolink/db/migrate';
import { setupTestDb } from '@inmolink/db/testing';
import pg from 'pg';

/**
 * Fixture tables, one per policy kind, so the generated suite proves the generator before real
 * tables exist. They live in schema `public` only while `pnpm test:isolation` runs.
 */
export const fixtureRegistry: TenantRegistry = {
  tenant: {
    iso_fx_strict: { kind: 'STRICT' },
    iso_fx_network: {
      kind: 'NETWORK_READ',
      networkReadSql: `visibility in ('SHARED', 'PUBLIC') and status = 'ACTIVE' and deleted_at is null`,
      base: { visibility: 'PRIVATE', status: 'DRAFT' },
      samples: {
        visible: [
          { visibility: 'SHARED', status: 'ACTIVE' },
          { visibility: 'PUBLIC', status: 'ACTIVE' },
        ],
        hidden: [
          { visibility: 'PRIVATE', status: 'ACTIVE' },
          { visibility: 'SHARED', status: 'DRAFT' },
          { visibility: 'PUBLIC', status: 'ACTIVE', deleted_at: new Date() },
        ],
      },
    },
    iso_fx_public: {
      kind: 'PUBLIC_READ',
      publicReadSql: 'published',
      samples: { visible: [{ published: true }], hidden: [{ published: false }] },
    },
  },
  global: {
    iso_fx_global: { reason: 'isolation fixture: reference data' },
    iso_fx_global_public: { reason: 'isolation fixture: public reference data', publicRead: true },
  },
};

const FIXTURE_TABLES = [...Object.keys(fixtureRegistry.tenant), ...Object.keys(fixtureRegistry.global)];

const FIXTURE_DDL = `
drop table if exists ${FIXTURE_TABLES.join(', ')};
create table iso_fx_strict (
  id uuid primary key, agency_id uuid not null, name text not null,
  created_at timestamptz not null default now());
create table iso_fx_network (
  id uuid primary key, agency_id uuid not null, visibility text not null, status text not null,
  deleted_at timestamptz);
create table iso_fx_public (id uuid primary key, agency_id uuid not null, published boolean not null);
create table iso_fx_global (id uuid primary key, code text not null unique);
create table iso_fx_global_public (id uuid primary key, code text not null unique);
`;

/** Production registry + fixtures: what the database must match while the suite runs. */
export const isolationRegistry = mergeRegistries(registry, fixtureRegistry);

const silent = { info: () => {} };

async function asOwner(url: string, sql: string): Promise<void> {
  const owner = new pg.Client({ connectionString: url });
  await owner.connect();
  try {
    await owner.query(sql);
  } finally {
    await owner.end();
  }
}

/** Test stack + migrations, fixture tables (as app_owner), RLS for registry + fixtures. */
export async function setupIsolation() {
  const cfg = await setupTestDb('http');
  if (!cfg.DATABASE_URL_ADMIN) throw new Error('isolation suite needs DATABASE_URL_ADMIN (seeds bypass FKs)');
  await asOwner(cfg.DATABASE_URL_APP_OWNER, FIXTURE_DDL);
  await runRls(cfg, silent, isolationRegistry);
  return { ...cfg, DATABASE_URL_ADMIN: cfg.DATABASE_URL_ADMIN };
}

export async function teardownIsolation(ownerUrl: string): Promise<void> {
  await closeDb();
  await asOwner(ownerUrl, `drop table if exists ${FIXTURE_TABLES.join(', ')}`);
}
