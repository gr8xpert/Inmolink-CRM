import { describe, expect, it } from 'vitest';
import type { TenantRegistry, TenantTable } from './registry';
import { mergeRegistries, registry } from './registry';
import {
  DEFINER_VIEWS,
  expectedPolicies,
  expectedPrivileges,
  generateRlsSql,
  HELPER_FUNCTIONS,
  tablesSql,
} from './rls';

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
    // S7-F10: and the generated commission floor view (ids only; its own test below).
    expect(out.match(/^grant select on table .*app_public;$/gm)).toHaveLength(3);
    expect(out).toContain('grant select on table public.search_commission_floor to app_public;');
    expect(out).toContain('alter view public.search_commission_floor owner to app_owner;');
  });

  it('[S5-05] a PUBLIC_READ table with a network predicate also gets the guarded network_read policy', () => {
    const sqlOut = generateRlsSql({
      ...reg,
      tenant: {
        ...reg.tenant,
        listing_read_models: {
          kind: 'PUBLIC_READ',
          publicReadSql: 'published',
          networkReadSql: 'exists (select 1 from public.properties p where p.id = listing_read_models.target_id)',
          samples: { visible: [], hidden: [] },
        },
      },
    });
    expect(sqlOut).toContain(`create policy network_read on public."listing_read_models" for select to app_user
  using (app_agency() is not null and (select public.app_agency_verified()) and (exists (select 1 from public.properties p where p.id = listing_read_models.target_id)));`);
    expect(sqlOut).toContain(`create policy public_read on public."listing_read_models" for select to app_public`);
    expect(out).not.toContain(`create policy network_read on public."listing_read_models"`);
  });

  it('[S5-05] table-level hiddenColumns: app_user gets SELECT on the other columns only, writes stay table-wide', () => {
    const sqlOut = generateRlsSql({
      ...reg,
      tenant: {
        ...reg.tenant,
        listing_read_models: {
          kind: 'PUBLIC_READ',
          publicReadSql: 'published',
          hiddenColumns: ['share_scope'],
          samples: { visible: [], hidden: [] },
        },
      },
    });
    expect(sqlOut).toContain(`attname <> all (array['share_scope'])`);
    expect(sqlOut).toContain(`grant insert, update, delete on table public."listing_read_models" to app_user;`);
    expect(sqlOut).not.toContain(
      `grant select, insert, update, delete on table public."listing_read_models" to app_user;`,
    );
  });

  it('[S6-08] staff column allowlists: app_staff reads and writes only the listed columns', () => {
    const sqlOut = generateRlsSql({
      ...reg,
      tenant: {
        ...reg.tenant,
        feeds: {
          kind: 'STRICT',
          staff: { select: 'true', update: 'true', selectColumns: ['id', 'name'], updateColumns: ['name'] },
        },
      },
    });
    expect(sqlOut).toContain(`grant select ("id", "name") on table public."feeds" to app_staff;`);
    expect(sqlOut).toContain(`grant update ("name") on table public."feeds" to app_staff;`);
    expect(sqlOut).not.toMatch(/grant select, update on table public\."feeds" to app_staff/);
    const bad = (staff: object) => () =>
      generateRlsSql({ ...reg, tenant: { ...reg.tenant, feeds: { kind: 'STRICT', staff } as never } });
    expect(bad({ select: 'true', selectColumns: ['x; drop'] })).toThrow(/not a column name/);
    expect(bad({ updateColumns: ['name'] })).toThrow(/needs staff.update/);
  });

  it('[S0-05] global tables are read-only for app_user and written only by app_system', () => {
    expect(out).toContain(`grant select, insert, update, delete on table public."locations" to app_system;`);
    expect(out).not.toMatch(/grant [^;]*insert[^;]*"locations" to app_user/);
  });

  it('[S0-05] every table resets its grants and policies, so reruns are idempotent', () => {
    expect(out).toContain(
      `revoke all on table public."contacts" from public, app_user, app_system, app_public, app_auth, app_staff, app_media, app_intake;`,
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

  it('[S1-08] partition maintenance is a SECURITY DEFINER helper executable by app_system only (the other: [S7-03])', () => {
    // S8-02 adds the two legacy-id lookups (app_public), S9-03 the portal feed token lookup (app_public), S10-06 the
    // calendar feed token lookup (app_public).
    expect(out.match(/security definer/gi)).toHaveLength(6);
    expect(out).toContain(
      'create or replace function app_partition_maintenance() returns void language plpgsql security definer',
    );
    expect(out).toContain('set search_path = pg_catalog, pg_temp');
    expect(out).toContain('grant execute on function app_partition_maintenance() to app_system;');
    expect(out).not.toMatch(/app_partition_maintenance\(\) to [^;]*app_(?:user|public|auth|staff)/);
  });

  it('[S7-F11] no app role can execute the S7-F4 commission lookup: dropped, not a helper, never created or granted', () => {
    // Unused since S7-F10 (the generated view answers instead), kept one release for the app version running during
    // that deploy. The guard rejects any function an app role can execute that is not a helper (`[S7-F11]` guard test).
    expect(HELPER_FUNCTIONS as readonly string[]).not.toContain('search_commission_at_least');
    expect(out).toContain('drop function if exists public.search_commission_at_least(uuid, integer);');
    expect(out.match(/search_commission_at_least/g)).toHaveLength(1);
  });

  it('[S7-F10] the commission floor is a generated security-barrier view of ids only, readable by app_public alone', () => {
    expect(DEFINER_VIEWS).toEqual(['search_commission_floor']);
    const view = /create view public\.search_commission_floor[^;]*;/.exec(out)?.[0] ?? '';
    expect(view).toContain('with (security_barrier = true)');
    // Ids and the transaction's own minimum out, never the commission; an unset minimum fails the cast loudly.
    expect(view).toMatch(
      /select c\.target_id as floor_target_id, [^;]* as floor_bp\s+from public\.listing_search_commissions c/,
    );
    expect(view).not.toMatch(/commission_bp as|c\.commission_bp,/);
    expect(view).toContain("'app.search_min_commission_bp is not set')::integer");
    expect(out).toContain('grant select on table public.search_commission_floor to app_public;');
    expect(out).not.toMatch(/search_commission_floor to [^;]*app_(?:user|system|auth|staff|media|intake)/);
    // The table behind it: no application role but app_system has a grant; the view's owner reads through a policy.
    const table = tablesSql(registry).split('-- listing_search_commissions: GLOBAL')[1]?.split('\n\n')[0] ?? '';
    expect(table).toContain(
      'create policy definer_read on public."listing_search_commissions" for select to app_owner',
    );
    expect(table).not.toMatch(/grant select[^;]*to [^;]*app_(?:user|public)/);
  });

  it('[S8-02] legacy_id_maps: app_public reads taxonomy maps only; listing ids through two SECURITY DEFINER lookups', () => {
    const table = tablesSql(registry).split('-- legacy_id_maps: GLOBAL')[1]?.split('\n\n')[0] ?? '';
    expect(table).toContain(
      `create policy global_read on public."legacy_id_maps" for select to app_public using (entity in ('location', 'propertyType', 'feature'));`,
    );
    expect(table).toContain(
      'create policy definer_read on public."legacy_id_maps" for select to app_owner using (true);',
    );
    expect(table).not.toMatch(/grant select[^;]*to [^;]*app_user/);
    for (const fn of ['legacy_target_ids', 'legacy_ids_of']) {
      expect(HELPER_FUNCTIONS as readonly string[]).toContain(fn);
      const body = out.split(`create or replace function ${fn}(`)[1]?.split('$$;')[0] ?? '';
      expect(body).toContain('security definer set search_path = pg_catalog, pg_temp');
      expect(body).toContain("in ('listing', 'unit')");
    }
    expect(out).toContain('grant execute on function legacy_target_ids(text[]), legacy_ids_of(uuid[]) to app_public;');
    expect(out).toContain('alter function legacy_target_ids(text[]) owner to app_owner;');
    expect(out).toContain('alter function legacy_ids_of(uuid[]) owner to app_owner;');
    expect(() =>
      generateRlsSql({
        ...registry,
        global: { ...registry.global, x: { reason: 'x', publicRead: true, publicReadSql: 'true' } },
      }),
    ).toThrow(/publicReadSql is only valid with publicRead and noUserRead/);
  });

  it('[S9-03] portal feed tokens resolve through a SECURITY DEFINER lookup for app_public; the connections table stays closed to it', () => {
    expect(HELPER_FUNCTIONS as readonly string[]).toContain('portal_feed_by_token');
    expect(out).toContain('drop function if exists portal_feed_by_token(text);');
    const body = out.split('create function portal_feed_by_token(')[1]?.split('$$;')[0] ?? '';
    // Only what feed-api uses: the connection, its portal, the served run and its content hash.
    expect(body).toContain('returns table(connection_id uuid, channel_code text, run_id uuid, sha256 text)');
    expect(body).toContain('security definer set search_path = pg_catalog, pg_temp');
    // Only the served file's columns: never the credentials, selection or names.
    expect(body).not.toMatch(/credentials|credential_keys|selection_|\bname\b/);
    expect(body).toContain("g.status = 'VERIFIED'");
    expect(body).toContain('c.revoked_at is null');
    expect(out).toContain('grant execute on function portal_feed_by_token(text) to app_public;');
    expect(out).not.toMatch(/portal_feed_by_token\(text\) to [^;]*app_(?:user|system|auth|staff)/);
    const tables = tablesSql(registry);
    const table = tables.split('-- agency_portal_connections:')[1]?.split('\n\n')[0] ?? '';
    expect(table).toContain(
      'create policy definer_read on public."agency_portal_connections" for select to app_owner using (true);',
    );
    expect(table).not.toMatch(/to [^;]*app_public/);
  });

  it('[S10-06] calendar feed tokens resolve through a SECURITY DEFINER lookup for app_public: the member’s own events, names only', () => {
    const sig = 'calendar_feed_by_token(text, timestamptz, timestamptz, timestamptz, integer)';
    expect(HELPER_FUNCTIONS as readonly string[]).toContain('calendar_feed_by_token');
    expect(out).toContain(`drop function if exists ${sig};`);
    const body = out.split('create function calendar_feed_by_token(')[1]?.split('$$;')[0] ?? '';
    expect(body).toContain('security definer set search_path = pg_catalog, pg_temp');
    // the live token of an active member, and only the events that member attends
    expect(body).toContain('f.token_hash = hash and f.revoked_at is null');
    expect(body).toContain('m.deactivated_at is null');
    expect(body).toContain('a.user_id = feed.user_id');
    // access follows the member: a CRM role, an active login, an agency not suspended; contacts still open
    expect(body).toContain("m.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT')");
    expect(body).toContain("u.status = 'ACTIVE'");
    expect(body).toContain("g.status <> 'SUSPENDED'");
    expect(body).toContain('c.deleted_at is null');
    // attendees' names only: never a contact's or member's e-mail or phone
    expect(body).not.toMatch(/email|phone|token_hash,|agency_id uuid/);
    expect(out).toContain(`grant execute on function ${sig} to app_public;`);
    expect(out).not.toMatch(/calendar_feed_by_token\([^)]*\) to [^;]*app_(?:user|system|auth|staff)/);
    const owner = `alter function ${sig} owner to app_owner;`;
    expect(out.indexOf(owner)).toBeGreaterThan(out.indexOf('create function calendar_feed_by_token('));
    const tables = tablesSql(registry);
    expect(tables).toContain('create policy definer_read on public."users" for select to app_owner using (true);');
    for (const t of ['calendar_feeds', 'calendar_events', 'calendar_event_attendees', 'contacts', 'agency_members']) {
      const table = tables.split(`-- ${t}:`)[1]?.split('\n\n')[0] ?? '';
      expect(table).toContain(`create policy definer_read on public."${t}" for select to app_owner using (true);`);
      expect(table).not.toMatch(/to [^;]*app_public/);
    }
  });

  it('[S9-review] portal_feed_by_token is owned by app_owner (its definer_read policy), set after it is recreated', () => {
    const owner = 'alter function portal_feed_by_token(text) owner to app_owner;';
    expect(out).toContain(owner);
    // Recreated (dropped first) on every run: the owner must be set after the create, never before it.
    expect(out.indexOf(owner)).toBeGreaterThan(out.indexOf('create function portal_feed_by_token('));
  });

  it('[S7-03] the website network gate is SECURITY DEFINER, executable by app_public only; its tables open to the owner only', () => {
    expect(out).toContain(
      'create or replace function website_network_open(a_id uuid, min_shared integer, grace_days integer) returns boolean',
    );
    expect(out).toMatch(/website_network_open[^;]*security definer set search_path = pg_catalog, pg_temp/);
    expect(out).toContain('grant execute on function website_network_open(uuid, integer, integer) to app_public;');
    expect(out).not.toMatch(/website_network_open\(uuid, integer, integer\) to [^;]*app_(?:user|system|auth|staff)/);
    const tables = tablesSql(registry);
    for (const name of ['agencies', 'properties']) {
      expect(tables).toContain(`create policy definer_read on public."${name}" for select to app_owner using (true);`);
    }
    // No other role gains a policy or grant from it.
    expect(tables).not.toMatch(/definer_read[^;]*to [^;]*app_(?:user|public|system|auth|staff)/);
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
      app_intake: [],
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
      app_intake: [],
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
      app_intake: [],
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
    // S7-F10: the gate is an init plan (once per statement), never a function call per row.
    expect(sql).toContain(`create policy staff_select on public."requests" for select to app_staff
  using ((select public.app_is_staff()) and (true));`);
    expect(sql).toContain(`create policy staff_update on public."requests" for update to app_staff
  using ((select public.app_is_staff()) and (status = 'SUBMITTED')) with check ((select public.app_is_staff()) and (status = 'SUBMITTED'));`);
    expect(sql).not.toMatch(/using \(app_is_staff\(\)/);
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
      app_intake: [],
    });
    expect(() => tablesSql({ tenant: {}, global: { g: { reason: 'x', access: 'staff', publicRead: true } } })).toThrow(
      /publicRead/,
    );
  });

  it('[S3-F1] noUserRead: no app_user policy or grant; staff keep their gated policies; refused on access tables', () => {
    const r: TenantRegistry = {
      tenant: {},
      global: { queue: { reason: 'staff queue', staffWrite: true, noUserRead: true } },
    };
    const sql = generateRlsSql(r);
    expect(sql).not.toContain('create policy global_read on public."queue"');
    expect(sql).not.toMatch(/grant select on table public\."queue" to app_user/);
    expect(sql).toContain(
      'create policy staff_select on public."queue" for select to app_staff using ((select public.app_is_staff()));',
    );
    const def = r.global.queue as NonNullable<(typeof r.global)['queue']>;
    expect(expectedPrivileges(def).app_user).toEqual([]);
    expect(expectedPolicies(def).map((p) => p.name)).not.toContain('global_read');
    expect(() =>
      generateRlsSql({ tenant: {}, global: { x: { reason: 'x', access: 'auth', noUserRead: true } } }),
    ).toThrow(/noUserRead/);
  });

  it('[S6-F1] noUserRead with publicRead: app_public alone reads the global table', () => {
    const def = { reason: 'fallback rows', publicRead: true, noUserRead: true } as const;
    const sql = generateRlsSql({ tenant: {}, global: { docs: def } });
    expect(sql).toContain('create policy global_read on public."docs" for select to app_public using (true);');
    expect(sql).toContain('grant select on table public."docs" to app_public;');
    expect(sql).not.toMatch(/(policy|grant)[^;]*"docs"[^;]*app_user/);
    expect(expectedPrivileges(def)).toMatchObject({ app_user: [], app_public: ['SELECT'] });
    expect(expectedPolicies(def)).toEqual([{ name: 'global_read', cmd: 'SELECT', roles: ['app_public'] }]);
  });

  it('[S6-F1] userReadOnly PUBLIC_READ: app_user only reads (own rows, network); app_public is refused the hidden columns', () => {
    const def: TenantTable = {
      kind: 'PUBLIC_READ',
      userReadOnly: true,
      publicReadSql: 'published',
      hiddenColumns: ['share_scope'],
      networkReadSql: 'exists (select 1 from public.properties p where p.id = listing_read_models.target_id)',
      samples: { visible: [], hidden: [] },
    };
    const sqlOut = generateRlsSql({ ...reg, tenant: { ...reg.tenant, listing_read_models: def } });
    const t = 'public."listing_read_models"';
    expect(sqlOut).toContain(`create policy own_rows on ${t} for select to app_user
  using (agency_id = app_agency());`);
    expect(sqlOut).not.toMatch(/grant [^;]*(insert|update|delete)[^;]*"listing_read_models" to app_user/);
    // Column grants for both readers, without the hidden column.
    expect(sqlOut).toContain(`execute format('grant select (%s) on table ${t} to app_user', cols);`);
    expect(sqlOut).toContain(`execute format('grant select (%s) on table ${t} to app_public', cols);`);
    expect(sqlOut).not.toContain(`grant select on table ${t} to app_public;`);
    expect(expectedPrivileges(def)).toMatchObject({ app_user: ['SELECT'], app_public: ['SELECT'] });
    expect(expectedPolicies(def).find((p) => p.name === 'own_rows')).toEqual({
      name: 'own_rows',
      cmd: 'SELECT',
      roles: ['app_user'],
    });
    // Only on PUBLIC_READ and STRICT tables (S10-F4); the production read models are registered so.
    expect(() =>
      generateRlsSql({
        tenant: {
          x: { kind: 'NETWORK_READ', userReadOnly: true, networkReadSql: 'true', samples: { visible: [], hidden: [] } },
        },
        global: {},
      }),
    ).toThrow(/userReadOnly/);
    expect(() =>
      generateRlsSql({ tenant: { x: { kind: 'STRICT', userReadOnly: true, appendOnly: true } }, global: {} }),
    ).toThrow(/userReadOnly/);
    expect(registry.tenant.listing_read_models).toMatchObject({ userReadOnly: true });
    expect(registry.global.listing_search_docs).toMatchObject({ publicRead: true, noUserRead: true });
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

  it('[S7-05] intake access: app_intake appends its pinned agency rows, reads back only the listed columns', () => {
    const r: TenantRegistry = {
      tenant: {
        leads: { kind: 'STRICT', intake: { selectColumns: ['id', 'request_hash'] } },
        events: {
          kind: 'STRICT',
          appendOnly: true,
          intakeAppend: { column: 'type', values: ['websites.lead.received'] },
        },
        contacts: { kind: 'STRICT' },
      },
      global: { flags: { reason: 'flags' } },
    };
    const sql = generateRlsSql(r);
    expect(sql).toContain(`create policy intake_insert on public."leads" for insert to app_intake
  with check (agency_id = app_agency());`);
    expect(sql).toContain(`create policy intake_select on public."leads" for select to app_intake
  using (agency_id = app_agency());`);
    expect(sql).toContain('grant select ("id", "request_hash") on table public."leads" to app_intake;');
    expect(sql).toContain(`create policy intake_append on public."events" for insert to app_intake
  with check (agency_id = app_agency() and "type" in ('websites.lead.received'));`);
    expect(sql).not.toMatch(/on table public\."(contacts|flags)" to app_intake/);
    expect(expectedPrivileges(r.tenant.leads as never).app_intake).toEqual(['SELECT', 'INSERT']);
    expect(expectedPrivileges(r.tenant.events as never).app_intake).toEqual(['INSERT']);
    expect(expectedPrivileges(r.tenant.contacts as never).app_intake).toEqual([]);
    expect(() =>
      generateRlsSql({
        tenant: { x: { kind: 'STRICT', intakeAppend: { column: 'type', values: ['a'] } } },
        global: {},
      }),
    ).toThrow(/appendOnly/);
    expect(() =>
      generateRlsSql({ tenant: { x: { kind: 'STRICT', intake: { selectColumns: [] } } }, global: {} }),
    ).toThrow(/selectColumns/);
    expect(registry.tenant.website_leads).toMatchObject({ kind: 'STRICT' });
  });

  it('[S0-05] the production registry generates valid SQL', () => {
    expect(() => generateRlsSql(registry)).not.toThrow();
  });
});

describe('portal worker tables (S10-F4)', () => {
  const part = (table: string) =>
    tablesSql(registry).split(`-- ${table}:`)[1]?.split(String.fromCharCode(10, 10))[0] ?? '';

  it('[S10-F4] agency_portal_connections: app_user reads neither credentials_enc nor token_hash, and updates no worker column', () => {
    const t = 'public."agency_portal_connections"';
    const sqlOut = part('agency_portal_connections');
    expect(sqlOut).toContain("attname <> all (array['credentials_enc', 'token_hash'])");
    expect(sqlOut).toContain(`execute format('grant select (%s) on table ${t} to app_user', cols);`);
    expect(sqlOut).toContain(
      "attname <> all (array['feed_run_id', 'feed_sha256', 'feed_bytes', 'feed_item_count', 'feed_generated_at', 'push_error', 'nightly_at'])",
    );
    expect(sqlOut).toContain(`execute format('grant update (%s) on table ${t} to app_user', cols);`);
    expect(sqlOut).toContain(`grant insert, delete on table ${t} to app_user;`);
    expect(sqlOut).not.toContain(`grant select on table ${t} to app_user;`);
  });

  it('[S10-F4] portal_feed_runs and portal_listing_sync: app_user only reads its own rows', () => {
    for (const table of ['portal_feed_runs', 'portal_listing_sync'] as const) {
      const def = registry.tenant[table] as TenantTable;
      expect(def).toMatchObject({ kind: 'STRICT', userReadOnly: true });
      expect(expectedPrivileges(def).app_user).toEqual(['SELECT']);
      const t = `public."${table}"`;
      const sqlOut = part(table);
      expect(sqlOut).toContain(`create policy own_rows on ${t} for select to app_user
  using (agency_id = app_agency());`);
      expect(sqlOut).toContain(`grant select on table ${t} to app_user;`);
      expect(sqlOut).not.toMatch(/grant [^;]*(insert|update|delete)[^;]* to app_user;/);
    }
  });
});

describe('userNoUpdateColumns', () => {
  it('[S8-F26] api_keys: app_user gets UPDATE on a column list without legacy_query_key; other privileges unchanged', () => {
    const sqlOut = tablesSql(registry);
    const part = sqlOut.split('-- api_keys:')[1]?.split('\n\n')[0] ?? '';
    expect(part).toContain("attname <> all (array['legacy_query_key'])");
    expect(part).toContain(`grant update (%s) on table public."api_keys" to app_user`);
    expect(part).not.toMatch(/grant [^;]*\bupdate\b[^;(]* on table public\."api_keys" to app_user;/);
    expect(registry.tenant.api_keys?.userNoUpdateColumns).toEqual(['legacy_query_key']);
  });

  it('[S11-F3] userAppendRead: app_user selects and inserts only (no UPDATE, no DELETE); app_system keeps DML', () => {
    const def = registry.tenant.data_export_jobs as TenantTable;
    expect(def.userAppendRead).toBe(true);
    expect(expectedPrivileges(def).app_user).toEqual(['SELECT', 'INSERT']);
    expect(expectedPrivileges(def).app_system).toEqual(expect.arrayContaining(['UPDATE', 'DELETE']));
    const part = tablesSql(registry).split('-- data_export_jobs:')[1]?.split('\n\n')[0] ?? '';
    expect(part).toContain('data_export_jobs');
    expect(part).not.toMatch(/grant [^;]*\b(update|delete)\b[^;]* to app_user/);
    const bad = (d: TenantTable) => () => tablesSql({ tenant: { t: d }, global: {} });
    expect(bad({ kind: 'NETWORK_READ', userAppendRead: true } as TenantTable)).toThrow(/userAppendRead/);
    expect(bad({ kind: 'STRICT', userAppendRead: true, userReadOnly: true })).toThrow(/userAppendRead/);
    expect(bad({ kind: 'STRICT', userAppendRead: true, userNoUpdateColumns: ['x'] })).toThrow(/userAppendRead/);
  });

  it('[S10-03] definerAppend: app_user only reads; app_owner appends through a definer_append policy; STRICT userReadOnly only', () => {
    const history = registry.tenant.lead_stage_history;
    expect(history).toMatchObject({ kind: 'STRICT', userReadOnly: true });
    expect(history?.definerAppend?.functions).toEqual(['lead_stage_history_append']);
    expect(expectedPolicies(history as TenantTable)).toContainEqual({
      name: 'definer_append',
      cmd: 'INSERT',
      roles: ['app_owner'],
    });
    const part = tablesSql(registry).split('-- lead_stage_history: STRICT')[1]?.split('\n\n')[0] ?? '';
    expect(part).toContain('create policy definer_append on public."lead_stage_history" for insert to app_owner');
    expect(part).not.toMatch(/grant [^;]*insert[^;]* to app_user/);
    const bad = (def: TenantTable) => () => tablesSql({ tenant: { t: def }, global: {} });
    expect(bad({ kind: 'STRICT', definerAppend: { functions: ['f'] } })).toThrow(/definerAppend/);
    expect(bad({ kind: 'STRICT', userReadOnly: true, definerAppend: { functions: [] } })).toThrow(/definerAppend/);
  });
});
