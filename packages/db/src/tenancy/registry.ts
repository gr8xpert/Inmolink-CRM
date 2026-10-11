/**
 * Tenant registry (PLAN §3 #32 #53, PATTERNS §2) — the single source of truth for RLS policies,
 * table grants (`pnpm db:rls`) and the generated isolation suite (`pnpm test:isolation`).
 *
 * Every table in schema `public` must appear here: tenant tables (with `agency_id`) under
 * `tenantTables`, everything else under `globalTables`. The guard fails on anything unregistered,
 * and an unregistered table gets no grants, so access fails closed.
 */
export type PolicyKind = 'STRICT' | 'NETWORK_READ' | 'PUBLIC_READ';

/** Column overrides (DB column names) for rows the isolation suite seeds. */
export type SampleRow = Record<string, unknown>;

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
     * by them. RLS shares whole rows: keep private columns in a STRICT side table. The predicate must
     * include `app_agency_verified()` once agencies exist (S1-01).
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
   * the user it acts for (`user_id = app_user_id()`, which `app_is_staff()` relies on). Nobody else.
   */
  access?: 'auth' | 'staff';
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
    staff: { insert: `starts_with(type, 'agencies.') and agency_id <> '00000000-0000-0000-0000-000000000000'::uuid` },
  },
  // The tenant itself (S1-01). Sign-up (app_auth) creates it PENDING; a repeated sign-up for an
  // unconfirmed email may rename it while it is still PENDING and not onboarded. Status changes are
  // staff-only (S1-03) — no service lets a tenant write `status`. Staff (app_staff) read every agency
  // and change only `status` (guard trigger, migration 0011).
  agencies: {
    kind: 'STRICT',
    singleRow: true,
    staff: { select: 'true', update: 'true' },
    auth: {
      select: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
      insert: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
      update: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
    },
  },
  agency_settings: { kind: 'STRICT', singleRow: true, auth: { insert: 'agency_id = app_agency()' } },
  agency_translations: { kind: 'STRICT' },
  // Membership + role (S1-01, S1-02). app_auth reads only the user it is signing in, and writes only
  // the membership of the user it is signing up or who accepts an invite. Tenant sessions change only
  // role and deactivation, as an admin, never their own (guard trigger, migration 0008).
  agency_members: {
    kind: 'STRICT',
    guardedInsert: true,
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
  agency_verification_requests: { kind: 'STRICT', staff: { select: 'true', update: 'true' } },
  agency_verification_documents: { kind: 'STRICT', staff: { select: 'true' } },
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
