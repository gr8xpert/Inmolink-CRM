import { checkRls, mergeRegistries, type TenantRegistry, tablesSql } from '@inmolink/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolationRegistry, setupIsolation, teardownIsolation } from './fixtures';

/** The RLS guard over the real test database, plus planted violations (rolled back, never committed). */

let owner: pg.Client;
let ownerUrl = '';

beforeAll(async () => {
  const cfg = await setupIsolation();
  ownerUrl = cfg.DATABASE_URL_APP_OWNER;
  owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner?.end();
  if (ownerUrl) await teardownIsolation(ownerUrl);
});

/**
 * Runs `plant` and the guard in one transaction as app_owner, then rolls back. Returns only the
 * planted tables' problems, so a dirty database fails the first test alone.
 */
async function guardWith(plant: string, reg: TenantRegistry = isolationRegistry): Promise<string[]> {
  await owner.query('begin');
  try {
    await owner.query(plant);
    return (await checkRls(owner, reg)).filter((p) => p.startsWith('planted_'));
  } finally {
    await owner.query('rollback');
  }
}

const strict = (name: string): TenantRegistry => ({ tenant: { [name]: { kind: 'STRICT' } }, global: {} });

describe('RLS guard', () => {
  it('[S0-05] the database matches the tenant registry (production + fixtures)', async () => {
    expect(await checkRls(owner, isolationRegistry)).toEqual([]);
  });

  it('[S0-05] a planted unregistered table with agency_id fails the guard', async () => {
    const problems = await guardWith(
      'create table planted_unregistered (id uuid primary key, agency_id uuid not null)',
    );
    expect(problems).toContain('planted_unregistered: has agency_id but is not in the tenant registry');
  });

  it('[S0-05] a planted unregistered table without agency_id fails the guard', async () => {
    const problems = await guardWith('create table planted_global (id uuid primary key)');
    expect(problems).toContain('planted_global: not in the tenant registry (register it as tenant or global)');
  });

  it('[S0-05] a planted table with RLS disabled fails the guard', async () => {
    const reg = mergeRegistries(isolationRegistry, strict('planted_no_rls'));
    const problems = await guardWith(
      `create table planted_no_rls (id uuid primary key, agency_id uuid not null);
       ${tablesSql(strict('planted_no_rls'))}
       alter table planted_no_rls disable row level security;`,
      reg,
    );
    expect(problems).toEqual(['planted_no_rls: row level security is disabled']);
  });

  it('[S0-05] RLS that is not forced, a hand-added policy, or a direct app_public grant fail the guard', async () => {
    const reg = mergeRegistries(isolationRegistry, strict('planted_loose'));
    const problems = await guardWith(
      `create table planted_loose (id uuid primary key, agency_id uuid not null);
       ${tablesSql(strict('planted_loose'))}
       alter table planted_loose no force row level security;
       create policy everyone on planted_loose for select using (true);
       grant select on planted_loose to app_public;`,
      reg,
    );
    expect(problems).toEqual([
      'planted_loose: app_public has unexpected SELECT',
      'planted_loose: row level security is not forced',
      'planted_loose: unexpected policy everyone (run pnpm db:rls)',
    ]);
  });

  it('[S0-05] an altered policy, a TRUNCATE or column grant, or a revoked grant fail the guard', async () => {
    const reg = mergeRegistries(isolationRegistry, strict('planted_drift'));
    const problems = await guardWith(
      `create table planted_drift (id uuid primary key, agency_id uuid not null, secret text);
       ${tablesSql(strict('planted_drift'))}
       alter policy own_rows on planted_drift to app_user, app_public;
       grant truncate on planted_drift to app_user;
       grant select (secret) on planted_drift to app_public;
       revoke delete on planted_drift from app_system;`,
      reg,
    );
    expect(problems).toEqual([
      'planted_drift: app_public has unexpected SELECT',
      'planted_drift: app_system lacks DELETE (run pnpm db:rls)',
      'planted_drift: app_user has unexpected TRUNCATE',
      'planted_drift: policy own_rows was altered (run pnpm db:rls)',
    ]);
  });

  it('[S0-05] accessible views, materialized views, other schemas and extra functions fail the guard', async () => {
    const problems = await guardWith(
      `create materialized view planted_mv as select 1 as x;
       grant select on planted_mv to app_user;
       create view planted_view as select 1 as x;
       grant select on planted_view to app_public;
       create view planted_invoker with (security_invoker = true) as select 1 as x;
       grant select on planted_invoker to app_user;
       create schema planted_schema;
       create table planted_schema.t (x int);
       grant usage on schema planted_schema to app_user;
       grant select on planted_schema.t to app_user;
       create function planted_fn() returns int language sql security definer as $$ select 1 $$;
       grant execute on function planted_fn() to app_user;`,
    );
    expect(problems).toEqual([
      'planted_fn(): SECURITY DEFINER outside the generated helpers',
      'planted_fn(): executable by an app role but not a generated helper',
      'planted_mv: accessible to an app role outside the tenant registry',
      'planted_schema.t: accessible to an app role outside the tenant registry',
      'planted_view: accessible to an app role outside the tenant registry',
    ]);
  });

  it('[S0-09] an auth table readable by app_user, or a tenant table reachable by app_auth, fails the guard', async () => {
    const auth: TenantRegistry = { tenant: {}, global: { planted_auth: { reason: 'x', access: 'auth' } } };
    const reg = mergeRegistries(isolationRegistry, auth, strict('planted_tenant'));
    const problems = await guardWith(
      `create table planted_auth (id uuid primary key, secret text);
       create table planted_tenant (id uuid primary key, agency_id uuid not null);
       ${tablesSql(mergeRegistries(auth, strict('planted_tenant')))}
       grant select on planted_auth to app_user;
       grant select on planted_tenant to app_auth;`,
      reg,
    );
    expect(problems).toEqual([
      'planted_auth: app_user has unexpected SELECT',
      'planted_tenant: app_auth has unexpected SELECT',
    ]);
  });

  it('[S0-05] a stale registry entry and a nullable agency_id fail the guard', async () => {
    const reg = mergeRegistries(isolationRegistry, strict('planted_nullable'), strict('planted_missing'));
    const problems = await guardWith(
      `create table planted_nullable (id uuid primary key, agency_id uuid);
       ${tablesSql(strict('planted_nullable'))}`,
      reg,
    );
    expect(problems).toEqual([
      'planted_missing: registered but the table does not exist',
      'planted_nullable: agency_id must be NOT NULL',
    ]);
  });
});
