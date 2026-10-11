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
}

export interface AuthAccess {
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
   */
  access?: 'auth';
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
  outbox_events: { kind: 'STRICT', appendOnly: true, authAppend: { column: 'type', prefix: 'identity.' } },
  // The tenant itself (S1-01). Sign-up (app_auth) creates it PENDING; a repeated sign-up for an
  // unconfirmed email may rename it while it is still PENDING and not onboarded. Status changes are
  // staff-only (S1-03) — no service lets a tenant write `status`.
  agencies: {
    kind: 'STRICT',
    singleRow: true,
    auth: {
      select: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
      insert: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
      update: `agency_id = app_agency() and status = 'PENDING' and onboarded_at is null`,
    },
  },
  agency_settings: { kind: 'STRICT', singleRow: true, auth: { insert: 'agency_id = app_agency()' } },
  agency_translations: { kind: 'STRICT' },
  // Membership + role (S1-01). app_auth reads only the user it is signing in, and writes only the
  // membership of the user it is signing up, in the agency that sign-up created.
  agency_members: {
    kind: 'STRICT',
    auth: {
      select: 'user_id = app_user_id()',
      // The agency must be one app_auth can see: the PENDING, not-onboarded agency being signed up.
      insert:
        'agency_id = app_agency() and user_id = app_user_id() and exists (select 1 from agencies a where a.agency_id = app_agency())',
      update:
        'agency_id = app_agency() and user_id = app_user_id() and exists (select 1 from agencies a where a.agency_id = app_agency())',
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
