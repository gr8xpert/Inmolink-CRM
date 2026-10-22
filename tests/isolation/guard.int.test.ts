import { checkRls, mergeRegistries, type TenantRegistry, tablesSql } from '@inmolink/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolationRegistry, setupIsolation, teardownIsolation } from './fixtures';

/** The RLS guard over the real test database, plus planted violations (rolled back, never committed). */

let owner: pg.Client;
let ownerUrl = '';
let adminUrl = '';

beforeAll(async () => {
  const cfg = await setupIsolation();
  ownerUrl = cfg.DATABASE_URL_APP_OWNER;
  adminUrl = cfg.DATABASE_URL_ADMIN as string;
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

  it('[S7-F11] no app role can execute the S7-F4 commission lookup: dropped by db:rls, and the guard rejects it back', async () => {
    // Dropped from the database by the generated SQL (applied by the isolation setup)…
    const { rows } = await owner.query<{ fn: string | null }>(
      `select to_regprocedure('public.search_commission_at_least(uuid, integer)')::text as fn`,
    );
    expect(rows[0]?.fn).toBeNull();
    // …and no longer a helper: re-created as it was (SECURITY DEFINER, executable by app_public), the guard fails.
    await owner.query('begin');
    try {
      await owner.query(`create function public.search_commission_at_least(t_id uuid, bp integer) returns boolean
        language sql stable security definer set search_path = pg_catalog, pg_temp
        as $$ select exists (select 1 from public.listing_search_commissions c
                              where c.target_id = t_id and c.commission_bp >= bp) $$;
        revoke all on function public.search_commission_at_least(uuid, integer) from public;
        grant execute on function public.search_commission_at_least(uuid, integer) to app_public;`);
      const problems = (await checkRls(owner, isolationRegistry)).filter((p) =>
        p.startsWith('search_commission_at_least'),
      );
      expect(problems).toEqual([
        'search_commission_at_least(): SECURITY DEFINER outside the generated helpers',
        'search_commission_at_least(): executable by an app role but not a generated helper',
      ]);
    } finally {
      await owner.query('rollback');
    }
  });

  it('[S7-F10] a generated definer view: another owner, another reader or a missing view fails the guard', async () => {
    const viewProblems = (all: string[]) => all.filter((p) => p.startsWith('search_commission_floor'));
    expect(viewProblems(await checkRls(owner, isolationRegistry))).toEqual([]);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      for (const [plant, want] of [
        [
          'alter view public.search_commission_floor owner to postgres',
          'search_commission_floor: a definer view must be owned by app_owner (run pnpm db:rls)',
        ],
        [
          'grant select on public.search_commission_floor to app_user',
          'search_commission_floor: a definer view must grant SELECT to app_public only (run pnpm db:rls)',
        ],
        [
          'drop view public.search_commission_floor',
          'search_commission_floor: generated view is missing (run pnpm db:rls)',
        ],
      ] as const) {
        await admin.query('begin');
        try {
          await admin.query(plant);
          expect(viewProblems(await checkRls(admin, isolationRegistry)), plant).toEqual([want]);
        } finally {
          await admin.query('rollback');
        }
      }
    } finally {
      await admin.end();
    }
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

  it('[S1-07] a hand-weakened policy predicate, helper body or guard trigger fails the guard', async () => {
    const STAMP =
      'app_user_id(): policy predicates, helper bodies or triggers differ from the last pnpm db:rls (run it again)';
    const all = async (plant: string) => {
      await owner.query('begin');
      try {
        await owner.query(plant);
        return await checkRls(owner, isolationRegistry);
      } finally {
        await owner.query('rollback');
      }
    };
    // Same name, command and roles: only the predicate changed.
    expect(await all(`alter policy network_read on public.preferred_agencies using (true)`)).toEqual([STAMP]);
    expect(
      await all(
        `create or replace function app_agency_verified() returns boolean language sql stable parallel safe as $$ select true $$`,
      ),
    ).toEqual([STAMP]);
    // A guard trigger: its function body edited, the trigger disabled or dropped, or one added.
    expect(
      await all(`create or replace function preferred_agencies_guard() returns trigger language plpgsql
                   as $$ begin return coalesce(new, old); end $$`),
    ).toEqual([STAMP]);
    expect(await all('alter table preferred_agencies disable trigger preferred_agencies_guard')).toEqual([
      STAMP,
      'preferred_agencies: trigger preferred_agencies_guard is disabled',
    ]);
    expect(await all('drop trigger preferred_agency_notes_guard on preferred_agency_notes')).toEqual([
      STAMP,
      'preferred_agency_notes: missing trigger preferred_agency_notes_guard (run pnpm db:migrate)',
    ]);
    expect(
      await all(`create function planted_noop() returns trigger language plpgsql as $$ begin return new; end $$;
                 revoke all on function planted_noop() from public;
                 create trigger planted_noop before insert on preferred_agency_notes for each row execute function planted_noop()`),
    ).toEqual([STAMP, 'preferred_agency_notes: unexpected trigger planted_noop']);
    expect(await checkRls(owner, isolationRegistry)).toEqual([]);
  });

  it('[S1-08] a partitioned table: a reachable partition, an UPDATE grant on an immutable table, or a wrong partitioned flag fail the guard', async () => {
    const audit: TenantRegistry = {
      tenant: {
        planted_audit: { kind: 'STRICT', immutable: true, partitioned: true },
        planted_plain: { kind: 'STRICT', partitioned: true },
      },
      global: {},
    };
    const problems = await guardWith(
      `create table planted_audit (id uuid not null, at timestamptz not null, agency_id uuid not null,
         primary key (id, at)) partition by range (at);
       create table planted_audit_p1 partition of planted_audit for values from ('2026-01-01') to ('2026-02-01');
       create table planted_plain (id uuid primary key, agency_id uuid not null);
       ${tablesSql(audit)}
       grant update on planted_audit to app_system;
       grant select on planted_audit_p1 to app_user;`,
      mergeRegistries(isolationRegistry, audit),
    );
    expect(problems).toEqual([
      'planted_audit: app_system has unexpected UPDATE',
      'planted_audit_p1: partition is directly accessible to an app role',
      'planted_plain: registered as partitioned but is not',
    ]);
    // The production audit log passes as registered (first test); unregistered as partitioned, it fails.
    const loose = mergeRegistries(
      {
        ...isolationRegistry,
        tenant: { ...isolationRegistry.tenant, audit_logs: { kind: 'STRICT', immutable: true } },
      },
      { tenant: {}, global: {} },
    );
    expect(await checkRls(owner, loose)).toContain('audit_logs: partitioned but not registered so');
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
