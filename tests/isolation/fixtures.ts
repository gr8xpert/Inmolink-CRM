import { closeDb, mergeRegistries, registry, SAMPLE_USER, type TenantRegistry } from '@inmolink/db';
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
    // S1-07: the listing policy shape S3-02 ships — shared with every verified agency (ALL) or only with
    // the agencies that list the owner as preferred (PREFERRED). Without a relationship (the generated
    // suite) PREFERRED rows stay hidden; `preferred.int.test.ts` adds one and removes it.
    iso_fx_preferred: {
      kind: 'NETWORK_READ',
      networkReadSql: `share_scope = 'ALL' or (share_scope = 'PREFERRED' and agency_id in (select a from public.app_preferring_agencies() a))`,
      base: { share_scope: 'PRIVATE' },
      samples: {
        visible: [{ share_scope: 'ALL' }],
        hidden: [{ share_scope: 'PREFERRED' }, { share_scope: 'PRIVATE' }],
      },
    },
    // S1-F10: STRICT with a narrowed app_user read (the rows naming the reading user) and a column it never reads.
    iso_fx_user_read: {
      kind: 'STRICT',
      userSelect: {
        sql: 'owner_user_id = app_user_id()',
        hiddenColumns: ['secret'],
        samples: { visible: [{ owner_user_id: SAMPLE_USER }], hidden: [{}] },
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
create table iso_fx_preferred (id uuid primary key, agency_id uuid not null, share_scope text not null);
create table iso_fx_user_read (
  id uuid primary key, agency_id uuid not null, owner_user_id uuid not null, secret text not null default 'x');
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

/**
 * Drops the fixtures and puts the production RLS back (S1-09 review). Leaving the fixture registry's
 * SQL (and stamp) in place made the next run's first `setupTestDb` re-apply RLS — ACCESS EXCLUSIVE on
 * every table — while other packages' suites were already sending requests: their statements waited past
 * the roles' 5 s statement timeout and surfaced as 500s (GET /v1/staff/agencies) and timeouts.
 */
export async function teardownIsolation(ownerUrl: string): Promise<void> {
  await closeDb();
  await asOwner(ownerUrl, `drop table if exists ${FIXTURE_TABLES.join(', ')}`);
  await runRls({ DATABASE_URL_APP_OWNER: ownerUrl }, silent);
}
