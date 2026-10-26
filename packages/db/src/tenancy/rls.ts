import { PLATFORM_AGENCY_ID } from '@inmolink/platform/tenancy';
import type pg from 'pg';
import type {
  AuthAccess,
  DefinerOp,
  GlobalTable,
  StaffAccess,
  StaffWriteRule,
  TenantRegistry,
  TenantTable,
} from './registry';

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
const APP_ROLES = 'public, app_user, app_system, app_public, app_auth, app_staff, app_media, app_intake';

/** Functions the generator owns. The guard rejects any other function an app role can execute. */
export const HELPER_FUNCTIONS = [
  'app_agency',
  'app_user_id',
  'app_impersonated_by',
  'app_is_staff',
  'app_agency_verified',
  'app_preferring_agencies',
  'app_partition_maintenance',
  'website_network_open',
  'agency_ai_features',
  'legacy_target_ids',
  'legacy_ids_of',
  'portal_feed_by_token',
  'calendar_feed_by_token',
  'calendar_feed_tag',
  'selection_by_token',
] as const;

/**
 * Views the generator owns that run as their owner (`app_owner`), not as the caller (S7-F10). The guard rejects any
 * other view an app role can read unless it is `security_invoker`.
 */
export const DEFINER_VIEWS = ['search_commission_floor'] as const;

/**
 * The transaction's minimum commission (S7-F10). Unset: the cast fails with the setting's name in the message, so a
 * read that forgot `withPublicRead({ minCommissionBp })` errors instead of silently matching nothing.
 */
const COMMISSION_FLOOR =
  "coalesce(nullif(pg_catalog.current_setting('app.search_min_commission_bp', true), ''), 'app.search_min_commission_bp is not set')::integer";

/** Every staff policy's gate (S7-F10): an init plan, once per statement, never a call per row. */
const STAFF_GATE = '(select public.app_is_staff())';

export type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export type AppRole = 'app_user' | 'app_system' | 'app_public' | 'app_auth' | 'app_staff' | 'app_media' | 'app_intake';
export const APP_ROLE_NAMES: readonly AppRole[] = [
  'app_user',
  'app_system',
  'app_public',
  'app_auth',
  'app_staff',
  'app_media',
  'app_intake',
];

const DML: Privilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/** S12-F16: `definerSync` operations and the `app_owner` policy each gets. */
const DEFINER_OPS: readonly DefinerOp[] = ['read', 'append', 'update'];
const DEFINER_POLICY: Record<
  DefinerOp,
  { name: string; cmd: 'SELECT' | 'INSERT' | 'UPDATE'; sql: (t: string) => string }
> = {
  read: {
    name: 'definer_read',
    cmd: 'SELECT',
    sql: (t) => `create policy definer_read on ${t} for select to app_owner using (true);`,
  },
  append: {
    name: 'definer_append',
    cmd: 'INSERT',
    sql: (t) => `create policy definer_append on ${t} for insert to app_owner with check (true);`,
  },
  update: {
    name: 'definer_update',
    cmd: 'UPDATE',
    sql: (t) => `create policy definer_update on ${t} for update to app_owner using (true) with check (true);`,
  },
};
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
    }
    if (def.userNoUpdate) {
      // S13-05: also with `memberWrite` (no `update` predicate) — rows a member appends and never rewrites.
      if (
        (!def.userSelect && !def.memberWrite) ||
        (def.userSelect && def.memberWrite) ||
        def.userNoUpdateColumns?.length ||
        def.userSelect?.write?.update !== undefined ||
        def.memberWrite?.update !== undefined
      ) {
        throw new Error(
          `${name}: userNoUpdate is only valid with userSelect or memberWrite (no update predicate or userNoUpdateColumns)`,
        );
      }
    }
    if (def.userNoDelete) {
      // S13-05: STRICT tables app_user writes but never removes rows from (a support ticket, its conversation).
      if (
        def.kind !== 'STRICT' ||
        def.appendOnly ||
        def.immutable ||
        def.userReadOnly ||
        def.userAppendRead ||
        def.userSelect?.write?.delete !== undefined ||
        def.memberWrite?.delete !== undefined
      ) {
        throw new Error(
          `${name}: userNoDelete is only valid for STRICT tables app_user writes (no delete predicate; appendOnly, immutable, userReadOnly and userAppendRead have no DELETE already)`,
        );
      }
    }
    if (def.userNoInsert) {
      // S13-F3: rows a worker writes that a member reads and may remove (saved-search alerts), never plants.
      if (
        (!def.userSelect && !def.memberWrite) ||
        def.userSelect?.write?.insert !== undefined ||
        def.memberWrite?.insert !== undefined
      ) {
        throw new Error(`${name}: userNoInsert is only valid with userSelect or memberWrite (no insert predicate)`);
      }
    }
    if (def.memberWrite) {
      if (def.kind !== 'STRICT') throw new Error(`${name}: memberWrite is only valid for STRICT tables`);
      if (
        def.appendOnly ||
        def.immutable ||
        def.userSelect ||
        def.userReadOnly ||
        def.userAppendRead ||
        def.userInsert !== undefined
      ) {
        throw new Error(
          `${name}: memberWrite is not valid with appendOnly, immutable, userSelect, userReadOnly, userAppendRead or userInsert`,
        );
      }
      const { insert, update, delete: del } = def.memberWrite;
      if (insert === undefined && update === undefined && del === undefined) {
        throw new Error(`${name}: memberWrite needs at least one write predicate`);
      }
    }
    for (const c of hiddenColumnsOf(def)) {
      if (!IDENT.test(c) || c === 'agency_id') throw new Error(`${name}: "${c}" cannot be a hidden column`);
    }
    for (const c of def.userNoUpdateColumns ?? []) {
      if (!IDENT.test(c) || c === 'agency_id') throw new Error(`${name}: "${c}" cannot be a no-update column`);
    }
    for (const c of def.mediaRead?.columns ?? []) {
      if (!IDENT.test(c)) throw new Error(`${name}: "${c}" is not a column name`);
    }
    if (def.mediaRead && def.mediaRead.columns.length === 0) throw new Error(`${name}: mediaRead needs columns`);
    if (def.intake) {
      if (def.kind !== 'STRICT' || def.appendOnly || def.immutable) {
        throw new Error(`${name}: intake is only valid for plain STRICT tables`);
      }
      if (def.intake.selectColumns.length === 0) throw new Error(`${name}: intake needs selectColumns`);
      for (const c of def.intake.selectColumns) {
        if (!IDENT.test(c)) throw new Error(`${name}: "${c}" is not a column name`);
      }
    }
    if (def.intakeAppend) {
      if (!def.appendOnly) throw new Error(`${name}: intakeAppend is only valid for appendOnly tables`);
      if (!IDENT.test(def.intakeAppend.column) || def.intakeAppend.values.length === 0) {
        throw new Error(`${name}: intakeAppend needs a column name and values`);
      }
      for (const v of def.intakeAppend.values) {
        if (!/^[a-z][a-zA-Z0-9.]*$/.test(v)) throw new Error(`${name}: intakeAppend value "${v}" is not allowed`);
      }
    }
    // S10-F4: also STRICT worker tables (feed runs, push sync state) the dashboard only reads.
    if (def.userReadOnly && def.kind === 'NETWORK_READ') {
      throw new Error(`${name}: userReadOnly is only valid for PUBLIC_READ and STRICT tables`);
    }
    if (def.userReadOnly && (def.appendOnly || def.immutable || def.userSelect || def.userInsert !== undefined)) {
      throw new Error(`${name}: userReadOnly is not valid with appendOnly, immutable, userSelect or userInsert`);
    }
    if (def.userAppendRead) {
      if (def.kind !== 'STRICT') throw new Error(`${name}: userAppendRead is only valid for STRICT tables`);
      if (
        def.appendOnly ||
        def.immutable ||
        def.userReadOnly ||
        def.userSelect ||
        def.userInsert !== undefined ||
        def.userNoUpdateColumns?.length
      ) {
        throw new Error(
          `${name}: userAppendRead is not valid with appendOnly, immutable, userReadOnly, userSelect, userInsert or userNoUpdateColumns`,
        );
      }
    }
    if (def.definerAppend) {
      if (def.kind !== 'STRICT' || !def.userReadOnly) {
        throw new Error(`${name}: definerAppend is only valid for STRICT userReadOnly tables`);
      }
      if (def.definerAppend.functions.length === 0 || def.definerAppend.functions.some((f) => !IDENT.test(f))) {
        throw new Error(`${name}: definerAppend needs function names`);
      }
    }
    if (def.definerSync) {
      if (def.kind !== 'STRICT' || def.userReadOnly || def.appendOnly || def.immutable) {
        throw new Error(`${name}: definerSync is only valid for STRICT tables app_user writes`);
      }
      if (def.definerAppend || def.definerRead) {
        throw new Error(`${name}: definerSync already includes definerRead and definerAppend`);
      }
      if (def.definerSync.functions.length === 0 || def.definerSync.functions.some((f) => !IDENT.test(f))) {
        throw new Error(`${name}: definerSync needs function names`);
      }
      // S12-F16: only the operations the functions use, each named once.
      const ops = def.definerSync.ops;
      if (ops.length === 0 || new Set(ops).size !== ops.length || ops.some((o) => !DEFINER_OPS.includes(o))) {
        throw new Error(`${name}: definerSync needs its operations (read, append, update), each once`);
      }
    }
    if (def.userInsert !== undefined && !def.immutable)
      throw new Error(`${name}: userInsert is only valid for immutable tables`);
    for (const c of [...(def.staff?.selectColumns ?? []), ...(def.staff?.updateColumns ?? [])]) {
      if (!IDENT.test(c)) throw new Error(`${name}: "${c}" is not a column name`);
    }
    if (def.staff?.selectColumns && (def.staff.select === undefined || def.staff.selectColumns.length === 0)) {
      throw new Error(`${name}: staff.selectColumns needs staff.select and at least one column`);
    }
    if (def.staff?.updateColumns && (def.staff.update === undefined || def.staff.updateColumns.length === 0)) {
      throw new Error(`${name}: staff.updateColumns needs staff.update and at least one column`);
    }
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
    if ((def.publicReadSql !== undefined || def.publicSamples) && !(def.publicRead && def.noUserRead)) {
      throw new Error(`${name}: publicReadSql is only valid with publicRead and noUserRead`);
    }
    if (def.staffWrite && def.access) throw new Error(`${name}: an ${def.access} table cannot be staffWrite`);
    if (def.staffRead && (def.access || def.staffWrite)) {
      throw new Error(`${name}: staffRead is not valid with access or staffWrite`);
    }
    if (def.userScoped && def.access !== 'auth') throw new Error(`${name}: userScoped is only valid for auth tables`);
    if (def.mediaWrite && def.access) throw new Error(`${name}: an ${def.access} table cannot be mediaWrite`);
    if (def.noUserRead && def.access) throw new Error(`${name}: noUserRead is not valid for ${def.access} tables`);
  }
}

/** Exact table privileges per app role; anything else (TRUNCATE, column grants, …) fails the guard. */
export function expectedPrivileges(def: TenantTable | GlobalTable): Record<AppRole, Privilege[]> {
  if (!('kind' in def)) {
    if (def.access === 'auth')
      return {
        app_user: [],
        app_system: DML,
        app_public: [],
        app_auth: ['SELECT', 'INSERT', 'UPDATE'],
        app_staff: [],
        app_media: [],
        app_intake: [],
      };
    if (def.access === 'staff')
      return {
        app_user: [],
        app_system: DML,
        app_public: [],
        app_auth: ['SELECT'],
        app_staff: ['SELECT'],
        app_media: [],
        app_intake: [],
      };
    return {
      app_user: def.noUserRead ? [] : ['SELECT'],
      app_system: DML,
      app_public: def.publicRead ? ['SELECT'] : [],
      app_auth: [],
      app_staff: def.staffWrite
        ? staffWriteRule(def)?.noDelete
          ? ['SELECT', 'INSERT', 'UPDATE']
          : DML
        : def.staffRead
          ? ['SELECT']
          : [],
      app_media: def.mediaWrite ? DML : [],
      app_intake: [],
    };
  }
  const granted: Privilege[] = def.userNoUpdate
    ? ['SELECT', 'INSERT', 'DELETE']
    : def.appendOnly
      ? ['INSERT']
      : def.immutable
        ? APPEND_READ
        : def.userReadOnly
          ? ['SELECT']
          : def.userAppendRead
            ? APPEND_READ
            : DML;
  // S13-05: `userNoDelete` drops DELETE from whatever the table grants app_user.
  // S13-F3: `userNoInsert` drops INSERT the same way.
  const user = granted.filter((p) => !(def.userNoDelete && p === 'DELETE') && !(def.userNoInsert && p === 'INSERT'));
  return {
    app_user: user,
    app_system: def.immutable ? APPEND_READ : DML,
    app_public: def.kind === 'PUBLIC_READ' ? ['SELECT'] : [],
    app_auth: def.authAppend ? ['INSERT'] : authPrivileges(def.auth),
    app_staff: authPrivileges(def.staff),
    app_media: def.mediaRead ? ['SELECT'] : [],
    app_intake: def.intake ? ['SELECT', 'INSERT'] : def.intakeAppend ? ['INSERT'] : [],
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
    if (def.access === 'auth') {
      // S10-06: an auth table a definer function reads (`users.status` for the calendar feed) has `definer_read` too.
      const definerAuth: PolicySpec[] = def.definerRead
        ? [{ name: 'definer_read', cmd: 'SELECT', roles: ['app_owner'] }]
        : [];
      return [...definerAuth, { name: 'auth_rows', cmd: 'ALL', roles: ['app_auth'] }];
    }
    if (def.access === 'staff') {
      return [
        { name: 'auth_self', cmd: 'SELECT', roles: ['app_auth'] },
        { name: 'staff_self', cmd: 'SELECT', roles: ['app_staff'] },
      ];
    }
    const readers = [...globalReaders(def)].sort();
    const read: PolicySpec[] = readers.length ? [{ name: 'global_read', cmd: 'SELECT', roles: readers }] : [];
    const media: PolicySpec[] = def.mediaWrite ? [{ name: 'media_rows', cmd: 'ALL', roles: ['app_media'] }] : [];
    const definer: PolicySpec[] = def.definerRead
      ? [{ name: 'definer_read', cmd: 'SELECT', roles: ['app_owner'] }]
      : [];
    if (def.staffRead)
      return [...definer, ...read, ...media, { name: 'staff_select', cmd: 'SELECT', roles: ['app_staff'] }];
    if (!def.staffWrite) return [...definer, ...read, ...media];
    return [
      ...definer,
      ...read,
      ...media,
      { name: 'staff_select', cmd: 'SELECT', roles: ['app_staff'] },
      { name: 'staff_insert', cmd: 'INSERT', roles: ['app_staff'] },
      { name: 'staff_update', cmd: 'UPDATE', roles: ['app_staff'] },
      ...(staffWriteRule(def)?.noDelete
        ? []
        : [{ name: 'staff_delete', cmd: 'DELETE' as const, roles: ['app_staff' as const] }]),
    ];
  }
  const out: PolicySpec[] =
    def.userSelect || def.memberWrite
      ? [
          ...(def.userNoInsert ? [] : [{ name: 'own_insert', cmd: 'INSERT' as const, roles: ['app_user'] }]),
          ...(def.userNoUpdate ? [] : [{ name: 'own_update', cmd: 'UPDATE' as const, roles: ['app_user'] }]),
          ...(def.userNoDelete ? [] : [{ name: 'own_delete', cmd: 'DELETE' as const, roles: ['app_user'] }]),
          { name: def.userSelect ? 'user_select' : 'own_select', cmd: 'SELECT', roles: ['app_user'] },
        ]
      : [
          {
            name: 'own_rows',
            cmd: def.appendOnly ? 'INSERT' : def.userReadOnly ? 'SELECT' : 'ALL',
            roles: ['app_user'],
          },
        ];
  if (def.authAppend) out.push({ name: 'auth_append', cmd: 'INSERT', roles: ['app_auth'] });
  if (def.mediaRead) out.push({ name: 'media_read', cmd: 'SELECT', roles: ['app_media'] });
  if (def.intake) {
    out.push(
      { name: 'intake_insert', cmd: 'INSERT', roles: ['app_intake'] },
      { name: 'intake_select', cmd: 'SELECT', roles: ['app_intake'] },
    );
  }
  if (def.intakeAppend) out.push({ name: 'intake_append', cmd: 'INSERT', roles: ['app_intake'] });
  for (const [key, cmd] of AUTH_COMMANDS) {
    if (def.auth?.[key] !== undefined) out.push({ name: `auth_${key}`, cmd, roles: ['app_auth'] });
  }
  for (const [key, cmd] of AUTH_COMMANDS) {
    if (def.staff?.[key] !== undefined) out.push({ name: `staff_${key}`, cmd, roles: ['app_staff'] });
  }
  if (def.kind === 'NETWORK_READ' || (def.kind === 'PUBLIC_READ' && def.networkReadSql !== undefined)) {
    out.push({ name: 'network_read', cmd: 'SELECT', roles: ['app_user'] });
  }
  if (def.kind === 'PUBLIC_READ') out.push({ name: 'public_read', cmd: 'SELECT', roles: ['app_public'] });
  if (def.definerRead) out.push({ name: 'definer_read', cmd: 'SELECT', roles: ['app_owner'] });
  if (def.definerAppend) out.push({ name: 'definer_append', cmd: 'INSERT', roles: ['app_owner'] });
  if (def.definerSync) {
    // S12-F16: one policy per operation the functions use, in a fixed order.
    for (const op of DEFINER_OPS) {
      if (def.definerSync.ops.includes(op))
        out.push({ name: DEFINER_POLICY[op].name, cmd: DEFINER_POLICY[op].cmd, roles: ['app_owner'] });
    }
  }
  return out;
}

/** Roles that read every row of a plain global table (`global_read`). */
function globalReaders(def: GlobalTable): ('app_public' | 'app_user')[] {
  return [...(def.noUserRead ? [] : (['app_user'] as const)), ...(def.publicRead ? (['app_public'] as const) : [])];
}

/** ` and (<predicate>)` for a `userSelect.write` or `memberWrite` (S12-F14) command, or nothing. */
function userWrite(table: string, def: TenantTable, cmd: 'insert' | 'update' | 'delete'): string {
  const sql = def.userSelect?.write?.[cmd] ?? def.memberWrite?.[cmd];
  return sql === undefined ? '' : ` and (${predicate(table, sql)})`;
}

/** S13-03: a global table's narrowed `staffWrite` rule, or null for `staffWrite: true` (any active staff). */
function staffWriteRule(def: GlobalTable): StaffWriteRule | null {
  return def.staffWrite && def.staffWrite !== true ? def.staffWrite : null;
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
 * The live feed of one token hash whose member may still use it, and the events it serves (S10-06): shared by
 * `calendar_feed_by_token` (the events) and `calendar_feed_tag` (their fingerprint, S11-F7), so both see the same set.
 */
const CALENDAR_FEED_EVENTS = `with feed as (
          select f.agency_id, f.user_id, f.id as feed_id, f.content_version from public.calendar_feeds f
            join public.agency_members m on m.agency_id = f.agency_id and m.user_id = f.user_id
             and m.deactivated_at is null and m.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT')
            join public.users u on u.id = f.user_id and u.status = 'ACTIVE'
            join public.agencies g on g.agency_id = f.agency_id and g.status <> 'SUSPENDED'
           where f.token_hash = hash and f.revoked_at is null),
        upcoming as (
          select a.agency_id, a.event_id from feed
            join public.calendar_event_attendees a on a.agency_id = feed.agency_id and a.user_id = feed.user_id
           where a.starts_at >= now_ts and a.starts_at < to_ts
           order by a.starts_at, a.event_id limit greatest(max_events, 0)),
        picked as (
          select agency_id, event_id from upcoming
          union all
          -- S11-F7: recent events only fill what the upcoming ones leave (the feed keeps upcoming ones first)
          (select a.agency_id, a.event_id from feed
             join public.calendar_event_attendees a on a.agency_id = feed.agency_id and a.user_id = feed.user_id
            where a.starts_at >= from_ts and a.starts_at < now_ts
            order by a.starts_at desc, a.event_id desc
            limit greatest(max_events - (select count(*) from upcoming), 0)))`;

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
    // it takes no input and only runs partman's maintenance, then re-arms the append-only triggers on archived
    // audit months (S2-F1). Partman lives in its own schema (initdb).
    `create or replace function app_partition_maintenance() returns void language plpgsql security definer
  set search_path = pg_catalog, pg_temp set lock_timeout = '5s'
  as $$
declare t record;
begin
  perform partman.run_maintenance(p_analyze := false, p_jobmon := false);
  -- S2-F1: a month moved to audit_archive by retention loses the triggers cloned from the parent; it stays
  -- append-only (and untruncatable) until the runbook's export step drops it.
  for t in select c.oid::regclass as rel,
                  not exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = 'audit_logs_immutable') as no_row,
                  not exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = 'audit_logs_no_truncate') as no_trunc
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'audit_archive' and c.relkind = 'r' loop
    if t.no_row then
      execute format('create trigger audit_logs_immutable before update or delete on %s for each row execute function public.audit_logs_immutable()', t.rel);
    end if;
    if t.no_trunc then
      execute format('create trigger audit_logs_no_truncate before truncate on %s for each statement execute function public.audit_logs_immutable()', t.rel);
    end if;
  end loop;
end $$;`,
    // S7-F10 (was S7-F4's `search_commission_at_least(target, bp)`, a SECURITY DEFINER call per candidate row, ~10 µs
    // each): the targets that pay at least the transaction's `app.search_min_commission_bp` basis points of their price
    // (`withPublicRead({ minCommissionBp })`, folded into BEGIN) — ids only, never the value. Without the setting a
    // probe fails loudly (a caller that forgot it, rather than a site silently showing no network listing). Owned
    // by app_owner and read with its `definer_read` policy, as the function was; a security barrier, so a caller's
    // non-leakproof condition never sees a row the threshold drops. The website fallback probes it per candidate with
    // the primary key (an index probe, ~3 µs) and compares `floor_bp` with its own threshold, so a transaction set for
    // another minimum answers nothing rather than the wrong rows. Same answer for every role (BYPASSRLS included).
    `drop view if exists public.search_commission_floor;`,
    `create view public.search_commission_floor with (security_barrier = true) as
  select c.target_id as floor_target_id, ${COMMISSION_FLOOR} as floor_bp
    from public.listing_search_commissions c
   where c.commission_bp >= ${COMMISSION_FLOOR};`,
    // Owned by app_owner explicitly (whoever applies the file): the view reads the table with its owner's policy, and
    // the guard requires this owner for every definer view.
    `alter view public.search_commission_floor owner to app_owner;`,
    `revoke all on table public.search_commission_floor from ${APP_ROLES};`,
    `grant select on table public.search_commission_floor to app_public;`,
    // S7-F4's per-row lookup (SECURITY DEFINER, granted to app_public), unused since S7-F10 and kept one release for
    // the app version running during that deploy: dropped (S7-F11). Not a helper any more, so the guard rejects it
    // wherever it is still executable.
    `drop function if exists public.search_commission_at_least(uuid, integer);`,
    // S7-03: may this agency's websites show network listings (PLAN §3 #5 give-to-get)? Exempt, within its grace period,
    // or sharing at least `min_shared` listings with the whole network (the network search's count, capped). feed-api
    // runs as app_public, which reads neither table; it gets this one boolean per agency.
    `create or replace function website_network_open(a_id uuid, min_shared integer, grace_days integer) returns boolean
  language sql stable security definer set search_path = pg_catalog, pg_temp
  as $$ select coalesce((select g.give_to_get_exempt or g.created_at > now() - make_interval(days => grace_days)
                           from public.agencies g where g.agency_id = a_id), false)
            or (select count(*) from (select 1 from public.properties p
                  where p.agency_id = a_id and p.visibility <> 'PRIVATE' and p.status = 'ACTIVE'
                    and p.deleted_at is null and p.network_hidden_at is null and p.share_scope = 'ALL'
                  limit greatest(min_shared, 0)) s) >= min_shared $$;`,
    // S13-F17: the AI features an agency switched on, for feed-api (app_public: website AI search, `withPublicRead`).
    // S14-F7 (S13 review): only the website-search toggle, and only for an agency with a live website site (one whose
    // plan has not ended) that is not SUSPENDED — any other agency id, or any other toggle, answers nothing (workers
    // read the full toggles on `withSystem`). Primary key probes of agency_settings and agencies, one range of
    // website_sites (agency, created) — each through its `definer_read` policy. Cached by the caller
    // (`agencies.aiFeatureEnabled`).
    `create or replace function agency_ai_features(a_id uuid) returns text[]
  language sql stable security definer set search_path = pg_catalog, pg_temp
  as $$ select case when exists (
                 select 1 from public.agency_settings s
                   join public.agencies g on g.agency_id = s.agency_id and g.status <> 'SUSPENDED'
                  where s.agency_id = a_id and 'WEBSITE_SEARCH' = any(s.ai_features)
                    and exists (select 1 from public.website_sites w
                                 where w.agency_id = a_id and (w.plan_ends_at is null or w.plan_ends_at > now())))
               then array['WEBSITE_SEARCH']::text[] else '{}'::text[] end $$;`,
    // S8-02: the v1 shim's listing and unit legacy ids. feed-api (app_public) reads only the taxonomy maps; these two
    // answer, for the ids a request names, the matching ids and nothing else (no scan: at most 1,000 inputs, each an
    // index probe). Owned by app_owner (its `definer_read` policy on legacy_id_maps).
    `create or replace function legacy_target_ids(legacy_ids text[]) returns table(entity text, legacy_id text, new_id uuid)
  language sql stable security definer set search_path = pg_catalog, pg_temp
  as $$ select m.entity, m.legacy_id, m.new_id
          from (select distinct x from unnest(legacy_ids[1:1000]) x) k
          join public.legacy_id_maps m on m.entity in ('listing', 'unit') and m.legacy_id = k.x $$;`,
    `create or replace function legacy_ids_of(new_ids uuid[]) returns table(new_id uuid, legacy_id text)
  language sql stable security definer set search_path = pg_catalog, pg_temp
  as $$ select m.new_id, min(m.legacy_id)
          from public.legacy_id_maps m
         where m.entity in ('listing', 'unit') and m.new_id = any(new_ids[1:1000])
         group by m.new_id $$;`,
    // S9-03: a portal feed URL's served file. feed-api (app_public) cannot read agency_portal_connections (credentials,
    // selection, names): for one token hash it gets the live connection's id, portal, served run and content hash —
    // enabled, token not revoked, its agency VERIFIED — and nothing else (S9-03 review: not even the agency or the hash).
    // One index probe (unique token hash). Dropped first: `create or replace` cannot change a function's result columns.
    `drop function if exists portal_feed_by_token(text);`,
    `create function portal_feed_by_token(hash text) returns table(connection_id uuid, channel_code text, run_id uuid, sha256 text)
  language sql stable security definer set search_path = pg_catalog, pg_temp
  as $$ select c.id, c.channel_code, c.feed_run_id, c.feed_sha256
          from public.agency_portal_connections c
          join public.agencies g on g.agency_id = c.agency_id and g.status = 'VERIFIED'
         where c.token_hash = hash and c.enabled and c.revoked_at is null and c.feed_run_id is not null $$;`,
    // S10-06: a member's ICS feed (feed-api, app_public, which reads no crm, member or user table). For one token hash:
    // the live feed whose member may still use it — an active membership in a role that holds `crm.calendar.feed`
    // (crm/policy.ts MEMBER_ROLES), an ACTIVE login, an agency not SUSPENDED — and that member's own events (those they
    // attend, organizer included): the next ones from `now_ts` to `to_ts` (at most max_events, soonest first) and the
    // latest ones from `from_ts` to `now_ts` (latest first, only as many as the upcoming ones leave of max_events —
    // S11-F7: the caller keeps the upcoming ones first, so at most max_events rows in all). Attendees' names only — members' from the team directory, open contacts' first and last name (never an
    // e-mail or phone). Every join names the feed's agency. One row with a null event when there is none; no row for an
    // unknown, rotated or revoked token or a member who lost access. One statement: the token's unique index, then two
    // ordered ranges of the member's attendee index.
    `drop function if exists calendar_feed_by_token(text, timestamptz, timestamptz, timestamptz, integer);`,
    `create function calendar_feed_by_token(hash text, from_ts timestamptz, now_ts timestamptz, to_ts timestamptz,
    max_events integer)
  returns table(event_id uuid, type text, title text, description text, location text, starts_at timestamptz,
    ends_at timestamptz, status text, version integer, updated_at timestamptz, member_names text[], contact_names text[],
    feed_id uuid, feed_version bigint)
  language sql stable security definer set search_path = pg_catalog, pg_temp
  as $$ ${CALENDAR_FEED_EVENTS}
        select e.id, e.type, e.title, e.description, e.location, e.starts_at, e.ends_at, e.status, e.version,
               e.updated_at, names.member_names, names.contact_names, feed.feed_id, feed.content_version
          from feed
          left join picked p on p.agency_id = feed.agency_id
          left join public.calendar_events e on e.agency_id = p.agency_id and e.id = p.event_id
          -- S11-F7: one pass over the event's attendees for both lists (was two)
          left join lateral (
            select array_agg(x.member_name order by x.member_name) filter (where x.member_id is not null) as member_names,
                   array_agg(distinct x.contact_name order by x.contact_name)
                     filter (where x.contact_name <> '') as contact_names
              from (select m2.user_id as member_id, m2.name as member_name,
                           case when c.id is not null then btrim(concat_ws(' ', c.first_name, c.last_name)) end
                             as contact_name
                      from public.calendar_event_attendees a2
                      left join public.agency_members m2
                        on a2.user_id is not null and m2.agency_id = a2.agency_id and m2.user_id = a2.user_id
                      left join public.contacts c
                        on a2.contact_id is not null and c.agency_id = a2.agency_id and c.id = a2.contact_id
                       and c.deleted_at is null
                     where a2.agency_id = e.agency_id and a2.event_id = e.id) x) names on e.id is not null $$;`,
    // S12-F22 (was S11-F7's fingerprint of the events, ~5 buffers an event): what a feed's ETag is made of — the feed's
    // id and `content_version` (bumped in the transaction of every change to what it renders: the `*_calendar_feed_*`
    // triggers) — for the live token of a member who may still use it: the same access joins as `calendar_feed_by_token`
    // (membership, CRM role, login, agency — S12-F22 security review: fail closed), with the trigger-kept `live` only a
    // hint AND-ed to them. No row for an unknown, rotated or revoked token or a member who lost access. One
    // statement: the token's unique index and the user's primary key, nothing per event.
    `drop function if exists calendar_feed_tag(text, timestamptz, timestamptz, timestamptz, integer);`,
    `drop function if exists calendar_feed_tag(text);`,
    `create function calendar_feed_tag(hash text)
  returns table(feed_id uuid, feed_version bigint)
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp
  as $$ begin
  -- plpgsql, not sql: the statement's plan is cached per session (an SQL function is planned on every call, which reads
  -- the joined tables' index metapages: ~40 buffers a 304 for nothing)
  return query select f.id, f.content_version from public.calendar_feeds f
          join public.agency_members m on m.agency_id = f.agency_id and m.user_id = f.user_id
           and m.deactivated_at is null and m.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT')
          join public.users u on u.id = f.user_id and u.status = 'ACTIVE'
          join public.agencies g on g.agency_id = f.agency_id and g.status <> 'SUSPENDED'
         where f.token_hash = hash and f.revoked_at is null and f.live;
end $$;`,
    // S13-F1: a selection's public page (`/s/<token>`, app_public — which reads neither selections nor selection_items:
    // it also serves feed-api, export downloads and websites, and the agent's notes can name the client). For the
    // token's keyed hashes (HMAC rotation candidates, at most 8): the live selection (not revoked, not expired, its
    // agency not SUSPENDED, as `portal_feed_by_token` — S13-F1 security review) — its id, agency, title, message, locale
    // and expiry — with its items in order, and nothing else (never who made it, for which client, its link hint or
    // hash). No row for an unknown, revoked or expired token. One statement: the token's unique index, the agency's
    // primary key, then the items' (selection, position) index. SQL, not plpgsql: a cold session pays ~1 ms, not
    // plpgsql's ~3-5 ms compile.
    `drop function if exists selection_by_token(text[]);`,
    `create function selection_by_token(hashes text[])
  returns table(id uuid, agency_id uuid, title text, message text, locale text, expires_at timestamptz, items json)
  language sql stable security definer set search_path = pg_catalog, pg_temp
  as $$ select s.id, s.agency_id, s.title, s.message, s.locale, s.expires_at,
               coalesce((select json_agg(json_build_object('targetId', i.target_id, 'position', i.position,
                                                           'titleOverride', i.title_override, 'note', i.note)
                                         order by i.position)
                           from public.selection_items i
                          where i.selection_id = s.id and i.agency_id = s.agency_id), '[]'::json)
          from public.selections s
          join public.agencies g on g.agency_id = s.agency_id and g.status <> 'SUSPENDED'
         where s.token_hash = any(hashes[1:8]) and s.revoked_at is null
           and (s.expires_at is null or s.expires_at > now())
         limit 1 $$;`,
    `revoke all on function app_agency(), app_user_id(), app_impersonated_by(), app_is_staff(), app_agency_verified(), app_preferring_agencies(), app_partition_maintenance(), website_network_open(uuid, integer, integer), agency_ai_features(uuid), legacy_target_ids(text[]), legacy_ids_of(uuid[]), portal_feed_by_token(text), calendar_feed_by_token(text, timestamptz, timestamptz, timestamptz, integer), calendar_feed_tag(text), selection_by_token(text[]) from public;`,
    `grant execute on function calendar_feed_by_token(text, timestamptz, timestamptz, timestamptz, integer) to app_public;`,
    `grant execute on function calendar_feed_tag(text) to app_public;`,
    `grant execute on function portal_feed_by_token(text) to app_public;`,
    `grant execute on function selection_by_token(text[]) to app_public;`,
    `grant execute on function website_network_open(uuid, integer, integer) to app_public;`,
    `grant execute on function agency_ai_features(uuid) to app_public;`,
    // S13-F17: reads agency_settings through its `definer_read` policy (app_owner), whichever role ran the SQL.
    `alter function agency_ai_features(uuid) owner to app_owner;`,
    `grant execute on function legacy_target_ids(text[]), legacy_ids_of(uuid[]) to app_public;`,
    // S8-F26: both lookups read legacy_id_maps through its `definer_read` policy (app_owner), so they must be OWNED by
    // app_owner whichever role ran the migration (a function runs as its owner).
    `alter function legacy_target_ids(text[]) owner to app_owner;`,
    `alter function legacy_ids_of(uuid[]) owner to app_owner;`,
    // S9 review: the portal feed token lookup reads agency_portal_connections through its `definer_read` policy
    // (app_owner) and is recreated (dropped first) on every run, so it is owned by whichever role ran the SQL unless set.
    `alter function portal_feed_by_token(text) owner to app_owner;`,
    // S10-06: reads the calendar tables, contacts, agency_members, users and agencies through their `definer_read` policies.
    `alter function calendar_feed_by_token(text, timestamptz, timestamptz, timestamptz, integer) owner to app_owner;`,
    `alter function calendar_feed_tag(text) owner to app_owner;`,
    // S13-F1: reads selections, selection_items and agencies through their `definer_read` policies; recreated on every
    // run.
    `alter function selection_by_token(text[]) owner to app_owner;`,
    `grant execute on function app_agency(), app_user_id() to app_user, app_system, app_public, app_auth, app_staff;`,
    `grant execute on function app_impersonated_by() to app_user;`,
    `grant execute on function app_agency() to app_intake;`,
    `grant execute on function app_is_staff() to app_staff;`,
    `grant execute on function app_agency_verified(), app_preferring_agencies() to app_user;`,
    `grant execute on function app_partition_maintenance() to app_system;`,
  ].join('\n');
}

/** Columns `app_user` may not read: the table's own `hiddenColumns` and `userSelect.hiddenColumns`. */
export function hiddenColumnsOf(def: TenantTable): readonly string[] {
  return [...(def.hiddenColumns ?? []), ...(def.userSelect?.hiddenColumns ?? [])];
}

/**
 * Columns `app_public` may not read on a PUBLIC_READ table: the table's own `hiddenColumns` (S6-F1) and its
 * `publicHiddenColumns` (S7-02).
 */
export function publicHiddenColumnsOf(def: TenantTable): readonly string[] {
  return def.kind === 'PUBLIC_READ' ? [...(def.hiddenColumns ?? []), ...(def.publicHiddenColumns ?? [])] : [];
}

/**
 * A role's grant. With hidden columns the table-level SELECT becomes a column list of every other column, read from
 * the catalog when the SQL runs (ADR 0016); INSERT, UPDATE and DELETE stay table-wide.
 */
function grantSql(
  t: string,
  role: AppRole,
  privileges: readonly Privilege[],
  hidden: readonly string[],
  noWrite: readonly string[] = [],
): string {
  const colWrites = noWrite.length > 0 ? privileges.filter((p) => p === 'UPDATE') : [];
  if (colWrites.length > 0) {
    // S8-F26: UPDATE becomes a column list of every column but `noWrite` (catalog read when the SQL runs);
    // the excluded column keeps its default on insert.
    const literals = noWrite.map((c) => `'${c}'`).join(', ');
    const rest = privileges.filter((p) => p !== 'UPDATE');
    return [
      rest.length ? grantSql(t, role, rest, hidden) : '',
      ...colWrites.map(
        (p) => `do $$
declare cols text;
begin
  select string_agg(format('%I', attname), ', ' order by attnum) into cols from pg_attribute
   where attrelid = '${t}'::regclass and attnum > 0 and not attisdropped and attname <> all (array[${literals}]);
  execute format('grant ${p.toLowerCase()} (%s) on table ${t} to ${role}', cols);
end $$;`,
      ),
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (hidden.length === 0 || !privileges.includes('SELECT')) {
    return `grant ${grantList([...privileges])} on table ${t} to ${role};`;
  }
  const others = privileges.filter((p) => p !== 'SELECT');
  const literals = hidden.map((c) => `'${c}'`).join(', ');
  return [
    `do $$
declare cols text;
begin
  select string_agg(format('%I', attname), ', ' order by attnum) into cols from pg_attribute
   where attrelid = '${t}'::regclass and attnum > 0 and not attisdropped and attname <> all (array[${literals}]);
  execute format('grant select (%s) on table ${t} to ${role}', cols);
end $$;`,
    others.length ? `grant ${grantList(others)} on table ${t} to ${role};` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** `app_staff`'s grant: table-wide, or column lists where `selectColumns` / `updateColumns` narrow it (S6-08). */
function staffGrantSql(t: string, staff: StaffAccess): string[] {
  const out: string[] = [];
  const tableWide: Privilege[] = [];
  for (const priv of authPrivileges(staff)) {
    const cols = priv === 'SELECT' ? staff.selectColumns : priv === 'UPDATE' ? staff.updateColumns : undefined;
    if (cols)
      out.push(`grant ${priv.toLowerCase()} (${cols.map((c) => `"${c}"`).join(', ')}) on table ${t} to app_staff;`);
    else tableWide.push(priv);
  }
  if (tableWide.length) out.unshift(`grant ${grantList(tableWide)} on table ${t} to app_staff;`);
  return out;
}

/** `app_user`'s grant: its hidden columns are `hiddenColumns` and `userSelect.hiddenColumns`. */
function userGrantSql(t: string, def: TenantTable): string {
  return grantSql(t, 'app_user', expectedPrivileges(def).app_user, hiddenColumnsOf(def), def.userNoUpdateColumns);
}

function tenantTableSql(name: string, def: TenantTable): string[] {
  const t = ident(name);
  assertValid(name, def);
  const out = [
    ...(def.userSelect || def.memberWrite
      ? [
          // S1-F10: writes stay on the agency's rows; reads are narrowed to what the reading user may see.
          // S11-04: `userSelect.write` narrows each write to rows of the writing user too.
          // S12-F14: `memberWrite` — the same write policies, and every row of the agency is read.
          // S13-F3: `userNoInsert` — no INSERT grant, no insert policy
          ...(def.userNoInsert
            ? []
            : [
                `create policy own_insert on ${t} for insert to app_user
  with check (agency_id = app_agency()${userWrite(name, def, 'insert')});`,
              ]),
          // S12-F3 review: `userNoUpdate` — no UPDATE grant, no update policy
          ...(def.userNoUpdate
            ? []
            : [
                `create policy own_update on ${t} for update to app_user
  using (agency_id = app_agency()${userWrite(name, def, 'update')}) with check (agency_id = app_agency()${userWrite(name, def, 'update')});`,
              ]),
          // S13-05: `userNoDelete` — no DELETE grant, no delete policy
          ...(def.userNoDelete
            ? []
            : [
                `create policy own_delete on ${t} for delete to app_user
  using (agency_id = app_agency()${userWrite(name, def, 'delete')});`,
              ]),
          def.userSelect
            ? `create policy user_select on ${t} for select to app_user
  using (agency_id = app_agency() and (${predicate(name, def.userSelect.sql)}));`
            : `create policy own_select on ${t} for select to app_user
  using (agency_id = app_agency());`,
        ]
      : [
          def.appendOnly
            ? `create policy own_rows on ${t} for insert to app_user
  with check (agency_id = app_agency());`
            : def.userReadOnly
              ? `create policy own_rows on ${t} for select to app_user
  using (agency_id = app_agency());`
              : def.userInsert !== undefined
                ? `create policy own_rows on ${t} to app_user
  using (agency_id = app_agency()) with check (agency_id = app_agency() and (${predicate(name, def.userInsert)}));`
                : `create policy own_rows on ${t} to app_user
  using (agency_id = app_agency()) with check (agency_id = app_agency());`,
        ]),
  ];
  const networkReadSql = def.kind === 'STRICT' ? undefined : def.networkReadSql;
  if (networkReadSql !== undefined) {
    // Only a tenant reads the network: a connection with no agency set sees nothing at all. Only a
    // verified one (PLAN §3 #3, S1-07): added here, not by the registry, so no predicate can weaken it;
    // as a sub-select it is an init plan, evaluated once per statement rather than per row.
    out.push(`create policy network_read on ${t} for select to app_user
  using (app_agency() is not null and (select public.app_agency_verified()) and (${predicate(name, networkReadSql)}));`);
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
  if (def.kind === 'PUBLIC_READ') out.push(grantSql(t, 'app_public', ['SELECT'], publicHiddenColumnsOf(def)));
  if (def.mediaRead) {
    // The media worker's reference counts (S3-F4): every agency's rows, through a column grant of what it counts.
    const cols = def.mediaRead.columns.map((c) => `"${c}"`).join(', ');
    out.push(
      `create policy media_read on ${t} for select to app_media using (true);`,
      `grant select (${cols}) on table ${t} to app_media;`,
    );
  }
  if (def.intake) {
    // Website form intake (S7-05): the pinned agency's rows only; reads back the listed columns, never the rest.
    const cols = def.intake.selectColumns.map((c) => `"${c}"`).join(', ');
    out.push(
      `create policy intake_insert on ${t} for insert to app_intake
  with check (agency_id = app_agency());`,
      `create policy intake_select on ${t} for select to app_intake
  using (agency_id = app_agency());`,
      `grant insert on table ${t} to app_intake;`,
      `grant select (${cols}) on table ${t} to app_intake;`,
    );
  }
  if (def.intakeAppend) {
    // The intake transaction's own events, for its pinned agency only.
    const { column, values } = def.intakeAppend;
    const list = values.map((v) => `'${v}'`).join(', ');
    out.push(
      `create policy intake_append on ${t} for insert to app_intake
  with check (agency_id = app_agency() and "${column}" in (${list}));`,
      `grant insert on table ${t} to app_intake;`,
    );
  }
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
    // Staff work across tenants, but only as an active staff member (`app_is_staff()`), never DELETE. S7-F10: as an
    // init plan `(select …)`, evaluated once per statement like `app_agency_verified()` — called bare it was a filter
    // on every row (the staff import health read 120k runs in 24 h: 520 ms per aggregate, a function call per run).
    const { select, insert, update } = def.staff;
    const gated = (p: string) => `${STAFF_GATE} and (${predicate(name, p)})`;
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
    out.push(...staffGrantSql(t, def.staff));
  }
  if (def.definerRead) {
    // S7-03: read by a SECURITY DEFINER function only (owned by app_owner); no application role gains a row.
    out.push(`create policy definer_read on ${t} for select to app_owner using (true);`);
  }
  if (def.definerAppend) {
    // S10-03: appended by a SECURITY DEFINER trigger function only (owned by app_owner); app_user reads, never writes.
    out.push(`create policy definer_append on ${t} for insert to app_owner with check (true);`);
  }
  if (def.definerSync) {
    // S11-02: two agencies' copies kept in step by SECURITY DEFINER trigger functions only (owned by app_owner).
    // S12-F16: only the operations they use.
    for (const op of DEFINER_OPS) {
      if (def.definerSync.ops.includes(op)) out.push(DEFINER_POLICY[op].sql(t));
    }
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
      ...(def.definerRead ? [`create policy definer_read on ${t} for select to app_owner using (true);`] : []),
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
  const readers = globalReaders(def).join(', ');
  const rule = staffWriteRule(def);
  // S13-03: a narrowed `staffWrite` ANDs its predicate into every write policy (reads stay with the staff gate).
  const write = rule ? `${STAFF_GATE} and (${predicate(name, rule.sql)})` : STAFF_GATE;
  const staffWrite = def.staffWrite
    ? [
        // Reference data edited by the staff console (S2-04): any active staff member at the database level;
        // which staff role may write is the service's policy (`staff.taxonomy.write`).
        `create policy staff_select on ${t} for select to app_staff using (${STAFF_GATE});`,
        `create policy staff_insert on ${t} for insert to app_staff with check (${write});`,
        `create policy staff_update on ${t} for update to app_staff using (${write}) with check (${write});`,
        ...(rule?.noDelete
          ? [`grant select, insert, update on table ${t} to app_staff;`]
          : [
              `create policy staff_delete on ${t} for delete to app_staff using (${write});`,
              `grant select, insert, update, delete on table ${t} to app_staff;`,
            ]),
      ]
    : def.staffRead
      ? [
          // S14-03: read-only for every active staff member (operator reports written by scripts).
          `create policy staff_select on ${t} for select to app_staff using (${STAFF_GATE});`,
          `grant select on table ${t} to app_staff;`,
        ]
      : [];
  // noUserRead (S3-F1): no app_user policy or grant; app_system bypasses RLS, staff have their own policies. With
  // publicRead (S6-F1) app_public alone reads it.
  // mediaWrite (S3-F4): the media worker's own table, every row, nothing else.
  const mediaWrite = def.mediaWrite
    ? [
        `create policy media_rows on ${t} to app_media using (true) with check (true);`,
        `grant select, insert, update, delete on table ${t} to app_media;`,
      ]
    : [];
  const definerRead = def.definerRead
    ? [`create policy definer_read on ${t} for select to app_owner using (true);`]
    : [];
  return [
    ...definerRead,
    // S8-02: a `publicReadSql` narrows app_public's rows (only with noUserRead, so app_public is the sole reader).
    ...(readers
      ? [
          `create policy global_read on ${t} for select to ${readers} using (${def.publicReadSql === undefined ? 'true' : predicate(name, def.publicReadSql)});`,
        ]
      : []),
    `revoke all on table ${t} from ${APP_ROLES};`,
    ...(readers ? [`grant select on table ${t} to ${readers};`] : []),
    `grant select, insert, update, delete on table ${t} to app_system;`,
    ...staffWrite,
    ...mediaWrite,
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
