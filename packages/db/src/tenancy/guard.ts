import type pg from 'pg';
import type { GlobalTable, TenantRegistry, TenantTable } from './registry';
import { APP_ROLE_NAMES, expectedPolicies, expectedPrivileges, HELPER_FUNCTIONS } from './rls';

/**
 * RLS guard (CI): compares the database with the tenant registry. Returns one message per problem,
 * empty when it matches. Run by `pnpm db:rls` and `pnpm test:isolation`. Extension-owned objects
 * (PostGIS `spatial_ref_sys`, its views and functions) are skipped.
 */

const ROLES = APP_ROLE_NAMES;
const ROLES_SQL = `array[${ROLES.map((r) => `'${r}'`).join(', ')}]`;
/** Column-capable privileges go through has_any_column_privilege, so column-level grants count too. */
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

const NOT_EXTENSION = (cls: string, alias: string) =>
  `not exists (select 1 from pg_depend d where d.classid = '${cls}'::regclass and d.objid = ${alias}.oid and d.deptype = 'e')`;

interface RelationRow {
  schema: string;
  name: string;
  kind: string;
  partition: boolean;
  rls: boolean;
  forced: boolean;
  security_invoker: boolean;
  agency_type: string | null;
  agency_not_null: boolean | null;
  /** "role:PRIV" for every privilege an app role holds. */
  grants: string[];
}

const RELATIONS_SQL = `
select n.nspname as schema, c.relname as name, c.relkind as kind, c.relispartition as partition,
       c.relrowsecurity as rls, c.relforcerowsecurity as forced,
       coalesce('security_invoker=true' = any (c.reloptions), false) as security_invoker,
       format_type(a.atttypid, a.atttypmod) as agency_type, a.attnotnull as agency_not_null,
       array(select r || ':' || p
               from unnest(${ROLES_SQL}) r,
                    unnest(array[${PRIVILEGES.map((p) => `'${p}'`).join(', ')}]) p
              where case when p in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                         then has_any_column_privilege(r, c.oid, p)
                         else has_table_privilege(r, c.oid, p) end) as grants
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attribute a on a.attrelid = c.oid and a.attname = 'agency_id' and not a.attisdropped
 where c.relkind in ('r', 'p', 'v', 'm', 'f')
   and n.nspname <> all (array[${SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(', ')}])
   and ${NOT_EXTENSION('pg_class', 'c')}`;

const POLICIES_SQL = `
select tablename as table, policyname as name, cmd, permissive, roles::text[] as roles
  from pg_policies where schemaname = 'public'`;

const FUNCTIONS_SQL = `
select n.nspname as schema, p.proname as name, p.prosecdef as definer,
       exists (select 1 from unnest(${ROLES_SQL}) r where has_function_privilege(r, p.oid, 'EXECUTE')) as executable
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname <> all (array[${SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(', ')}])
   and ${NOT_EXTENSION('pg_proc', 'p')}`;

function lookup(registry: TenantRegistry, name: string): { tenant?: TenantTable; global?: GlobalTable } {
  return {
    tenant: Object.hasOwn(registry.tenant, name) ? registry.tenant[name] : undefined,
    global: Object.hasOwn(registry.global, name) ? registry.global[name] : undefined,
  };
}

function checkPrivileges(name: string, grants: string[], def: TenantTable | GlobalTable, problems: string[]) {
  const want = expectedPrivileges(def);
  for (const role of ROLES) {
    const have = grants.filter((g) => g.startsWith(`${role}:`)).map((g) => g.slice(role.length + 1));
    const missing = want[role].filter((p) => !have.includes(p));
    const extra = have.filter((p) => !(want[role] as string[]).includes(p));
    if (missing.length) problems.push(`${name}: ${role} lacks ${missing.join(', ')} (run pnpm db:rls)`);
    if (extra.length) problems.push(`${name}: ${role} has unexpected ${extra.join(', ')}`);
  }
}

export async function checkRls(client: pg.ClientBase, registry: TenantRegistry): Promise<string[]> {
  const [relations, policies, functions] = await Promise.all([
    client.query<RelationRow>(RELATIONS_SQL),
    client.query<{ table: string; name: string; cmd: string; permissive: string; roles: string[] }>(POLICIES_SQL),
    client.query<{ schema: string; name: string; definer: boolean; executable: boolean }>(FUNCTIONS_SQL),
  ]);
  const policiesOf = new Map<string, (typeof policies.rows)[number][]>();
  for (const p of policies.rows) policiesOf.set(p.table, [...(policiesOf.get(p.table) ?? []), p]);

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const t of relations.rows) {
    const label = t.schema === 'public' ? t.name : `${t.schema}.${t.name}`;
    const accessible = t.grants.length > 0;
    if (t.schema !== 'public' || !['r', 'p'].includes(t.kind)) {
      // Views run as their owner unless security_invoker; materialized views and foreign tables have no RLS.
      const safeView = t.kind === 'v' && t.security_invoker && t.schema === 'public';
      if (accessible && !safeView) problems.push(`${label}: accessible to an app role outside the tenant registry`);
      continue;
    }
    seen.add(t.name);
    if (t.partition) {
      // A partition queried directly skips its parent's policies: reach it only through the parent.
      if (accessible) problems.push(`${t.name}: partition is directly accessible to an app role`);
      continue;
    }
    const { tenant, global } = lookup(registry, t.name);
    const def = tenant ?? global;
    if (!def) {
      problems.push(
        t.agency_type
          ? `${t.name}: has agency_id but is not in the tenant registry`
          : `${t.name}: not in the tenant registry (register it as tenant or global)`,
      );
      continue;
    }
    if (global && t.agency_type) problems.push(`${t.name}: has agency_id but is registered as global`);
    if (tenant && t.agency_type !== 'uuid') problems.push(`${t.name}: tenant table needs an agency_id uuid column`);
    if (tenant && t.agency_type && !t.agency_not_null) problems.push(`${t.name}: agency_id must be NOT NULL`);
    if (!t.rls) problems.push(`${t.name}: row level security is disabled`);
    if (!t.forced) problems.push(`${t.name}: row level security is not forced`);

    const have = policiesOf.get(t.name) ?? [];
    const want = expectedPolicies(def);
    for (const spec of want) {
      const p = have.find((h) => h.name === spec.name);
      if (!p) {
        problems.push(`${t.name}: missing policy ${spec.name}`);
        continue;
      }
      const roles = [...p.roles].sort().join(',');
      if (p.cmd !== spec.cmd || p.permissive !== 'PERMISSIVE' || roles !== [...spec.roles].sort().join(',')) {
        problems.push(`${t.name}: policy ${spec.name} was altered (run pnpm db:rls)`);
      }
    }
    for (const p of have) {
      if (!want.some((w) => w.name === p.name))
        problems.push(`${t.name}: unexpected policy ${p.name} (run pnpm db:rls)`);
    }
    checkPrivileges(t.name, t.grants, def, problems);
  }
  for (const name of [...Object.keys(registry.tenant), ...Object.keys(registry.global)]) {
    if (!seen.has(name)) problems.push(`${name}: registered but the table does not exist`);
  }

  const helpers = new Set<string>(HELPER_FUNCTIONS);
  for (const f of functions.rows) {
    const label = f.schema === 'public' ? f.name : `${f.schema}.${f.name}`;
    const ours = f.schema === 'public' && helpers.has(f.name);
    if (f.executable && !ours) problems.push(`${label}(): executable by an app role but not a generated helper`);
    if (f.definer && !ours) problems.push(`${label}(): SECURITY DEFINER outside the generated helpers`);
  }
  return [...new Set(problems)].sort();
}
