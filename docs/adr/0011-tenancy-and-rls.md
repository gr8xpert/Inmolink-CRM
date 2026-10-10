# ADR 0011 — Tenancy and row-level security

- **Status:** Accepted (in use since S0-04 and S0-05)
- **Date:** 2026-10-11
- **Task:** S0-04, S0-05, S0-16 (PLAN §2 #7, §3 #1 #32 #53, §12)
- **Related:** ADR 0003 (Argon2id parameters and encryption), ADR 0004 (`app_auth` and identity tables)

> The backlog numbered this "0003 tenancy & RLS + Argon2 params". ADR 0003 already held the password and encryption decision (S0-03) and is cited across the repo, so tenancy got this number and the Argon2id parameters stay in ADR 0003.

## Context

The agency is the tenant (PLAN §3 #1). Principle 7 says tenant isolation is absolute. App-level `where agency_id = …` filters alone fail open the first time someone forgets one, and with AI-written code across about 110 models, someone will. The database itself must refuse cross-tenant reads and writes. Connections go through PgBouncer in transaction mode, so session-level state cannot carry the tenant.

## Decision

### Roles (one pool per role; `packages/db/src/roles.ts`)
| Role | RLS | Statement timeout | Used by |
|---|---|---|---|
| `app_user` | enforced | 5 s | dashboard and API requests (`withTenant`) |
| `app_public` | enforced, read-only, per-table SELECT only | 2 s | feed-api, portal (`withPublicRead`) |
| `app_auth` | enforced, identity tables only | 5 s | sign-up, login, reset (`withAuth`, ADR 0004) |
| `app_system` | BYPASSRLS | 60 s | workers and scripts only (`withSystem(reason, …)`), refused for `APP_ROLE=http` in production |
| `app_owner` | owns tables, no DML grants, sees no rows | — | migrations only, never at runtime |

### Scoping
- `withTenant(scope, fn)` opens a transaction and sets `app.agency_id` and `app.user_id` with `set_config(…, true)` (transaction-local, so PgBouncer-safe). Policies read them through the `app_agency()` and `app_user_id()` helpers.
- Every tenant table has `agency_id`, **forced** RLS, and is listed in the **tenant registry** (`packages/db/src/tenancy/registry.ts`) with a policy kind:
  - **STRICT:** own rows only (`own_rows`, all commands, `app_user`).
  - **NETWORK_READ:** own rows plus a read predicate for other verified tenants (must use `app_agency_verified()` once agencies exist). Holds only shareable columns.
  - **PUBLIC_READ:** own rows plus a `public_read` SELECT for `app_public`. Holds only shareable columns.
  - Options: `appendOnly` (INSERT only, e.g. the outbox) and `authAppend` (`app_auth` may insert `identity.*` events).
  - **Global tables** (no `agency_id`) are declared explicitly: read-only for `app_user`, written through `withSystem()`, `publicRead` opt-in, or `access: 'auth'`.
- **`pnpm db:rls` generates everything** from the registry: helpers, forced RLS, policies and per-table grants (`packages/db/rls/policies.sql`, never hand-edited). App roles have no default privileges, so a table missing from the registry is unreachable (fails closed). The **guard** fails on any `public` table that is neither registered nor declared global. Deploys run migrations, then RLS, then the guard (ADR 0007).
- **Isolation suite** (`pnpm test:isolation`, in `verify` and CI) is generated from the same registry. It seeds rows on both sides of each predicate and asserts that cross-tenant reads, updates, deletes and inserts fail for every table.
- **App-level second layer:** services authorize with `policy.ts` (`can(ctx, action, resource)`), and repos still scope by `ctx`.

## Consequences

- Forgetting a filter returns zero rows instead of another tenant's data. Forgetting to register a table makes it inaccessible, not open.
- **Known limit:** `app_user` can call `set_config('app.agency_id', …)`, so SQL injection in a request path could switch tenants. This is inherent to GUC scoping. The mitigation is that SQL goes only through Drizzle or the `sql` template, never concatenation. A lint against `set_config('app.…', …, false)` and `SET app.` lands with the first `withTenantClient` COPY path.
- **Known gap (before the first NETWORK_READ table):** the guard compares policy names, roles and grants, but not predicates or helper bodies, so a hand-weakened policy passes it. Fix tracked in STATUS.
- `db:rls` rewrites every registered table in one transaction. If lock contention shows up at scale, it will skip tables that already match.
- Backfills cannot run as `app_owner`, which sees no rows. They run as `withSystem()` jobs.
