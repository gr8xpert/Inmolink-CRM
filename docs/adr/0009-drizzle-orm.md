# ADR 0009 — Drizzle ORM on node-postgres

- **Status:** Accepted (in use since S0-04)
- **Date:** 2026-10-11
- **Task:** S0-04, S0-16 (PLAN §3 #50, §5.8)

## Context

Plan v1 used Prisma for CRUD and Kysely for complex SQL: two query tools, two type systems and two ways to set the tenant. RLS needs `set_config('app.agency_id', …, true)` inside the same transaction as the queries, which works through PgBouncer in transaction mode. Prisma's connection and transaction model made that awkward. Imports need bulk loads (COPY → staging → MERGE), and reporting and matching need hand-written SQL with full Postgres features (PostGIS, pgvector, `MERGE`, CTEs).

## Decision

1. **Drizzle ORM** (0.45.x) with **drizzle-kit** migrations on **node-postgres** (`pg`). It is SQL-first: the schema is TypeScript in `packages/db/src/schema/<module>.ts`, and queries are the builder or the `sql` template. String concatenation is never used.
2. **One schema file per module.** A module's repo touches only its own file (dependency-cruiser rule, ADR 0010).
3. **Transactions are explicit.** `withTenant(scope, fn)`, `withSystem(reason, fn)`, `withPublicRead(fn)` and `withAuth(fn)` open a transaction on the right role pool, set the GUCs, and hand `fn` a typed `tx`. Services receive `ctx.tx`.
4. **Migrations are generated** (`pnpm db:generate`), reviewed, and applied by `pnpm db:migrate` as `app_owner`. Applied migrations are never edited. CI (`pnpm ci:migrations`) checks that the journal extends the previous release unchanged and that migrations apply both on an empty database and on top of the previous release.
5. **Bulk paths use `pg-copy-streams`:** COPY into a temp staging table, then `MERGE` (PATTERNS §13). Seeds use skip-then-COPY because `app_system` has no TEMPORARY privilege (STATUS decision, S0-13).
6. **Hot paths** select only needed columns, never use `SELECT *`, and use cursor pagination (CLAUDE.md budgets).

## Consequences

- One tool and one type source. Raw SQL is a first-class escape hatch, not a second library.
- drizzle-kit is pre-1.0. Upgrades are pinned PRs (ADR 0001), and the migration check catches journal drift.
- `Tx` is typed with the full schema, so `tx.query.<otherTable>` in a repo needs no import and escapes the boundary check. Code review catches it. Narrowing `Tx` per module is a later option (STATUS decision, S0-12).
- Drizzle relational queries generate SQL we do not hand-tune. On hot paths, prefer explicit selects and check plans with `/perf-check`.
