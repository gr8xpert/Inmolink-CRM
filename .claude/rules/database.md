---
paths:
  - "packages/db/**"
  - "packages/core/src/modules/**/repo.ts"
  - "scripts/**/*.sql"
  - "scripts/legacy-migration/**"
---

# Database rules (PostgreSQL + Drizzle)

## Schema
- One schema file per owning module: `packages/db/src/schema/<module>.ts`. Tables are snake_case plural; columns snake_case; TypeScript names camelCase.
- Primary keys: `uuid` filled with UUIDv7 from `@inmolink/platform/ids` (app-side). Never serial IDs for entities.
- Every tenant-owned table: `agency_id uuid not null` + entry in `packages/db/src/tenancy/registry.ts` with its policy kind (`STRICT`, `NETWORK_READ`, `PUBLIC_READ`). Run `pnpm db:rls` after adding a table.
- Standard columns: `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` (set by repo on update), `deleted_at timestamptz` only where soft delete is specified.
- Money: `bigint` cents + `char(3)` currency. Percent: `integer` basis points. Areas: `numeric(10,2)` m². Never floats for money or areas.
- Enums: `pgEnum` for closed sets that rarely change; add values via migration only (never remove in the same release).
- JSONB only for genuinely schemaless payloads (feed raw data, AI outputs, snapshots). Never for fields you filter on — promote those to columns.
- Translations: separate `<entity>_translations` tables keyed by `(entity_id, locale)`.

## Indexes
- Every foreign key has an index. Tenant tables lead composite indexes with `agency_id`.
- Every hot-path query has a supporting index; put a one-line comment above the index naming the query it serves.
- List endpoints sort by `(created_at, id)` or another unique tuple and use keyset (cursor) pagination.
- Use partial indexes for common filters (`where deleted_at is null`, `where status = 'ACTIVE'`).
- Geo: GiST on geometry columns. Text search: `pg_trgm` GIN only where used. Vectors: HNSW on `halfvec`.

## Partitioning
- Monthly range partitions via pg_partman from day 1 for: `activities`, `audit_logs`, `notifications`, `api_usage_daily`, `search_query_logs`, `property_stats_daily`, `agency_stats_daily`. Primary key must include the partition column.

## Migrations
- Generate with `pnpm db:generate`; review the SQL before applying. Never edit an applied migration.
- Expand → migrate → contract: add nullable column / new table → backfill in a job → switch reads/writes → drop old in a later release.
- No long locks: create indexes `CONCURRENTLY` in a custom migration on large tables; backfills in batches of ≤ 5,000 rows.

## Queries
- Select only the columns you need. No `select *` on hot paths. No queries inside loops — batch with `inArray` or joins.
- Use `withTenant(ctx)` for request work. `withSystem()` only in workers/scripts and always with a reason string (audited).
- Keep transactions short. Never await network calls (search, email, AI, HTTP) inside a transaction.
- Work queues and claims: `FOR UPDATE SKIP LOCKED`.
- Bulk loads: staging table → validate → `MERGE` into the target → delete the batch's staging rows. Never row-by-row inserts for feeds or migrations.
  - Tenant loads (`app_user`, e.g. feeds): `INSERT … SELECT … FROM jsonb_to_recordset($1::jsonb)` (≤ 8 MB per statement) into an UNLOGGED tenant staging table keyed by batch id — **not COPY**: RLS refuses `COPY FROM` for a role without BYPASSRLS, and app roles have no TEMPORARY (ADR 0017).
  - System scripts (`withSystemClient`, e.g. seeds): `pg-copy-streams` is fine.
- Statement timeouts are set per role/connection (feed 2 s, dashboard 5 s, worker 60 s). Do not raise them to hide a slow query — fix the query.
- Before marking a hot-path task done, run `EXPLAIN (ANALYZE, BUFFERS)` on the scale seed and include the plan summary in STATUS.

## Read models
- `listing_read_models` (listing × locale) holds denormalized card + detail JSON for public paths. They are rebuilt by outbox consumers only, never written by request handlers.
