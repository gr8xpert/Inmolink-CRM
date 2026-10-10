import { describe, expect, it } from 'vitest';
import type { TenantRegistry } from './registry';
import { mergeRegistries, registry } from './registry';
import { expectedPolicies, expectedPrivileges, generateRlsSql, tablesSql } from './rls';

const reg: TenantRegistry = {
  tenant: {
    contacts: { kind: 'STRICT' },
    properties: {
      kind: 'NETWORK_READ',
      networkReadSql: `visibility in ('SHARED','PUBLIC')
        and status = 'ACTIVE'`,
      samples: { visible: [], hidden: [] },
    },
    listing_read_models: { kind: 'PUBLIC_READ', publicReadSql: 'published', samples: { visible: [], hidden: [] } },
  },
  global: { locations: { reason: 'reference data', publicRead: true } },
};

describe('RLS generator', () => {
  const out = generateRlsSql(reg);

  it('[S0-05] enables and forces RLS on every registered table', () => {
    for (const t of ['contacts', 'properties', 'listing_read_models', 'locations']) {
      expect(out).toContain(`alter table public."${t}" enable row level security;`);
      expect(out).toContain(`alter table public."${t}" force row level security;`);
    }
  });

  it('[S0-05] STRICT: own rows for app_user only, read and write', () => {
    expect(out).toContain(`create policy own_rows on public."contacts" to app_user
  using (agency_id = app_agency()) with check (agency_id = app_agency());`);
    expect(out).not.toMatch(/on public."contacts" for select/);
    expect(out).not.toContain(`grant select on table public."contacts" to app_public`);
  });

  it('[S0-05] NETWORK_READ adds a select-only predicate policy for app_user, only with a tenant set', () => {
    expect(out).toContain(`create policy network_read on public."properties" for select to app_user
  using (app_agency() is not null and (visibility in ('SHARED','PUBLIC') and status = 'ACTIVE'));`);
  });

  it('[S0-05] PUBLIC_READ grants app_public select through a predicate policy; nothing else reaches app_public', () => {
    expect(out).toContain(`create policy public_read on public."listing_read_models" for select to app_public`);
    expect(out).toContain(`grant select on table public."listing_read_models" to app_public;`);
    expect(out).toContain(`grant select on table public."locations" to app_user, app_public;`);
    expect(out.match(/^grant select on table .*app_public;$/gm)).toHaveLength(2);
  });

  it('[S0-05] global tables are read-only for app_user and written only by app_system', () => {
    expect(out).toContain(`grant select, insert, update, delete on table public."locations" to app_system;`);
    expect(out).not.toMatch(/grant [^;]*insert[^;]*"locations" to app_user/);
  });

  it('[S0-05] every table resets its grants and policies, so reruns are idempotent', () => {
    expect(out).toContain(
      `revoke all on table public."contacts" from public, app_user, app_system, app_public, app_auth;`,
    );
    expect(out).toContain(`array['contacts', 'listing_read_models', 'locations', 'properties']`);
    expect(generateRlsSql(reg)).toBe(out);
  });

  it('[S0-05] rejects invalid table names and multi-statement predicates', () => {
    expect(() => tablesSql({ tenant: { 'Bad-Name': { kind: 'STRICT' } }, global: {} })).toThrow(/snake_case/);
    const smuggle = (networkReadSql: string): TenantRegistry => ({
      tenant: { t: { kind: 'NETWORK_READ', networkReadSql, samples: { visible: [], hidden: [] } } },
      global: {},
    });
    expect(() => tablesSql(smuggle('true; drop table x'))).toThrow(/single expression/);
    expect(() => tablesSql(smuggle('true -- x'))).toThrow(/single expression/);
    expect(() => tablesSql(smuggle('  '))).toThrow(/empty/);
  });

  it('[S0-05] expected policies per kind; duplicate registrations are refused', () => {
    expect(expectedPolicies({ kind: 'STRICT' })).toEqual([{ name: 'own_rows', cmd: 'ALL', roles: ['app_user'] }]);
    expect(expectedPolicies({ reason: 'x' })).toEqual([{ name: 'global_read', cmd: 'SELECT', roles: ['app_user'] }]);
    expect(expectedPrivileges({ reason: 'x' })).toEqual({
      app_user: ['SELECT'],
      app_system: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      app_public: [],
      app_auth: [],
    });
    expect(() => mergeRegistries(reg, { tenant: {}, global: { contacts: { reason: 'x' } } })).toThrow(/twice/);
  });

  it('[S0-09] auth tables: only app_auth and app_system reach them; tenant tables give app_auth nothing', () => {
    const authAppend = { column: 'type', prefix: 'identity.' };
    const auth = generateRlsSql({
      tenant: { outbox: { kind: 'STRICT', appendOnly: true, authAppend }, contacts: { kind: 'STRICT' } },
      global: { users: { reason: 'identity', access: 'auth' } },
    });
    expect(auth).toContain(`create policy auth_rows on public."users" to app_auth using (true) with check (true);`);
    expect(auth).toContain(`grant select, insert, update on table public."users" to app_auth;`);
    expect(auth).not.toMatch(/"users"[^;]* to app_user/);
    expect(auth).toContain(`create policy auth_append on public."outbox" for insert to app_auth
  with check (agency_id = '00000000-0000-0000-0000-000000000000'::uuid and starts_with("type", 'identity.'));`);
    expect(auth).not.toMatch(/"contacts"[^;]* to [^;]*app_auth/);
    expect(expectedPrivileges({ reason: 'x', access: 'auth' })).toEqual({
      app_user: [],
      app_system: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      app_public: [],
      app_auth: ['SELECT', 'INSERT', 'UPDATE'],
    });
    expect(() => tablesSql({ tenant: { t: { kind: 'STRICT', authAppend } }, global: {} })).toThrow(/appendOnly/);
    const smuggled = { column: 'type', prefix: "x'; drop table y; --" };
    expect(() =>
      tablesSql({ tenant: { t: { kind: 'STRICT', appendOnly: true, authAppend: smuggled } }, global: {} }),
    ).toThrow(/prefix/);
    expect(() => tablesSql({ tenant: {}, global: { u: { reason: 'x', access: 'auth', publicRead: true } } })).toThrow(
      /publicRead/,
    );
  });

  it('[S0-05] the production registry generates valid SQL', () => {
    expect(() => generateRlsSql(registry)).not.toThrow();
  });
});
