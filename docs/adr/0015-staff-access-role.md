# ADR 0015 — Staff access: `app_staff` login role and `staff_users`

- **Status:** Accepted — new `app_staff` role chosen by Shahzaib, 2026-10-11 (over SECURITY DEFINER functions and worker-applied decisions)
- **Date:** 2026-10-11
- **Task:** S1-03 (PLAN §3 #2 #3, §7 M1 M20, §12); extends ADR 0011 (roles) and ADR 0004 (staff have no agency)

## Context

Staff verify agencies (S1-03) and later run the staff console (S1-09, S13-03). They work across tenants: the verification queue lists every agency's requests, and a decision changes another agency's status. The existing roles do not fit. `app_user` sees one tenant only. `app_system` bypasses RLS and is refused in request paths (CLAUDE.md "Never"). `app_auth` reaches identity tables only. Staff users have no agency (ADR 0004), so `withMemberCtx` refuses them, and the migration 0006 guard blocks tenant roles from changing `agencies.status`.

## Decision

- A sixth login role, **`app_staff`** (RLS on, no BYPASSRLS, 5 s statement timeout), used by `withStaff({ userId, reason }, fn)` in request paths. Only `api` gets `DATABASE_URL_APP_STAFF`.
- **Who is staff:** global table `staff_users` (`user_id`, `role` SUPER_ADMIN / STAFF_SUPPORT / STAFF_DATA_OPS, `deactivated_at`), registry kind `access: 'staff'`. Only `app_system` writes it (`pnpm staff:grant` / `staff:revoke`). `app_staff` reads only the row of the user it acts for (policy `staff_self`). No other role reaches it.
- **What staff reach:** a tenant table opts in with registry `staff: { select?, insert?, update? }` predicates. The generator emits `staff_<cmd>` policies `to app_staff` whose predicate is ANDed with the helper `app_is_staff()` (security invoker: an active `staff_users` row for `app_user_id()`). DELETE is never granted. Tables without `staff` give `app_staff` nothing, and the guard and the generated isolation suite check every table for both cases.
- **Which columns staff change:** guard triggers, as for tenants. Migration 0011 limits `app_staff` to `agencies.status` and to deciding an open verification request once, as itself, with a reason.
- **Core:** `StaffCtx` (no tenant; actor `{ kind: 'staff', userId, role }`) and `withStaffCtx`, which reads the staff role per request. Staff use cases take `StaffCtx`, so tenant and staff use cases cannot be mixed up. Authorization still goes through module policies (`canStaff`).
- **API:** `app.withStaffCtx(req, reason, fn)`. A token with an agency claim is refused (staff have none), and so is a user who is not active staff (403).

## Consequences

- Every environment needs a `DATABASE_URL_APP_STAFF` credential (env examples, Ansible vault `vault_db_app_staff_password`, PgBouncer `get_auth` list, Kamal `api` secret).
- The staff check depends on the `app.user_id` setting, which app code sets after reading the staff role. This is the known limit of ADR 0011: only SQL injection in a staff path could change it, and SQL goes only through Drizzle or the `sql` template. Compared with the existing `app.agency_id` limit, the extra exposure is what staff predicates open (today: reading verification data, deciding requests). Guard triggers still apply, and VERIFIED needs an APPROVED decision recorded in the same transaction (migration 0012). Only `api` holds the credential.
- Staff sign in with a password until S1-04 adds the TOTP that `.claude/rules/security.md` requires for staff. Do not run `pnpm staff:grant` in production before S1-04.
- `staff_users` does not see `users.status`. A disabled account keeps staff access until its 15-minute token expires, unless `pnpm staff:revoke` is run too. Nothing stops a staff user from joining an agency later through an invite (`grantStaff` refuses current members). S1-09 closes both gaps.
- Staff actions are recorded in their own tables (the verification request keeps reviewer, reason and the reviewed version), and `withStaff` sets `app.staff_reason` on the transaction. Nothing reads it yet: S1-08 (`audit_logs`) should, and S1-09 adds impersonation.
- Staff console features add `staff` predicates table by table. Each one is reviewed like a NETWORK_READ predicate.

## Amendment (S1-04, 2026-10-11)
`app_auth` may read the `staff_users` row of the user its flow is scoped to (policy `auth_self`,
`user_id = app_user_id()`), so the access-token mint can require 2FA for staff. Staff must pass 2FA
before any token is minted; `pnpm staff:grant` in production is no longer blocked on S1-04.

## Amendment (S1-09, 2026-10-12): impersonation
- **Sessions are rows**, `staff_impersonations` (STRICT, under the agency acted on; identity module):
  staff member, member, reason (10–500 chars, never copied into `audit_logs`), `started_at`, `expires_at`
  (≤ 60 minutes, CHECK + guard 0026), `ended_at`; one open session per staff member (partial unique index;
  a new start ends the previous one). Staff start and end only their own (registry `staff` predicates +
  guard: as themselves, now, for an active member of an agency that is not suspended; only `ended_at` may
  change, once). Tenants read their agency's rows (the request check below) and never write them. The
  access-token mint (`app_auth`) reads the staff member's own rows (`auth.select: staff_user_id = app_user_id()`).
- **Token:** the web mints an impersonation token only for active staff with no agency who passed 2FA in
  this session and own the live session: `sub` = the member, `agency`, `act` = the staff member, `imp` =
  the session id (after RFC 8693 `act`); API audience only. Staff routes refuse it (it has an agency).
- **Every request re-checks the session** (`withMemberCtx`, one primary-key probe in the request's own
  transaction): ended, expired or revoked → 403 `IMPERSONATION_ENDED` on the very next call, not after the
  15-minute token lifetime. `pnpm staff:revoke` and any `staff:grant` role change end the staff member's open
  session in the same transaction, and each impersonated request also re-reads the staff role in a short
  `app_staff` transaction (withdrawn or downgraded → refused). Not re-checked per request: the staff member's
  `users.status` and `session_version` (app_staff cannot read `users`) — bounded by the 15-minute token, since
  the mint re-checks both (same as every access token). Concurrent starts are serialised per staff member
  (advisory transaction lock). Acting as a user who is staff is refused at the mint (staff cannot see each
  other's `staff_users` rows, so neither the guard nor the staff service can check it).
- **Both actors on every write:** `ctx.actor.impersonatedBy` is set from the checked session, and
  `withTenant` sets `app.impersonated_by`; the `audit_logs` app_user policy requires
  `impersonated_by is not distinct from app_impersonated_by()`, so an impersonated transaction cannot write
  an audit row without the staff member, nor a normal one name someone. Events carry `impersonatedBy`.
- **Deny by default while impersonating** (review): every module policy declares each action `allowed` or
  `forbidden` in a map typed over its action union; `can()` refuses forbidden (and undeclared) actions. Forbidden:
  team and invites (invite, role change, deactivate, revoke/list invites), API key create/rotate/revoke, company
  details and verification, settings, adding preferred agencies, billing changes. Allowed: reads, the profile
  (audited `agencies.profile.updated` with both actors), preferred notes and removal. 2FA and password changes
  act on the web session's own user (the staff member); the web also refuses 2FA enrol/regenerate/disable while
  an impersonation cookie is set.
- Staff (super admin, support) read every agency's `agency_members` for the tenant page and the target check,
  and every `audit_logs` row; reads of a tenant, its members and the audit log are each audited
  (`staff.tenant.read`, `staff.members.read`, `staff.auditLog.read`). The API logs one
  `staff.impersonation.request` line (ids and route only) per impersonated request. Guard 0028 limits session
  starts to SUPER_ADMIN/STAFF_SUPPORT.
