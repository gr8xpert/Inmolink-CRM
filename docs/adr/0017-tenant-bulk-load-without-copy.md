# ADR 0017 — Tenant bulk loads without COPY: `INSERT … jsonb_to_recordset` into UNLOGGED staging

- **Status:** Accepted — S7-F2 (the shape S6-02 built; recorded from the S6 review)
- **Date:** 2026-10-21
- **Task:** S7-F2 (PLAN §7 M5); amends ADR 0009 decision 5 and PATTERNS §13

## Context

ADR 0009 and PATTERNS §13 said bulk paths `COPY` into a temporary staging table, then `MERGE`. Feed imports run as `app_user` inside `withTenant` (RLS, PLAN §3), and two things rule that out:

- PostgreSQL refuses `COPY FROM` into a table with row-level security for a role without `BYPASSRLS` ("COPY FROM not supported with row-level security"). Copying as `app_system` would skip the tenant check on every staged row.
- App roles have no `TEMPORARY` privilege (S0-04), so there is no per-transaction temp table to copy into either.

## Decision

- **Tenant bulk loads** (feeds, and any later load running as `app_user`) stage into a permanent **UNLOGGED tenant table** (`property_import_staging`: `agency_id`, registry entry, RLS), keyed by a per-batch id. Rows go in with one `INSERT … SELECT … FROM jsonb_to_recordset($1::jsonb)` per ≤ 8 MB of JSON (one bind parameter per statement), are `MERGE`d into the target, and are deleted in the same transaction.
- Statements that read staging never rely on its statistics (it looks empty to the planner between batches): lookups are driven by array parameters or by the batch id on the primary key.
- **`COPY` stays** for system scripts that run with `withSystemClient` and own their rows (seeds: skip-then-COPY, S0-13), and for read-only exports.

## Consequences

- RLS checks every staged row; no load path needs `BYPASSRLS` or a temporary table.
- A batch of 500 listings costs a fixed handful of statements (S6-02 statement-count test); JSON encoding costs some CPU against COPY's CSV, measured at 100 MB per run in 48–57 s (S6-02 perf).
- UNLOGGED: staging rows are lost on a crash, which is fine — they never outlive their transaction.
- Autovacuum is tuned on the staging table (insert/delete churn, S6-02).
