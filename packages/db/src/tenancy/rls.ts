import type pg from 'pg';
import type { GlobalTable, TenantRegistry, TenantTable } from './registry';

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
const APP_ROLES = 'public, app_user, app_system, app_public';

/** Functions the generator owns. The guard rejects any other function an app role can execute. */
export const HELPER_FUNCTIONS = ['app_agency', 'app_user_id'] as const;

export type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export type AppRole = 'app_user' | 'app_system' | 'app_public';

const DML: Privilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/** Exact table privileges per app role; anything else (TRUNCATE, column grants, …) fails the guard. */
export function expectedPrivileges(def: TenantTable | GlobalTable): Record<AppRole, Privilege[]> {
  if (!('kind' in def)) {
    return { app_user: ['SELECT'], app_system: DML, app_public: def.publicRead ? ['SELECT'] : [] };
  }
  const user: Privilege[] = def.appendOnly ? ['INSERT'] : DML;
  return { app_user: user, app_system: DML, app_public: def.kind === 'PUBLIC_READ' ? ['SELECT'] : [] };
}

export interface PolicySpec {
  name: string;
  /** pg_policies.cmd */
  cmd: 'ALL' | 'SELECT' | 'INSERT';
  roles: string[];
}

/** Policies a registered table must have — exactly these (name, command, roles), and no others. */
export function expectedPolicies(def: TenantTable | GlobalTable): PolicySpec[] {
  if (!('kind' in def)) {
    return [{ name: 'global_read', cmd: 'SELECT', roles: def.publicRead ? ['app_public', 'app_user'] : ['app_user'] }];
  }
  const out: PolicySpec[] = [{ name: 'own_rows', cmd: def.appendOnly ? 'INSERT' : 'ALL', roles: ['app_user'] }];
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

/** Helper functions used by policies. `security invoker`, read only the transaction-local settings. */
export function helperSql(): string {
  return [
    `create or replace function app_agency() returns uuid language sql stable parallel safe
  as $$ select nullif(current_setting('app.agency_id', true), '')::uuid $$;`,
    `create or replace function app_user_id() returns uuid language sql stable parallel safe
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;`,
    `revoke all on function app_agency(), app_user_id() from public;`,
    `grant execute on function app_agency(), app_user_id() to app_user, app_system, app_public;`,
  ].join('\n');
}

function tenantTableSql(name: string, def: TenantTable): string[] {
  const t = ident(name);
  if (def.appendOnly && def.kind !== 'STRICT') throw new Error(`${name}: appendOnly is only valid for STRICT tables`);
  const out = [
    def.appendOnly
      ? `create policy own_rows on ${t} for insert to app_user
  with check (agency_id = app_agency());`
      : `create policy own_rows on ${t} to app_user
  using (agency_id = app_agency()) with check (agency_id = app_agency());`,
  ];
  if (def.kind === 'NETWORK_READ') {
    // Only a tenant reads the network: a connection with no agency set sees nothing at all.
    out.push(`create policy network_read on ${t} for select to app_user
  using (app_agency() is not null and (${predicate(name, def.networkReadSql)}));`);
  }
  if (def.kind === 'PUBLIC_READ') {
    out.push(`create policy public_read on ${t} for select to app_public
  using (${predicate(name, def.publicReadSql)});`);
  }
  out.push(
    `revoke all on table ${t} from ${APP_ROLES};`,
    def.appendOnly
      ? `grant insert on table ${t} to app_user;
grant select, insert, update, delete on table ${t} to app_system;`
      : `grant select, insert, update, delete on table ${t} to app_user, app_system;`,
  );
  if (def.kind === 'PUBLIC_READ') out.push(`grant select on table ${t} to app_public;`);
  return out;
}

function globalTableSql(name: string, def: GlobalTable): string[] {
  const t = ident(name);
  const readers = def.publicRead ? 'app_user, app_public' : 'app_user';
  return [
    `create policy global_read on ${t} for select to ${readers} using (true);`,
    `revoke all on table ${t} from ${APP_ROLES};`,
    `grant select on table ${t} to ${readers};`,
    `grant select, insert, update, delete on table ${t} to app_system;`,
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
