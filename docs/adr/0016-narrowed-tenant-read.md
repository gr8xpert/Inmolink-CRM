# ADR 0016 — Narrowed tenant read: `userSelect` and column grants

- **Status:** Accepted — S1-F10 (decided by the task; flagged in STATUS)
- **Date:** 2026-10-14
- **Task:** S1-F10 (PLAN §12); extends ADR 0011 (policy kinds) and ADR 0015 (staff sessions)

## Context

A STRICT table gives `app_user` every row of its agency. `staff_impersonations` holds the staff member's id and the stated reason. Every agent could read both through RLS, although only admins may see the access record (`GET /v1/staff-access`) and nobody in the agency should learn which staff member acted (S1-F9 security audit, Low–Medium). The guard also refused column-level grants, so the narrowing could not be written as a registry entry.

## Decision

- **Rows:** a STRICT table may declare `userSelect: { sql, hiddenColumns?, samples }`. `own_rows` is then replaced by `own_insert`, `own_update` and `own_delete` (all `agency_id = app_agency()`) and a `user_select` policy: `agency_id = app_agency() and (<sql>)`. The predicate is about the reading user (`app_user_id()`); it is trusted source like `networkReadSql` (single expression, no `;` or comments). Not valid together with `appendOnly` or `immutable`.
- **Columns:** `hiddenColumns` are unreadable to `app_user`. The generator grants `SELECT (<every other column>)` from a `do` block that reads the column list from the catalog when the SQL runs; INSERT, UPDATE and DELETE stay table-wide (guard triggers narrow writes). We chose column grants over a `SECURITY DEFINER` reader: the only definer helper stays `app_partition_maintenance()`, there is no new function for the guard to vet, and the database refuses `select *`, `where staff_user_id = …` and `order by staff_user_id` outright instead of relying on callers.
- **Guard:** policies are compared by name, command and role as before (`own_insert`, `own_update`, `own_delete`, `user_select`); table privileges still compare through `has_any_column_privilege`; a new check requires every hidden column to be unreadable and every other column readable by `app_user`. A column added by a migration is unreadable until `pnpm db:rls` runs: the guard says so (fails closed).
- **Isolation suite:** a `userSelect` table is read as a member (`SAMPLE_USER` in samples names the reading user). Generated cases: no user or another user reads none, the reader reads exactly the visible samples, hidden columns fail on select, star, filter and order. A fixture table (`iso_fx_user_read`) proves the generator; branches that need other rows (an agency admin) are tested by the owning module.
- **`staff_impersonations`:** a row is readable by the member it targets, or by an active `AGENCY_ADMIN` / `DEVELOPER_ADMIN` of the agency; `staff_user_id` is hidden. The per-request `isSessionLive` check no longer filters on `staff_user_id`: the id is read from the signed token that the mint built from the row, and a session's staff member never changes (guard 0028).

## Consequences

- `app_user` code can no longer select `staff_user_id` from `staff_impersonations`; staff (`app_staff`), the mint (`app_auth`) and workers (`app_system`) are unchanged.
- Run `pnpm db:rls` after deploying the migrations that add columns to a `userSelect` table.
- The admin branch is an uncorrelated `exists` on `agency_members` (it pins `m.agency_id = app_agency()`, not the row's column), so it does not depend on the row being tested.
