/**
 * Database roles (PLAN §3 #50, BACKLOG S0-04). One login role per trust level; each runtime
 * pool connects as exactly one of them. Statement timeouts are set on the role, so they hold
 * through PgBouncer transaction pooling (which drops startup `options`). `dml`: may use sequences;
 * table grants come per table from `pnpm db:rls` (S0-05).
 */
export const DB_ROLES = {
  /** Owns the schema. Migrations only — never connected to at runtime. */
  app_owner: { bypassRls: false, readOnly: false, statementTimeout: null, dml: false },
  /** Request paths (dashboard API). RLS applies. */
  app_user: { bypassRls: false, readOnly: false, statementTimeout: '5s', dml: true },
  /** Workers and scripts via `withSystem()`. Bypasses RLS; refused when APP_ROLE=http. */
  app_system: { bypassRls: true, readOnly: false, statementTimeout: '60s', dml: true },
  /**
   * Anonymous auth flows (sign-up, login, email verification, password reset, access tokens) in
   * request paths, via `withAuth()`. Reaches only tables registered with `access: 'auth'` and may
   * INSERT platform outbox events; no tenant table, no BYPASSRLS (S0-09, ADR 0004).
   */
  app_auth: { bypassRls: false, readOnly: false, statementTimeout: '5s', dml: true },
  /**
   * Staff request paths (verification queue, later the staff console) via `withStaff()`. RLS on, no
   * BYPASSRLS: reaches only what the registry's `staff` predicates open, and only while `app.user_id`
   * names an active `staff_users` row (`app_is_staff()`) (S1-03, ADR 0015).
   */
  app_staff: { bypassRls: false, readOnly: false, statementTimeout: '5s', dml: true },
  /** Public read paths (feed-api, portal). Read-only; SELECT only on PUBLIC_READ tables, granted by `pnpm db:rls`. */
  app_public: { bypassRls: false, readOnly: true, statementTimeout: '2s', dml: false },
} as const;

export type DbRoleName = keyof typeof DB_ROLES;

/** Roles an app runtime may open a pool for. `app_owner` is reserved for the migration runner. */
export type RuntimeRole = Exclude<DbRoleName, 'app_owner'>;
