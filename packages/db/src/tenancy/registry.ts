/**
 * Tenant registry (PLAN §3 #32 #53, PATTERNS §2) — the single source of truth for RLS policies,
 * table grants (`pnpm db:rls`) and the generated isolation suite (`pnpm test:isolation`).
 *
 * Every table in schema `public` must appear here: tenant tables (with `agency_id`) under
 * `tenantTables`, everything else under `globalTables`. The guard fails on anything unregistered,
 * and an unregistered table gets no grants, so access fails closed.
 */
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/tenancy';

/** A staff member's own row, or any row for an active super admin (their own `staff_users` row, policy staff_self). */
const SUPER_ADMIN_OR_OWN_SESSION =
  "staff_user_id = app_user_id() or exists (select 1 from public.staff_users s where s.user_id = app_user_id() and s.role = 'SUPER_ADMIN' and s.deactivated_at is null)";

export type PolicyKind = 'STRICT' | 'NETWORK_READ' | 'PUBLIC_READ';

/** Column overrides (DB column names) for rows the isolation suite seeds. */
export type SampleRow = Record<string, unknown>;

/**
 * A sample value the isolation suite replaces with the reading tenant's agency id — for predicates about
 * the reader, such as `preferred_agency_id = app_agency()` (S1-07).
 */
export const SAMPLE_READER = '{reader}';

/** Like `SAMPLE_READER`, for the reading *user* (`app_user_id()`): `userSelect` samples such as `target_user_id = app_user_id()`. */
export const SAMPLE_USER = '{user}';

/** Rows that satisfy (`visible`) and fail (`hidden`) a read predicate, so the suite can test both sides. */
export interface PredicateSamples {
  visible: SampleRow[];
  hidden: SampleRow[];
}

interface TenantBase {
  /** Values for NOT NULL columns the isolation suite cannot invent (geometry, check-constrained text, …). */
  base?: SampleRow;
  /**
   * STRICT only: `app_user` may INSERT its own agency's rows and nothing else (no SELECT, UPDATE or
   * DELETE) — write-only queues such as the outbox. Reads and acknowledgements go through `withSystem()`.
   */
  appendOnly?: true;
  /**
   * History that never changes (audit logs, S1-08): no app role — `app_system` included — gets UPDATE or
   * DELETE. `app_user` reads and appends its own agency's rows (only appends with `appendOnly`),
   * `app_system` reads and appends any, and `auth` / `staff` may grant SELECT and INSERT only. Removing
   * old rows is partition retention (owner), never a statement of an app role.
   */
  immutable?: true;
  /**
   * immutable only: what an `app_user` row must also satisfy to be appended (ANDed with
   * `agency_id = app_agency()` in `own_rows`' WITH CHECK) — e.g. it names the session's own user as the
   * actor. One SQL predicate, reviewed like `networkReadSql`.
   */
  userInsert?: string;
  /**
   * STRICT only (S1-F10): `app_user` reads its own agency's rows only where `sql` holds — a predicate about
   * the reading user (`app_user_id()`), ANDed with `agency_id = app_agency()` — instead of every row
   * (`own_rows` then covers INSERT, UPDATE and DELETE only). `hiddenColumns` are not readable by `app_user`
   * at all: the generator grants SELECT on the other columns only (ADR 0016), so a new column stays
   * unreadable until `pnpm db:rls` runs. `samples` hold rows the suite's reading user (`SAMPLE_USER`) can
   * and cannot read; branches that need other rows (an admin of the agency) are tested in the owning module.
   */
  userSelect?: { sql: string; hiddenColumns?: readonly string[]; samples: PredicateSamples };
  /**
   * Range-partitioned parent (pg_partman, PLAN §4.1). The guard checks the table is partitioned and that
   * no partition is reachable directly (partitions skip their parent's policies).
   */
  partitioned?: true;
  /**
   * appendOnly only: `app_auth` (anonymous auth flows, `withAuth()`) may INSERT platform rows
   * (`agency_id` = nil UUID) whose `column` starts with `prefix` — e.g. `identity.*` outbox events
   * ("send the verification email") in the sign-up transaction, and nothing else.
   */
  authAppend?: { column: string; prefix: string };
  /**
   * Anonymous auth flows (`app_auth`, `withAuth()`) may reach some rows: the sign-up transaction creates
   * the agency and its founding admin, and access-token minting reads the user's own membership (S1-01).
   * One SQL predicate per command, reviewed like `networkReadSql`. Each must pin rows to `app_agency()`
   * and/or `app_user_id()`, which the flow sets with `setAuthScope()`; without them nothing matches.
   * DELETE is never granted.
   */
  auth?: AuthAccess;
  /**
   * Exactly one row per agency (keyed by `agency_id`): the isolation suite's positive control updates
   * the tenant's row instead of inserting a second one.
   */
  singleRow?: true;
  /**
   * A guard trigger refuses `app_user` INSERTs the service rules do not allow (members join through
   * `app_auth`; invites need an active admin). The isolation suite's positive control then proves the
   * grant by updating the tenant's row and expects its insert to be refused.
   */
  guardedInsert?: true;
  /**
   * Staff request paths (`app_staff`, `withStaff()`, S1-03, ADR 0015) may reach rows across tenants:
   * the verification queue reads every agency's requests and decides them. One SQL predicate per
   * command (`'true'` for all rows); the generator ANDs each with `app_is_staff()`, so a staff
   * transaction whose `app.user_id` is not an active staff member sees and changes nothing. DELETE is
   * never granted; column rules (which fields staff may change) live in guard triggers.
   */
  staff?: StaffAccess;
  /**
   * The table's own (non-constraint) triggers — guard triggers and the directory sync (S1-07). The guard
   * fails if one is missing or disabled, or if the table has a trigger not listed here; their function
   * bodies are part of the catalog fingerprint `pnpm db:rls` records.
   */
  triggers?: readonly string[];
}

export interface AuthAccess {
  select?: string;
  insert?: string;
  update?: string;
}

export interface StaffAccess {
  select?: string;
  insert?: string;
  update?: string;
}

export type TenantTable = TenantBase &
  (
    | /** Own agency only. */ { kind: 'STRICT' }
    /**
     * Own agency, plus other agencies (`app_user`) may read rows matching the predicate. Never writable
     * by them. RLS shares whole rows: keep private columns in a STRICT side table. The generator ANDs
     * the predicate with `(select public.app_agency_verified())` — only verified agencies read the
     * network (S1-07); the isolation suite reads as a verified agency listed in the directory, and checks
     * that an unverified one sees nothing. Listing-style rows shared with preferred agencies only use
     * `agency_id in (select a from public.app_preferring_agencies() a)` (S1-07).
     */
    | {
        kind: 'NETWORK_READ';
        networkReadSql: string;
        samples: PredicateSamples;
      }
    /** Own agency, plus `app_public` (feed-api, portal) may read matching rows — whole rows, so no private columns. */
    | {
        kind: 'PUBLIC_READ';
        publicReadSql: string;
        samples: PredicateSamples;
      }
  );

export interface GlobalTable {
  /** Why this table has no `agency_id` (reviewed like an exception). */
  reason: string;
  /** `app_public` may read it (reference data used by public pages). */
  publicRead?: boolean;
  /**
   * `'auth'`: identity data (password hashes, auth tokens). Only `app_auth` (`withAuth()`) and
   * `app_system` may read or write it; `app_user` and `app_public` get nothing (S0-09, ADR 0004).
   *
   * `'staff'`: who is staff (S1-03, ADR 0015). Only `app_system` writes it; `app_staff` reads the row of
   * the user it acts for (`user_id = app_user_id()`, which `app_is_staff()` relies on), and `app_auth`
   * the row of the user its flow is scoped to (S1-04: staff must pass 2FA). Nobody else.
   */
  access?: 'auth' | 'staff';
  /**
   * `access: 'auth'` only: `app_auth` reaches only the rows of the user its flow is scoped to
   * (`user_id = app_user_id()`, set by `setAuthScope`) — for per-user secrets such as 2FA (S1-04), so
   * no other auth flow can read or change another user's factor.
   */
  userScoped?: true;
}

export interface TenantRegistry {
  tenant: Record<string, TenantTable>;
  global: Record<string, GlobalTable>;
}

/** Tables with `agency_id`. Add each new tenant table here, then run `pnpm db:rls`. */
export const tenantTables: Record<string, TenantTable> = {
  // Transactional outbox: request transactions insert their own agency's events; the dispatcher
  // reads and acknowledges every agency's rows through withSystem(). Platform events use the nil UUID;
  // auth flows (app_auth) may append those too (sign-up / reset emails).
  // Staff decisions (app_staff, S1-03) append the decided agency's `agencies.*` events in the same
  // transaction — never platform (nil-agency) rows or another module's events, which workers trust.
  outbox_events: {
    kind: 'STRICT',
    appendOnly: true,
    authAppend: { column: 'type', prefix: 'identity.' },
    staff: { insert: `starts_with(type, 'agencies.') and agency_id <> '${PLATFORM_AGENCY_ID}'::uuid` },
  },
  // The tenant itself (S1-01). Sign-up (app_auth) creates it PENDING; a repeated sign-up for an
  // unconfirmed email may rename it while it is still PENDING and not onboarded. Status changes are
  // staff-only (S1-03) — no service lets a tenant write `status`. Staff (app_staff) read every agency
  // and change only `status` (guard trigger, migration 0011).
  agencies: {
    kind: 'STRICT',
    singleRow: true,
    triggers: ['agencies_guard', 'agencies_directory_sync'],
    staff: { select: 'true', update: 'true' },
    auth: {
      select: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
      insert: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
      update: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
    },
  },
  // S1-06: CHECK constraints bound every setting, so the suite's invented row needs a valid locale list.
  agency_settings: {
    kind: 'STRICT',
    singleRow: true,
    auth: { insert: 'agency_id = app_agency()' },
    base: { enabled_locales: '{es}' },
  },
  // Logo, colours, contact (S1-06). Created by the agency's first profile save (app_user).
  agency_profiles: { kind: 'STRICT', singleRow: true },
  agency_translations: { kind: 'STRICT' },
  // Membership + role (S1-01, S1-02). app_auth reads only the user it is signing in, and writes only
  // the membership of the user it is signing up or who accepts an invite. Tenant sessions change only
  // role and deactivation, as an admin, never their own (guard trigger, migration 0008).
  // Staff (S1-09) read every agency's members: the tenant detail lists them, and an impersonation session
  // may only target an active member (0026 guard). Staff never write memberships.
  agency_members: {
    kind: 'STRICT',
    guardedInsert: true,
    triggers: ['agency_members_guard'],
    staff: { select: 'true' },
    auth: {
      select: 'user_id = app_user_id()',
      // Sign-up: the agency is one app_auth can see (the PENDING, not-onboarded agency being signed
      // up). Invite: this user accepted an invite of this agency for exactly this role.
      insert:
        'agency_id = app_agency() and user_id = app_user_id() and exists (select 1 from agencies a where a.agency_id = app_agency() union all select 1 from agency_invites i where i.agency_id = app_agency() and i.accepted_user_id = app_user_id() and i.role = agency_members.role)',
      update:
        'agency_id = app_agency() and user_id = app_user_id() and exists (select 1 from agencies a where a.agency_id = app_agency())',
    },
  },
  // Invites (S1-02). Admins create and revoke them (guard trigger); the email job sets the token. The
  // accept flow (app_auth) pins its scope to the agency named in the link, reads that agency's open
  // invites, and marks one accepted by the user it just created. The coalesce reads "open, or
  // accepted by the scoped user" (`accepted_user_id` is set together with `accepted_at`).
  agency_invites: {
    kind: 'STRICT',
    guardedInsert: true,
    triggers: ['agency_invites_guard'],
    auth: {
      select:
        'agency_id = app_agency() and coalesce(accepted_user_id, app_user_id()) is not distinct from app_user_id()',
      // Only with a user in scope, never a revoked invite; the guard trigger (0009) limits it to
      // marking an open invite accepted by that user.
      update:
        'agency_id = app_agency() and revoked_at is null and coalesce(accepted_user_id, app_user_id()) = app_user_id()',
    },
  },
  // Verification (S1-03). The agency submits requests and uploads documents; staff read every agency's
  // and decide requests. Guard triggers (0011): tenants never change a request after submitting it,
  // nor a document once attached; staff change only the decision columns of an open request.
  agency_verification_requests: {
    kind: 'STRICT',
    staff: { select: 'true', update: 'true' },
    triggers: ['agency_verification_requests_guard'],
  },
  agency_verification_documents: {
    kind: 'STRICT',
    staff: { select: 'true' },
    triggers: ['agency_verification_documents_guard'],
  },
  // Website API keys (S1-05). Agency admins manage their own; feed-api (app_public) authenticates a
  // request by prefix before it knows the tenant, so it reads usable keys of every agency: the stored
  // hash is an HMAC under HMAC_KEY of a 256-bit secret, and the rest is metadata the API enforces.
  // `agency_active` mirrors the agency status (app_public cannot read `agencies`).
  // Inserts need the session's own user as creator (guard trigger 0018), which the suite cannot fake.
  api_keys: {
    kind: 'PUBLIC_READ',
    guardedInsert: true,
    triggers: ['api_keys_guard'],
    publicReadSql: 'revoked_at is null and agency_active',
    samples: {
      visible: [{}],
      hidden: [{ revoked_at: '2026-01-01T00:00:00Z' }, { agency_active: false }],
    },
  },
  // Directory of verified agencies (S1-07): name and kind only. Verified agencies read the listed rows
  // (find a partner, show partner names). A trigger on `agencies` keeps it in step in the status change's
  // transaction — staff decisions (app_staff) and app_system. Tenants never write it, and staff write only
  // what `agencies` says (guard trigger, migration 0022); app_user's grant is proven by a no-op update.
  // The `listed = false` side is tested in the agencies module (one row per agency: the suite seeds one).
  agency_directory: {
    kind: 'NETWORK_READ',
    singleRow: true,
    networkReadSql: 'listed',
    staff: { select: 'true', insert: 'true', update: 'true' },
    samples: { visible: [{ listed: true }], hidden: [] },
    triggers: ['agency_directory_guard'],
  },
  // Preferred agencies (S1-07, PLAN §3 #57): the relationship only. The preferred agency reads the rows
  // naming it whose owner is listed (VERIFIED) — what `app_preferring_agencies()` returns to listing
  // policies; a suspended owner's relationships are invisible. Admins of a verified agency add verified
  // agencies, at most 200; rows are never updated (guard trigger 0022). Notes are in the STRICT table below.
  preferred_agencies: {
    kind: 'NETWORK_READ',
    guardedInsert: true,
    networkReadSql:
      'preferred_agency_id = app_agency() and exists (select 1 from public.agency_directory d where d.agency_id = preferred_agencies.agency_id and d.listed)',
    samples: { visible: [{ preferred_agency_id: SAMPLE_READER }], hidden: [{}] },
    triggers: ['preferred_agencies_guard'],
  },
  // The owner's internal note on a preferred agency (S1-07): never visible to the preferred agency.
  // Admins only (guard trigger 0022).
  preferred_agency_notes: { kind: 'STRICT', guardedInsert: true, triggers: ['preferred_agency_notes_guard'] },
  // Audit log (S1-08): append-only, monthly partitions, no UPDATE/DELETE/TRUNCATE for anyone (grants, and
  // triggers for the owner, migration 0024). Rows name who acted, and each role may only name itself:
  // - members' request transactions (app_user) append their agency's rows as their own user, never as
  //   staff. `impersonated_by` must equal the transaction's `app.impersonated_by` (S1-09: set by `withTenant`
  //   for an impersonated session, whose row the request ctx checks first), so an impersonated request
  //   cannot write a row without the staff member, nor a normal one name someone.
  // - login, 2FA and invite flows (app_auth) append `identity.*` rows about the user they are scoped to,
  //   under that user's membership agency (the nil agency without one) — checked here, not trusted from
  //   the caller — as that user or anonymous, never impersonated.
  // - staff (app_staff) append staff and agencies rows naming themselves, and read every row (S1-09).
  audit_logs: {
    kind: 'STRICT',
    immutable: true,
    partitioned: true,
    triggers: ['audit_logs_immutable', 'audit_logs_no_truncate'],
    base: { type: 'iso.fixture', actor_kind: 'user' },
    userInsert: `actor_user_id is not distinct from app_user_id() and actor_kind <> 'staff' and impersonated_by is not distinct from app_impersonated_by()`,
    auth: {
      insert: `agency_id = app_agency() and agency_id = coalesce((select m.agency_id from public.agency_members m where m.user_id = app_user_id()), '${PLATFORM_AGENCY_ID}'::uuid) and target_type = 'user' and target_id = app_user_id() and starts_with(type, 'identity.') and impersonated_by is null and actor_kind in ('user', 'anonymous') and coalesce(actor_user_id, app_user_id()) = app_user_id()`,
    },
    staff: {
      select: 'true',
      insert: `actor_kind = 'staff' and actor_user_id = app_user_id() and impersonated_by is null and split_part(type, '.', 1) in ('staff', 'agencies')`,
    },
  },
  // Staff impersonation sessions (S1-09), under the agency acted on. An impersonated request reads its own
  // session row (app_user, own agency) to check it is still open; tenants never write it (guard 0026; a
  // no-op update proves the grant). The access-token mint (app_auth) reads the staff member's own rows;
  // staff start only their own sessions and end their own; super admins also see and end anyone's (S1-F9).
  // Rows hold the staff member's reason: `app_user` reads a row only as the member it targets (the per-request
  // `isSessionLive` check) or as an admin of the agency (`GET /v1/staff-access`), and never `staff_user_id`
  // (S1-F10, ADR 0016). The admin side is tested in the identity module.
  staff_impersonations: {
    kind: 'STRICT',
    guardedInsert: true,
    userSelect: {
      sql: `target_user_id = app_user_id() or exists (select 1 from public.agency_members m where m.agency_id = app_agency() and m.user_id = app_user_id() and m.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN') and m.deactivated_at is null)`,
      hiddenColumns: ['staff_user_id'],
      samples: { visible: [{ target_user_id: SAMPLE_USER }], hidden: [{}] },
    },
    triggers: ['staff_impersonations_guard'],
    base: {
      reason: 'isolation fixture reason',
      started_at: '2100-01-01T00:00:00Z',
      expires_at: '2100-01-01T00:30:00Z',
    },
    auth: { select: 'staff_user_id = app_user_id()' },
    staff: {
      select: SUPER_ADMIN_OR_OWN_SESSION,
      insert: 'staff_user_id = app_user_id()',
      update: SUPER_ADMIN_OR_OWN_SESSION,
    },
  },
};

/**
 * Tables without `agency_id`. Readable by `app_user`, written only by `withSystem()` (app_system) —
 * except `access: 'auth'` tables, which only `app_auth` and `app_system` reach.
 */
export const globalTables: Record<string, GlobalTable> = {
  // Staff-managed flags; per-agency overrides are ID lists, so agencies cannot enable their own (S0-07).
  feature_flags: { reason: 'platform feature flags, written by staff via withSystem()' },
  // Login identity: looked up by email before any tenant is known; staff users have no agency (S0-09).
  users: { reason: 'login identity, resolved before a tenant is known', access: 'auth' },
  auth_tokens: { reason: 'email verification and password reset tokens (hashed)', access: 'auth' },
  // Second factor (S1-04): checked at login and on every access-token mint, before a tenant is known.
  user_mfa: { reason: 'TOTP second factor of a login identity (secret encrypted)', access: 'auth', userScoped: true },
  user_recovery_codes: { reason: '2FA recovery codes of a login identity (hashed)', access: 'auth', userScoped: true },
  // Staff have no agency (S1-03, ADR 0015). Granted by `pnpm staff:grant`; app_staff reads its own row.
  staff_users: { reason: 'Inmolink staff, who have no agency', access: 'staff' },
};

export const registry: TenantRegistry = { tenant: tenantTables, global: globalTables };

/** Merges registries (production + test fixtures). Duplicate table names are a programming error. */
export function mergeRegistries(...parts: TenantRegistry[]): TenantRegistry {
  const out: TenantRegistry = { tenant: {}, global: {} };
  for (const part of parts) {
    for (const [name, def] of Object.entries(part.tenant)) {
      if (Object.hasOwn(out.tenant, name) || Object.hasOwn(out.global, name)) {
        throw new Error(`table ${name} is registered twice`);
      }
      out.tenant[name] = def;
    }
    for (const [name, def] of Object.entries(part.global)) {
      if (Object.hasOwn(out.tenant, name) || Object.hasOwn(out.global, name)) {
        throw new Error(`table ${name} is registered twice`);
      }
      out.global[name] = def;
    }
  }
  return out;
}
