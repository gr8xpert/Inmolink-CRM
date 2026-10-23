import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { GlobalTable, TenantRegistry, TenantTable } from './registry';
import {
  APP_ROLE_NAMES,
  type AppRole,
  DEFINER_VIEWS,
  expectedPolicies,
  expectedPrivileges,
  HELPER_FUNCTIONS,
  hiddenColumnsOf,
  publicHiddenColumnsOf,
} from './rls';

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
  /** The relation's owner role. */
  owner: string;
  agency_type: string | null;
  agency_not_null: boolean | null;
  /** "role:PRIV" for every privilege an app role holds. */
  grants: string[];
}

const RELATIONS_SQL = `
select n.nspname as schema, c.relname as name, c.relkind as kind, c.relispartition as partition,
       c.relrowsecurity as rls, c.relforcerowsecurity as forced,
       coalesce('security_invoker=true' = any (c.reloptions), false) as security_invoker,
       pg_get_userbyid(c.relowner) as owner,
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

/**
 * Policy predicates and helper bodies, as the catalog holds them (S1-07: closes the S0-05 audit gap before
 * the first NETWORK_READ table). Names, commands and roles are compared above; the predicate text and the
 * helper bodies are compared with a fingerprint `pnpm db:rls` records right after applying the generated
 * SQL. A hand-edited policy (`alter policy … using (true)`) or helper body no longer matches it. Trigger
 * definitions and their functions' bodies (guard triggers, the directory sync) are part of it too: a
 * hand-edited guard fails the guard until a migration changes it and `pnpm db:rls` runs (deploy order).
 */
const CATALOG_SQL = `
select coalesce(string_agg(x, E'\\n' order by x), '') as catalog from (
  select format('policy %s.%s %s %s %s using(%s) check(%s)', tablename, policyname, cmd, permissive,
                roles::text, coalesce(qual, ''), coalesce(with_check, '')) as x
    from pg_policies where schemaname = 'public'
  union all
  select 'function ' || pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = any($1::text[])
  union all
  select format('view %s %s %s', c.relname, coalesce(c.reloptions::text, ''), pg_get_viewdef(c.oid))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v' and c.relname = any($2::text[])
  union all
  select format('trigger %s %s %s', pg_get_triggerdef(t.oid), t.tgenabled, pg_get_functiondef(t.tgfoid))
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal and t.tgparentid = 0
) s`;

/**
 * Non-constraint triggers on public tables, with their state (`D` = disabled). Clones of a partitioned
 * parent's row triggers on its partitions (`tgparentid`, S1-08) are left out: partman adds partitions
 * every month, and the parent's trigger is what the registry lists.
 */
const TRIGGERS_SQL = `
select c.relname as table, t.tgname as name, t.tgenabled::text as enabled
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal and t.tgparentid = 0`;

/** Where `pnpm db:rls` keeps the fingerprint (the SQL stamp lives on `app_agency()`). */
export const CATALOG_STAMP_FUNCTION = 'public.app_user_id()';
const CATALOG_STAMP_SQL = `select obj_description(to_regprocedure('${CATALOG_STAMP_FUNCTION}'), 'pg_proc') as stamp`;

/** Fingerprint of every public policy's predicates and the generated helpers' definitions. */
export async function rlsCatalogStamp(client: pg.ClientBase): Promise<string> {
  const { rows } = await client.query<{ catalog: string }>(CATALOG_SQL, [[...HELPER_FUNCTIONS], [...DEFINER_VIEWS]]);
  return `rls catalog sha256:${createHash('sha256')
    .update(rows[0]?.catalog ?? '')
    .digest('hex')}`;
}

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
  // One after another: a pg client runs one query at a time (queuing them is deprecated in pg 9).
  const relations = await client.query<RelationRow>(RELATIONS_SQL);
  const policies = await client.query<{
    table: string;
    name: string;
    cmd: string;
    permissive: string;
    roles: string[];
  }>(POLICIES_SQL);
  const functions = await client.query<{ schema: string; name: string; definer: boolean; executable: boolean }>(
    FUNCTIONS_SQL,
  );
  const policiesOf = new Map<string, (typeof policies.rows)[number][]>();
  for (const p of policies.rows) policiesOf.set(p.table, [...(policiesOf.get(p.table) ?? []), p]);

  const problems: string[] = [];
  const seen = new Set<string>();
  const seenViews = new Set<string>();
  for (const t of relations.rows) {
    const label = t.schema === 'public' ? t.name : `${t.schema}.${t.name}`;
    const accessible = t.grants.length > 0;
    if (t.schema !== 'public' || !['r', 'p'].includes(t.kind)) {
      // S7-F10: a generated definer view (its body is in the catalog stamp) is read by app_public alone.
      if (t.schema === 'public' && t.kind === 'v' && (DEFINER_VIEWS as readonly string[]).includes(t.name)) {
        seenViews.add(t.name);
        if (t.grants.join(',') !== 'app_public:SELECT') {
          problems.push(`${t.name}: a definer view must grant SELECT to app_public only (run pnpm db:rls)`);
        }
        // It reads as its owner: only app_owner's `definer_read` policy may be what it reads through.
        if (t.owner !== 'app_owner')
          problems.push(`${t.name}: a definer view must be owned by app_owner (run pnpm db:rls)`);
        continue;
      }
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
    // S1-08: a partitioned parent is registered as such (its partitions are checked above).
    const partitioned = 'kind' in def && def.partitioned === true;
    if (partitioned !== (t.kind === 'p')) {
      problems.push(
        partitioned
          ? `${t.name}: registered as partitioned but is not`
          : `${t.name}: partitioned but not registered so`,
      );
    }
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
  for (const name of DEFINER_VIEWS) {
    if (!seenViews.has(name)) problems.push(`${name}: generated view is missing (run pnpm db:rls)`);
  }

  const helpers = new Set<string>(HELPER_FUNCTIONS);
  for (const f of functions.rows) {
    const label = f.schema === 'public' ? f.name : `${f.schema}.${f.name}`;
    const ours = f.schema === 'public' && helpers.has(f.name);
    if (f.executable && !ours) problems.push(`${label}(): executable by an app role but not a generated helper`);
    if (f.definer && !ours) problems.push(`${label}(): SECURITY DEFINER outside the generated helpers`);
  }

  // Guard triggers carry the rules RLS cannot express (S1-07 review): each registered one must exist and
  // fire; a trigger the registry does not list is unexpected.
  const triggers = await client.query<{ table: string; name: string; enabled: string }>(TRIGGERS_SQL);
  for (const name of seen) {
    const { tenant, global } = lookup(registry, name);
    const def = tenant ?? global;
    if (!def) continue;
    const want = 'kind' in def ? (def.triggers ?? []) : [];
    const have = triggers.rows.filter((t) => t.table === name);
    for (const trigger of want) {
      const found = have.find((t) => t.name === trigger);
      if (!found) problems.push(`${name}: missing trigger ${trigger} (run pnpm db:migrate)`);
      else if (found.enabled === 'D') problems.push(`${name}: trigger ${trigger} is disabled`);
    }
    for (const t of have) {
      if (!want.includes(t.name)) problems.push(`${name}: unexpected trigger ${t.name}`);
    }
  }

  // S1-F10, S5-05: a table with `userSelect` or `hiddenColumns` grants app_user SELECT on every column except the
  // hidden ones; S6-F1: a PUBLIC_READ table with `hiddenColumns` does the same for app_public.
  for (const [name, def] of Object.entries(registry.tenant)) {
    if (!seen.has(name)) continue;
    const checks: [AppRole, readonly string[]][] = [];
    const hidden = hiddenColumnsOf(def);
    if (def.userSelect || hidden.length > 0) checks.push(['app_user', hidden]);
    const publicHidden = publicHiddenColumnsOf(def);
    if (publicHidden.length > 0) checks.push(['app_public', publicHidden]);
    for (const [role, columns] of checks) {
      const cols = await client.query<{ column: string; readable: boolean }>(
        `select a.attname as column, has_column_privilege($2, c.oid, a.attnum, 'SELECT') as readable
           from pg_attribute a join pg_class c on c.oid = a.attrelid
          where c.oid = $1::regclass and a.attnum > 0 and not a.attisdropped`,
        [`public."${name}"`, role],
      );
      for (const c of cols.rows) {
        if (columns.includes(c.column) && c.readable)
          problems.push(`${name}: ${role} can read hidden column ${c.column}`);
        if (!columns.includes(c.column) && !c.readable) {
          problems.push(`${name}: ${role} cannot read column ${c.column} (run pnpm db:rls)`);
        }
      }
    }
  }

  // S8-F26: app_user may not UPDATE the registry's `userNoUpdateColumns`, and may UPDATE every other column.
  for (const [name, def] of Object.entries(registry.tenant)) {
    if (!seen.has(name) || !def.userNoUpdateColumns?.length) continue;
    for (const priv of ['UPDATE'] as const) {
      const cols = await client.query<{ column: string; granted: boolean }>(
        `select a.attname as column, has_column_privilege('app_user', c.oid, a.attnum, $2) as granted
           from pg_attribute a join pg_class c on c.oid = a.attrelid
          where c.oid = $1::regclass and a.attnum > 0 and not a.attisdropped`,
        [`public."${name}"`, priv],
      );
      for (const c of cols.rows) {
        const locked = def.userNoUpdateColumns.includes(c.column);
        if (locked && c.granted) problems.push(`${name}: app_user can ${priv.toLowerCase()} locked column ${c.column}`);
        if (!locked && !c.granted) {
          problems.push(`${name}: app_user cannot ${priv.toLowerCase()} column ${c.column} (run pnpm db:rls)`);
        }
      }
    }
  }

  // S6-08: staff column allowlists — app_staff reads and writes exactly the listed columns.
  for (const [name, def] of Object.entries(registry.tenant)) {
    if (!seen.has(name) || !def.staff) continue;
    const lists: ['SELECT' | 'UPDATE', readonly string[] | undefined][] = [
      ['SELECT', def.staff.selectColumns],
      ['UPDATE', def.staff.updateColumns],
    ];
    for (const [priv, allowed] of lists) {
      if (!allowed) continue;
      const cols = await client.query<{ column: string; granted: boolean }>(
        `select a.attname as column, has_column_privilege('app_staff', c.oid, a.attnum, $2) as granted
           from pg_attribute a join pg_class c on c.oid = a.attrelid
          where c.oid = $1::regclass and a.attnum > 0 and not a.attisdropped`,
        [`public."${name}"`, priv],
      );
      for (const c of cols.rows) {
        if (!allowed.includes(c.column) && c.granted) problems.push(`${name}: app_staff has ${priv} on ${c.column}`);
        if (allowed.includes(c.column) && !c.granted) {
          problems.push(`${name}: app_staff lacks ${priv} on ${c.column} (run pnpm db:rls)`);
        }
      }
    }
  }

  // S7-05: website form intake reads back exactly its listed columns (never a lead's client details).
  for (const [name, def] of Object.entries(registry.tenant)) {
    if (!seen.has(name) || !def.intake) continue;
    const allowed = def.intake.selectColumns;
    const cols = await client.query<{ column: string; granted: boolean }>(
      `select a.attname as column, has_column_privilege('app_intake', c.oid, a.attnum, 'SELECT') as granted
         from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.oid = $1::regclass and a.attnum > 0 and not a.attisdropped`,
      [`public."${name}"`],
    );
    for (const c of cols.rows) {
      if (!allowed.includes(c.column) && c.granted) problems.push(`${name}: app_intake can read ${c.column}`);
      if (allowed.includes(c.column) && !c.granted) {
        problems.push(`${name}: app_intake cannot read ${c.column} (run pnpm db:rls)`);
      }
    }
  }

  const recorded = (await client.query<{ stamp: string | null }>(CATALOG_STAMP_SQL)).rows[0]?.stamp ?? null;
  if (recorded !== (await rlsCatalogStamp(client))) {
    problems.push(
      'app_user_id(): policy predicates, helper bodies or triggers differ from the last pnpm db:rls (run it again)',
    );
  }
  return [...new Set(problems)].sort();
}
