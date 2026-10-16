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
  using (app_agency() is not null and (select public.app_agency_verified()) and (visibility in ('SHARED','PUBLIC') and status = 'ACTIVE'));`);
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
      `revoke all on table public."contacts" from public, app_user, app_system, app_public, app_auth, app_staff, app_media;`,
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

  it('[S1-07] the generator itself requires a verified reader on every NETWORK_READ policy; no predicate can widen it', () => {
    const weak = tablesSql({
      tenant: {
        t: {
          kind: 'NETWORK_READ',
          networkReadSql: 'app_agency_verified() or true',
          samples: { visible: [], hidden: [] },
        },
      },
      global: {},
    });
    // ANDed outside the registry predicate (in its own parentheses), as a once-per-statement init plan.
    expect(weak).toContain(
      'using (app_agency() is not null and (select public.app_agency_verified()) and (app_agency_verified() or true));',
    );
  });

  it('[S1-07] the preferred helper is a set-returning SQL function for app_user only, never SECURITY DEFINER', () => {
    expect(out).toContain(
      'create or replace function app_preferring_agencies() returns setof uuid language sql stable parallel safe',
    );
    expect(out).toContain('drop function if exists app_is_preferred_by(uuid);');
    expect(out).toContain('grant execute on function app_agency_verified(), app_preferring_agencies() to app_user;');
    expect(out).not.toMatch(/app_preferring_agencies\(\) returns setof uuid[^;]*security definer/i);
  });

  it('[S1-08] partition maintenance is the only SECURITY DEFINER helper, executable by app_system only', () => {
    expect(out.match(/security definer/gi)).toHaveLength(1);
    expect(out).toContain(
      'create or replace function app_partition_maintenance() returns void language plpgsql security definer',
    );
    expect(out).toContain('set search_path = pg_catalog, pg_temp');
    expect(out).toContain('grant execute on function app_partition_maintenance() to app_system;');
    expect(out).not.toMatch(/app_partition_maintenance\(\) to [^;]*app_(?:user|public|auth|staff)/);
  });

  it('[S1-F10] userSelect: app_user reads through a user predicate and a column list without the hidden columns', () => {
    const userSelect = {
      sql: 'owner_user_id = app_user_id()',
      hiddenColumns: ['secret'],
      samples: { visible: [], hidden: [] },
    };
    const def = { kind: 'STRICT', userSelect } as const;
    const sql = tablesSql({ tenant: { notes: def }, global: {} });
    expect(sql).toContain(`create policy user_select on public."notes" for select to app_user
  using (agency_id = app_agency() and (owner_user_id = app_user_id()));`);
    for (const cmd of ['insert', 'update', 'delete'])
      expect(sql).toContain(`create policy own_${cmd} on public."notes" for ${cmd} to app_user`);
    expect(sql).not.toContain('create policy own_rows');
    expect(sql).toContain(`attname <> all (array['secret'])`);
    expect(sql).toContain('grant insert, update, delete on table public."notes" to app_user;');
    expect(sql).not.toMatch(/grant select, insert[^;]*"notes" to app_user/);
    expect(expectedPolicies(def).map((p) => `${p.name}:${p.cmd}`)).toEqual([
      'own_insert:INSERT',
      'own_update:UPDATE',
      'own_delete:DELETE',
      'user_select:SELECT',
    ]);
    expect(expectedPrivileges(def).app_user).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
  });

  it('[S1-F10] userSelect is refused on non-STRICT, append-only and immutable tables', () => {
    const userSelect = { sql: 'true', samples: { visible: [], hidden: [] } };
    const bad = (tenant: TenantRegistry['tenant'][string]) => () => tablesSql({ tenant: { t: tenant }, global: {} });
    expect(bad({ kind: 'STRICT', appendOnly: true, userSelect })).toThrow(/userSelect/);
    expect(bad({ kind: 'STRICT', immutable: true, userSelect })).toThrow(/userSelect/);
    expect(bad({ kind: 'STRICT', userSelect: { ...userSelect, hiddenColumns: ['agency_id'] } })).toThrow(
      /hidden column/,
    );
  });

  it('[S1-08] immutable tables: no app role gets UPDATE or DELETE', () => {
    const def = {
      kind: 'STRICT',
      immutable: true,
      auth: { insert: 'agency_id = app_agency() and true' },
      staff: { select: 'true', insert: 'true' },
    } as const;
    const sql = tablesSql({ tenant: { audit: def }, global: {} });
    expect(sql).toContain('grant select, insert on table public."audit" to app_user;');
    expect(sql).toContain('grant select, insert on table public."audit" to app_system;');
    expect(sql).toContain('grant insert on table public."audit" to app_auth;');
    expect(sql).toContain('grant select, insert on table public."audit" to app_staff;');
    expect(sql).not.toMatch(/grant [^;]*(?:update|delete)[^;]*"audit"/);
    expect(expectedPrivileges(def)).toEqual({
      app_user: ['SELECT', 'INSERT'],
      app_system: ['SELECT', 'INSERT'],
      app_public: [],
      app_auth: ['INSERT'],
      app_staff: ['SELECT', 'INSERT'],
      app_media: [],
    });
    expect(() =>
      tablesSql({ tenant: { audit: { kind: 'STRICT', immutable: true, staff: { update: 'true' } } }, global: {} }),
    ).toThrow(/immutable/);
    // userInsert narrows app_user's appends (only for immutable tables).
    const narrowed = tablesSql({
      tenant: { audit: { kind: 'STRICT', immutable: true, userInsert: 'actor = app_user_id()' } },
      global: {},
    });
    expect(narrowed).toContain('with check (agency_id = app_agency() and (actor = app_user_id()));');
    expect(() => tablesSql({ tenant: { t: { kind: 'STRICT', userInsert: 'true' } }, global: {} })).toThrow(
      /userInsert/,
    );
    // The production audit log is immutable and partitioned.
    expect(registry.tenant.audit_logs).toMatchObject({ immutable: true, partitioned: true });
    expect(expectedPrivileges(registry.tenant.audit_logs as never).app_system).toEqual(['SELECT', 'INSERT']);
  });

  it('[S0-05] expected policies per kind; duplicate registrations are refused', () => {
    expect(expectedPolicies({ kind: 'STRICT' })).toEqual([{ name: 'own_rows', cmd: 'ALL', roles: ['app_user'] }]);
    expect(expectedPolicies({ reason: 'x' })).toEqual([{ name: 'global_read', cmd: 'SELECT', roles: ['app_user'] }]);
    expect(expectedPrivileges({ reason: 'x' })).toEqual({
      app_user: ['SELECT'],
      app_system: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      app_public: [],
      app_auth: [],
      app_staff: [],
      app_media: [],
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
      app_staff: [],
      app_media: [],
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

  it('[S1-01] auth predicates: app_auth gets exactly the scoped policies and grants, never DELETE', () => {
    const def = {
      kind: 'STRICT' as const,
      auth: { select: 'user_id = app_user_id()', insert: 'agency_id = app_agency() and user_id = app_user_id()' },
    };
    const sql = tablesSql({ tenant: { agency_members: def }, global: {} });
    expect(sql).toContain(`create policy auth_select on public."agency_members" for select to app_auth
  using (user_id = app_user_id());`);
    expect(sql).toContain(`create policy auth_insert on public."agency_members" for insert to app_auth
  with check (agency_id = app_agency() and user_id = app_user_id());`);
    expect(sql).not.toContain('auth_update');
    expect(sql).toContain(`grant select, insert on table public."agency_members" to app_auth;`);
    expect(expectedPrivileges(def).app_auth).toEqual(['SELECT', 'INSERT']);
    expect(expectedPolicies(def).map((p) => `${p.name}:${p.cmd}`)).toEqual([
      'own_rows:ALL',
      'auth_select:SELECT',
      'auth_insert:INSERT',
    ]);
    expect(generateRlsSql(reg)).toContain(
      'grant execute on function app_agency(), app_user_id() to app_user, app_system, app_public, app_auth, app_staff;',
    );
  });

  it('[S1-01] auth predicates must pin rows to the auth scope and are not allowed on append-only tables', () => {
    expect(() => tablesSql({ tenant: { agencies: { kind: 'STRICT', auth: { select: 'true' } } }, global: {} })).toThrow(
      /must pin rows/,
    );
    expect(() =>
      tablesSql({
        tenant: { q: { kind: 'STRICT', appendOnly: true, auth: { insert: 'agency_id = app_agency()' } } },
        global: {},
      }),
    ).toThrow(/appendOnly/);
  });

  it('[S1-04] staff tables: app_auth reads only the row of the user its flow is scoped to, and writes nothing', () => {
    const def = { reason: 'staff', access: 'staff' as const };
    const sql = generateRlsSql({ tenant: {}, global: { staff_users: def } });
    expect(sql).toContain(
      `create policy auth_self on public."staff_users" for select to app_auth using (user_id = app_user_id());`,
    );
    expect(sql).toContain(`grant select on table public."staff_users" to app_auth, app_staff;`);
    expect(expectedPolicies(def).map((p) => `${p.name}:${p.cmd}:${p.roles.join()}`)).toEqual([
      'auth_self:SELECT:app_auth',
      'staff_self:SELECT:app_staff',
    ]);
  });

  it("[S1-04] userScoped auth tables: app_auth reaches only the scoped user's rows", () => {
    const sql = generateRlsSql({
      tenant: {},
      global: { user_mfa: { reason: 'x', access: 'auth', userScoped: true }, users: { reason: 'x', access: 'auth' } },
    });
    expect(sql).toContain(
      `create policy auth_rows on public."user_mfa" to app_auth using (user_id = app_user_id()) with check (user_id = app_user_id());`,
    );
    expect(sql).toContain(`create policy auth_rows on public."users" to app_auth using (true) with check (true);`);
    expect(() => tablesSql({ tenant: {}, global: { g: { reason: 'x', userScoped: true } } })).toThrow(/userScoped/);
  });

  it('[S1-03] staff predicates: app_staff gets gated policies and grants, never DELETE; staff tables show it only its own row', () => {
    const def = { kind: 'STRICT' as const, staff: { select: 'true', update: "status = 'SUBMITTED'" } };
    const sql = generateRlsSql({
      tenant: { requests: def },
      global: { staff_users: { reason: 'staff', access: 'staff' } },
    });
    expect(sql).toContain(`create policy staff_select on public."requests" for select to app_staff
  using (app_is_staff() and (true));`);
    expect(sql).toContain(`create policy staff_update on public."requests" for update to app_staff
  using (app_is_staff() and (status = 'SUBMITTED')) with check (app_is_staff() and (status = 'SUBMITTED'));`);
    expect(sql).toContain(`grant select, update on table public."requests" to app_staff;`);
    expect(sql).not.toContain('staff_insert');
    expect(sql).toContain(
      `create policy staff_self on public."staff_users" for select to app_staff using (user_id = app_user_id());`,
    );
    expect(sql).toContain('grant execute on function app_is_staff() to app_staff;');
    expect(expectedPrivileges(def).app_staff).toEqual(['SELECT', 'UPDATE']);
    expect(expectedPolicies(def).map((p) => `${p.name}:${p.cmd}`)).toEqual([
      'own_rows:ALL',
      'staff_select:SELECT',
      'staff_update:UPDATE',
    ]);
    expect(expectedPrivileges({ kind: 'STRICT' }).app_staff).toEqual([]);
    expect(sql).not.toMatch(/"staff_users"[^;]* to [^;]*app_(?:user|public)(?![a-z_])/);
    expect(expectedPrivileges({ reason: 'x', access: 'staff' })).toEqual({
      app_user: [],
      app_system: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      app_public: [],
      app_auth: ['SELECT'],
      app_staff: ['SELECT'],
      app_media: [],
    });
    expect(() => tablesSql({ tenant: {}, global: { g: { reason: 'x', access: 'staff', publicRead: true } } })).toThrow(
      /publicRead/,
    );
  });

  it('[S3-F1] noUserRead: no app_user policy or grant; staff keep their gated policies; refused with publicRead', () => {
    const r: TenantRegistry = {
      tenant: {},
      global: { queue: { reason: 'staff queue', staffWrite: true, noUserRead: true } },
    };
    const sql = generateRlsSql(r);
    expect(sql).not.toContain('create policy global_read on public."queue"');
    expect(sql).not.toMatch(/grant select on table public\."queue" to app_user/);
    expect(sql).toContain(
      'create policy staff_select on public."queue" for select to app_staff using (app_is_staff());',
    );
    const def = r.global.queue as NonNullable<(typeof r.global)['queue']>;
    expect(expectedPrivileges(def).app_user).toEqual([]);
    expect(expectedPolicies(def).map((p) => p.name)).not.toContain('global_read');
    expect(() =>
      generateRlsSql({ tenant: {}, global: { x: { reason: 'x', publicRead: true, noUserRead: true } } }),
    ).toThrow(/noUserRead/);
  });

  it('[S3-F4] media access: app_media gets its global table whole and a column grant on mediaRead tables, nothing else', () => {
    const r: TenantRegistry = {
      tenant: { photos: { kind: 'STRICT', mediaRead: { columns: ['sha256'] } }, contacts: { kind: 'STRICT' } },
      global: { objects: { reason: 'blobs', mediaWrite: true }, flags: { reason: 'flags' } },
    };
    const sql = generateRlsSql(r);
    expect(sql).toContain('create policy media_read on public."photos" for select to app_media using (true);');
    expect(sql).toContain('grant select ("sha256") on table public."photos" to app_media;');
    expect(sql).toContain('create policy media_rows on public."objects" to app_media using (true) with check (true);');
    expect(sql).toContain('grant select, insert, update, delete on table public."objects" to app_media;');
    expect(sql).not.toMatch(/on table public\."(contacts|flags)" to app_media/);
    expect(expectedPrivileges(r.tenant.contacts as never).app_media).toEqual([]);
    expect(expectedPrivileges(r.global.flags as never).app_media).toEqual([]);
    expect(() =>
      generateRlsSql({ tenant: { x: { kind: 'STRICT', mediaRead: { columns: ['a b'] } } }, global: {} }),
    ).toThrow(/not a column name/);
  });

  it('[S0-05] the production registry generates valid SQL', () => {
    expect(() => generateRlsSql(registry)).not.toThrow();
  });
});
