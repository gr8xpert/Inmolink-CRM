import { PLATFORM_AGENCY_ID } from '@inmolink/platform/tenancy';
import type pg from 'pg';
import type { AuthAccess, GlobalTable, StaffAccess, TenantRegistry, TenantTable } from './registry';

/**
 * RLS generator (PATTERNS §2). Turns the tenant registry into idempotent SQL: helper functions,
 * forced RLS, policies and per-table grants. `pnpm db:rls` writes it to `rls/policies.sql` and
 * applies it as `app_owner`; never hand-edit the output.
 *
 * Grants come only from here (bootstrap sets no default DML privileges), so a table missing from
 * the registry is unreachable for the app roles — access fails closed. Grants to PUBLIC are revoked too.
 *
 * Forced RLS also binds `app_owner` (no policy): data backfills in migrations affect 0 rows. Backfill
 * in a worker via `withSystem()` instead.
 */

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const APP_ROLES = 'public, app_user, app_system, app_public, app_auth, app_staff';

/** Functions the generator owns. The guard rejects any other function an app role can execute. */
export const HELPER_FUNCTIONS = [
  'app_agency',
  'app_user_id',
  'app_impersonated_by',
  'app_is_staff',
  'app_agency_verified',
  'app_preferring_agencies',
  'app_partition_maintenance',
] as const;

export type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export type AppRole = 'app_user' | 'app_system' | 'app_public' | 'app_auth' | 'app_staff';
export const APP_ROLE_NAMES: readonly AppRole[] = ['app_user', 'app_system', 'app_public', 'app_auth', 'app_staff'];

const DML: Privilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
/** `immutable` tables (S1-08): read and append, never change or remove. */
const APPEND_READ: Privilege[] = ['SELECT', 'INSERT'];

/** `auth` predicates start with `agency_id = app_agency()` or `user_id` / `staff_user_id = app_user_id()` (S1-09), then only `and …`. */
const AUTH_PIN = /^(agency_id = app_agency\(\)|(?:staff_)?user_id = app_user_id\(\))(\s+and\s+[\s\S]+)?$/;

function assertValid(name: string, def: TenantTable | GlobalTable): void {
  if ('kind' in def) {
    if (def.appendOnly && def.kind !== 'STRICT') throw new Error(`${name}: appendOnly is only valid for STRICT tables`);
    if (def.authAppend && !def.appendOnly) throw new Error(`${name}: authAppend is only valid for appendOnly tables`);
    if (def.userSelect) {
      if (def.kind !== 'STRICT') throw new Error(`${name}: userSelect is only valid for STRICT tables`);
      if (def.appendOnly || def.immutable) {
        throw new Error(`${name}: userSelect is not valid for appendOnly or immutable tables`);
      }
      for (const c of def.userSelect.hiddenColumns ?? []) {
        if (!IDENT.test(c) || c === 'agency_id') throw new Error(`${name}: "${c}" cannot be a hidden column`);
      }
    }
    if (def.userInsert !== undefined && !def.immutable)
      throw new Error(`${name}: userInsert is only valid for immutable tables`);
    if (def.immutable && (def.auth?.update !== undefined || def.staff?.update !== undefined)) {
      throw new Error(`${name}: an immutable table cannot open UPDATE to app_auth or app_staff`);
    }
    if (
      def.authAppend &&
      (!IDENT.test(def.authAppend.column) || !/^[a-z][a-zA-Z0-9]*\.$/.test(def.authAppend.prefix))
    ) {
      throw new Error(`${name}: authAppend needs a column name and a prefix like 'identity.'`);
    }
    if (def.auth) {
      if (def.appendOnly) throw new Error(`${name}: auth access is not valid for appendOnly tables`);
      for (const [cmd, sql] of Object.entries(def.auth) as [keyof AuthAccess, string][]) {
        // Pinned: the predicate starts with the scope equality and only narrows it with `and`.
        if (!AUTH_PIN.test(sql.trim()) || /\bor\b/i.test(sql)) {
          throw new Error(`${name}: auth.${cmd} must pin rows to app_agency() or app_user_id()`);
        }
      }
    }
  } else {
    if (def.access && def.publicRead) throw new Error(`${name}: an ${def.access} table cannot be publicRead`);
    if (def.staffWrite && def.access) throw new Error(`${name}: an ${def.access} table cannot be staffWrite`);
    if (def.userScoped && def.access !== 'auth') throw new Error(`${name}: userScoped is only valid for auth tables`);
  }
}

/** Exact table privileges per app role; anything else (TRUNCATE, column grants, …) fails the guard. */
export function expectedPrivileges(def: TenantTable | GlobalTable): Record<AppRole, Privilege[]> {
  if (!('kind' in def)) {
    if (def.access === 'auth')
      return { app_user: [], app_system: DML, app_public: [], app_auth: ['SELECT', 'INSERT', 'UPDATE'], app_staff: [] };
    if (def.access === 'staff')
      return { app_user: [], app_system: DML, app_public: [], app_auth: ['SELECT'], app_staff: ['SELECT'] };
    return {
      app_user: ['SELECT'],
      app_system: DML,
      app_public: def.publicRead ? ['SELECT'] : [],
      app_auth: [],
      app_staff: def.staffWrite ? DML : [],
    };
  }
  const user: Privilege[] = def.appendOnly ? ['INSERT'] : def.immutable ? APPEND_READ : DML;
  return {
    app_user: user,
    app_system: def.immutable ? APPEND_READ : DML,
    app_public: def.kind === 'PUBLIC_READ' ? ['SELECT'] : [],
    app_auth: def.authAppend ? ['INSERT'] : authPrivileges(def.auth),
    app_staff: authPrivileges(def.staff),
  };
}

const AUTH_COMMANDS = [
  ['select', 'SELECT'],
  ['insert', 'INSERT'],
  ['update', 'UPDATE'],
] as const satisfies readonly (readonly [keyof AuthAccess, Privilege])[];

function grantList(privileges: Privilege[]): string {
  return privileges.join(', ').toLowerCase();
}

function authPrivileges(auth: AuthAccess | StaffAccess | undefined): Privilege[] {
  return AUTH_COMMANDS.filter(([key]) => auth?.[key] !== undefined).map(([, priv]) => priv);
}

export interface PolicySpec {
  name: string;
  /** pg_policies.cmd */
  cmd: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  roles: string[];
}

/** Policies a registered table must have — exactly these (name, command, roles), and no others. */
export function expectedPolicies(def: TenantTable | GlobalTable): PolicySpec[] {
  if (!('kind' in def)) {
    if (def.access === 'auth') return [{ name: 'auth_rows', cmd: 'ALL', roles: ['app_auth'] }];
    if (def.access === 'staff') {
      return [
        { name: 'auth_self', cmd: 'SELECT', roles: ['app_auth'] },
        { name: 'staff_self', cmd: 'SELECT', roles: ['app_staff'] },
      ];
    }
    const read: PolicySpec = {
      name: 'global_read',
      cmd: 'SELECT',
      roles: def.publicRead ? ['app_public', 'app_user'] : ['app_user'],
    };
    if (!def.staffWrite) return [read];
    return [
      read,
      { name: 'staff_select', cmd: 'SELECT', roles: ['app_staff'] },
      { name: 'staff_insert', cmd: 'INSERT', roles: ['app_staff'] },
      { name: 'staff_update', cmd: 'UPDATE', roles: ['app_staff'] },
      { name: 'staff_delete', cmd: 'DELETE', roles: ['app_staff'] },
    ];
  }
  const out: PolicySpec[] = def.userSelect
    ? [
        { name: 'own_insert', cmd: 'INSERT', roles: ['app_user'] },
        { name: 'own_update', cmd: 'UPDATE', roles: ['app_user'] },
        { name: 'own_delete', cmd: 'DELETE', roles: ['app_user'] },
        { name: 'user_select', cmd: 'SELECT', roles: ['app_user'] },
      ]
    : [{ name: 'own_rows', cmd: def.appendOnly ? 'INSERT' : 'ALL', roles: ['app_user'] }];
  if (def.authAppend) out.push({ name: 'auth_append', cmd: 'INSERT', roles: ['app_auth'] });
  for (const [key, cmd] of AUTH_COMMANDS) {
    if (def.auth?.[key] !== undefined) out.push({ name: `auth_${key}`, cmd, roles: ['app_auth'] });
  }
  for (const [key, cmd] of AUTH_COMMANDS) {
    if (def.staff?.[key] !== undefined) out.push({ name: `staff_${key}`, cmd, roles: ['app_staff'] });
  }
  if (def.kind === 'NETWORK_READ') out.push({ name: 'network_read', cmd: 'SELECT', roles: ['app_user'] });
  if (def.kind === 'PUBLIC_READ') out.push({ name: 'public_read', cmd: 'SELECT', roles: ['app_public'] });
  return out;
}

function predicate(table: string, sql: string): string {
  const trimmed = sql.trim();
  if (trimmed === '') throw new Error(`registry: ${table} has an empty read predicate`);
  // Predicates are trusted source, but a `;` or comment would smuggle statements into the generated file.
  if (/;|--|\/\*/.test(trimmed)) throw new Error(`registry: ${table} predicate must be a single expression`);
  return trimmed.replace(/\s+/g, ' ');
}

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`registry: "${name}" is not a valid snake_case table name`);
  // Schema-qualified: never depends on the applying role's search_path.
  return `public."${name}"`;
}

/**
 * Helper functions used by policies. `security invoker`: `app_agency()` / `app_user_id()` read only the
 * transaction-local settings; `app_is_staff()` reads the caller's own `staff_users` row (policy
 * `staff_self`), so it is true only for `app_staff` acting for an active staff member.
 *
 * S1-07, for NETWORK_READ predicates (executable by `app_user` only):
 * - `app_agency_verified()`: the session's agency is VERIFIED now (its own `agencies` row, `own_rows`).
 *   The generator ANDs every `network_read` policy with `(select public.app_agency_verified())` — an
 *   init plan, evaluated once per statement, that registry predicates cannot weaken (only verified
 *   agencies read the network).
 * - `app_preferring_agencies()`: the agencies that list the session's agency as preferred and are
 *   themselves listed (VERIFIED) in the directory. Listing policies (S3-02) use it as
 *   `share_scope = 'PREFERRED' and agency_id in (select a from public.app_preferring_agencies() a)`:
 *   a set-returning SQL function in FROM is inlined by the planner into a (hashed) semi-join over
 *   `preferred_agencies_preferred_idx`, evaluated once per statement — not a function call per listing
 *   row, as a scalar `app_is_preferred_by(agency_id)` would be. It reads `preferred_agencies` through
 *   that table's own `network_read` policy (rows naming the session's agency), so it needs no SECURITY
 *   DEFINER and tells an agency only who prefers it. No cache: a removal hides the owner's PREFERRED rows
 *   from the next statement on. No `set search_path` (that would stop the inlining): every name in the
 *   body is schema-qualified, and it runs with the caller's own privileges.
 */
export function helperSql(): string {
  return [
    `create or replace function app_agency() returns uuid language sql stable parallel safe
  as $$ select nullif(current_setting('app.agency_id', true), '')::uuid $$;`,
    `create or replace function app_user_id() returns uuid language sql stable parallel safe
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;`,
    // S1-09: the staff member impersonating the session's user (set by `withTenant` after the request ctx
    // checked the open session); `audit_logs` rows of app_user must name exactly this value.
    `create or replace function app_impersonated_by() returns uuid language sql stable parallel safe
  as $$ select nullif(current_setting('app.impersonated_by', true), '')::uuid $$;`,
    `create or replace function app_is_staff() returns boolean language sql stable parallel safe
  as $$ select exists (select 1 from public.staff_users s where s.user_id = app_user_id() and s.deactivated_at is null) $$;`,
    `create or replace function app_agency_verified() returns boolean language sql stable parallel safe
  as $$ select exists (select 1 from public.agencies a where a.agency_id = public.app_agency() and a.status = 'VERIFIED') $$;`,
    // Replaced by app_preferring_agencies() (S1-07 review: a scalar helper is evaluated per row).
    `drop function if exists app_is_preferred_by(uuid);`,
    `create or replace function app_preferring_agencies() returns setof uuid language sql stable parallel safe
  as $$ select p.agency_id from public.preferred_agencies p
      join public.agency_directory d on d.agency_id = p.agency_id and d.listed
     where p.preferred_agency_id = public.app_agency() $$;`,
    // S1-08: pg_partman maintenance (create the months ahead) for `app_system`'s recurring worker job.
    // Owned by app_owner (who owns the partitioned parents), so SECURITY DEFINER with a fixed search_path;
    // it takes no input and only runs partman's maintenance. Partman lives in its own schema (initdb).
    `create or replace function app_partition_maintenance() returns void language plpgsql security definer
  set search_path = pg_catalog, pg_temp set lock_timeout = '5s'
  as $$ begin perform partman.run_maintenance(p_analyze := false, p_jobmon := false); end $$;`,
    `revoke all on function app_agency(), app_user_id(), app_impersonated_by(), app_is_staff(), app_agency_verified(), app_preferring_agencies(), app_partition_maintenance() from public;`,
    `grant execute on function app_agency(), app_user_id() to app_user, app_system, app_public, app_auth, app_staff;`,
    `grant execute on function app_impersonated_by() to app_user;`,
    `grant execute on function app_is_staff() to app_staff;`,
    `grant execute on function app_agency_verified(), app_preferring_agencies() to app_user;`,
    `grant execute on function app_partition_maintenance() to app_system;`,
  ].join('\n');
}

/**
 * `app_user`'s grant. With `userSelect.hiddenColumns` the table-level SELECT becomes a column list of every
 * other column, read from the catalog when the SQL runs (ADR 0016); INSERT, UPDATE and DELETE stay table-wide.
 */
function userGrantSql(t: string, def: TenantTable): string {
  const hidden = def.userSelect?.hiddenColumns ?? [];
  const privileges = expectedPrivileges(def).app_user;
  if (hidden.length === 0) return `grant ${grantList(privileges)} on table ${t} to app_user;`;
  const others = privileges.filter((p) => p !== 'SELECT');
  const literals = hidden.map((c) => `'${c}'`).join(', ');
  return [
    `do $$
declare cols text;
begin
  select string_agg(format('%I', attname), ', ' order by attnum) into cols from pg_attribute
   where attrelid = '${t}'::regclass and attnum > 0 and not attisdropped and attname <> all (array[${literals}]);
  execute format('grant select (%s) on table ${t} to app_user', cols);
end $$;`,
    others.length ? `grant ${grantList(others)} on table ${t} to app_user;` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function tenantTableSql(name: string, def: TenantTable): string[] {
  const t = ident(name);
  assertValid(name, def);
  const out = [
    ...(def.userSelect
      ? [
          // S1-F10: writes stay on the agency's rows; reads are narrowed to what the reading user may see.
          `create policy own_insert on ${t} for insert to app_user
  with check (agency_id = app_agency());`,
          `create policy own_update on ${t} for update to app_user
  using (agency_id = app_agency()) with check (agency_id = app_agency());`,
          `create policy own_delete on ${t} for delete to app_user
  using (agency_id = app_agency());`,
          `create policy user_select on ${t} for select to app_user
  using (agency_id = app_agency() and (${predicate(name, def.userSelect.sql)}));`,
        ]
      : [
          def.appendOnly
            ? `create policy own_rows on ${t} for insert to app_user
  with check (agency_id = app_agency());`
            : def.userInsert !== undefined
              ? `create policy own_rows on ${t} to app_user
  using (agency_id = app_agency()) with check (agency_id = app_agency() and (${predicate(name, def.userInsert)}));`
              : `create policy own_rows on ${t} to app_user
  using (agency_id = app_agency()) with check (agency_id = app_agency());`,
        ]),
  ];
  if (def.kind === 'NETWORK_READ') {
    // Only a tenant reads the network: a connection with no agency set sees nothing at all. Only a
    // verified one (PLAN §3 #3, S1-07): added here, not by the registry, so no predicate can weaken it;
    // as a sub-select it is an init plan, evaluated once per statement rather than per row.
    out.push(`create policy network_read on ${t} for select to app_user
  using (app_agency() is not null and (select public.app_agency_verified()) and (${predicate(name, def.networkReadSql)}));`);
  }
  if (def.kind === 'PUBLIC_READ') {
    out.push(`create policy public_read on ${t} for select to app_public
  using (${predicate(name, def.publicReadSql)});`);
  }
  out.push(
    `revoke all on table ${t} from ${APP_ROLES};`,
    userGrantSql(t, def),
    `grant ${grantList(expectedPrivileges(def).app_system)} on table ${t} to app_system;`,
  );
  if (def.kind === 'PUBLIC_READ') out.push(`grant select on table ${t} to app_public;`);
  if (def.authAppend) {
    // Anonymous auth flows have no tenant: they may only append their own module's platform rows.
    const { column, prefix } = def.authAppend;
    out.push(
      `create policy auth_append on ${t} for insert to app_auth
  with check (agency_id = '${PLATFORM_AGENCY_ID}'::uuid and starts_with("${column}", '${prefix}'));`,
      `grant insert on table ${t} to app_auth;`,
    );
  }
  if (def.auth) {
    // Sign-up and token minting have no tenant session: rows are pinned to the scope the flow set.
    const { select, insert, update } = def.auth;
    if (select !== undefined) {
      out.push(`create policy auth_select on ${t} for select to app_auth
  using (${predicate(name, select)});`);
    }
    if (insert !== undefined) {
      out.push(`create policy auth_insert on ${t} for insert to app_auth
  with check (${predicate(name, insert)});`);
    }
    if (update !== undefined) {
      out.push(`create policy auth_update on ${t} for update to app_auth
  using (${predicate(name, update)}) with check (${predicate(name, update)});`);
    }
    out.push(`grant ${authPrivileges(def.auth).join(', ').toLowerCase()} on table ${t} to app_auth;`);
  }
  if (def.staff) {
    // Staff work across tenants, but only as an active staff member (`app_is_staff()`), never DELETE.
    const { select, insert, update } = def.staff;
    const gated = (p: string) => `app_is_staff() and (${predicate(name, p)})`;
    if (select !== undefined) {
      out.push(`create policy staff_select on ${t} for select to app_staff
  using (${gated(select)});`);
    }
    if (insert !== undefined) {
      out.push(`create policy staff_insert on ${t} for insert to app_staff
  with check (${gated(insert)});`);
    }
    if (update !== undefined) {
      out.push(`create policy staff_update on ${t} for update to app_staff
  using (${gated(update)}) with check (${gated(update)});`);
    }
    out.push(`grant ${authPrivileges(def.staff).join(', ').toLowerCase()} on table ${t} to app_staff;`);
  }
  return out;
}

function globalTableSql(name: string, def: GlobalTable): string[] {
  const t = ident(name);
  assertValid(name, def);
  if (def.access === 'auth') {
    // userScoped: the table needs a `user_id`; app_auth sees and writes only the scoped user's rows.
    const rows = def.userScoped ? 'user_id = app_user_id()' : 'true';
    return [
      `create policy auth_rows on ${t} to app_auth using (${rows}) with check (${rows});`,
      `revoke all on table ${t} from ${APP_ROLES};`,
      `grant select, insert, update on table ${t} to app_auth;`,
      `grant select, insert, update, delete on table ${t} to app_system;`,
    ];
  }
  if (def.access === 'staff') {
    // The table needs a `user_id`; app_staff sees only the staff member it acts for, and app_auth only
    // the user its flow is scoped to (`setAuthScope`) — the token mint requires 2FA for staff (S1-04).
    return [
      `create policy auth_self on ${t} for select to app_auth using (user_id = app_user_id());`,
      `create policy staff_self on ${t} for select to app_staff using (user_id = app_user_id());`,
      `revoke all on table ${t} from ${APP_ROLES};`,
      `grant select on table ${t} to app_auth, app_staff;`,
      `grant select, insert, update, delete on table ${t} to app_system;`,
    ];
  }
  const readers = def.publicRead ? 'app_user, app_public' : 'app_user';
  const staffWrite = def.staffWrite
    ? [
        // Reference data edited by the staff console (S2-04): any active staff member at the database level;
        // which staff role may write is the service's policy (`staff.taxonomy.write`).
        `create policy staff_select on ${t} for select to app_staff using (app_is_staff());`,
        `create policy staff_insert on ${t} for insert to app_staff with check (app_is_staff());`,
        `create policy staff_update on ${t} for update to app_staff using (app_is_staff()) with check (app_is_staff());`,
        `create policy staff_delete on ${t} for delete to app_staff using (app_is_staff());`,
        `grant select, insert, update, delete on table ${t} to app_staff;`,
      ]
    : [];
  return [
    `create policy global_read on ${t} for select to ${readers} using (true);`,
    `revoke all on table ${t} from ${APP_ROLES};`,
    `grant select on table ${t} to ${readers};`,
    `grant select, insert, update, delete on table ${t} to app_system;`,
    ...staffWrite,
  ];
}

/** Per-table SQL for the given registry: force RLS, replace every policy, reset grants. */
export function tablesSql(registry: TenantRegistry): string {
  const names = [...Object.keys(registry.tenant), ...Object.keys(registry.global)].sort();
  if (names.length === 0) return '-- no registered tables';
  for (const name of names) ident(name);

  const blocks = [
    // Drop every existing policy first: a hand-added permissive policy would widen access (policies OR together).
    `do $$
declare p record;
begin
  for p in select tablename, policyname from pg_policies
            where schemaname = 'public' and tablename = any (array[${names.map((n) => `'${n}'`).join(', ')}])
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;`,
  ];
  for (const name of names) {
    const tenant = registry.tenant[name];
    const global = registry.global[name];
    const body = tenant ? tenantTableSql(name, tenant) : globalTableSql(name, global as GlobalTable);
    blocks.push(
      [
        `-- ${name}: ${tenant ? tenant.kind : 'GLOBAL'}`,
        `alter table ${ident(name)} enable row level security;`,
        `alter table ${ident(name)} force row level security;`,
        ...body,
      ].join('\n'),
    );
  }
  return blocks.join('\n\n');
}

/** The full generated file. */
export function generateRlsSql(registry: TenantRegistry): string {
  return [
    '-- GENERATED by `pnpm db:rls` from packages/db/src/tenancy/registry.ts. Do not edit.',
    '',
    helperSql(),
    '',
    tablesSql(registry),
    '',
  ].join('\n');
}

/** Applies generated SQL in one transaction (no window where a table has RLS on but no policies). */
export async function applyRls(client: pg.ClientBase, sql: string): Promise<void> {
  await client.query('begin');
  try {
    // ALTER TABLE / CREATE POLICY take ACCESS EXCLUSIVE locks: give up quickly rather than queue
    // behind a long read and block live traffic. A failed run changes nothing; rerun it.
    await client.query(`set local lock_timeout = '5s'`);
    await client.query(sql);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}
