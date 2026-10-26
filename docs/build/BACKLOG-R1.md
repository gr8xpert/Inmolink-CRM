# Backlog — R0 + R1 (Switch-ready)

Every task Claude builds for R1, in order. Read with `CLAUDE.md` (protocol, budgets, Definition of Done) and `docs/build/PATTERNS.md` (code shapes).

**Format**
- `Ref` — PLAN.md sections to read · `Mod` — owning module(s) · `Dep` — tasks that must be `DONE` first
- `[Hn]` — needs human action n from `HUMAN-ACTIONS.md` (build with fixtures/mocks if missing, then mark `BLOCKED-HUMAN Hn`)
- ⚡ hot path → run `/perf-check` · 🔒 security-sensitive → run `security-auditor`
- **Done when** — acceptance checks; each needs a test named `[<task-id>] …` unless marked *(manual)*

Status values (tracked in `STATUS.md`): `TODO` · `DOING` · `DONE` · `BLOCKED-HUMAN Hn` · `BLOCKED <reason>`

---

## S0 — Foundation

### S0-01 · Monorepo scaffold and tooling
Ref §5.7 §5.8 §18 · Mod — · Dep —
**Build:** pnpm workspace + Turborepo with every app and package from §5.7 as an empty, building skeleton. TypeScript strict presets in `packages/config`. Biome, Vitest workspace, husky + lint-staged, path aliases, `.editorconfig`, `.gitignore`, `.env.example`. Root scripts listed in `CLAUDE.md` (stubs allowed where the feature comes later). Pin current stable versions and record them in ADR 0001.
**Done when:**
- `pnpm i && pnpm build && pnpm typecheck && pnpm lint && pnpm test` pass on a clean clone
- `pnpm verify` exists and runs only affected packages (Turbo filters)
- Every package exports a placeholder and builds independently

### S0-02 · Local stack
Ref §5.1 §5.8 · Mod — · Dep S0-01
**Build:** `docker-compose.yml` with profiles `dev` and `test`: PostgreSQL 17+ with PostGIS, pgvector, pg_trgm, pg_partman; PgBouncer (transaction mode); `redis-queue` (noeviction, AOF) and `redis-cache` (allkeys-lru); Meilisearch; MinIO (R2 stand-in); Mailpit; OpenTelemetry collector + Jaeger. `pnpm dev` starts infra + apps; `scripts/ops/health.ts` checks all services.
**Done when:**
- `docker compose --profile dev up -d && pnpm dev` brings everything up; health script passes
- `test` profile uses separate ports/volumes so tests never touch dev data
- Extensions are created by an init script and verified by the health check

### S0-03 · Platform core
Ref §3 #52 §12 · Mod platform · Dep S0-01 · 🔒
**Build:** `platform/config` (Zod-validated env, fails fast), `platform/logger` (pino, request IDs, PII redaction list), `platform/errors` re-export of `AppError`, `platform/ids` (UUIDv7, listing refs), `platform/clock` (fakeable), `platform/crypto` (AES-256-GCM with key IDs + rotation, HMAC, Argon2id password helpers), `platform/http` (cache-control builders, ETag helpers).
**Done when:**
- Missing/invalid env var stops boot with a clear message
- Redaction removes configured fields (email, phone, password, token, key) from logs
- Encrypt → rotate key → decrypt with old key ID works; tampered ciphertext is rejected
- UUIDv7 values sort by creation time

### S0-04 · Database package
Ref §3 #50 #52 §5.8 · Mod db · Dep S0-02 S0-03
**Build:** Drizzle on node-postgres; pools per role: `app_owner` (migrations only), `app_user` (no BYPASSRLS), `app_system` (BYPASSRLS, workers/scripts only), `app_public` (read-only). Role-level `statement_timeout` (feed 2 s, dashboard 5 s, worker 60 s). drizzle-kit config with schema glob `packages/db/src/schema/*.ts`. `withTenant`, `withSystem`, `withPublicRead`, `getPgClient` (PATTERNS §3). Migration runner `pnpm db:migrate`.
**Done when:**
- `withTenant` sets `app.agency_id` transaction-locally and it is gone in the next transaction on the same pooled connection (tested through PgBouncer)
- `withSystem` throws when `APP_ROLE=http`
- A query exceeding the role timeout is cancelled

### S0-05 · Tenant registry, RLS generator, isolation harness
Ref §3 #32 #53 §12 · Mod db · Dep S0-04 · 🔒
**Build:** `packages/db/src/tenancy/registry.ts`; `pnpm db:rls` generates SQL for helper functions and STRICT / NETWORK_READ / PUBLIC_READ policies (PATTERNS §2) and applies it. Generated isolation suite `tests/isolation`: for each registered table, tenant B cannot select/update/delete tenant A's rows; NETWORK_READ tables are readable only under their predicate and never writable. CI guard: any table with an `agency_id` column that is not registered, or has RLS disabled, fails.
**Done when:**
- A planted unregistered table with `agency_id` fails `pnpm test:isolation`
- A planted table with RLS disabled fails the guard
- STRICT and NETWORK_READ fixture tables pass all generated cases

### S0-06 · Outbox and queues
Ref §5.3 (6, 7) · Mod platform · Dep S0-04
**Build:** `outbox_events` table; `defineEvent`, `emit(tx, event)`, `subscribe(event, handler)`; dispatcher (claims with `FOR UPDATE SKIP LOCKED`, LISTEN/NOTIFY wake-up, batch 500). `defineJob` over BullMQ with pools, stable job IDs, retries/backoff, dead-letter queue, debounce, per-group fair share (`group`, `concurrencyPerGroup`). `scripts/ops/replay-outbox.ts`.
**Done when:**
- An event emitted in a rolled-back transaction is never dispatched
- Dispatcher sustains ≥ 2,000 events/s locally with zero loss across a Redis restart (AOF)
- Same `jobId` enqueued twice runs once; debounced jobs collapse bursts into one run
- With 10 groups, one group flooding 1,000 jobs does not delay another group's job by more than one job duration

### S0-07 · Cache, rate limits, feature flags
Ref §3 #42 §5.3 (11) · Mod platform · Dep S0-04
**Build:** `platform/cache` (Redis read-through with single-flight, tags, in-process LRU for hot config); `platform/rate-limit` (sliding window per IP/user/key/tenant, Fastify plugin); `feature_flags` table + `flag(ctx, key)` with per-agency overrides, cached 60 s.
**Done when:**
- 100 concurrent misses on one key cause exactly one loader call
- Tag invalidation removes all tagged keys
- Rate limit returns 429 with `Retry-After`; limits are per scope
- Flag override for one agency does not affect others

### S0-08 · App skeletons
Ref §5.2 §3 #38 · Mod apps · Dep S0-03 S0-04 S0-07
**Build:** Fastify apps `api`, `feed-api`, `realtime` (Socket.io + Redis adapter), `worker` (pool runner by env `WORKER_POOLS`), Next.js apps `web`, `public` (next-intl, Tailwind, shadcn base in `packages/ui`). Plugins: request ID, error mapping (`AppError` → HTTP JSON), Zod type provider, OpenAPI (`/docs` in dev), `withCtx`. `/healthz` and `/readyz` (DB, Redis, search). Graceful shutdown everywhere.
**Done when:**
- All apps boot with `pnpm dev`; `/readyz` fails when Postgres is stopped
- `AppError('VERSION_CONFLICT')` thrown in a service returns 409 with the standard error body
- SIGTERM drains in-flight requests/jobs within 30 s

### S0-09 · Authentication foundation
Ref §3 #30 #31 · Mod identity · Dep S0-08 · 🔒
**Build:** Auth.js in `apps/web` (email + password with Argon2id, email verification, password reset via Mailpit locally); session → 15-minute JWT (audience per app) for `api` and `realtime`; Fastify `requireSession` plugin; login/logout/reset pages (EN/ES).
**Done when:**
- Sign-up → verify email → log in → call an authenticated API route works end to end (Playwright)
- Expired or wrong-audience JWT is rejected with 401
- Reset tokens are single-use and expire in 60 minutes
- Login is rate-limited per IP and per email

### S0-10 · Observability
Ref §17 §3 #44 · Mod platform · Dep S0-08
**Build:** OpenTelemetry SDK in all Node apps (HTTP, pg, Redis, BullMQ spans; RED metrics); Sentry for Node and Next.js; structured logs with trace IDs; Grafana dashboard JSON stubs in `infra/grafana/`.
**Done when:**
- One trace links web → api → Postgres → outbox → worker locally in Jaeger
- Errors reach Sentry (DSN from env) with release and request ID tags
- Metrics endpoint exposes request rate, error rate and latency histograms per route

### S0-11 · i18n foundation
Ref §3 #14 #15 · Mod i18n · Dep S0-08
**Build:** `packages/i18n` with `locales.ts` (UI locales and content locales, config-driven), message catalogs (EN, ES), next-intl wiring in both Next apps, locale formatters, `pnpm i18n:draft` (finds missing keys, drafts them via the AI gateway once S12-01 exists — until then writes TODO markers), `pnpm i18n:check` in CI.
**Done when:**
- Locale-prefixed routing works in `web` and `public`
- `pnpm i18n:check` fails on a key missing in EN or ES
- Adding a locale is config-only (no code change)

### S0-12 · Module scaffolder and boundary rules
Ref §3 #51 · Mod — · Dep S0-04 S0-08
**Build:** `pnpm gen:module <name>` (plop or a small script) producing PATTERNS §1 layout + schema file + contracts file + route plugin + test file. `.dependency-cruiser.cjs` rules: apps → core/contracts/ui only; core modules → other modules only via `index.ts`; repos → only their own schema file; platform never imports core. `pnpm check:boundaries` in `verify`.
**Done when:**
- Generated module passes typecheck, lint and boundaries
- A planted import of another module's `repo.ts` fails `check:boundaries`
- A planted import of `@inmolink/db/schema/<other>` from a repo fails

### S0-13 · Seed and scale generator
Ref §4.1 §15 · Mod scripts · Dep S0-04 S0-06
**Build:** `pnpm db:seed` (5 agencies, 25 users, 500 listings, contacts, leads — grows as modules land) and `pnpm db:seed:scale --agencies=N` (COPY-based synthetic generator following §4.1 ratios; deterministic with a seed). Logins for demo users printed at the end.
**Done when:**
- Dev seed completes in < 30 s
- `--agencies=1000` completes locally in < 15 min; `--agencies=5000` profile documented for staging
- Re-running the seed is idempotent

### S0-14 · CI pipeline
Ref §18 · Mod — · Dep S0-05 S0-12
**Build:** GitHub Actions: install with pnpm store + Turbo cache; typecheck, lint, boundaries, unit, integration (service containers), isolation, i18n check, build, migration check (apply all migrations to an empty DB and to the previous release's schema). Docker image build per app on main.
**Done when:**
- Pipeline green on main; typical PR run < 12 minutes with cache
- A failing isolation or boundary check blocks merge

### S0-15 · Deploy, backups and HA
Ref §5.5 §3 #35 #36 #40 · Mod infra · Dep S0-14 · [H4] [H5] [H3]
**Build:** Ansible baseline (users, SSH hardening, firewall, unattended upgrades, node exporter, Docker); Kamal configs for staging and production (app-1, db-1, db-2); Postgres primary on db-1 with streaming replica on db-2 (other datacenter); WAL-G continuous archiving to R2 + nightly base backup; `scripts/ops/restore-drill.ts`; runbooks `docs/runbooks/{deploy,failover,pitr-restore}.md`.
**Done when:**
- `kamal deploy` to staging is zero-downtime (*manual check*: continuous curl during deploy shows no errors)
- PITR restore to a chosen timestamp on a fresh server succeeds; measured RTO recorded
- Replica lag visible in Grafana; alert fires when lag > 60 s

### S0-16 · Project docs and ADRs
Ref §22 §23 · Mod docs · Dep S0-01
**Build:** README (setup in 10 steps), ARCHITECTURE.md (diagram from §5.1 + module map), CHANGELOG (Keep a Changelog), TROUBLESHOOTING, ADRs 0001 stack + versions, 0002 media content addressing, 0003 tenancy & RLS + Argon2 params, 0004 website API & caching, 0005 search adapter & fallback, 0006 legacy migration, 0007 backups & HA, 0008 AI gateway + model defaults, 0009 Drizzle, 0010 modular monolith & boundaries.
**Done when:** *(manual)* a new developer can run the stack from README alone; each ADR states context, decision, consequences.

---

## S1 — Tenancy & identity

### S1-01 · Agencies and signup
Ref §3 #1 #3 §6 Identity · Mod agencies, identity · Dep S0-09 S0-05
**Build:** `agencies`, `agency_settings`, `agency_translations`; signup creates user + agency-of-one (status PENDING, kind AGENCY or DEVELOPER); onboarding form for company details (name, CIF/NIF, address, region, languages).
**Done when:**
- Signup creates exactly one agency + admin user in one transaction
- New agency is PENDING and cannot set SHARED/PUBLIC or create API keys (`VERIFICATION_REQUIRED`)
- CIF/NIF format validated (Spanish rules) with a clear error

### S1-02 · Users, roles, invites, seats
Ref §3 #2 · Mod identity · Dep S1-01
**Build:** roles per §3 #2; invite by email (signed token, 7-day expiry, single use); role changes; deactivate user; seat count check hook (`billing.assertSeat`, stubbed until S13).
**Done when:**
- Invite accept joins the inviting agency with the chosen role; reused or expired tokens fail
- Only AGENCY_ADMIN can invite or change roles; an agent cannot elevate itself
- Deactivated users cannot log in; their sessions are revoked

### S1-03 · Agency verification
Ref §3 #3 §7 M1 · Mod agencies · Dep S1-01 · 🔒
**Build:** document upload (private R2 bucket, signed URLs), verification request, staff queue with approve/reject + reason, status change events, emails to the agency.
**Done when:**
- Approve → VERIFIED unlocks SHARED/PUBLIC/API keys immediately (cache invalidated)
- Verification documents are never readable by other tenants or via public URLs
- Every decision is in the audit log with reviewer and reason
- Note (S1-01): approval records the details `version` staff reviewed and is refused if the agency changed since; invalidate the tenant info read by `withMemberCtx` once it is cached.

### S1-04 · Two-factor authentication
Ref §3 #30 §12 · Mod identity · Dep S0-09 · 🔒
**Build:** TOTP enrol/verify/disable, 10 hashed recovery codes, enforcement policy (required for staff and AGENCY_ADMIN; optional for others), remember-device 30 days.
**Done when:**
- Required roles cannot reach the dashboard without completing 2FA
- Recovery codes are single-use
- Verification attempts are rate-limited

### S1-05 · API keys
Ref §3 #30 §9.1 · Mod identity · Dep S1-03 · 🔒
**Build:** create/rotate/revoke keys (secret and publishable), scopes, origin allowlist (publishable), per-key rate tier, `last_used_at` (batched updates). Format and storage per `.claude/rules/security.md`. Fastify `requireApiKey(scope)` plugin (used by feed-api in S7).
**Done when:**
- Secret is shown once; only prefix + hash are stored
- Revoked key is rejected within 60 s (cache TTL)
- Publishable key from a non-allowlisted origin is rejected
- Note (S1-01): call `agencies.assertVerified(ctx, 'apiKey.create')` before creating a key.

### S1-06 · Agency profile and settings
Ref §6 Identity §3 #7 #8 · Mod agencies · Dep S1-01
**Build:** profile (logo, colours, contact, register number, languages, translations), settings (default commission, registration validity days, viewing response days, enabled locales, white-label options, Client Mode PIN policy). Commission defaults (5 % and a 50/50 split): S1-06-F1.
**Done when:**
- Settings changes emit `agencies.settings.changed` and invalidate cached settings
- Logo upload goes through the media pipeline once S3-03 exists (stub until then)

### S1-07 · Preferred agencies
Ref §3 #57 §7 M1 · Mod agencies · Dep S1-03
**Build:** add/remove preferred agencies (verified only), list with notes; `app_is_preferred_by()` SQL helper used by NETWORK_READ policies.
**Done when:**
- A PREFERRED-scope listing is visible to preferred agencies and invisible to others (isolation-style test, added with S3-02)
- Removing an agency from the list revokes access on the next query

### S1-08 · Audit log
Ref §6 Support/audit §12 · Mod compliance · Dep S0-06
**Build:** partitioned `audit_logs`; `audit(ctx, type, target, metadata)` helper; security events wired (login, 2FA, role change, key create/revoke, verification decision, impersonation).
**Done when:**
- Audit rows are append-only (no update/delete grants for app roles)
- Partitions for the next 3 months exist (pg_partman maintenance job)

### S1-09 · Staff console shell and impersonation
Ref §7 M20 · Mod admin · Dep S1-03 S1-08 · 🔒
**Build:** `/staff` area in `apps/web` (staff roles only): tenants list/search/detail, verification queue, audit viewer, impersonation (reason required, banner, time-limited, fully audited, no billing/2FA changes).
**Done when:**
- Non-staff get 404 on `/staff` routes and 403 on staff APIs
- Every action during impersonation records both staff and impersonated user

### S1-10 · Dashboard shell
Ref §2 · Mod web · Dep S0-09 S0-11
**Build:** app layout, role-based navigation, locale switcher, notifications bell placeholder, empty states, error boundaries, loading skeletons, keyboard shortcuts for search.
**Done when:**
- Dashboard route first-load JS ≤ 250 KB gzip
- Lighthouse accessibility ≥ 90 on the shell

### S1 follow-ups from the S0 review (`docs/build/reviews/S0.md`)
Small hardening tasks. Take them between feature tasks; the 🔒 ones before S1-05 (API keys) at the latest.

### S1-F1 · Test reliability
Ref §15 · Mod tests · Dep S0-14
**Build:** Playwright e2e against `next build` + `next start` instead of `next dev` (the reload loop: two of four e2e tests failed in the S0 review run); then add e2e to CI. Integration `setupTestDb` hooks get a timeout that survives a full, non-affected `verify` (the identity suite timed out at 10 s under full parallel load, then passed alone). Package `test:int` scripts still use Vitest's 5 s / 10 s defaults while the root projects use 30 s+; align them.
**Done when:**
- `pnpm test:e2e` passes 3 runs in a row locally and runs in CI
- A full `turbo run … test:int` (no `--affected`) passes twice in a row

### S1-F2 · Outbox hardening
Ref §5.3 #6 · Mod platform · Dep S0-06
**Build:** per-tenant fairness in the claim query (one agency's burst must not delay others' events); per-table autovacuum settings for `outbox_events`; either per-subscriber delivery tracking or a PATTERNS §8 rule that each subscriber is idempotent on its own (a retry re-runs all subscribers); one shared `PLATFORM_AGENCY_ID` (now in `db/tenancy/rls.ts` and `platform/outbox/emit.ts`); implement ADR 0014 (accepted: poll only): `emit()` sends no NOTIFY, each lane polls every 250 ms and drains without pause while batches are full, remove `DATABASE_URL_LISTEN` / `packages/db/src/listen.ts` and the `app_listen` follow-up.
**Done when:**
- With 10 agencies, one agency emitting 50,000 events does not delay another agency's event by more than one batch
- An idle dispatcher picks up a new event within one poll interval (250 ms); ≥ 2,000 events/s still holds (ADR 0014)
- A test fails if the two platform agency IDs ever differ

### S1-F3 · Platform and core cleanups
Ref §5.3 · Mod platform, core · Dep S0-07 S0-11
**Build:** feature-flag reload on its own short read, not on the first caller's `tx` (a failed request transaction must not fail concurrent flag reads); narrow `Locale` in `core/context.ts` to the i18n type; the `gen:module` policy template gets the Client Mode branch from PATTERNS §6; `withTenant`/`withSystem` fold `set_config` into the first statement (3 round trips → 1 per transaction, feed-api budget ≤ 3 queries); queue fair share uses growing backoff for over-cap groups instead of re-delaying at the same priority.
**Done when:**
- A flag read during another request's failed transaction succeeds
- `withTenant` with one query issues one round trip plus commit (counted by `countQueries()`)

### S1-F4 · Identity follow-ups · 🔒
Ref §6 Identity · Mod identity, web · Dep S0-09
**Build:** `policy.test.ts` for `loginDecision` / `canIssueAccessToken`; web auth paths pass the incoming request ID instead of `authCtx(newId())`; debounce verification emails per user on unverified logins; `/v1/me` through an `identity.getMe` service; a maintenance job that prunes used/expired `auth_tokens`.
**Done when:**
- Ten logins to an unverified account within 10 minutes send one email
- Expired and used tokens older than 7 days are deleted by the job

### S1-F5 · Security hardening · 🔒
Ref §14 · Mod platform, infra · Dep S0-15
**Build:** production refuses the committed example `ENCRYPTION_KEYS`, `HMAC_KEY` and `AUTH_SECRET` by value (not only by the `dev` prefix); 401 bodies give no token-failure reason (log it instead); logger redacts `name`; replace the hard per-email login block with a Turnstile step after the limit; Kamal: Cloudflare Authenticated Origin Pulls (or `TRUST_PROXY` by hop count) and drop the Workers range `2a06:98c0::/29`, narrow `172.16.0.0/12` to the kamal network, redis-cache `requirepass`, a search-only Meilisearch key for api/feed-api instead of `MEILI_MASTER_KEY`.
**Done when:**
- Production config with an example secret minus its `dev` prefix fails to load
- A 401 body is identical for expired, unknown-key and wrong-audience tokens

### S1-F6 · Database and Redis operations
Ref §5.5 §5.6 · Mod infra · Dep S0-15
**Build:** PgBouncer `query_wait_timeout` ≈ 5 s and `max_db_connections` below `max_connections`; `idle_in_transaction_session_timeout` 10–30 s for `app_user`, `app_auth`, `app_public`, `app_staff`; rate-limit counters on a Redis that does not evict (redis-queue with a prefix, or a `volatile-lru` split); scale seed throughput (bigger chunks, buffered COPY writes; 25k users took 15.2 s).
**Done when:**
- A saturated pool returns an error within 6 s instead of waiting 120 s
- `pnpm db:seed:scale --agencies=5000` users phase runs ≥ 5× faster

### S1-F7 · Verification follow-ups (S1-03 reviews)
Ref §3 #3 §12 · Mod agencies, identity, platform · Dep S1-03 (image part: S3-03)
**Build:** re-encode image verification documents with sharp (strips EXIF and payloads), plus a scan hook that does nothing until a scanner is configured, once the media pipeline brings sharp (S3-03); a maintenance job that deletes `verification/<agency>/…` objects with no row (crash between store and record, failed deletes, deleted agencies); one decision email job per recipient (`jobId` per event + recipient, fair-share `group` = agency); an advisory lock on the agency for the document cap; `Idempotency-Key` on the upload (or dedupe on `(agency_id, sha256)` among unattached documents); refuse invites and sign-ups for staff users, and end staff access when `users.status` is not ACTIVE (with S1-09).
**Done when:**
- An uploaded JPEG is stored without EXIF
- An object without a document row older than 24 h is deleted by the job
- A retried decision email job does not email an admin who already got it
- Eleven parallel uploads leave at most ten unsubmitted documents

### S1-F8 · Two-factor follow-ups (S1-04 reviews) · 🔒
Ref §12 · Mod identity, web · Dep S1-04
**Build:** email the user when 2FA is turned on or off, a recovery code is used, or a new browser is remembered (the `identity.twoFactor.*` events exist); step-up before enrolment for accounts without 2FA (fresh password or emailed link), so a stolen password alone cannot enrol first; "forget all remembered browsers" (a per-user counter in the device signature); count failed codes per user and IP so someone with the password cannot lock the owner out of the challenge; create the pending secret in a POST instead of the enrolment page's GET; one query for MFA + staff state on the mint; S1-09: impersonation must not reach 2FA settings.
**Done when:**
- Each 2FA change emails the account owner (EN/ES)
- Enrolment without an existing factor needs a fresh password check
- The owner can still pass the challenge while another client is rate-limited

### S1-F9 · Staff console follow-ups (S1-09 reviews) · 🔒
Ref §7 M20 §12 · Mod identity, agencies, compliance, web · Dep S1-09
**Build:** end open impersonation sessions when the staff account is disabled or its session version changes (the per-request check cannot read `users` as `app_staff`; today bounded by the 15-min token); show agency members that staff accessed their account (access history from `staff.impersonation.*` audit rows); a super admin can end another staff member's session; names instead of ids in the audit viewer; `pg_trgm` index for tenant search before agencies pass 10k (leading-`%` ILIKE scans today); countdown in the banner; run `tests/e2e/staff.spec.ts` and keep it in CI; narrow tenant read of `staff_impersonations` (members can read `reason` via RLS; no endpoint shows it).
**Done when:**
- Disabling a staff account ends its impersonation on the next request
- Agency admins can see when staff accessed their account and why
- The staff e2e spec runs green in CI

### S1-F10 · Narrow the tenant read of staff sessions (S1-F9 review) · 🔒
Ref §12 · Mod db, identity · Dep S1-F9
**Build:** today every member of an agency (agents too) can SELECT its `staff_impersonations` rows through RLS (`own_rows`), including `reason` and `staff_user_id`; only the service limits the record to admins (`GET /v1/staff-access`). Add a registry option for a narrowed `app_user` SELECT on STRICT tables (the generator, the guard and the isolation suite learn it), and use it here: a row is visible to the member it targets (the per-request `isSessionLive` check) or to an admin of the agency; `staff_user_id` is not readable by `app_user` at all (column grant or a `SECURITY DEFINER` reader — the guard currently refuses column grants, so decide in an ADR). Fix the flaky `[S1-F2]` outbox fair-share test seen in S1-F9 runs (442/500 claimed after a full verify; passes alone).
**Done when:**
- An agent cannot read another member's staff sessions; an admin can; the impersonated member can read their own open session
- No app_user query can read `staff_user_id`
- Isolation suite covers the narrowed policy

### S1-06-F1 · Commission defaults in agency settings
Ref §3 #7 §6 Identity · Mod agencies · Dep S1-06
**Build:** `AgencySettings` gains `default_commission_bp` (500 = 5 % of the sale price) and `default_split_bp` (5000 = the collaborating agent's share is 50 %); settings API and form expose them as percentages, stored as basis points; migration backfills existing agencies with the defaults. Listings copy them on create and import (S3-02).
**Done when:**
- A new agency's settings read 5 % commission (`default_commission_bp` 500) and a 50 % split (`default_split_bp` 5000)
- The split accepts 0–100 % and rejects anything else

---

## S2 — Taxonomy & i18n

### S2-01 · Locations
Ref §6 Taxonomy §7 M4 · Mod taxonomy · Dep S0-05
**Build:** `locations` (4 levels, parent, PostGIS centroid + polygon), `location_groups` + members, `location_aliases`, translations with per-locale slugs.
**Done when:**
- Point-in-polygon lookup returns the deepest matching location in < 10 ms with GiST
- Slugs are unique per (parent, locale)

### S2-02 · Property types and features
Ref §6 Taxonomy · Mod taxonomy · Dep S0-05
**Build:** type groups, types, feature groups, features (Lucide icon names), aliases, translations.
**Done when:** aliases resolve case- and accent-insensitively (`unaccent` + lower)

### S2-03 · Taxonomy services, cache, endpoints
Ref §7 M4 · Mod taxonomy · Dep S2-01 S2-02 S0-07 · ⚡
**Build:** read services with cache (tag `taxonomy`), localized trees for UI and website API, change events.
**Done when:** a full localized taxonomy read uses ≤ 3 queries cold and 0 warm

### S2-04 · Staff taxonomy admin
Ref §7 M4 · Mod admin · Dep S2-03 S1-09
**Build:** tree editor with drag-and-drop ordering, polygon drawing (MapLibre draw, dynamic import), translation editor, alias management.
**Done when:** *(manual + E2E)* create area → draw polygon → translate → appears in localized endpoints after cache invalidation

### S2-05 · Alias resolver and unmatched queue
Ref §7 M4 M5 · Mod taxonomy · Dep S2-03
**Build:** `resolveLocation(text, hints)`, `resolveType`, `resolveFeature` with alias + fuzzy (pg_trgm) fallback and confidence; unmatched values stored in a staff queue with counts and examples; mapping a value creates an alias and re-resolves affected drafts.
**Done when:**
- Known alias → exact match; low-confidence fuzzy → queued, never silently guessed
- Mapping a queued value promotes affected DRAFT listings on the next import run

### S2-06 · Legacy taxonomy import
Ref §14 · Mod migration · Dep S2-05 · [H1]
**Build:** script mapping legacy locations/types/features into the new taxonomy, writing aliases for every legacy spelling and `legacy_id_maps` rows.
**Done when:** every legacy taxonomy ID maps to a new ID or is listed in a report with a reason

### S2-F1 · Identity query and index follow-ups (S1 review) · ⚡
Ref §15 · Mod identity, agencies, compliance · Dep S1-F10
**Build:** `staff_impersonations_agency_idx` gains `id` (the staff access list orders by `started_at desc, id desc`); `(status, created_at, id)` index on `agencies` for the staff tenants list filtered by status; audit log `(type, occurred_at)` index if the staff view filters by type, plus a per-partition archive/retention policy before ~12 months of partitions; an impersonated request runs 5 auth queries on 3 pools (`isImpersonatorActive`, `isStaffLoginCurrent`, `isImpersonationLive` + member + tenant) — merge the two pre-checks into one `app_auth` query or cache them 5–10 s per session id.
**Done when:**
- An impersonated dashboard request runs ≤ 3 queries before the handler (`countQueries()`)
- EXPLAIN on the scale seed: staff access list and status-filtered tenants list use an index with no separate sort node

### S2-F2 · Settings and impersonation hardening (S1 review) · 🔒
Ref §3 #56 §12 · Mod agencies, identity, platform · Dep S1-06-F1
**Build:** `AgencySettings` (the shared read) drops `clientMode`; a separate internal `getClientModePolicy` serves the one server-side consumer, so no client-facing serializer can pass the PIN policy on. Decide and record whether staff impersonating a member may read the commission, split and PIN policy (today `allowed`); if not, `forbidden` while impersonating. Per-user rate-limit bucket keyed on `act ?? sub`, so staff acting as a member neither exhaust that member's quota nor go uncounted. Logger `REDACT_KEYS` add `contactEmail`, `contactPhone`, `websiteUrl` and invite/verification-document fields.
**Done when:**
- `getAgencySettings`' type and output have no `clientMode`, `defaultCommission` or `defaultSplitBp`
- A test logs a profile DTO and finds the contact fields censored
- Staff impersonating a member use their own rate-limit bucket

### S2-F3 · Test hygiene (S1 review)
Ref §15 · Mod tests · Dep S1-F2
**Build:** the S1-F2 idle-dispatcher latency test failed once under full `verify:all` load (577 ms vs 500 ms) and passed 3/3 alone: measure pickup from the dispatcher's own poll timestamps, or allow one extra poll under load, keeping the 250 ms interval check. `test:int:root` chains its projects with `&&`, so one failure silently skips the rest (adapters, apps, seed, ci, ops): run them all and fail at the end. Name the S1-10 budget checks `[S1-10]` (`scripts/perf/bundle-budget.ts`, `tests/e2e/shell.spec.ts`). A migration test for data backfills (0033: a NULL-commission row becomes 500 bp / 5000 bp). `toCommission` throws an internal `AppError` instead of `Error`.
**Done when:**
- `pnpm verify:all` passes twice in a row with the outbox latency test included
- A planted failure in the `queue` project still runs and reports the other root projects

---

## S3 — Properties & media

### S3-01 · Property schema
Ref §6 Properties · Mod properties · Dep S2-03
**Build:** `properties`, `property_privates` (STRICT), `property_translations`, `property_features`, `property_price_histories`, `property_status_histories`, `property_media`; registry entries (properties NETWORK_READ with share scope + verification predicate); indexes per PATTERNS §2.
**Done when:**
- Isolation suite covers all new tables
- Another tenant can read a SHARED ACTIVE listing but never its `property_privates` row

### S3-02 · Listing service
Ref §3 #4 #7 #18 #34 #57 §7 M2 · Mod properties · Dep S3-01 S1-07
**Build:** create/update/soft-delete/restore (30 days), status lifecycle, visibility + share scope (verification gate), per-listing commission (`commission_bp` = total % of the sale price, or `commission_fixed_cents`; VAT flag) and `split_bp` (the collaborating agent's share), both defaulting from agency settings, field locks, optimistic `version`, price/status history, events, CEE energy rating required for PUBLIC. Dashboard API routes.
**Done when:**
- Only the owner agency writes; agents edit only their own listings unless AGENCY_ADMIN
- PUBLIC without CEE rating fails with `ENERGY_RATING_REQUIRED`
- Stale `version` → 409; history rows written for price and status changes
- PREFERRED scope visible only to agencies that list the owner as preferred
- `properties.listing.*` events emitted in the same transaction
- New and imported listings get the agency defaults (`commission_bp` 500, `split_bp` 5000) unless the agent sets their own; `split_bp` accepts 0–100 % only
- Note (S1-01): SHARED/PUBLIC visibility calls `agencies.assertVerified(ctx, 'listing.share' | 'listing.publish')`.

### S3-03 · Media upload pipeline
Ref §3 #33 §7 M2 · Mod media · Dep S3-01 · ⚡ 🔒
**Build:** `media_objects` (sha256 unique, phash, refcount), browser hashes → `POST /media/check` (batch of up to 100 hashes) → signed PUT URLs for unknown hashes only → `POST /media/register`; attach to listing with position/cover/kind; refcount on attach/detach; magic-byte validation; size caps.
**Done when:**
- Uploading a file that already exists anywhere in the system transfers zero bytes and increments refcount
- Non-image bytes with an image extension are rejected
- Detaching the last reference schedules deletion after 7 days

### S3-04 · Media processing worker
Ref §3 #33 §5.3 · Mod media · Dep S3-03 S0-06 · ⚡
**Build:** `media` pool: normalize master (≤ 2560 px), strip EXIF, HEIC → WebP, deterministic variants `v{pipeline}/{sha}/{size}.webp` (thumb, small, medium, large; JPEG cover for OG), pHash, `variants_ready` bitmask; on-demand generation for missing sizes; orphan cleanup job.
**Done when:**
- Variants are byte-identical when regenerated with the same pipeline version
- A 12 MP JPEG processes in < 1.5 s per image on the dev box; RSS < 512 MB under load
- Orphaned objects older than the grace period are deleted; referenced objects never are

### S3-05 · Listing editor UI
Ref §7 M2 · Mod web · Dep S3-02 S1-10
**Build:** sectioned form (basics, location with map pin and precision, specs, features, price + commission, visibility + share scope, translations tabs with origin badges, field-lock toggles), autosave drafts, validation messages by error code.
**Done when:** *(E2E)* create → add translations → publish SHARED → appears in own list; field lock toggles persist

### S3-06 · Media manager UI
Ref §7 M2 · Mod web · Dep S3-03 S3-05
**Build:** drag-and-drop mass upload (parallel, retry, progress), reorder, cover, room type, alt text, floor plans, video, documents; client-side hashing in a Web Worker.
**Done when:** *(E2E)* 50 photos upload with progress; duplicates are skipped instantly; order persists

### S3-07 · Listings list and bulk actions
Ref §7 M2 · Mod properties, web · Dep S3-02 · ⚡
**Build:** own-listings list (filters, saved views, keyset pagination, column chooser), bulk actions (status, visibility, share scope, price change %, assign agent, add tag) as a job with progress.
**Done when:**
- List endpoint ≤ 10 queries and p95 < 300 ms for an agency with 5,000 listings on the scale seed
- Bulk action on 1,000 listings completes in a job and emits one event per listing

### S3-08 · Quality score and freshness
Ref §7 M2 §10 · Mod quality · Dep S3-02 S3-04
**Build:** quality score (photos count/resolution, description length, translations, location precision, CEE, freshness) recomputed on events; fix-it hints in the editor; freshness jobs: 90-day confirmation prompt, 120-day auto-hide from network (SHARED → hidden flag), confirm button.
**Done when:**
- Score changes after adding photos without a manual refresh
- A listing unconfirmed for 120 days disappears from network search but stays visible to its owner

### S3-09 · Bookmarks
Ref §3 §7 M2 · Mod properties · Dep S3-02
**Build:** folders, bookmark any visible listing/unit with a note, list bookmarks, “create selection from folder” hook (used in S12-04).
**Done when:** bookmarks of listings that are no longer visible show as unavailable instead of erroring

### S3-10 · Listing overrides
Ref §3 #54 §7 M2 · Mod properties · Dep S3-02 S4-02
**Build:** `listing_overrides` (agency, target listing/development/unit, locale, title, description, origin); editor panel on network and new-build listings; precedence used by website serializer (S7-02) and selections (S12-04).
**Done when:**
- An override is used only in the overriding agency's channels
- Removing the override falls back to the owner text

### S3-F1 · Taxonomy data and queue hygiene (S2 review) · 🔒
Ref §6 Taxonomy · Mod taxonomy, migration · Dep S2-05
**Build:** `taxonomy_unmatched` is readable by staff and `app_system` only (registry flag that skips the `app_user` read; its examples carry agencies' listing refs and feed names), `pnpm db:rls`. Before S14 maps tenant entities, `legacy_id_maps` gets a tenant-scoped home (STRICT table with `agency_id`) or loses the `app_user` read. `staff.taxonomy.changed` audits name the changed entity id. Translation writes accept content locales only (service check against `CONTENT_LOCALES`). `GeoMultiPolygon` caps polygons, rings and vertices (e.g. 50 / 50 / 10,000 total). Queue examples keep the most recent 5, not the alphabetical first. Queue paging on a stable key (count changes during imports) with a `(status, count desc, id)` index for the unfiltered list. A catalog slug clash gets its own error code. `ReorderLocationsInput.orderedIds` max covers the largest sibling set (> 2,248 cities in one Spanish region).
**Done when:**
- A member session cannot select from `taxonomy_unmatched` (isolation suite)
- A translation in a non-content locale and an over-sized polygon are refused with 422
- An audit row for a taxonomy change names the entity

### S3-F2 · Taxonomy read paths at scale (S2 review) · ⚡
Ref §7 M5 · Mod taxonomy · Dep S2-03
**Build:** cache reload reads only the wanted + fallback locales (the whole-tree DISTINCT ON sorts 28k × locales, 0.9 s with a disk spill) and serves the stale in-process copy while one reload runs; store the serialized website cuts + ETag in Redis (a Redis hit re-parses ~3 MB and re-serializes, 50–60 ms event-loop block per process per locale per minute); cap or cursor-page `/v2/taxonomy/locations/{id}/children` (150 KB budget breaks at ~5,300 children); pre-serialize `GET /v1/taxonomy` like feed-api (Zod parse + stringify of the whole tree, 60–100 ms per 200) and load regions on demand in `/staff/taxonomy`.
**Done when:**
- Cold reload of a Spain-sized tree < 300 ms with no sort spill (EXPLAIN in a test)
- A warm Redis hit serves a website cut without re-serializing (test)
- Children responses stay ≤ 150 KB gzip for any parent

### S3-F3 · Test fixture hygiene (S2 review)
Ref §15 · Mod tests
**Build:** int tests that create global reference data (taxonomy `tree`, `catalog`, properties' locations) remove stale fixtures of earlier runs in `beforeAll`, as S2-F4 did for the resolver and location tests: a fork that crashes (Windows 0xC0000409) never reaches `afterAll`, and its rows then break later runs (8 failures seen). Investigate the Windows fork crash (Node 24 + native modules, `maxForks`, or `verify:all` in WSL).
**Done when:**
- Killing a taxonomy int test mid-run leaves the next run green
- `pnpm verify:all` passes twice in a row on the Windows dev machine, or the crash is documented as Windows-only with CI as the gate

---

### S3-F4 · Media worker least privilege (S3-04 security review) 🔒
Ref §3 #33 §5.3 · Mod media, worker, infra · Dep S3-04
**Build:** the `media` role (S3-04: its own container, `WORKER_POOLS=media`) still gets every worker secret, because `workerEnv` requires them whatever the pools. Make the worker's env pool-aware (SMTP only for `email`, encryption keys only for pools that decrypt), start the media container with S3, Redis, `MEDIA_URL_KEY` and a narrow DB role (`app_media`: read/write `media_objects`, read `property_media` — no BYPASSRLS on other tables) instead of `app_system`; read-only filesystem. Edge rule or bucket policy so only `v<n>/<32 hex>/…` keys of the `media` bucket are public.
**Done when:**
- The media container boots and processes with only the media variables; a check fails the deploy config if it gets SMTP or encryption keys
- The media DB role cannot read another tenant table (isolation test)
- A request for a key outside `v<n>/…` on the public media host is refused

### S3-F5 · Listing videos and documents (split from S3-06)
Ref §7 M2 · Mod media, web · Dep S3-06
**Build:** videos as links (YouTube, Vimeo, Matterport/virtual tours: URL allowlist, normalized embed id, no fetch of the page) and listing documents (PDF: magic bytes, size cap, scan hook) in the media manager. Documents stay out of the global content-addressed namespace (S3-03 decision 4): per-agency private keys, a STRICT table, signed GET for the owner agency only, never on websites or to other agencies. `property_media` keeps VIDEO/DOCUMENT kinds or the new tables replace them — decide and record it.
**Done when:**
- A YouTube or Vimeo link is added, reordered with the photos and shown as a video; other hosts are refused
- A PDF uploads with progress and only the owner agency can open it (isolation test); a non-PDF with a `.pdf` name is refused

### S3-F6 · Listings in the scale seed; location filter by subtree (S3-07 follow-up) ⚡
Ref §4.1 §15 · Mod properties, taxonomy, seed · Dep S3-07
**Build:** `pnpm db:seed:scale` seeds a synthetic Spain-sized taxonomy (1 country, 20 regions, 2,000 cities, 26,000 areas at ≥ 1,000 agencies; property types) and listings — §4.1's 150 own listings per agency, 5,000 for agency 0 — by COPY, deterministic and idempotent. The listings location filter matches a location's whole subtree: listings store their country, region and city (written with the location, backfilled), filtered with an indexed `=` on the level's column (leakproof under RLS).
**Done when:**
- `db:seed:scale` writes the listings (agency 0: 5,000) and a re-run writes nothing (test)
- A region filter returns the listings of its cities and areas; moving a listing moves it (test)
- A rare subtree on the 5,000-listing agency reads by index, no Seq Scan, < 20 ms (EXPLAIN in the perf test)

### S3-F7 · Media container: Redis and storage least privilege (S3-F4 security review) 🔒
Ref §5.3 · Mod media, worker, infra · Dep S3-F4 · needs H3 (Cloudflare R2 tokens)
**Build:** the media container still shares the full `REDIS_QUEUE_URL` (it could enqueue jobs other pools run as `app_system`) and `REDIS_CACHE_URL` (it could poison cached bodies the api serves), and the workers' S3 credentials (exports and the whole private bucket). Give it a Redis ACL user limited to its own BullMQ keys (`bull:media:*`, like the S1-F6 `limits` user) and no cache (skip `configureCache` when media-only); its own R2 token limited to `inmolink-media` and the private bucket's `originals/` + `masters/` prefixes; move the S3 secrets from the shared Kamal env into each role.
**Done when:**
- The media container cannot add a job to another pool's queue or read the cache (test against the test stack's Redis ACL)
- Its storage credentials cannot read an export or a private document (MinIO policy test; R2 token scope documented)

### S3-F8 · Listing document storage hygiene and access audit (S3-F5 security review) 🔒
Ref §13 · Mod media, compliance, worker · Dep S3-F5
**Build:** a document's object is deleted by a worker from an outbox event emitted in the delete transaction (retried; today a failed storage delete is swallowed and the PDF stays); a listing purge or agency offboarding deletes its `documents/<agency>/<listing>/` prefix; a sweep removes `documents/` objects older than an hour without a `listing_documents` row (a crash between upload and insert). Opening, uploading and deleting a document writes an audit row (`media.document.*`, actor and listing). Per-user concurrency cap on the web upload route before it buffers the body.
**Done when:**
- A document whose storage delete fails at first is gone after the retry; a purged listing leaves no object under its prefix (MinIO test)
- Opening a document leaves an audit row naming the listing and the document

### S3-F9 · Media work bucket: originals and masters out of the private bucket (S3-F7) 🔒
Ref §5.3 · Mod media, platform, infra · Dep S3-F7 · needs H3 (Cloudflare R2 bucket + token)
**Build:** R2 API tokens scope to buckets, not prefixes, so the media container's token (S3-F7) can still read private documents on R2. Move `originals/` and `masters/` into their own bucket (`S3_BUCKET_MEDIA_WORK`, a new `BucketName`): the api signs upload PUTs into it, the media pool reads and writes it, the orphan sweep lists it; the media R2 token covers `inmolink-media` + that bucket only and no longer `inmolink-private`. No production data exists yet, so no copy step; local stacks re-upload.
**Done when:**
- The media container's storage credentials cover only the media and work buckets (`infra/storage/media-worker-policy.json` without prefix conditions; R2 token documented as bucket-scoped)
- Upload → process → variants still works end to end on the test stack

### S3-F10 · S3 review must-fixes 🔒 ⚡
Ref §15 · Mod media, properties, quality, platform, api, migration · Dep S3-F9
**Build:** listing documents open only for listing roles (PARTNER members read every listing, not the seller's nota simple or DNI); the API's document upload route takes the same per-user and per-process buffered-upload slots as the web relay (`platform/rate-limit` `createUploadSlots`), before the body is read; a floor plan turned image becomes the cover of a listing without one, and every media edit (kind, cover, alt text, room type, order, video links) emits `media.listing.changed` in its transaction, which recomputes the quality score; the listing list's status filter and reference prefix become leakproof index conditions under RLS (stored `status_code` smallint and `ref_key = upper(ref)`, C-collated range, agency-leading indexes; a country index for depth-1 filters); listing content reads run one after the other on the transaction; the document purge continuation gets a counted trigger.
**Done when:**
- A PARTNER member cannot list or open listing documents
- An API caller over the buffered-upload cap gets 429 before the body is read
- A floor plan turned image becomes the cover; every media edit emits one `media.listing.changed`
- On 200,000 listings, a status matching 2 % (every sort), a reference prefix and an empty country filter read by index in < 20 ms under RLS

---

## S4 — New developments

### S4-01 · Development schema
Ref §6 New developments §3 #21 · Mod developments · Dep S2-03
**Build:** developments, phases, units, unit price histories, price lists (versioned), documents, access (OPEN / PRIVATE_NETWORK + allowed agencies), translations; registry entries.
**Done when:** PRIVATE_NETWORK developments are invisible to non-allowed agencies (isolation test)

### S4-02 · Development services
Ref §7 M3 · Mod developments · Dep S4-01 S3-03
**Build:** CRUD; unit status changes with history; bulk unit edits; price-list versions with computed diffs; developer commission per development or unit; events for unit and price changes.
**Done when:**
- Uploading a new price list version produces a diff (added/removed/changed units and prices)
- Unit status change emits an event within the same transaction

### S4-03 · Development UI
Ref §7 M3 · Mod web · Dep S4-02
**Build:** development editor, unit table with inline edit and bulk status, price-list upload + diff view, documents, access settings.
**Done when:** *(E2E)* create development → add 48 units via CSV → mark 3 reserved → diff view shows changes

### S4-04 · Legacy new-build import
Ref §14 · Mod migration · Dep S4-02 S2-06 · [H1]
**Build:** script importing legacy new-build projects into developments/units with legacy ID maps.
**Done when:** imported counts match the legacy dump; mismatches listed in a report

### S4-F1 · Listing and media access hardening (S3 review) 🔒
Ref §3 #54 §5 · Mod properties, media, db, migration · Dep S3-F10
**Build:** the network-shared `properties` row stops carrying owner-only data: `external_ref`, `quality_score` and the freshness columns move to an owner-only (STRICT) table or network readers get a column grant, so no future network read (search, matching, exports) leaks the owner's portal ref. Bookmark folders and bookmarks get a member-only RLS predicate (`user_id = app_user_id()`), not only the app filter. `checkUploads` / `registerUploads` skip the upload or allow attaching an existing hash only when the agency already references it (otherwise the bytes are uploaded again and re-hashed), and the media list leaves `sha256` out for other agencies (no platform-wide existence probe, no attaching another agency's photos without the file). Signed upload URLs are tied to a target listing (`media.manage` checked on it) and capped in bytes per tenant per hour. A `media.documents.manage` action (upload and delete documents) is forbidden while impersonating, and detaching media under impersonation is either split into its own forbidden action or recorded as a decision.
**Done when:**
- A network reader cannot select `external_ref` of another agency's listing (isolation test)
- A member cannot read a colleague's bookmark notes through `withTenant` (isolation test)
- Registering a hash the agency never referenced, without uploading it, is refused or re-uploaded
- Impersonating staff cannot upload or delete a listing document

### S4-F2 · Listing and media performance follow-ups (S3 review) ⚡
Ref §16 · Mod quality, properties, web, contracts, media, tests · Dep S3-F10
**Build:** the quality recompute skips `properties.listing.updated` events whose `changed` holds only fields the score never reads (price, owner, tags, visibility, share scope — bulk actions set them), so a 5,000-listing bulk price change queues no recomputes. Client components import plain `as const` value lists from a zod-free contracts subpath (the listings bulk bar bundles zod today); rebuild and re-run `pnpm perf:bundle` (the S3 numbers predate S3-F5/F8; the editor route has 17 KB headroom). Measure the compiled media worker's total RSS (not only growth over an assumed 160 MB idle) — `docker stats` on staging or the built `dist` in the burst child. Before S6 imports, review the 22 `properties` indexes against the query shapes and drop overlaps (`updated_at` in an index makes every edit non-HOT); add a migration check that refuses a non-`CONCURRENTLY` index or an unbatched backfill on tables listed as large. The `[S2-F5]` resolver level-hint statement fails locally on a long-lived test DB (the planner hash-joins a Seq Scan of `locations`, 25–40 ms; green on CI): make the plan robust (e.g. drive the hint from the `(level, id)` index) or seed the test's own isolated tree only.
**Done when:**
- A bulk price action on 1,000 listings enqueues no quality recompute (test)
- Dashboard routes ≤ 250 KB first-load on a fresh build with zod absent from the listings client chunk
- The media burst test asserts total worker RSS < 512 MB
- `[S2-F5]` passes on the local test DB as well as on CI

### S4-F3 · Listing lifecycle and job correctness (S3 review)
Ref §7 M2 · Mod properties, media, docs · Dep S3-F10
**Build:** `failStaleBulks` fails only `RUNNING` actions after 2 h; a `QUEUED` one is checked against its BullMQ job (or a much longer limit), so a busy `imports` pool in S6 does not fail actions that never started. A listing purge job removes soft-deleted listings after their retention (the comment in `properties/service.ts` promises it) and calls `media.requestDocumentPurge`; media recounts their references. A one-off recount schedules the objects of DOCUMENT rows removed by migration 0056 (refcount > 0, never scheduled), or the migration's comment is corrected. Record in PATTERNS whether worker-facing cross-module functions may take a raw `Tx` (`freshness`, `listingImageSizes`) or pass a system `ctx`.
**Done when:**
- A bulk action queued for 3 h behind other jobs still runs (test)
- A listing soft-deleted past retention is purged with its documents (test)

### S4-F4 · Development documents (split from S4-03) 🔒
Ref §7 M3 · Mod developments, contracts, api, web, worker · Dep S4-03
**Build:** the services and UI for `development_documents` (S4-01 table; S4-02 built no use cases for it): upload a PDF (raw body ≤ 20 MB through a web relay route like the listing documents, magic bytes, the scan hook, store-then-record with cleanup on failure, retried upload of the same file answers with the same document), list, open by short signed URL (audited), delete (row + audit + outbox event; the worker deletes the object; the hourly orphan sweep covers the `development-documents/` prefix), the `kind` and the `shared` flag (shared ones readable by agencies that see the development, the rest owner-only). A documents panel on the development page; a price list may name its source document.
**Done when:**
- A shared brochure is readable by an allowed agency and a non-shared contract is not (test)
- A renamed non-PDF is refused and a deleted document's object is removed by the worker (test)

### S4-F5 · S4 review fixes ⚡
Ref §16 · Mod developments, contracts, web, perf · Dep S4-F4
**Build:** the three must-fixes of the S4 review. (1) `withDbErrors` names the access FK as migration 0059 creates it (`development_access_allowed_agency_id_agencies_agency_id_fk`), so an unknown allowed agency is `VALIDATION_FAILED`, not a 500. (2) The price-list list carries the diff's counts only (computed in SQL, `PriceListSummaryDto`); the full diff comes from `GET …/price-lists/:version`, which the panel loads when a version is opened. (3) The unit caps move to `@inmolink/contracts/values`, so the development page's client chunk bundles no zod; `perf:bundle` enforces it.
**Done when:**
- An unknown allowed agency id answers `VALIDATION_FAILED` (test)
- A price-list page carries counts, one version the full diff (test)
- `/developments/[id]` first load ≤ 250 KB with zod absent from its client chunks (`perf:bundle`)

---

## S5 — Search & read models

### S5-01 · Listing read models
Ref §5.3 (3) PATTERNS §14 · Mod search · Dep S3-02 S4-02 S0-06 · ⚡
**Build:** `listing_read_models` (listing or unit × locale: card JSON, detail JSON, version, etag); builder consuming listing, media, translation, development and unit events (debounced); `pnpm ops:rebuild-read-models` full rebuild with progress.
**Done when:**
- Read model never goes backwards in version under out-of-order events
- Rebuild of 200k listings × 3 locales completes in < 30 min locally
- Detail JSON contains no owner contact or private fields

### S5-02 · Search adapter and index
Ref §3 #16 · Mod search, platform · Dep S5-01 · ⚡
**Build:** `platform/search` interface + Meilisearch implementation; single listings index, localized searchable fields, filterable attributes (location path, type, price, beds, baths, features, visibility, share scope, owner agency, development, status), geo, sortable fields; settings applied by code; document builder from read models.
**Done when:**
- Index settings are idempotently applied on boot
- Filter + facet query on 2M synthetic docs p95 < 100 ms (staging-sized box)

### S5-03 · Indexer and drift checker
Ref §5.3 (6) · Mod search · Dep S5-02 · ⚡
**Build:** outbox → batched upserts/deletes (debounced per listing); nightly drift check comparing counts and sampled versions between Postgres and the index; auto-repair job.
**Done when:**
- Listing edit is searchable in < 10 s p95
- Stopping search for 10 minutes then restarting converges with zero lost updates

### S5-04 · Postgres fallback search
Ref §5.4 · Mod search · Dep S5-02
**Build:** basic filter search on read models + indexes; circuit breaker switches automatically when the search engine is down or slow; metric + alert.
**Done when:** with Meilisearch stopped, website search still returns correct filtered results (simpler ranking) within budget

### S5-05 · Network search
Ref §3 #5 #7 #57 §7 M10 · Mod search, web · Dep S5-03 S1-07 · ⚡
**Build:** network search API + UI: commission shown as the total %, the split and the viewer's own earnings, owner agency (agent-side only), filters incl. preferred agencies only, new-builds, map view (dynamic import), bookmarks; give-to-get gate (threshold from config, grace period, exemption flag).
**Done when:**
- Agency below the give-to-get threshold after grace sees a clear upsell state, not results
- Results never include PRIVATE listings or PREFERRED listings from non-preferring owners
- Each result shows the total commission %, the split and the viewer's own earnings (price × `commission_bp` × `split_bp`, or the fixed amount × `split_bp`), computed from the listing's values
- API p95 < 300 ms on the scale seed

### S5-06 · Saved searches and alerts
Ref §7 M9 · Mod matching · Dep S5-05 S11-04
**Build:** agent saved searches; alerts on new listing, price drop, back on market (event-driven + daily digest); notification + email.
**Done when:** a new matching listing produces exactly one alert per saved search (deduplicated)
*(Note: depends on S11-04 notifications — build alert generation first, delivery when S11-04 is done.)*
*(S11 review: not built in S11 — it was outside the S11 run's scope; moved to S12 — approved by Shahzaib 2026-10-25. S11-04 notifications (`raiseNotifications`, digest) is DONE, so delivery is ready.)*

### S5-F1 · Development access and audit hardening (S4 review) 🔒
Ref §3 #21 §5 · Mod developments, db, tests · Dep S4-F5
**Build:** opening a development document of the caller's own agency needs a writer role (PARTNER members cannot read the owner's contracts, as for listing documents). `setDevelopmentAccess`, a commission change and `approvePriceList` write a `compliance.audit` entry with before and after values. An isolation/int test per case shows units, phases, translations and documents disappear for an unverified reader, an unlisted or suspended owner and a soft-deleted development. Re-uploading the same file with a different `kind`/`shared` updates the row (share check applies) or answers 409, never silently returns the old row. `uploaded_by` and `legacy_id` leave the NETWORK_READ tables (owner-only table) or are recorded as owner-only in the registry. Unknown `allowedAgencyIds` are checked against `agency_directory` with one neutral error. The browser refuses unit and price-list CSVs over 2 MB before reading them. Record (BACKLOG S7-02, S12-04) that override texts are escaped or sanitized when rendered.
**Done when:**
- A PARTNER member of the owner cannot open a non-shared development document (test)
- Changing access, commission or approving a price list writes an audit entry (test)
- Child rows of a soft-deleted or suspended owner's development are invisible to other agencies (test)

### S5-F2 · Development and document lifecycle (S4 review)
Ref §7 M3 · Mod developments, media, properties · Dep S4-F5
**Build:** soft-deleted developments are purged after the restore window with their documents (the S4-F3 listing purge shape: `documentDeleted` per document, objects removed by the worker). `listing_overrides` of a purged listing or a deleted unit/development are removed by a system job subscribed to `properties.listing.purged` and `developments.unit.deleted`. The orphan sweeps (`development-documents/`, listing `documents/`) persist their last key and resume from it, wrapping at the end, so objects past the first 100k keys are swept. The listing purge gets a partial index on `(deleted_at) where deleted_at is not null` (created `CONCURRENTLY`) and queues a continuation when a run ends full.
**Done when:**
- A development soft-deleted past retention is purged with its document objects (test)
- A purged listing's overrides are removed (test)
- A sweep that stops at its page cap resumes from the next key on the following run (test)

### S5-F3 · Developments performance and structure (S4 review) ⚡
Ref §16 PATTERNS §9 · Mod developments, contracts, web, tests · Dep S4-F5
**Build:** approving a price list with `priceListId` set writes no per-unit outbox events (one `priceListApproved` carries it) or `emit` chunks large inserts, so a 2,000-unit repricing stays well under the 65,535-parameter limit and the dashboard p95. `getPriceList` reads without `entries` on the read path; `listOwnDevelopments` and `listUnits` select only the DTO's columns. The CSV price and unit-type parsing moves from `apps/web/.../developments/csv.ts` into contracts or core (S4-04 and S6 imports reuse it; the web keeps file reading). The development currency defaults to the agency's currency, not a hard-coded `'EUR'`. The `[S0-15]` Kamal env test (38 s alone, 60 s timeout under a full run) gets a margin or a cheaper import. Integration tests stop leaving agencies behind (the test DB holds 80k; `[S1-09]` times out under load): factories clean up or suites share founders, and the staff tenant search gets a trigram index on `agencies.name` (or a prefix search on an indexed key).
**Done when:**
- Approving a 2,000-unit price list stays within the dashboard budget (test)
- No list repo in `developments` selects every column (test or lint)
- `[S1-09]` passes in a full `verify:all` run

### S5-F4 · S5 review must-fixes (search performance) ⚡
Ref §16 PATTERNS §12 §14 · Mod search, db, worker, tests · Dep S5-04 S5-01
**Build:** the Postgres fallback matches its filter once — a `MATERIALIZED` set capped at `countCap + 1` gives the total and, within the cap, the page; the index-ordered branches run only past it (InitPlan-gated). Read-model rebuilds are batched: listing and unit events queue their target in `read_model_queue` (worker-only, one row per target, debounced by `due_at`, generation-guarded like `search_index_queue`) and ask for the agency's throttled `search.buildReadModels` run, which rebuilds up to `READ_MODEL_BATCH` targets per transaction, requeues image rechecks and pushes each batch to the index as it commits; `search.sweepReadModelQueue` (every minute) asks again for agencies whose run was lost.
**Done when:**
- Every website fallback shape's statement runs under 20 ms at 500k rows (fastest of 5 EXPLAINs; perf test)
- A burst of changes across many listings is rebuilt in one batched transaction, each target once (test)
- A listing edit is still searchable in < 10 s p95 (S5-03 perf test)

---

## S6 — Imports

### S6-01 · Connector framework, safe fetch, XML streaming
Ref §3 #17 #64 §7 M5 · Mod imports, platform · Dep S3-02 S0-06 · 🔒
**Build:** `feed_connections`, `feed_runs`, `feed_item_errors`, `feed_mapping_profiles`; connector interface (`fetch → parse stream → map → validate`); `platform/safe-fetch`; XXE-safe streaming XML parser wrapper; schedules via repeatable jobs; per-connection mutex; run history UI.
**Done when:**
- Feed URLs resolving to private/loopback/metadata IPs are refused, including after redirects
- XML with a DOCTYPE/entity declaration is rejected
- Two runs of the same connection never overlap

### S6-02 · Bulk loader
Ref PATTERNS §13 §3 #18 · Mod imports · Dep S6-01 · ⚡
**Build:** COPY → staging → MERGE (PostgreSQL 17 `RETURNING merge_action()`), field locks honoured, import hash to skip unchanged rows, withdrawals (missing from feed for N runs → WITHDRAWN), images queued hash-first, outbox events bulk-inserted.
**Done when:**
- Re-importing an unchanged 20k-listing feed changes 0 rows and emits 0 events
- Locked fields survive re-import
- 100 MB feed imports in < 10 min with RSS < 512 MB
- A listing held as DRAFT for an unmatched location, type or feature is promoted on the next run after staff map the value in the S2-05 queue (taxonomy resolved through `resolveAndQueue`, per location level with the parent as hint) — carried over from S2-05 by the S2 review

### S6-03 · Kyero connector
Ref §3 #17 · Mod imports · Dep S6-02
**Build:** Kyero v3 mapping (incl. images, features, translations), fixtures in `tests/fixtures/kyero/`.
**Done when:** fixture feed imports with 100% field mapping coverage report and correct taxonomy resolution

### S6-04 · Generic XML connector and visual mapper
Ref §7 M5 · Mod imports, web · Dep S6-02
**Build:** upload/URL sample → detect repeating node → UI to map fields (path picker with preview) → saved mapping profile → dry run report.
**Done when:** *(E2E)* map a non-Kyero sample to a profile and import it without code changes

### S6-05 · CSV/Excel import
Ref §7 M5 · Mod imports · Dep S6-02
**Build:** CSV/XLSX upload, column mapper, validation preview, import as a job.
**Done when:** 5,000-row XLSX imports with per-row error report; formula cells are read as values

### S6-06 · Resales Online connector (own listings only)
Ref §3 #17 §20 · Mod imports · Dep S6-02 · [H13]
**Build:** connector using the agency's own API credentials, restricted to that agency's own listings; mapping + fixtures.
**Done when:** network/other-agency listings are excluded by construction (filter verified against fixture containing both)

### S6-07 · Milenio+, Infocasa, Inmoba, thinkSPAIN connectors
Ref §3 #17 · Mod imports · Dep S6-02 · [H14]
**Build:** one connector per format, each with fixtures and mapping coverage reports.
**Done when:** each fixture imports with ≥ 95% field coverage; unmapped fields listed

### S6-08 · Fair scheduler, anomaly guard, import health
Ref §5.3 (7) §3 #39 · Mod imports, admin · Dep S6-02 · ⚡
**Build:** per-tenant fair share for import runs, global concurrency caps, anomaly guard (> 5× typical volume or > 30% withdrawals → pause + alert + agency notice), staff import-health dashboard (runs, failures, lag, unmatched values).
**Done when:**
- With 500 simultaneous feeds, no tenant's queue wait exceeds 15 min (load test)
- A feed that suddenly drops 40% of listings pauses instead of withdrawing them

### S6-F1 · Search access and public-path hardening (S5 review) 🔒
Ref §3 #5 #57 §5 · Mod search, agencies, properties, db · Dep S5-F4
**Build:** a suspended or unlisted owner agency's PUBLIC listings and OPEN-development units leave the public read models, `listing_search_docs` and the PUBLIC index (an agency-status condition in the read-model loaders; an agency status change queues its targets' rebuild). `listing_read_models` becomes read-only for `app_user` (only the worker writes it): the registry/generator gives PUBLIC_READ read models no user DML. The `app_public` grant honours `hiddenColumns` (`share_scope`, `allowed_agency_ids` unreadable on public paths). `listing_search_docs` is granted to `app_public` only (not `app_user`, which maps every PUBLIC listing to its owner without the verified gate). `properties.removeOverrides` checks inside its transaction that the target is gone and belongs to `meta.agencyId`. The network search total is documented as approximate (or the engine filter excludes freshness-hidden listings and unlisted owners — with S6-F2's `networkHidden`). The give-to-get exemption takes a staff reason and audits before and after.
**Done when:**
- A suspended agency's PUBLIC listing disappears from website search (engine and fallback) after its status change (test)
- `app_user` cannot insert or update a `listing_read_models` row, and `app_public` cannot read `share_scope` (isolation test)
- `removeOverrides` for a live listing, or one of another agency, removes nothing (test)

### S6-F2 · Search correctness and structure (S5 review)
Ref §5.3 §7 M10 · Mod search, agencies, developments, properties, web · Dep S5-F4
**Build:** the repair walk pages the index by id (`id > last`), not by offset, so deletions during the walk skip nothing. An engine cursor that continues in the fallback restarts at the fallback's first keyset page with a "results changed" flag instead of an SQL `OFFSET`. Index documents carry `networkHidden` (freshness-hidden listings) and network search excludes it, so pages are full and totals right. PREFERRED listings are filtered by a `preferredAgencyIds` field on the document (`eq preferredAgencyIds = viewer`) instead of up to 2,000 owner ids per query (`NETWORK_PREFERRING_CAP` goes). New-build units can be bookmarked on `/network` (unit bookmarks, S3-09 note) — or the gap is recorded under Decisions. `developments` `unitsForUpdate` selects only the columns the approval needs; `properties/read-models.ts` binds its status list (`sql.join`/`inArray`), no string splice. `UNIT_SPLIT_BP` (units pay 100 % to the selling agency) moves to config or a development field after Shahzaib's decision (S5 review). Note for S7-03: wire `searchPublicListings` into feed-api with Cache-Control and ETag.
**Done when:**
- A repair walk with documents deleted during it finds every orphan (test)
- A freshness-hidden listing is not counted in a network search total (test)
- A network search by an agency preferred by 2,001 owners still shows their PREFERRED listings (test)

### S6-F3 · Search and lifecycle performance (S5 review) ⚡
Ref §16 §5.4 · Mod search, developments, db, tests · Dep S5-F4 · before S6-02
**Build:** website search's engine timeout ~100 ms and slow threshold ~80 ms (from config), and the breaker opens on a slow-or-failed share over a window, not only 5 in a row — or the fallback starts at ~80 ms and the first answer wins. The full read-model rebuild refreshes `listing_search_docs` once per target (not in `changed()` and again per page); re-run `tests/perf/read-model-rebuild`. The development purge bounds a transaction by units (≈ 5k), not by 100 developments. Network hydration reads the viewer's locale and fallback first and any locale only for ids still missing (no `distinct on` detoasting every locale's card). `properties_agency_network_idx` (0069) joins `CONCURRENT_INDEXES` before imports fill `properties`. `quality.recomputeListing` gets the S5-F4 queue shape (one job per listing today; imports emit one event per row). Integration and perf suites delete their `search_index_queue` / `read_model_queue` rows (495 stale rows from killed runs were found; a shared global queue's leftovers slow other suites' syncs).
**Done when:**
- A website search with the engine answering in 200 ms stays within feed-api's 150 ms p95 (test with a slowed engine)
- A full rebuild writes each target's fallback row once (statement count test)
- Purging a development with 20,000 units runs in transactions of ≤ 5,000 units (test)

### S6-F4 · Resales Online connector, corrected against the proven SPW adapter ⚡
Ref §3 #17 · Mod imports · Dep S6-06 · [H13] · findings `docs/build/reviews/S6-resales-vs-spw.md`
**Build:**
- Rework `imports/resales/` to the request and response shapes proven in the SPW project (`E:/Repos/SPW-AI/spw/apps/api/src/modules/feed/adapters/resales.adapter.ts`).
- The filter alias (1 Sale, 2 Short Term Rent, 3 Long Term Rent, 4 Featured) becomes a connection setting; the transaction type comes from the alias or `QueryInfo.SearchType`.
- Drop the `AgencyId` gate. Enforce own listings through the real own-property field (`OwnProperty` `"1"`; confirm on a live response).
- Use `P_PageNo` / `P_PageSize`, with the page size from `QueryInfo.PropertiesPerPage`.
- Error handling: `data.root || data`; fail only on `transaction.status === 'error'` and surface `errordescription`. Retry "P1 or P2 not valid" 3× with backoff before treating it as a credentials error. Keep Resales' error body.
- Parsing: prices with separators, ranges, rentals (`RentalPrice1`/`RentalPeriod`) and POA; type from `NameType`, or `Subtype1` for developments; decimal and range beds and baths; `GardenPlot ?? Plot`, `Built ?? BuiltArea`; location levels `Area` / `Location` / `SubLocation`.
- Translations: numeric `P_Lang` per language, dropping text identical to the English.
- `PropertyDetails` (5 concurrent) for coordinates, fees, IBI and development price lists.
- Replace the fixtures with real responses recorded on a whitelisted server; the key is IP-bound, so there is no local live run.
**Done when:**
- A recorded real SearchProperties response (own and shared listings) imports exactly the own listings (test)
- A 1,227-listing account with a 40-per-page cap imports all pages (test)

### S6-F5 · Sprint review must-fixes (S6 review) 🔒 ⚡
Ref §5.3 (7) · Mod imports, platform · Dep S6-08
**Build:**
- `platform/queue` gets a per-process cap per job definition (`perProcessConcurrency`). `imports.runFeed` takes it from `IMPORT_RUNS_PER_PROCESS` (default 2), so one worker process never holds more than two feed runs. Each 100 MB run adds about 110–150 MB, and the `imports` pool's 10 slots could otherwise take ten. The fair-share simulation models the cap.
- `htmlToPlainText` runs in linear time: the input is cut before the regexes run, and comments and `script`/`style`/`iframe`/`object`/`embed` bodies are removed by an index scan. Text after an unclosed opener is dropped. The old lazy backreference regexes rescanned to the end for every unclosed `<script` or `<!--`, so a 2 MB description blocked the event loop for minutes.
**Done when:**
- Two 100 MB feed runs in one worker process stay under 512 MB RSS (perf test)
- A third run in a process already running two goes back to delayed (test)
- A 2 MB description of repeated `<script ` is cleaned in < 100 ms (test)
- A busy-server "P1 or P2 not valid" answer is retried, not failed (test)
- One live run from a whitelisted server matches the agency's Resales count (H13)

---

## S7 — Website API v2

### S7-01 · Website sites and inventory policies
Ref §9.1 §6 Website delivery · Mod websites · Dep S5-01 S1-05
**Build:** `website_sites` (domains, mode, inventory policy OWN_ONLY / OWN_PLUS_NETWORK / CUSTOM with filters, reference prefix, locales, contact overrides); config UI; API keys bound to a site.
**Done when:** changing a site's policy changes its results within 60 s (cache)

### S7-02 · Website serializer
Ref §3 #6 #54 §9.1 · Mod websites · Dep S7-01 S3-10 · 🔒
**Build:** per-site serialization of read-model documents: presenting agency branding and contacts, reference prefix, overrides precedence (override > site content > owner text), canonical-only for duplicate clusters (no-op until R2 dedupe), sanitizer hook (S12-03). Override texts (`listing_overrides` title/description, S3-10) are agency input shown on other agencies' and public pages: escape them on render, or pass them through the S12-03 sanitizer — never raw HTML (S5-F1).
**Done when:**
- Serialized network listings contain no owner agency name, phone, email or commission (property-based test over fixtures)
- Override text is used for the overriding site only

### S7-03 · Website API v2 read endpoints
Ref §9.1 · Mod websites, feed-api · Dep S7-02 S5-02 · ⚡
**Build:** `/v2/listings` (filters, facets, geo, sort, cursor), `/v2/listings/{ref}`, `/v2/developments` (+ detail, units), `/v2/taxonomy/*`, `/v2/changes?since=`, `/v2/sitemap`; OpenAPI; SDK generation.
**Done when:**
- Each endpoint ≤ 3 queries, p95 < 150 ms origin on the scale seed
- ETag + 304 work; Cache-Control headers match the rules
- `/v2/changes` returns every change exactly once across pages

### S7-04 · Site keys, quotas, anti-scraping
Ref §9.2 §12 · Mod websites · Dep S7-03 · 🔒
**Build:** quotas per key per day, burst limits, pagination anomaly detection (deep sequential paging patterns), honeytoken listings per site, alerting.
**Done when:**
- Exceeding the daily quota returns 429 with reset time
- Scripted full-inventory paging triggers an alert and throttling

*Note (S7-03 review):* publishable keys answer browsers with their allowlisted origin echoed (CORS); add per-IP limits for publishable-key traffic here (a page's visitors share the key).

### S7-05 · Lead intake and speed-to-lead
Ref §3 #12 #60 §7 M8 · Mod websites, crm · Dep S7-03 · 🔒
**Build:** `POST /v2/leads`, `POST /v2/viewing-requests` (Turnstile, validation, idempotency); store as inbound leads (completed into CRM in S10-02); auto-acknowledgement email in the buyer's language within 60 s with 3 similar listings from the same site's inventory; agent notification.
**Done when:**
- Lead from site A for a network listing belongs to agency A (presenting agency)
- Auto-ack is sent in < 60 s p95 and uses the site's branding
- Duplicate submissions with the same idempotency key create one lead

*Note (S7-04):* honeytoken listings (fake cards on deep search pages of suspected scrapers, `website-api/honeytokens.ts`) have references `<prefix>-<code>` or the agency's own style with check digits, which `websiteApi.honeytokenKind` recognises. A lead or viewing request naming one must not create a lead or e-mail anyone: answer as for a withdrawn listing and raise `WebsiteHoneytokenHit` (`raiseWebsiteAlert`). Count lead posts against the key's daily quota (`requireApiKey` does).

### S7-06 · CDN caching and purge
Ref §9.2 §5.3 (4) · Mod websites, infra · Dep S7-03
**Build:** Cloudflare cache rules for feed-api, cache keys by site scope + query + locale, purge on listing events (tags where available, else short TTL + versioned keys), `stale-if-error`.
**Done when:**
- *(staging)* origin stopped → website API keeps serving cached responses
- Listing edit visible through the CDN within 5 min

*Note (S7-03):* site-scoped `/v2` answers are `private, max-age=0, must-revalidate` (+ strong ETag, `Vary: X-Api-Key, Authorization, Origin`) because the site comes from the key header and Cloudflare ignores `Vary`. Switch `SITE_CACHE_POLICY` (`apps/feed-api/src/plugins/site-response.ts`) to `public` with the TTLs of `WEBSITE_API_TTL` only together with cache keys that include the site (e.g. a site-scoped hostname or a key-derived cache key).

*Note (S7-04, after review):* quotas, burst and paging limits are checked at the origin in `requireApiKey`; requests the CDN answers from cache do not count. **Never CDN-cache** 429s, cursor pages (`cursor` present: deep pages must still pass the origin's paging and deep-page rules, and `/v2/listings` cursors are site-bound with a signed depth) or answers to suspicious callers (`Cache-Control: private, no-store`, no ETag — they may carry a honeytoken). Cache first pages only, keyed by site.

### S7-07 · Per-site XML feed and iFrame embed
Ref §9.5 · Mod websites, public · Dep S7-03
**Build:** token-protected XML feed per site (Kyero-format + generic) generated by a job to R2 and served via CDN; iFrame pages in `apps/public` (search, results, detail) themed with agency branding, leads routed to the site's agency.
**Done when:**
- XML feed validates against the Kyero schema fixture
- ~~iFrame detail page passes the white-label test and Lighthouse ≥ 90~~ — iFrame detail check moved to S7-F8 (split 2026-10-21, STATUS Decisions)

### S7-08 · Website API load test
Ref §4.2 §15 · Mod tests · Dep S7-06 · ⚡
**Build:** k6 scenario mix (search 60%, detail 30%, taxonomy/changes 10%) against staging scale seed.
**Done when:** 1,000 rps origin sustained 15 min with p95 < 150 ms and error rate < 0.1% *(staging)*

### S7-F1 · Import safety and data lifecycle (S6 review) 🔒
Ref §3 #17 §5 · Mod imports, platform, api · Dep S6-F5
**Build:**
- Uploaded sheets (`imports/sheets/<agency>/<file>`) are deleted: when the connection is deleted, when a new upload replaces the file, and by a lifecycle rule or sweep on the prefix (e.g. 30 days after the last run). Tenant erasure covers the prefix.
- A feed that comes back empty or entirely invalid while its connection has live listings pauses (new reason `EMPTY_FEED`, alert and agency notice), instead of ending `SUCCEEDED` silently.
- The staff resume takes a `StaffReason` and audits it, as the S6-F1 give-to-get exemption does.
- `platform/sheet`: a stored (method 0) zip entry whose `compressedSize` differs from its `size`, or exceeds the entry cap, is refused.
- `listFeedRuns`, `getFeedRun` and `listFeedItemErrors` pass the loaded row to `assertCan(ctx, 'imports.read', row)`.
- `allowLoopbackOriginsForTests` also refuses when `NODE_ENV === 'production'`. CI checks that no production start command loads `loopback-feeds`.
- The sheet upload route checks `imports.manage` in `onRequest`, before Fastify buffers the 25 MB body (the service check stays).
**Done when:**
- Deleting a sheet connection deletes its file, and a replaced upload's old file is gone (test)
- An empty feed for a connection with live listings pauses it with `EMPTY_FEED` (test)
- A staff resume without a reason is refused (test)

### S7-F2 · Import correctness and structure (S6 review)
Ref §7 M5 PATTERNS §13 · Mod imports, web, tests · Dep S6-F5
**Build:**
- Duplicate refs across batches of one run are caught (a per-run seen set bounded like `RunResolver`, or a `property_import_seen` conflict check before staging), so a listing is not updated twice and `updated` is not inflated.
- The mapper's title and description guesses move from `apps/web/.../imports/mapper/mapping-state.ts` into `imports/xml-mapped/suggest.ts` and return in `sample.suggested`.
- Per-format default locale (`kyero` 'en', `assemble` 'es') and currency ('EUR') move into one table in `imports/config.ts`, keyed by connector.
- A scaled integration test runs the fair share through real BullMQ and Redis (jobs of a few ms) and checks wait order and maximum against `fair-share-sim.ts`, so the model cannot drift from the queue.
- PATTERNS §13 and `.claude/rules` database notes record that the loader uses `INSERT … jsonb_to_recordset` instead of COPY, because RLS blocks COPY for `app_user` (ADR if needed).
**Done when:**
- A feed with the same ref in two batches updates the listing once (test)
- The real-queue fair-share test's max wait stays within the simulation's bound (test)

### S7-F3 · Import throughput at scale (S6 review) ⚡
Ref §5.3 (7) §16 · Mod imports, media, properties, search, db · Dep S6-F5 · part [H4]
**Build:**
- `media.importFeedImages` gets a `globalConcurrency` and a per-process cap, and hashes and uploads each image as it streams instead of holding the chunks and a `Buffer.concat` copy (worst case today about 1.2 GB per process).
- `imports.pruneRuns` loops until no expired runs are left, within a time budget (or `feed_runs` is partitioned by month with pg_partman). Today it removes at most 50k runs a day, against an estimated 120k–960k created.
- `imports.scheduleFeeds` keeps queueing batches until no connection is due (today at most 200 a minute, 12k an hour).
- `property_import_seen` becomes UNLOGGED like the staging table, drops the unused `property_import_seen_agency_created_idx`, and gets autovacuum settings for about 2M inserts and deletes an hour.
- Taxonomy resolution in the loader: one statement per level for all (parent, text) pairs (`unnest`), plus a per-run negative cache so unmatched values are resolved and queued once per run, not once per batch.
- `overdueAgencies` (feed image sweep) uses a skip scan over `(agency_id, created_at)` instead of `distinct` over the `updated_at` index.
- The staff health window aggregates read an hourly rollup, or the scheduler tick's metrics. EXPLAIN on a 300k-run seed.
- S6-F3 degraded path (engine slow, breaker closed: 151–254 ms): lower `SEARCH_SLOW_MS` to about 50, scale `SEARCH_BREAKER_MIN_CALLS` with traffic, and recheck on the staging box (H4).
- `pnpm perf:bundle` for `/imports/mapper` and `/staff/imports` after a fresh build.
**Done when:**
- 5 feed-image jobs of 20 MB images in one process stay under 512 MB RSS (perf test)
- A prune with 200k expired runs removes them all in one job (test)
- 1,000 due connections are all queued within one scheduler job (test)

**Split (2026-10-22):** the taxonomy resolution, staff health rollup, degraded search path [H4] and `perf:bundle` items moved to **S7-F10**; S7-F3 kept the three acceptance checks, `property_import_seen` and the `overdueAgencies` scan.

### S7-F4 · Minimum commission in CUSTOM site policies (S7-01)
Ref §9.1 · Mod websites, search · Dep S7-01
**Build:** the CUSTOM inventory policy's "minimum commission" filter (PLAN §9.1), left out of S7-01 because no index field carries commission. The listing's (or unit's) total commission in basis points as an index-only field: in the listings index documents and `listing_search_docs`, never in `card`/`detail` JSON nor readable by `app_public`/`app_user` (hidden column, like `share_scope`); `minCommissionBp` in `SiteInventoryFilters` (network listings only — own listings are never filtered by it) and the site form. Fixed-amount commissions compare as a share of the price (on-request prices: unknown → excluded when a minimum is set).
**Done when:**
- A CUSTOM site with a 3 % minimum shows network listings at ≥ 3 % only, engine and fallback alike (test)
- No public read path returns the commission field (isolation + serializer test)

### S7-F5 · White-labelled free-text search on network sites (S7-02 review) 🔒
Ref §3 #6 §9.1 · Mod search, websites · Dep S7-02
**Build:** on a site that shows network listings, free text still matches the owner's raw title, place and description in the engine, so a visitor who types an owner's name, phone, e-mail or website finds that owner's network listings (results are white-labelled, but the match itself tells the visitor who owns them). Index the localized text of every document through the deterministic white-label sanitizer with its owner's identity (`agencies.ownerIdentities`; the owner is the same for every site, so it is sanitized once, at index build): move the sanitizer out of `websites` to a module-neutral place both `search` and `websites` import; include a sanitizer version in `sourceHash` so a change re-pushes every document; reindex on deploy. Own-site search then no longer matches the agency's own contact details in its listings' text (accepted). The S12-03 model pass stays serving-time only.
**Done when:**
- On an OWN_PLUS_NETWORK site, searching an owner's name, phone, e-mail or website host returns none of its network listings (engine test; the fallback matches references only)
- Titles and descriptions without owner details rank as before (existing search tests green)

### S7-F6 · Website API v2: developments and taxonomy endpoints (split from S7-03)
Ref §9.1 · Mod websites, search, feed-api · Dep S7-03 · ⚡
**Build:** the rest of S7-03's read endpoints. `GET /v2/developments` (new-build cards of the site's inventory: name, place, status, completion, price range and unit counts from the public unit read models — a development read model or an aggregate over `listing_search_docs`, no per-request joins over raw tables), `/v2/developments/{ref}` (detail, white-labelled like listings: network developments by a site code, never the owner's id — S7-03 shows network ids scoped per site agency), `/v2/developments/{ref}/units` (live unit table, cursor pages). `GET /v2/taxonomy/types` and `/v2/taxonomy/features` (S2-03 serves both in `/v2/taxonomy/catalog`; split or alias, and decide whether options are narrowed to the site's inventory with counts). The `developmentId` search filter for network developments: S7-03 shows network development ids scoped per site agency (`siteScopedId`, not reversible), so the filter matches own developments only — map scoped ids back (a lookup by the site's agency) or accept the development's site reference instead. OpenAPI + `pnpm sdk:generate`.
**Done when:**
- Each endpoint ≤ 3 queries, p95 < 150 ms origin on the scale seed; ETag + 304 and Cache-Control as S7-03
- A network development and its units are white-labelled (no owner id, reference, name or contact; property test like S7-02)

---

## S8 — Legacy shim & WordPress plugin v2

### S7-F7 · Website extraction budgets and limits-Redis ops (S7-04 review)
Ref §9.2 §12 · Mod website-api, platform, infra · Dep S7-04 · 🔒
**Build:**
- **Filter-slicing:** a scraper slices the inventory by filters (location × type × price band) so no cursor chain gets deep; count filtered first pages per key / browser over a window and flag past a budget.
- **Detail / sync counting:** detail requests (`/v2/listings/{ref}`) and sitemap + detail sync per key / browser; a WordPress plugin should sync from `/v2/changes` — budget details beyond what the change feed explains.
- **Per-agency daily quota** across all its sites and keys (rotating or adding keys must not reset the budget).
- **Ops:** deploy `redis_exporter` next to redis-queue (and redis-cache) and its Prometheus scrape job, so `RedisMemoryHigh` / `RedisMemoryCritical` (infra/monitoring/rules/redis.yml) have series; decide whether rate-limit counters move to their own Redis (S7-04 Decision).
**Done when:**
- Scripted filter-sliced full-inventory extraction is flagged within an hour
- Rotating a key does not reset the agency's daily budget
- Redis memory alerts fire from real series on staging

### S7-F8 · iFrame embed pages and the XML feed in the dashboard (split from S7-07)
Ref §9.5 · Mod public, websites, web · Dep S7-07, S7-05 · 🔒⚡
**Build:**
- **iFrame pages** in `apps/public` (`/embed/<site>/…`): search, results and detail of the site's inventory through the website API read path (same policy, white-label and overrides; public read models only), themed with the presenting agency's branding (colours, name, contacts), the site's languages; `Content-Security-Policy: frame-ancestors` limited to the site's domains (no `X-Frame-Options: DENY` on these routes only); leads through the S7-05 intake path (Turnstile, presenting agency); public page budgets (LCP < 2.0 s, framework JS ≤ 149 KB, route JS ≤ 30 KB gzip, immutable chunks).
- **Dashboard:** the site's XML feed card (`/v1/sites/{id}/feed`: on/off, rotate with the token shown once, the last run, Kyero vs generic counts), EN + ES strings; the feed host from config.
- **Lighthouse CI** script against a local build (`pnpm perf:lighthouse` or similar); scores pasted into STATUS, staging run if it cannot run locally.
- **Security (S7-07 review):** `frame-ancestors` limited to the site's domains (nothing else may frame the pages); branding values (colours, CSS, logo URL, texts) sanitised against XSS (colours by pattern, no raw CSS, URLs https only, texts escaped); embed identity checked (no embedding another agency's site, nor a suspended agency's or a deleted site); cookies `SameSite=None; Secure` only where an embedded flow needs them; Turnstile and lead intake through the S7-05 path (presenting agency); no server-side fetch of a logo URL except through `safeFetch`.
**Done when:**
- iFrame detail page passes the white-label test and Lighthouse ≥ 90 (moved from S7-07)
- Each S7-07 review security item above has a named `[S7-F8]` test
- The iFrame pages render only inside the site's domains (frame-ancestors), and a lead from them reaches the presenting agency
- An agency admin turns the feed on, copies the URLs and rotates the token from the dashboard

### S7-F9 · Index-driven fallback search for network sites (split from S7-08 perf audit)
Ref §4.2 §15 · Mod search · Dep S5-04, S7-08 · ⚡
**Build:**
- The Postgres fallback's candidate set `m` (`search/repo.ts` `fallbackSearch`, ~l. 1038) is a filter over `listing_search_docs` then a sort: for a **network site with a price band and a price sort** it reads the whole network branch (Seq Scan) — 13–1,055 ms locally at ~800k rows, over the 2 s statement timeout at 2M (perf audit of S7-08), and it would carry ~600 rps of website search whenever the engine's circuit opens. Make it index-driven on the sort column: a keyset walk of `price_idx` (and the other sort indexes) with an early stop at `limit + 1` matches, or composite indexes for the network branch (`share_scope`, `status`, sort column), whichever keeps every fallback shape ≤ 3 statements and p95 < 150 ms.
- Perf test (`tests/perf/search-fallback.int.test.ts` or a new file): network + price band + `price_asc` / `price_desc`, own + network, at the scale seed — no Seq Scan, p95 < 150 ms; EXPLAIN in STATUS.
- **Degraded-engine k6 profile:** the S7-08 mix with Meilisearch stopped (circuit open) at the staging rate — a runbook step in `website-api.md` › Load test, numbers in STATUS.
**Done when:**
- Every fallback shape is index-driven (no Seq Scan) with p95 < 150 ms at 2M rows (staging, with S5-04)
- The degraded-engine load run holds the S7-08 thresholds

### S7-F10 · Import query shapes, staff health rollup and search tuning (split from S7-F3; fallback tails from the S7-F9 perf review)
Ref §5.3 (7) §15 · Mod imports, taxonomy, search, web · Dep S7-F3 S7-F9 · part [H4] · ⚡
**Build:**
- Taxonomy resolution in the loader: one statement per level for all (parent, text) pairs (`unnest`), plus a per-run negative cache so unmatched values are resolved and queued once per run, not once per batch (`imports/load.ts` `RunResolver`, `taxonomy.resolveAndQueue`).
- The staff import health window aggregates (`imports/health.ts`) read an hourly rollup, or the scheduler tick's metrics. EXPLAIN on a 300k-run seed.
- S6-F3 degraded path (engine slow, breaker closed: 151–254 ms): lower `SEARCH_SLOW_MS` to about 50, scale `SEARCH_BREAKER_MIN_CALLS` with traffic, and recheck on the staging box (H4).
- `pnpm perf:bundle` for `/imports/mapper` and `/staff/imports` after a fresh build.
- **Fallback tails (S7-F9 perf review):** (1) `[S5-04]` shape 13 (own + network + city + minimum commission 3 %, newest) runs 24–31 ms warm against the 20 ms SQL budget (≈ 60–120 ms at 2M): `search_commission_at_least` is called per candidate row — pre-filter by commission (e.g. the commission in a narrow definer-readable table joined first, or a composite index) so the SECURITY DEFINER call is not per row; (2) add a selective network shape (network + type + baths + price band, < 1,000 matches: a BitmapAnd at 20–25 ms warm) to `tests/perf/search-fallback.int.test.ts` and fix it with (1); (3) `developmentsCommission` in `tests/perf/website-api.int.test.ts` (120–165 ms p95, a per-row definer call per development): re-measure and fix with (1).
- **Staging notes (H4, with S7-F9):** confirm "no unbounded scan" for every fallback shape at 2M on a seed with realistic agency clustering (listings grouped by agency and area, not hashed), and measure cold `m` reads (~520 ms cold at `random_page_cost` 1.1 locally).
**Done when:**
- A 20k-listing run resolves each level of its locations in one statement per batch, and an unmatched value is queued once per run (query-count test)
- The staff health endpoint stays ≤ 10 queries and p95 < 300 ms on a 300k-run seed (EXPLAIN in STATUS, no Seq Scan)
- The degraded-engine path answers p95 < 150 ms on staging [H4]; both dashboard routes within their first-load budget
- Shape 13 and the selective network shape meet the 20 ms SQL budget warm at 500k rows, `developmentsCommission` p95 < 100 ms locally; at 2M on staging every fallback shape is index-driven with clustered data and its cold `m` read is recorded [H4]

### S7-F11 · Fallback planner statistics under RLS, and the S7-F4 commission function's removal (split from S7-F10)
Ref §4.2 §15 · Mod search, db · Dep S7-F10 · ⚡
**Build:**
- `listing_search_docs` is under RLS (`global_read using (true)` for `app_public`, S6-F1), so Postgres uses no column statistics for comparisons whose operator is not leakproof: `numeric` (`area_m2`, `plot_m2`), enums (`kind::text`), array `@>`. An area band is estimated at 1 row (148k real at 500k): an area band sorted by price reads the band through `area_idx` then sorts (467 ms at 500k, S7-F9). Measured in S7-F10: expression statistics on `(area_m2::float8)` with `float8` comparisons (leakproof) give the right estimate (152k), but lose `area_idx` as an index condition. Pick one, without weakening RLS (an ADR if the registry rule changes): (a) `area_m2` / `plot_m2` as `double precision` in this derived table (a table rewrite: expand → backfill → switch), (b) expression statistics + `float8` filters + expression indexes, (c) another leakproof form. Add the area band × price sort shapes to `[S7-F9]`.
- Drop `search_commission_at_least(uuid, integer)` — SECURITY DEFINER, still granted to `app_public` and unused by any code since S7-F10 (kept one release for the app version running during a deploy): out of `HELPER_FUNCTIONS`, `drop function if exists public.search_commission_at_least(uuid, integer)` in the generated SQL, the `[S7-F4]` generator test turned into a "no app role can execute it" check (guard + generator).
**Done when:**
- Every `[S7-F9]` shape plus area band × price sort and plot band × area sort is index-driven at 500k rows, p95 < 150 ms, estimates within 10× of the rows read
- No application role can execute `search_commission_at_least` (guard + generator test)

### S7-F12 · Resales follow-ups: run checkpoint, details fields and visible API errors (split from S6-F4)
Ref §3 #17 · Mod imports, properties, developments, web · Dep S6-F4 · ⚡
**Build:**
- Resume within a run: the last completed page on the run row; a retry of the same run resumes from it with the run's seen references kept (`property_import_seen` and `items_seen` are per run, so withdrawal stays correct after a resume); after N pages the job ends and requeues the run with its checkpoint, giving the imports slot back. Then a deadline overrun can be retryable.
- `FeedListing` + loader fields for what Resales sends only in `PropertyDetails`: community fees (`Community_Fees_Year` / 12 per month), IBI and basura (yearly), and a price range end (`priceTo`); other connectors map them where their formats have them.
- New developments from Resales (`NameType` development, `KeyReady`, Category "New Development"): `NewDevName`, key-ready and the `PriceList` units into the developments module (S4-01 / S4-02) through its public API, idempotent per reference.
- The API's own error text on a failed run: a bounded, redacted `error_detail` on `feed_runs`, shown on the run in the dashboard.
- A Resales Online connection form in the dashboard (EN / ES): Client ID, API key, filter alias, languages.
**Done when:**
- A 15,000-listing fake account at 40 per page completes across resumes, and a timeout mid-run resumes rather than restarting (integration test)
- A details record with fees, IBI and basura stores them on the listing (test)
- A development with a 2-unit price list creates one development with 2 units, and a re-run changes nothing (test)
- A run refused with "FilterAgencyId not valid" shows that text on the run (test)
**Split (2026-10-22):** the details-only fields, new developments and the connection form (with their two checks) moved to S7-F14; S7-F12 delivered the checkpoint / resume / slices and `error_detail`.

### S7-F13 · Contract: drop the pre-S7-F11 area index concurrently; scope the taxonomy test fixtures (split from S7-F11)
Ref §15 · Mod db, taxonomy, tests · Dep S7-F11
**Build:**
- Drop `listing_search_docs_area_idx` (on the `numeric` column; unused once every app runs S7-F11) with `DROP INDEX CONCURRENTLY` outside the migrator transaction: a drop list next to `CONCURRENT_INDEXES` that `pnpm db:migrate` applies before the migrations (an invalid or missing index is a no-op), the index out of the Drizzle schema with a migration that says `DROP INDEX IF EXISTS` (a no-op then).
- `ALTER TABLE feed_runs VALIDATE CONSTRAINT feed_runs_error_detail_ck` (added `NOT VALID` by S7-F12's migration 0105; the validation takes SHARE UPDATE EXCLUSIVE and does not block writes) in a migration of its own.
- Purge or scope the leftover location fixtures in the shared test database (37k locations left by other files' fixtures) that make the taxonomy tree cache entries multi-MB, so `taxonomy/tree.int.test.ts` no longer needs its 10 s Redis command timeout.
**Done when:**
- The drop list drops a listed index concurrently, skips a missing one, and the migration declaring the drop is a no-op once it ran (test)
- The taxonomy tree test runs under the default 200 ms command timeout in a parallel run (test)

### S7-F14 · Resales follow-ups, part 2: details fields, new developments and the connection form (split from S7-F12)
Ref §3 #17 · Mod imports, properties, developments, web · Dep S7-F12
**Build:**
- `FeedListing` + loader fields for what Resales sends only in `PropertyDetails`: community fees (`Community_Fees_Year` / 12 per month), IBI and basura (yearly), and a price range end (`priceTo`); property columns, DTO and read-model fields where the listing shows them; other connectors map them where their formats have them.
- New developments from Resales (`NameType` development, `KeyReady`, Category "New Development"): `NewDevName`, key-ready and the `PriceList` units into the developments module (S4-01 / S4-02) through its public API, idempotent per reference. Commission and owner data never reach public paths.
- A Resales Online connection form in the dashboard (EN / ES): Client ID, API key, filter alias, languages (dashboard route ≤ 250 KB first-load).
**Done when:**
- A details record with fees, IBI and basura stores them on the listing (test)
- A development with a 2-unit price list creates one development with 2 units, and a re-run changes nothing (test)
- The form creates a working Resales connection; a bad filter alias shows `FEED_SETTINGS_INVALID` (test)

### S7-F15 · Contract: validate `properties_costs_ck` (split from S7-F14)
Ref §3 #17 · Mod db · Dep S7-F14
**Build:**
- One migration that only runs `ALTER TABLE properties VALIDATE CONSTRAINT properties_costs_ck` (migration 0108 added the check `NOT VALID` so it did not scan `properties` under an exclusive lock; `VALIDATE` takes only a `SHARE UPDATE EXCLUSIVE` lock and reads and writes go on). Nothing else in the migration.
**Done when:**
- `properties_costs_ck` is validated (`pg_constraint.convalidated`) after `pnpm db:migrate`, and a negative fee is still refused (test)

### S8-01 · Legacy API capture and golden files
Ref §9.3 · Mod tests · Dep S0-14 · [H2]
**Build:** log analysis script (endpoints, params, frequencies per site); recorder that replays representative requests against the legacy API and stores normalized responses in `tests/golden/`.
**Done when:** the endpoints covering ≥ 99% of legacy traffic have golden files

### S8-02 · v1 shim
Ref §9.3 §3 #43 · Mod feed-api · Dep S8-01 S7-03 · ⚡
**Build:** `/v1/*` routes mapping legacy params to v2 services and reshaping responses; legacy IDs/refs via `legacy_id_maps`.
**Done when:** 100% golden-file parity in CI; latency within feed-api budget

### S8-03 · WordPress plugin core
Ref §9.4 · Mod wp-plugin · Dep S7-03 · [H15]
**Build:** settings page (API key, site, locales, cache TTL), API client, transient cache, mirror table for detail pages, delta sync via `/v2/changes` (cron), stale fallback when the API is unreachable.
**Done when:**
- With the API unreachable, cached search and detail pages still render
- Delta sync applies changes idempotently

### S8-04 · Plugin templates, blocks, shortcodes, SEO
Ref §9.4 · Mod wp-plugin · Dep S8-03 · [H15]
**Build:** Gutenberg blocks (search, results, detail, developments, map), legacy shortcodes mapped to blocks, overridable templates, pretty URLs per locale (Polylang/WPML), JSON-LD, sitemap provider.
**Done when:** every legacy shortcode in the inventory renders equivalent output on a test WP site *(manual + PHPUnit)*

### S8-05 · Plugin forms, health page, update server
Ref §9.4 · Mod wp-plugin, feed-api · Dep S8-04 S7-05
**Build:** lead/viewing forms (server-side post, Turnstile), health page (API status, cache age, version), update server endpoint + signed packages, release script.
**Done when:** a test site auto-updates from version N to N+1; forms create leads for the right agency

*Note (S7-05):* post with the secret key and an `Idempotency-Key` per form render (`createLead` / `createViewingRequest` in the SDK); forward the visitor's Turnstile token (`turnstileToken`, widget action `website-lead`) or, when the site runs its own check, send `serverVerified: true` (recorded as `SERVER_KEY`). A reference the site does not show answers 404 `LISTING_NOT_FOUND`.

### S8-06 · JS widget
Ref §9.5 · Mod sdk · Dep S7-03
**Build:** embeddable widget (search + results + detail modal) built on the SDK with publishable keys, SPW-AI natural-language search box when `/v2/search/ai` exists (R1: structured search only if AI not ready).
**Done when:** widget bundle ≤ 60 KB gzip; works on a plain HTML page with an allowlisted origin

### S8-F1 · Partner XML feeds follow visibility at once; feed tokens out of logs (S7 review) 🔒 ⚡
Ref §9.5 §12 · Mod website-api, infra · Dep S7-07
**Build:**
- On `publicDocsChanged` and `preferredRemoved`, queue the live feeds of every site that showed those targets, not only the owner's (`website-api/subscriptions.ts`), so a listing made PRIVATE or dropped by a give-to-get lock leaves partner `kyero.xml` / `inmolink.xml` within minutes, not at the next 6-hourly refresh. At minimum, filter the stored feed against current visibility before serving it.
- The feed token sits in the URL path: turn off or redact kamal-proxy request logging for `/v2/feeds/` (`infra/kamal/feed-api.yml`) and record Cloudflare log retention for that path in `docs/runbooks/cdn.md`.
- Feed size: with `WEBSITE_EDGE_CACHE` off, a feed poll streams the whole file (up to `SITE_FEED_MAX_GZIP_BYTES`, 64 MiB) through feed-api. Serve polls from a short-lived signed R2 URL (redirect) or only behind the edge cache. Record the feed as exempt from the 150 KB JSON budget.
- `refreshSiteFeeds` enqueues in bulk (`addBulk`), not one job per round trip.
- `website-api.int.test.ts` covers `/v2/feeds/:token/:file` in the ≤ 3-query check.
**Done when:**
- A network listing made PRIVATE is gone from a partner site's feed after the next feed job, without waiting for the 6-hour refresh (test)
- The feed route stays ≤ 3 queries warm and cold (test)

### S8-F2 · Embed page caching and one cache-policy table (S7 review) ⚡
Ref §9.5 §12 ADR 0013 · Mod public, feed-api · Dep S7-F8 S7-06
**Build:**
- Embed pages (`apps/public/src/embed/handlers.tsx`): `stale-if-error` with the feed cache shape, a strong ETag from the body with `If-None-Match` → 304.
- Only canonical embed URLs (known parameters, no free-text `q`) are public; anything else answers `private`, so cache-busting URLs cannot all reach the origin.
- A stale or forged cursor redirects to the first-page URL instead of running a second search.
- The edge-cache rules for `/v2/*` site answers (`plugins/site-response.ts`) and taxonomy (`routes/taxonomy/routes.ts`) move into one exported table, with a test that pins each route's policy.
- The ≤ 3-query check covers the embed search and detail pages.
**Done when:**
- An unchanged embed page answers 304 to its ETag; a URL with an unknown parameter is `private` (test)
- A forged cursor redirects without a search (test)

### S8-F3 · Resales developments: batched, and units the feed drops are withdrawn (S7 review) ⚡
Ref §3 #17 §7 M5 · Mod imports, developments · Dep S7-F14
**Build:**
- `importDevelopments` (`imports/load.ts`) reads the batch's developments by reference and their units in one statement each, diffs in memory and writes inserts / updates together; a per-development savepoint only as the fallback when the batch write fails. No statements per development in a loop.
- `importFeedDevelopment` (`developments/feed.ts`): units the feed no longer sends are withdrawn (as listings are after missed runs); a changed development name or location is applied.
**Done when:**
- A 500-development batch runs a fixed number of statements, independent of the batch size (test)
- A unit dropped from the price list is withdrawn and gone from the website API; a renamed development shows the new name (test)

### S8-F4 · Hardening and cleanups (S7 review) 🔒
Ref PATTERNS §1 §12 · Mod website-api, platform, search, taxonomy, imports, media, db, web · Dep S7-F15
**Build:**
- `site.tag` (`website-api/service.ts`) is an HMAC (`hmacSha256(HMAC_KEY, 'website-api.site-tag', …)`), not a plain SHA-256 of the site's settings, so a visitor cannot brute-force the minimum commission from `/v2/changes`' `scope`.
- `REDACT_KEYS` gains `whatsapp`, `turnstileToken`, `cf-turnstile-response`, `idempotency-key` / `idempotencyKey`, `pageUrl`, `viewingSlots`.
- Lead and viewing-request writes keep an in-process cap per key while the limits Redis is down (like `LocalFailedChecks`), so a leaked secret key with `serverVerified: true` cannot spam leads and acknowledgement e-mails during an outage.
- `deleteAgencySheets` has no caller: note it as a dependency of the offboarding / erasure task so tenant erasure covers uploaded sheets.
- Dead code and surface: delete `search/repo.ts` `targetOfCode`; trim `website-api/index.ts` to what apps, workers and other modules import; drop `export` from file-local `publishableIpRule`, `catalogAliases`, `maskAddresses`, `NO_DEVELOPMENT`, `newPublicCode`.
- Rename the recursive CTE `agencies` in `media/feed-images-repo.ts` (shadows the real table); update the registry reason of `listing_search_commissions` (read by `app_public` through `search_commission_floor` since S7-F10).
- The connection form's URL and API-key placeholders move to `packages/i18n` (EN, ES).
**Done when:**
- Two sites with different minimum commissions and the same settings otherwise get unrelated tags, and the tag is not a SHA-256 of the settings (test)
- With the limiter failing, lead writes on one key stop at the local cap (test)
- A log line with a `whatsapp` or `turnstileToken` field is redacted (test)

---

### S8-F5 · Field locks for feed developments (S8-F3 review)
Ref §3 #17 §7 M5 · Mod developments, imports · Dep S8-F3
**Build:**
- A development's name and location (and later fields a feed sets) can be locked by the owner, like a listing's field locks (S6): `importFeedDevelopments` (`developments/feed.ts`) leaves a locked field as the owner set it, in the same batched statements (no per-development reads).
- Editing a feed development's name or location by hand in the dashboard locks that field (or offers to), so the next run does not undo the edit; the development page shows which fields the feed owns.
**Done when:**
- A renamed feed development keeps the owner's name after the next run while an unlocked one follows the feed (test)
- The batch still runs a fixed number of statements with locks present (test)

### S8-F6 · One in-process fixed-window limiter (S8-F4 review)
Ref §12 · Mod platform, website-api, feed-api · Dep S8-F4
**Build:**
- `LocalWriteCaps` (`website-api/local-caps.ts`, S8-F4) and feed-api's `LocalFailedChecks` (`apps/feed-api/src/plugins/api-key.ts`, S7-F9) become one `platform/rate-limit` `LocalFixedWindows`: synchronous reserve/release, pools tracked apart (identities an attacker can multiply never evict others), expired windows swept first, a full pool refuses new identities instead of forgetting live windows.
- Optional: an in-process per-site cap on embed lead posts in `checkEmbedLimits` (today Turnstile, failing closed, and the per-site daily acknowledgement cap bound them).
**Done when:**
- Both callers use `LocalFixedWindows` and keep their S7-F9 / S8-F4 tests green (test)
- A flood of new IP identities does not evict a tracked failed-check or key window (test)

### S8-F7 · Media worker burst RSS back under budget (S8 CI)
Ref §13 · Mod media, worker · Dep S6-F5
**Build:**
- `[S4-F2]` / `[S3-04]` in `tests/perf/media-processing.int.test.ts` now peak at 460–530 MB on CI (370–500 MB on 2026-10-17…20; idle RSS flat at ~146 MB), so a normal run crosses 512 MB about one time in four (failed on 8f1d11e, 622b1c8, 5622153, 3288d64 twice). Find what raised the burst peak — first suspect e9d6d86 (S6-F5: large originals decoded alone, V8 sizing), then a9a40cb, fcaefaf, 5d2904c — by comparing peaks on Linux (`node:24.15.0-bookworm`, `--cpuset-cpus=0-3`), and restore real headroom under 512 MB without raising the budget.
**Done when:**
- The burst peak is ≤ 470 MB on 5 consecutive CI runs (test)
- **Manual CI check (S9-F6):** the test asserts only the 512 MB budget; after each CI run read `[S8-F7] (target ≤ 470 MB, budget 512 MB)` from the `[S3-04]` burst log of `tests/perf/media-processing.int.test.ts` and record the peak — done after 5 consecutive runs at or below 470 MB.

### S8-F8 · Widget: natural-language search and lead form (S8-06)
Ref §9.5 · Mod sdk, website-api · Dep S8-06
**Build:**
- Natural-language box in the widget once `/v2/search/ai` exists (feature check on the key's site); until then structured search only.
- Enquiry / viewing-request form in the detail modal on `createLead` / `createViewingRequest` (Turnstile for publishable keys, Idempotency-Key), after H3.
- Serve `inmolink-widget.iife.js` with a versioned immutable URL from the CDN (deploy).
**Done when:**
- A widget enquiry arrives as a website lead with the site's agency (test)
- The AI box is absent while the endpoint is missing (test)

### S8-F9 · Local limiter windows only while the shared limiter fails open (S8-F6 review)
Ref §9.5 · Mod platform, website-api · Dep S8-F6
**Build:**
- The rate-limit result says when it failed open (the signal behind `inmolink.rate_limit.failures`); the local windows (`LocalFixedWindows`: feed-api failed key checks, website form posts) enforce only then, and count always.
- A per-process cap on total failed key lookups and on untracked form posts while failing open, so identities left untracked (pool full of boxed windows, eviction scan past `EVICT_SCAN`) are still bounded.
- Eviction finds a window under its limit whenever one exists (no 64-window scan limit, e.g. a separate list of under-limit windows).
**Done when:**
- With Redis healthy, a flood of 10k+ failing IPs changes nothing for a new IP with a valid uncached key (test)
- With the limiter failing open and the ip pool full of boxed windows, failed lookups from new IPs stop at the per-process cap (test)

### S8-F11 · Settings migration from the legacy WordPress plugin (S8-03) · [H15]
Ref §9.4 · Mod wp-plugin · Dep S8-03
**Build:** on activation, read the legacy plugin's options (names from H15) into the new settings and the encrypted key; leave the old options untouched.
**Done when:** a site with the legacy plugin's settings activates v2 and syncs without re-entering the key (PHPUnit on a fixture of the legacy options)

### S8-F12 · Plugin: bound cache misses and detail 404s (S8-03 review)
Ref §9.4 · Mod wp-plugin · Dep S8-04
**Build:** per-IP limit on cache misses before calling the API; a short cache for detail 404s, once S8-04 wires query vars to search and detail.
**Done when:** a crawl of random refs makes at most the limit's API calls per IP (PHPUnit)

### S8-F13 · Plugin: separate back-offs, Retry-After (S8-03 review)
Ref §9.4 · Mod wp-plugin · Dep S8-03
**Build:** separate back-off for sync and page views; honour `Retry-After` on 429/503.
**Done when:** a 429 with `Retry-After: 120` pauses calls for 120 s and page views keep serving cache while sync backs off (PHPUnit)

### S8-F14 · Plugin: previous cache generation as stale-only fallback (S8-03 review)
Ref §9.4 · Mod wp-plugin · Dep S8-03
**Build:** after a cache flush, keep the previous generation readable as stale-only until the first successful refresh.
**Done when:** flush then API down still renders the last search page (PHPUnit)

### S8-F15 · Plugin: Plugin Check in CI and translations (S8-03 review)
Ref §9.4 · Mod wp-plugin · Dep S8-03
**Build:** WordPress Plugin Check in the `wp-plugin` CI job; `.pot` and EN/ES (+ NL/DE/FR/SV drafts) in `languages/`.
**Done when:** Plugin Check passes in CI; the admin page renders in Spanish (PHPUnit)

### S8-F16 · Plugin: multisite (S8-03 review)
Ref §9.4 · Mod wp-plugin · Dep S8-03
**Build:** uninstall loops over every site; changing the API URL needs network-level rights on multisite.
**Done when:** uninstall on a 2-site network removes both sites' tables and options (PHPUnit multisite)

### S8-F17 · Plugin: warn when salts live in the database (S8-03 review)
Ref §9.4 · Mod wp-plugin · Dep S8-03
**Build:** an admin notice when the WordPress salts are stored in the database rather than wp-config.php (a database dump alone could then decrypt the key).
**Done when:** the notice shows with DB salts and not with wp-config salts (PHPUnit)

### S8-F21 · Plugin: Polylang and WPML on real installs (S8-04) · [H15]
Ref §9.4 · Mod wp-plugin · Dep S8-04
**Build:** check the language adapters on real Polylang and WPML installs: Polylang directory mode vs our rewrite rules (double prefix), WPML's request URI / home URL rewriting, the extra `lang=` query var; fix what differs from the fake adapter.
**Done when:** listing and development URLs route and canonicalise per locale on a test site with each plugin (manual + PHPUnit on the adapters)

### S8-F22 · Plugin: translatable editor strings (S8-04 review)
Ref §9.4 · Mod wp-plugin · Dep S8-F15
**Build:** block attribute labels through a label map and `wp_set_script_translations`; included in the S8-F15 `.pot`.
**Done when:** the block sidebar renders in Spanish (PHPUnit on the registered translations)

### S8-F23 · Plugin: API host address checks (S8-04 review)
Ref §9.4 · Mod wp-plugin · Dep S8-03
**Build:** per-IP limit on uncached API calls; refuse link-local, carrier-grade NAT and private IPv6 API hosts, also after DNS resolution.
**Done when:** a base resolving to 169.254.0.0/16, 100.64.0.0/10 or fc00::/7 is refused (PHPUnit)

### S8-F24 · Developments in the plugin sitemap (S8-04 review)
Ref §9.4 · Mod wp-plugin, website-api · Dep S8-04
**Build:** `/v2/sitemap` gains DEVELOPMENT entries (contract + OpenAPI + `pnpm sdk:generate`); the plugin's provider lists them.
**Done when:** a site's developments appear in its WP sitemap with lastmod (PHPUnit + API int test)

### S8-F25 · Plugin: SEO plugin coexistence (S8-04 review)
Ref §9.4 · Mod wp-plugin · Dep S8-04
**Build:** silence Yoast / RankMath canonicals and titles on routed pages; an end-to-end `template_redirect` test.
**Done when:** a routed listing page has one canonical with Yoast active (PHPUnit)

### S8-F26 · Legacy key flag and lookup functions locked at the database (S8-02 re-audit)
Ref §9.3 · Mod db, identity · Dep S8-02
**Build:** `app_user` gets column-level `UPDATE` on `api_keys` without `legacy_query_key` (registry column grants, regenerated RLS); `alter function legacy_target_ids(text[]), legacy_ids_of(uuid[]) owner to app_owner` emitted by `pnpm db:rls`; optionally the functions take the site's inventory agency ids. Brought forward from S8-F19's guard (which waits on S14-03).
**Done when:**
- An `app_user` update of `legacy_query_key` fails with 42501 (isolation test)
- `app_user`, `app_intake`, `app_auth` and `app_staff` calling either lookup function get 42501, and a seeded `contact` map row never comes back from `legacy_target_ids` (isolation test)

### S8-F27 · Plugin: update freeze protection (S8-05 review)
Ref §9.4 · Mod wp-plugin, plugin-updates · Dep S8-05
**Build:** sign `releasedAt` too and refuse metadata older than N days, or remember the highest version seen, so a replayed old manifest cannot freeze a site on a vulnerable version.
**Done when:** a replayed older manifest offers no update and the health page flags it (PHPUnit)

### S8-F28 · Plugin: real API probe on the health page (S8-05 review)
Ref §9.4 · Mod wp-plugin · Dep S8-05
**Build:** a cached cheap API call for "API reachable" instead of inferring it from the back-off and the last sync.
**Done when:** the health page shows reachable / unreachable within one probe interval of a change (PHPUnit)

### S8-F29 · Plugin: limit failed form posts, trusted proxy CIDRs (S8-05 review)
Ref §9.4 · Mod wp-plugin · Dep S8-05
**Build:** a per-IP limit on form posts that fail Turnstile; a trusted-proxy CIDR list instead of a single header name.
**Done when:** the 6th failing post from one IP in 10 minutes is refused without a Cloudflare call (PHPUnit)

### S8-F30 · Release race and reproducible zips (S8-05 review)
Ref §9.4 · Mod plugin-updates, platform · Dep S8-05
**Build:** a conditional put in the storage adapter so two concurrent releases cannot race on `latest.json`; a byte-reproducible plugin zip across git versions.
**Done when:** two concurrent releases leave `latest.json` at the higher version (test); the same commit zipped twice is byte-identical (test)

---

### S8-F10 · v1 cutover on the legacy hostname (S8-02) · [H5]
Ref §9.3 · Mod ops, feed-api · Dep S8-02
**Build:** a Cloudflare transform rule on the legacy hostname rewriting `/api/*` to `/v1/*` (`legacyShimPath`), managed with `pnpm ops:cdn-rules`; Logpush and the origin proxy configured so no log on that hostname keeps the query string (`api_key`); `/v1` added to the k6 website mix (`tests/load`) with the legacy sites' request rate.
**Done when:**
- The rule maps every legacy path the traffic report names to its `/v1` route (test over `traffic.json`)
- A request with `?api_key=` leaves no key in Cloudflare or proxy logs (staging check, runbook step)
- `/v1` at the legacy sites' peak rate stays within the feed-api budget in the load test

### S8-F18 · v1 coverage of the real traffic (S8-02) · [H2]
Ref §9.3 · Mod feed-api, website-api · Dep S8-01 S8-02
**Build:** every endpoint of the traffic report's 99% set the shim does not serve yet — likely `/api/locations` (with legacy location ids from the taxonomy maps) and `POST /api/contact` (to the S7-05 lead intake: Turnstile and idempotency mapping, a hand-written golden).
**Done when:** `pnpm test:golden`'s coverage check passes on the real `traffic.json`; each new route stays within 3 queries and p95 < 150 ms

### S8-F19 · Legacy key import marks keys (S8-02) · [H1]
Ref §14 · Mod migration, identity · Dep S8-02 S14-03
**Build:** the legacy key import creates each site's v2 key with the legacy key's value hashed (zero-touch cutover) and `legacy_query_key = true`; a guard-trigger rule so no `app_user` write can set `legacy_query_key`; a staff report of keys still used as `?api_key=` (last seen) to drive rotation after cutover.
**Done when:**
- An imported legacy key authenticates as `?api_key=` on `/v1`, a dashboard-created key does not (test)
- An `app_user` update setting `legacy_query_key` is refused (isolation/guard test)

### S8-F20 · v1 golden parity sign-off (S8-02) · [H2]
Ref §9.3 · Mod feed-api, website-api · Dep S8-01 S8-F18 S14-03
**Build:** export the H2 test account's read-path rows to `tests/golden/fixture.json`; reshape contracts `legacy-v1.ts` and core `website-api/legacy-v1.ts` until every recorded golden matches; delete `tests/golden/synthetic/`; freeze `/v1`.
**Done when:** `pnpm test:golden` passes with 100% parity on the recorded set in CI; S8-02 marked DONE

## S9 — Portal exports

### S9-01 · Portal connections and selection rules
Ref §3 #19 §7 M7 · Mod exports · Dep S3-02 S7-02
**Build:** `portal_channels`, `agency_portal_connections` (encrypted credentials, feed token), selection rules (all PUBLIC / tagged / manual), per-property include/exclude, UI.
**Done when:** selection rules produce a deterministic listing set per connection (snapshot test on fixtures)

### S9-02 · Feed writers and validation
Ref §7 M7 · Mod exports · Dep S9-01 · [H6]
**Build:** streaming writers for Kyero, thinkSPAIN, A Place in the Sun, generic XML; pre-export validation (required fields, CEE, minimum photos, description length) with per-property status and error messages.
**Done when:**
- Output validates against each portal's schema/fixture
- Invalid properties are excluded with a visible reason; valid ones still export

### S9-03 · Export generation and delivery
Ref §7 M7 · Mod exports · Dep S9-02 · ⚡
**Build:** `exports` worker regenerates feeds on listing events (debounced) and nightly; writes to R2; served via CDN at tokenized URLs; run history.
**Done when:**
- 5,000 feeds regenerate nightly within 60 min on the scale seed without starving other pools
- Unchanged feeds are not rewritten (content hash)

### S9-04 · idealista and Fotocasa adapters
Ref §3 #19 · Mod exports · Dep S9-02 · [H6]
**Build:** adapters behind feature flags following each partner's integration spec once access is granted.
**Done when:** sandbox submissions succeed *(when H6 is complete)*; otherwise `BLOCKED-HUMAN H6` with scaffolding merged

### S9-F1 · Legacy recordings never carry keys or personal data (S8 review) 🔒
Ref §9.3 · Mod scripts · Dep S8-01
**Build:** `pnpm legacy:record` replaces the test key in recorded bodies (`normalizeJson` / `normalizeText`) and fails if it still appears; `tests/golden/recorded/` gitignored until the H2 sign-off; a scan that flags e-mail, phone and cadastral fields before the S8-F20 export is committed.
**Done when:**
- A stub API echoing the key in a paging link records `<key>` and a planted leftover fails the recording (test)
- A recorded body with an e-mail or phone fails the scan (test)

### S9-F2 · Embed pages purged when a site's domains change (S8 review) 🔒
Ref §9.5 · Mod websites, public · Dep S8-F2
**Build:** a change to a site's domains or `frameAncestors` emits the site's edge-tag purge, so a removed domain cannot keep framing the cached embed page until it expires.
**Done when:** removing a domain enqueues the site's purge in the same transaction (int test)

### S9-F3 · Plugin update metadata signed; Turnstile retries keep their key (S8 review)
Ref §9.4 · Mod wp-plugin, plugin-updates · Dep S8-05
**Build:** the release signature also covers `changelog`, `requires` and `tested` (with S8-F27's `releasedAt`); the plugin's Turnstile idempotency key is a UUIDv5 of the token hash, so a network retry of siteverify is not a duplicate.
**Done when:** a manifest with an altered changelog offers no update (PHPUnit); a retried siteverify with the same token succeeds (PHPUnit)

### S9-F4 · Worker and update-server bounds (S8 perf review) ⚡
Ref §5 · Mod platform, developments, plugin-updates, migration · Dep S8-F3 S8-05
**Build:** outbox `emit` chunks by payload bytes too (≈ 8 MB) besides `EMIT_CHUNK_ROWS`; a failed developments feed batch is bisected (halve and retry) instead of retried row by row; an unknown plugin version's miss is cached 60 s in-process; the legacy taxonomy reload uses the platform `clock`.
**Done when:**
- A batch of 10k 10 KB payloads is emitted in ≥ 13 statements, none over the byte cap (test)
- One bad development in 500 costs ≤ 7 × log2(500) statements (statement-count test)
- 50 requests for an unknown plugin version make one storage read (test)

### S9-F5 · Plugin and contract lead validation in step (S8 review)
Ref §9.4 · Mod wp-plugin, contracts · Dep S8-05 S8-F8
**Build:** the plugin's name check mirrors the contract (`website-leads.ts`, domains refused); `LEAD_LIMITS.phone` = 25 with `LeadPhone` derived from it; the plugin template uses `Turnstile::ACTION` and the limits; one shared fixture of valid / invalid leads run by both the contract tests and PHPUnit.
**Done when:** every fixture case gets the same verdict from the contract and the plugin (vitest + PHPUnit)

### S9-F6 · feed-api response helper and SDK surface (S8 review)
Ref §9.2 · Mod feed-api, plugin-updates, migration, sdk · Dep S8-02 S8-05
**Build:** one `sendConditional(req, reply, { etag, cacheControl, vary })` in `site-response.ts` for the six copies of the ETag / 304 code; plugin update routes tagged `wp-plugin` and left out of the customer SDK (`pnpm sdk:generate`); the `/v2/plugin/update` edge rule takes `PLUGIN_RELEASE_CACHE_SECONDS`; unused exports trimmed from `plugin-updates` and `migration` index files; the S8-F7 headroom check named as a manual CI check in the backlog (or a flagged soft assert).
**Done when:** the generated SDK has no plugin operations (test); every conditional GET still answers 304 on a matching `If-None-Match` (existing tests green)

---

## S10 — CRM core

### S10-01 · Contacts
Ref §6 CRM §7 M8 · Mod crm · Dep S1-02
**Build:** contacts (types, multiple emails/phones normalized E.164, language, source, tags, consent flags, do-not-contact), notes, duplicate detection on email/phone with merge, CSV import with mapping.
**Done when:**
- Creating a contact with an existing email/phone offers merge instead of duplicating
- Merge moves leads, activities, tasks and registrations to the surviving contact

### S10-02 · Leads, routing and inbox
Ref §3 #12 §7 M8 · Mod crm · Dep S10-01 S7-05
**Build:** leads with source channel, presenting and owner agency, target (listing/development/unit), status, assignment rules (round-robin or owner agent), unified inbox (website, portal, iFrame, selections, chatbot later, manual); inbound leads from S7-05 promoted to full leads.
**Done when:**
- Routing follows §3 #12 for each source (table-driven test)
- Website lead lands in the right agency inbox in < 10 s p95
- Listing owner sees introducer agency but never the client's PII before registration

*Note (S7-05):* inbound leads are `websites.website_leads` (presenting agency = `agency_id`, network owner = `owner_agency_id`, `verification`, `ack_sent_at` for response-time KPIs), each announced by `websites.lead.received`; promote them from that event (idempotent per lead id). The speed-to-lead acknowledgement and the agency e-mail already exist (website-api jobs); assignment rules replace the e-mail's recipient choice.

*Note (S10-01 merge):* register this task's contact-referencing tables in `crm/repo.ts` `CONTACT_REFERENCES` (crm-owned) or subscribe to `crm.contact.merged` (other modules) so a merge re-points them; extend the `[S10-01]` merge acceptance test with them.

### S10-03 · Pipeline
Ref §7 M8 · Mod crm, web · Dep S10-02
**Build:** agency-customizable stages, board and list views, drag to change stage, stage history.
**Done when:** stage changes are recorded in activity and visible in reports data

*Note (S10-01 merge):* register this task's contact-referencing tables in `crm/repo.ts` `CONTACT_REFERENCES` (crm-owned) or subscribe to `crm.contact.merged` (other modules) so a merge re-points them; extend the `[S10-01]` merge acceptance test with them.

### S10-04 · Activity timeline
Ref §6 CRM · Mod crm · Dep S10-01 S1-08
**Build:** partitioned `activities` (polymorphic: contact, lead, listing), writers from other modules via events, timeline UI with filters.
**Done when:** timeline for a contact with 5,000 activities loads first page in < 300 ms (keyset)

*Note (S10-01 merge):* register this task's contact-referencing tables in `crm/repo.ts` `CONTACT_REFERENCES` (crm-owned) or subscribe to `crm.contact.merged` (other modules) so a merge re-points them; extend the `[S10-01]` merge acceptance test with them.

### S10-05 · Tasks and reminders
Ref §7 M8 · Mod crm · Dep S10-01
**Build:** tasks linked to contact/lead/listing, due dates, assignees, reminders (notification + email), my-tasks view.
**Done when:** reminders fire once at the due time (scheduled job, idempotent)

*Note (S10-01 merge):* register this task's contact-referencing tables in `crm/repo.ts` `CONTACT_REFERENCES` (crm-owned) or subscribe to `crm.contact.merged` (other modules) so a merge re-points them; extend the `[S10-01]` merge acceptance test with them.

### S10-06 · Calendar
Ref §7 M8 · Mod crm · Dep S10-05
**Build:** events (viewing, meeting, call), attendees (users, contacts), reminders, per-user ICS feed (secret URL) for Google/Outlook subscription.
**Done when:** ICS feed validates and reflects changes within 15 min; revoking the URL token stops access

### S10-07 · Acquisition board
Ref §7 M8 · Mod crm, web · Dep S10-03 S3-02
**Build:** seller prospects (board, list, calendar views), confidential notes, one-click convert to a DRAFT listing with seller linked in `property_privates`.
**Done when:** conversion creates the listing and links the seller contact without exposing it to other tenants

*Note (S10-01 merge):* register this task's contact-referencing tables in `crm/repo.ts` `CONTACT_REFERENCES` (crm-owned) or subscribe to `crm.contact.merged` (other modules) so a merge re-points them; extend the `[S10-01]` merge acceptance test with them.

### S10-08 · Data export
Ref §3 #59 · Mod compliance · Dep S10-01 S3-02
**Build:** `data_export_jobs`: contacts, leads, listings as CSV/XLSX; full account ZIP (data + media manifest); signed download link, 7-day expiry; formula-injection escaping.
**Done when:**
- 100k-contact export completes as a job without blocking the API
- Cells starting with `= + - @` are escaped

### S10-09 · Response-time KPI
Ref §3 #60 · Mod crm, reports · Dep S10-02
**Build:** `auto_ack_sent_at`, `first_human_response_at`, `response_seconds` on leads; first human response detected from reply, call log or status change; per-agent and per-agency medians on the dashboard home.
**Done when:** KPI values match fixture scenarios (business-hours-agnostic for R1)

---

### S10-F1 · exports public surface: worker-only helpers out of the index (S9 review) 🔒
Ref §4 · Mod exports · Dep S9-04
**Build:** `decryptCredentials`, `workerConnections`, `connectionForWorker` and `selectConnectionListings` (tx, no ctx, `app_system`) move behind the worker-only entry (`exports/worker.ts`, e.g. `exports/connections-worker.ts`) so `service.ts` is ctx-only; trim index / worker exports with no consumer outside the module (`FEED_FILE_OF_FORMAT`, `PORTAL_PREFERRED_LOCALE`, `selectionBatch`, `selectionRuleOf`, `SELECTION_MAX_BATCH`, `portalFeedObjectKey`, `PORTAL_FEED_MAX_GZIP_BYTES`, `PORTAL_FEED_REDIRECT_TTL`, `planAgencyFeeds`, `writePlannedFeeds`, `FEED_BATCH`, `HashedGzipUpload`, the `queue*` helpers, push timing constants, `OAuthPortalHttp`, `LIVE_CACHE_MS`; tests import internals directly); `FEED_RUNS_KEPT` moves out of `service.ts`; the "feed server, S9-04" comment says S9-03; the S9-02 acceptance `it`s carry `[S9-02]`.
**Done when:** `apps/api` cannot import `decryptCredentials` or the tx-only helpers (boundary test); no export of either entry is unused outside the module (check script or test)

### S10-F2 · One stored-feed upload and serving helper (S9 review)
Ref §9.5 · Mod exports, website-api, feed-api · Dep S9-03
**Build:** a shared `GzipObjectUpload` (hash target text or gzip, size cap, abort) next to `core/src/feed-xml.ts` replacing `HashedGzipUpload` and site-feeds' `GzipUpload`; a shared `storedFeedFile(key, maxBytes, ttl, notFoundCode)` for `serve.ts` and `site-feeds.ts`; a feed-api `sendStoredFeed(req, reply, file)` beside `sendConditional` for both feed routes; one redirect TTL for site and portal feeds (60 s, the shorter) or a recorded reason.
**Done when:** site and portal feed tests green on the shared helpers; no copied upload / serve / route code left (review)

### S10-F3 · Row-bound credential cipher in platform/crypto (S9 review)
Ref §5 · Mod platform, exports, imports · Dep S9-01
**Build:** `rowCipher(table, column)` in `platform/crypto` replaces the duplicated encrypt / decrypt helpers in `exports/config.ts` and `imports/config.ts`.
**Done when:** a ciphertext bound to one row does not decrypt for another row or table (unit test); imports and exports credential tests green

### S10-F4 · Portal secrets out of request paths; worker tables read-only for app_user (S9 review) 🔒
Ref §5 · Mod exports, db · Dep S9-04
**Build:** `connectionColumns` stops selecting `credentials_enc` (a worker-only select reads it); registry `hiddenColumns: ['credentials_enc', 'token_hash']` on `agency_portal_connections`; `app_user` SELECT-only on `portal_feed_runs` and `portal_listing_sync` (written by the generator / push job as `app_system`); `userNoUpdateColumns` `feed_run_id`, `feed_sha256`, `push_error`, `nightly_at` on `agency_portal_connections`.
**Done when:** app_user selecting `credentials_enc` / `token_hash` and writing `portal_listing_sync.remote_id` get 42501 (isolation tests); dashboard and worker tests green

### S10-F5 · Location precision in portal XML feeds (S9 review) 🔒
Ref §7 M7 · Mod exports, website-api · Dep S9-04
**Build:** decide with Shahzaib whether EXACT pins may reach feed portals (Kyero, thinkSPAIN, A Place in the Sun, site feeds) while push portals get them rounded to 3 decimals until H6; apply the same rule in both XML writers (`core/src/feed-xml.ts`) or record that exact pins are intended.
**Done when:** the rule is in STATUS Decisions and a writer test asserts it for an EXACT and an APPROX listing

### S10-F6 · Plugin: wp-config key changes flush the cache; no unpinned API calls (S9 review) 🔒
Ref §9.4 · Mod wp-plugin · Dep S8-F14 S8-F23
**Build:** a fingerprint of (API base, key prefix) in `Cache::key()` and the mirror (or stored and compared on boot → `flush(false)` + mirror truncate), so `INMOLINK_API_KEY` / `INMOLINK_API_BASE` changes in wp-config.php never serve the previous agency; when `CURLOPT_RESOLVE` pinning cannot apply (streams transport), answer from cache only and say so on the health page; a deprecation notice when only the legacy trusted-header setting is used.
**Done when:** changing the key constant then taking the API down renders nothing from the old agency (PHPUnit); a streams-transport request makes no network call (PHPUnit)

### S10-F7 · Portal connection create takes Idempotency-Key (S9 review)
Ref §8 · Mod exports, api · Dep S9-01
**Build:** `POST /v1/portal-connections` accepts `Idempotency-Key` with the standard replay (the token shown once is answered again for a retry, as `POST /v1/sites/{id}/feed/token` does).
**Done when:** a retried create with the same key returns the same connection and token, no second row (int test)

### S10-F8 · Push teardown and live-advert queries index-driven (S9 perf review) ⚡
Ref §5 · Mod exports, db · Dep S9-04
**Build:** `liveAdverts` keyset on `property_id > last` (no restart from the start per page) and a partial index `(agency_id, connection_id, property_id) where remote_id is not null and state <> 'WITHDRAWN'`, also used by `hasLiveAdverts`.
**Done when:** teardown of 20k adverts reads each row once (statement / rows test); EXPLAIN of both queries uses the partial index, < 20 ms at 20k rows

### S10-F9 · One selection read per rule across an agency's connections (S9 perf review) ⚡
Ref §5 · Mod exports · Dep S9-03
**Build:** per 200-listing batch, connections with the same rule read the base page and exclusions once (grouped selection), and issue rows are written in one statement for all connections; `firstNightlyAgencies` without a Seq Scan (DISTINCT ON per lane over the live index, or an expression index on the lane hash); `setOverrides` ≤ 10 statements (counts from the rows written); a plain-XML request with the edge cache off is redirected to the signed URL instead of being gunzipped through feed-api.
**Done when:** a 20-connection agency's batch runs ≤ 2 × (rules + 2) statements (statement-count test); the nightly sweep and `setOverrides` meet their budgets (EXPLAIN / query-count tests)

### S10-F10 · Scale-seed cleanup within the statement timeout (S9 CI)
Ref §15 · Mod tests · Dep S0-13
**Build:** `tests/perf/seed-scale.int.test.ts` cleanup (`delete from properties where owner_user_id in (…)`) hit the statement timeout in CI twice (eafe6fb, a1e016a) — likely the growing set of FK cascades / checks on `properties` (exports tables S9-01 … S9-04); delete in batches (or by agency through the cascade) and check every FK referencing `properties` has an index.
**Done when:** the cleanup runs in batches each under the timeout (test); 5 consecutive CI runs green

---

## S11 — MLS collaboration & network board

### S11-01 · Client registration
Ref §3 #8 §7 M10 · Mod mls · Dep S10-01 S5-05 · 🔒
**Build:** `client_registrations`: introducer registers a contact to a listing/development; fingerprint = HMAC(normalized email/phone); encrypted client details; validity from agency settings; conflict rule (first valid wins); owner sees “registered by Agency X”, not the client.
**Done when:**
- Second agency registering the same client for the same target gets `REGISTRATION_CONFLICT`
- Expired registrations no longer block
- Fingerprints are not reversible without the HMAC key (no raw identifiers stored outside encrypted fields)
*Note (S10 review):* a contact merge must move registrations too (S10-01 Done-when) — subscribe to `crm.contact.merged` or register `client_registrations` in `CONTACT_REFERENCES`, and extend the `[S10-01]` merge test.

### S11-02 · Viewing requests and terms snapshot
Ref §3 #9 §7 M10 · Mod mls · Dep S11-01
**Build:** request → accept/decline/reschedule → scheduled → outcome; terms snapshot (commission, split, VAT, validity) accepted by both sides; immutable; simple PDF of accepted terms via PDF service when available (stub until S12-05); expiry job.
**Done when:**
- Terms snapshot cannot change after both acceptances (DB constraint + test)
- The snapshot stores `commission_bp` and `split_bp` (or the fixed amount) and the VAT flag as of acceptance
- Unanswered requests expire after the configured days and notify both sides

### S11-03 · Chat
Ref §7 M12 · Mod chat, realtime · Dep S11-02 S0-08
**Build:** threads (VIEWING, DIRECT), messages, read state, Socket.io delivery, typing indicator, WhatsApp/email handoff buttons; offline users get an email digest after 5 minutes.
**Done when:**
- Message fan-out p95 < 500 ms locally with 1,000 connected sockets
- Users cannot join or read threads they are not part of

### S11-04 · Notifications
Ref §7 M12 · Mod notifications · Dep S0-06
**Build:** partitioned `notifications`, preferences per type and channel, in-app feed (realtime), email digests, unread counts.
**Done when:** disabling a notification type stops both in-app and email for that type

### S11-05 · Network board (AMS)
Ref §3 #24 §7 M11 · Mod network · Dep S11-03 S5-02
**Build:** posts (BUYER_REQUEST, PROPERTY_OFFER, DISTRESSED, DEVELOPER_ANNOUNCEMENT) with structured criteria, expiry; subscriptions with filters; replies open chat threads; auto-match buyer requests to members' own listings and notify them.
**Done when:**
- Subscribers receive only posts matching their filters
- A buyer request matching 3 of my listings notifies me once with those 3

### S11-06 · My collaborations
Ref §7 M10 · Mod mls, web · Dep S11-02
**Build:** one view of my registrations, viewing requests (in and out) and their states, with filters.
**Done when:** view loads ≤ 10 queries for an agency with 500 collaborations

### S11-F1 · One Idempotency-Key helper for core services (S10 review)
Ref §8 · Mod crm, compliance, core · Dep S10-08
**Build:** the Idempotency-Key plumbing copied seven times (local `sha256`, 24 h window, replay lookup, `safeEqual` body check, 23505 → `IDEMPOTENCY_KEY_REUSED`) in `crm/{activities,leads,pipeline,tasks,calendar,prospects}.ts` and `compliance/data-export.ts` becomes one core helper; the advisory lock borrowed from `activitiesRepo.lockIdempotency` (prefix `crm-activity-idem`) moves to a neutral helper; one error code for "a body references an unknown listing" (`tasks`, `calendar`, `activities` throw the properties code `LISTING_NOT_FOUND` 404, leads `LEAD_TARGET_NOT_FOUND` 422) in `crmErrors`, with one shared check.
**Done when:** no copied idempotency code left (review); every create route's replay and reuse-after-24 h tests green on the helper

### S11-F2 · CRM audit trail (S10 security review) 🔒
Ref §5 · Mod crm, compliance · Dep S10-06
**Build:** `audit(ctx, …)` in the same transaction for ICS feed issue / rotate / revoke (a credential), contact merges and bulk contact imports (actor, impersonator, ids); confirm the S1-09 impersonation session audit covers bulk client-data reads (contacts, leads, activities, calendar, prospects lists) or audit list / get calls made under impersonation (crm currently cannot import compliance — resolve the cycle through an event or a platform-level audit writer).
**Done when:** each of those actions writes one audit row (int tests); impersonated CRM reads are traceable (test)

### S11-F3 · Data-export job state worker-only; cross-agency export test (S10 review) 🔒
Ref §5 · Mod compliance, db · Dep S10-08
**Build:** `data_export_jobs` `userNoUpdateColumns` for `status`, `expires_at`, `file_deleted_at`, `object_key` (job state written as `app_system`), or a guard trigger; an isolation test for the `withSystem` listing / media read: two agencies, export one, no row of the other in the file.
**Done when:** app_user updating those columns gets 42501 (isolation test); the two-agency export test is green

### S11-F4 · Logger redaction covers CRM payloads (S10 security review) 🔒
Ref §5 · Mod platform · Dep S10-01
**Build:** `REDACT_KEYS` adds `visitorName`, `visitorEmail`, `visitorPhone`, `phones`, `emails`, `body`, `description`, `notes`; array-valued keys redacted whole; the `MAX_DEPTH = 3` wildcard reaches `req.body.emails[0].email` (or arrays of PII keys are dropped before depth applies).
**Done when:** a logged request body with nested contact e-mails / phones / notes prints none of them (logger unit test)

### S11-F5 · CRM database defence in depth (S10 security review) 🔒
Ref §5 · Mod crm, db · Dep S10-07
**Build:** composite FKs (or a guard trigger) from member columns to `agency_members(agency_id, user_id)`: `tasks.assigned_user_id`, `leads.assigned_user_id`, `calendar_events.organizer_user_id`, `calendar_event_attendees.user_id`, `calendar_feeds.user_id`, `seller_prospects.assigned_user_id` (decide the behaviour when a member leaves: SET NULL vs. block); `lead_stage_history_append` definer `search_path = pg_catalog, pg_temp`, fully schema-qualified; a contact merge moves or deletes the closed contact's `contact_emails` / `contact_phones` rows.
**Done when:** inserting a non-member assignee fails at the DB (test); the definer's `proconfig` shows the pinned path (db test); a merged contact leaves no identifier rows behind (merge test)

### S11-F6 · Activities and inbox filters index-driven (S10 perf review) ⚡
Ref §5 · Mod crm, db · Dep S10-04
**Build:** activities `type = any(...)` is only a Filter on `activities_agency_idx` / `activities_<subject>_idx` — one type uses `activities_agency_type_idx` with `type = $x`, several types merge one keyset page per type (lateral) or require a date window; leads inbox combined filters (status + assignee, stage + assignee, source + status) get `(agency_id, assigned_user_id, status, created_ms, id)` for "my open leads" or the allowed combinations are limited; `countQueries` guard on activities subject / type pages; EXPLAIN (ANALYZE, BUFFERS) of `listLeads` stage + cursor on the scale seed recorded in STATUS.
**Done when:** a rare type on a 60k-activity agency and a rare status + assignee on 60k leads stay < 20 ms (EXPLAIN tests); activities page ≤ 2 queries (test)

### S11-F7 · ICS feed answers 304 before rendering (S10 perf review) ⚡
Ref §9.5 · Mod crm, feed-api · Dep S10-06
**Build:** a weak ETag from a cheap first query (`max(updated_at)`, event count, feed version) so a matching `If-None-Match` returns 304 without the definer read, render and gzip; the size-cap loop gzips once; a perf test at 2,000 events.
**Done when:** a 304 costs ≤ 1 statement and < 20 ms (test); a 1,000-event feed renders p95 < 150 ms (perf test)

### S11-F8 · Index builds and notice jobs (S10 perf review)
Ref §5 · Mod db, compliance · Dep S10-F8
**Build:** `portal_listing_sync_live_idx` and `agency_portal_connections_lane_idx` (migration 0122, plain `CREATE INDEX`) registered in `concurrent-indexes.ts` with a migration that declares them `IF NOT EXISTS` (the registry test requires it), as `property_privates_seller_idx` is; `notifyDataExport` / `sendDataExportNotice` get `group: agencyId` and the per-admin enqueue becomes one bulk add.
**Done when:** the concurrent-index tests list both; notice jobs carry the agency group (worker test)

### S11-F9 · Shared keyset `keysetAfter` as an index condition (S10) ⚡
Ref §5 · Mod platform, all list modules · Dep S10-01
**Build:** `platform/pagination.ts keysetAfter` emits the OR form, which Postgres applies as a Filter, not an index condition; switch to a row comparison `(a, b) > ($1, $2)` where the sort columns share a direction (the crm module's `crm/keyset.ts` already does), check every caller's EXPLAIN.
**Done when:** list endpoints' second pages show the cursor in the Index Cond (EXPLAIN tests on two modules)

### S11-F10 · CRM report rollups (S10) ⚡
Ref §7 · Mod crm, reports · Dep S10-03 S10-09
**Build:** the pipeline report's current-per-stage count (26.8 ms at 60k leads) and the response-time KPI (22–29 ms for 30 days, 90–150 ms for 92 days at 60k leads) exceed the 20 ms SQL budget — per-day rollups (stage counts; per-responder response seconds with exact medians from a stored histogram or nightly percentile rows), refreshed by outbox consumers.
**Done when:** both endpoints read rollups < 20 ms at 60k leads (EXPLAIN tests); fixture scenarios still match

### S11-F11 · One CRM reminder helper; agency time zone (S10)
Ref §7 M8 · Mod crm, identity · Dep S10-06
**Build:** tasks and calendar reminders share one claim / outbox / send helper (claimed sweep, per-agency cap, sent-for marker as app_system, Resend idempotency key); task today / overdue tabs, reminder e-mails and calendar views use the agency's time zone (agency setting, default `Europe/Madrid`; Canary Islands one hour behind) instead of the platform `DEFAULT_TIME_ZONE`.
**Done when:** both reminder suites green on the shared helper; a Canary-Islands agency's "today" tab and e-mail times follow its zone (test)

### S11-F12 · Contact erasure reaches seller links and activity bodies (S10) 🔒
Ref §3 #57 · Mod crm, properties, compliance · Dep S10-07
**Build:** contact erasure clears `property_privates.seller_contact_id` (no cross-module FK — through `crm.contact.erased` and a properties handler) and the erased contact's free-text activity bodies / notes, and the confidential prospect notes that name them; document what is kept (ids, timestamps).
**Done when:** after erasure no listing names the contact as seller and no activity body of theirs remains (int test)

### S11-F13 · HMAC_KEY rotation runbook (S10) 🔒
Ref §5 · Mod docs, platform · Dep S10-06
**Build:** rotating `HMAC_KEY` breaks every site / portal feed URL and every calendar feed URL; a runbook (or a dual-key verify window: current + previous key) and a re-issue step for members' calendar URLs.
**Done when:** runbook in `docs/runbooks/`; with a dual-key window, a URL issued under the previous key still resolves until the window ends (test)

### S11-F14 · CRM dashboard pages for contacts, inbox and data export (S10)
Ref §7 M8 · Mod web · Dep S10-08
**Build:** contacts list / detail (with merge), the lead inbox and the data-export page in the dashboard (EN + ES), on the existing APIs; a contact search picker replaces the 100-newest seller picker on the acquisition board; 2FA re-authentication before an export is requested.
**Done when:** each page loads within the dashboard route budget (≤ 250 KB first-load JS); an export without a fresh 2FA is refused (test)

### S11-F15 · Prospect conversion respects the listing policy (S10 review)
Ref §7 · Mod crm, properties · Dep S10-07
**Build:** `convertProspect` checks only `crm.prospects.write` then calls `properties.createListing` with the caller's ctx — confirm properties' `listing.create` refuses a role that may manage prospects but not create listings, and test it.
**Done when:** such a role gets `FORBIDDEN` on convert and no listing is created (int test)

---

## S12 — Presentations, AI Studio, Client Mode, social

### S12-01 · AI gateway
Ref §3 #47 §8 · Mod platform (ai) · Dep S0-06 · [H3]
**Build:** `ai.generate`, `ai.structured` (Zod-validated, one retry), `ai.batch`, `ai.embed`; model tiers from env; per-tenant/plan budgets and caps; input-hash cache; `ai_jobs`, `ai_usage_monthly`, `prompt_versions`, `ai_feedback`; prompt files; `pnpm ai:eval` runner; circuit breaker.
**Done when:**
- Hard cap reached → `AI_BUDGET_EXCEEDED` without calling the provider
- Identical request served from cache (no provider call)
- Provider outage → features degrade gracefully (core flows unaffected)

### S12-02 · AI Listing Studio
Ref §8 #1 §3 #15 · Mod ai-features · Dep S12-01 S3-02
**Build:** description + SEO meta + translations for enabled locales from facts and photo tags; tone presets; AI_DRAFT → REVIEWED workflow; bulk mode as a batch job; locked locales are never overwritten.
**Done when:**
- Numbers in generated text match listing facts (validator test)
- Locked locale untouched by bulk regeneration
- Eval set for `listing-studio` passes

### S12-03 · White-label text sanitizer
Ref §8 #2 · Mod ai-features · Dep S12-01
**Build:** deterministic pass (regex for phones, emails, URLs, known agency names) + FAST-model pass for indirect mentions; used by website serializer, selections, portal and PDFs; cached per listing version.
**Done when:** fixture set of 200 descriptions with planted contact details is cleaned with zero leaks; facts unchanged

### S12-04 · Selections
Ref §7 M13 · Mod presentations, public · Dep S3-09 S7-02 S12-03
**Build:** create from search/bookmarks; ordered items; branded live page in `apps/public` (prices/status live from read models, white-labelled, client language); share via WhatsApp deep link/email; view/like/enquire events → CRM timeline; expiry. Override texts in selection items are escaped or sanitized (S12-03) when rendered, as in the website serializer (S5-F1).
**Done when:**
- Owner price change shows on the selection within 5 min
- Selection page passes the white-label test and Lighthouse ≥ 90

### S12-05 · PDF brochures
Ref §7 M13 · Mod presentations · Dep S12-04
**Build:** `pdf` pool with a Puppeteer pool; brochure and portfolio templates (branded, locale-aware); stored in R2 with signed links; viewing-terms PDF for S11-02.
**Done when:** 20-page portfolio renders in < 10 s; concurrent renders capped per tenant

### S12-06 · Client Mode
Ref §3 #56 §7 M13 · Mod identity, presentations · Dep S3-02 S5-05 · 🔒
**Build:** toggle in the session; server-side DTO stripping (commission, owner agency, internal notes, private fields) across all dashboard endpoints via a serializer flag; PIN to exit (hashed, rate-limited); UI banner.
**Done when:**
- With Client Mode on, no API response contains commission or owner fields (contract test over all routes)
- Wrong PIN attempts are rate-limited and audited

### S12-07 · Social posting
Ref §3 #58 §7 M25 · Mod social · Dep S12-01 S3-04 · [H3]
**Build:** connect Facebook Pages + Instagram Business (Meta OAuth, encrypted tokens, refresh/expiry handling); compose post from a listing (image/carousel), AI captions per language/platform, schedule, publish via `social` pool, history with errors, white-label check.
**Done when:**
- Scheduled post publishes once at the scheduled time (idempotent) against the Meta sandbox/mock
- Expired token marks the account as needing reconnection and notifies the agency

### S12-08 · AI search endpoint for websites
Ref §8 #3 §9.1 · Mod search, ai-features · Dep S12-01 S7-03 · ⚡
**Build:** `GET /v2/search/ai?q=` — natural language → structured filters (FAST, cached by normalized query) → search adapter; port SPW-AI logic; fallback to keyword search on AI failure.
**Done when:**
- Eval set of 100 multilingual queries maps to expected filters with ≥ 90% accuracy
- p95 < 600 ms uncached, < 150 ms cached

### S12-F1 · Network board, chat and notification dashboard pages (S11 review)
Ref §7 M11 M12 · Mod web, i18n · Dep S11-03 S11-04 S11-05
**Build:** the network board (list, post, reply, my subscriptions), a chat inbox and thread view (typing indicator, WhatsApp / e-mail handoff buttons, warning in VIEWING threads that the owner must never see the client) and the notification bell, feed and preferences page — all on the existing APIs, socket.io-client behind a dynamic import, EN + ES.
**Done when:** each route ≤ 250 KB first-load gzip; one e2e test of reply → thread → message → notification; disabling a type in the preferences page stops it (e2e)

### S12-F2 · Raise the declared notification types (S11 review)
Ref §7 M12 · Mod crm, imports, notifications · Dep S11-04
**Build:** `LEAD_ASSIGNED` and `TASK_DUE` (contracts) are never raised; the import pause notice is still e-mail only; stale "no notifications module" comments in crm.
**Done when:** assigning a lead, a task falling due and an import pausing each raise one notification (tests); no stale comments (review)

### S12-F3 · Network subscriber matching on an index (S11 review) ⚡
Ref §5 · Mod network, db · Dep S11-05
**Build:** `notifySubscribers` reads every subscription per post (a Seq Scan on CI); at 5,000 agencies × members × 20 subscriptions that reaches ~1M rows. Pre-filter by kind / transaction type and a GIN on `location_ids` plus a partial index for unset filters (UNION, then the residual filter), or an inverted subscription index.
**Done when:** a 200k–1M-subscription seed gives a batch query < 20 ms with index scans only (EXPLAIN test)

### S12-F4 · Realtime nodes skip events with no local socket; pubsub buffer sized (S11 review) ⚡
Ref §9 · Mod platform, realtime, infra · Dep S11-04
**Build:** every realtime node JSON-parses, regex-checks and Zod-validates every user event before finding no local room; prefix messages with `agencyId:userId|` and check the adapter's rooms first; set redis-cache `client-output-buffer-limit pubsub` explicitly; metric for dropped / disconnected subscribers (or sharded pub/sub per node).
**Done when:** a non-local event is skipped without parsing (unit test); 10k events to 3 nodes, no subscriber disconnect (load test)

### S12-F5 · Buyer-request matching cannot crowd out public search (S11 review) ⚡
Ref §9 · Mod network, search · Dep S11-05
**Build:** `matchListingOwners` runs facet rounds over the 2M-doc index with a growing exclusion list, on the same Meilisearch as feed-api; add a pool-wide `globalConcurrency` (e.g. 4) to `network.matchBuyerRequest` and an engine-latency histogram per round.
**Done when:** 50 concurrent buyer requests keep feed-api search p95 < 150 ms (perf test)

### S12-F6 · Stage-count rollups by delta (S11 review) ⚡
Ref §5 · Mod crm · Dep S11-F10
**Build:** `crm.refreshStageCounts` re-aggregates all of an agency's leads every throttle window (est. 30–80 ms for a 200k-lead agency, `indexing` pool shared with search reindexing): apply ±1 deltas from lead events with a nightly full rebuild, or cap it (capGroup + perProcessConcurrency).
**Done when:** a rebuild touches ≤ 1 row per event, or search-index queue age is unchanged under 100 leads/s (test)

### S12-F7 · `leads` index review (S11 review) ⚡
Ref §5 · Mod db, crm · Dep S11-F6
**Build:** `leads` has 12 secondary indexes and its mutable columns (status, assignee, stage, rank) make most updates non-HOT; `leads_agency_assigned_status_created_idx` overlaps `leads_agency_assigned_created_idx`. After the scale gate read `pg_stat_user_indexes`, drop unused ones or fold overlaps; decide stage + assignee + cursor (22 ms at 60k) and source + status.
**Done when:** every leads index has a recorded consumer query and EXPLAIN in STATUS; ≤ 10 indexes; stage + assignee + cursor < 20 ms or explicitly unsupported

### S12-F8 · HMAC rotation cannot close before the fingerprint rehash finishes (S11 review) 🔒
Ref §5 · Mod mls, platform, db, docs · Dep S11-01 S11-F13
**Build:** fingerprint rows carry no key id, so nothing can tell when the rehash is done; add `key_id` to `client_registration_fingerprints`, `mls.fingerprintsPending()` (valid registrations without a current-key row), a worker alert when any are pending within 24 h of `HMAC_KEY_PREVIOUS_UNTIL`; runbook step 10.
**Done when:** one stale registration → pending > 0 and the alert fires; after the rehash pending = 0 (int test)

### S12-F9 · Staff reads of registrations, viewings and agency chat are audited (S11 review) 🔒
Ref §5 · Mod mls, chat, compliance · Dep S11-F2
**Build:** S11-F2 audits impersonated crm reads only; staff impersonating a member can read registrations (decrypted client details), introducer-side viewing requests and VIEWING / NETWORK messages without an audit row. Write `*.clientData.read` per impersonated list / get (shared helper).
**Done when:** an impersonated list / get writes one row, a member's own read none (tests)

### S12-F10 · Deactivated members and revoked sessions lose realtime (S11 review) 🔒
Ref §5 · Mod chat, identity, realtime · Dep S11-03
**Build:** realtime never checks membership or `sessionVersion` after connect and chat fan-out does not filter deactivated members; filter recipients by `agency_members.deactivated_at is null` and publish a user event on deactivation / session-version bump that disconnects that user's sockets in both namespaces.
**Done when:** a deactivated participant gets no push and their open socket closes within 1 s (test)

### S12-F11 · `/notifications` sockets limited like `/chat` (S11 review) 🔒
Ref §5 · Mod realtime · Dep S11-04
**Build:** `/notifications` has no sockets-per-user cap and no connect rate rule; reuse `CHAT_SOCKET_LIMITS.socketsPerUser` and add `realtime.notifications.connect.user`.
**Done when:** the 11th socket and the 31st connect per minute are refused (tests)

### S12-F12 · NETWORK threads close with their post or an unlisted agency (S11 review) 🔒
Ref §7 M11 · Mod chat, network, db · Dep S11-05
**Build:** listed / open is checked only at thread creation; the fan-out keeps copying messages after the post closes or an agency is de-verified. Refuse (42501) when either side is no longer listed; a `network.post.closed` job closes the post's threads (as `closeViewingThread`).
**Done when:** both refusals covered by int tests

### S12-F13 · Network post publish and close audited (S11 review) 🔒
Ref §5 · Mod network, compliance · Dep S11-05
**Build:** `compliance.audit` `network.post.published` / `network.post.closed` (ids and kind only, never title or body).
**Done when:** create, close and the impersonation-forbidden path tested

### S12-F14 · Notification preference writes limited to the member by RLS (S11-04) 🔒
Ref §5 · Mod db, notifications · Dep S11-04
**Build:** `notification_preferences` is readable agency-wide (needed by `notify`), but only the service limits writes to the member: a registry shape "agency reads, member writes" plus isolation-suite support.
**Done when:** a member writing a colleague's preference gets 42501 (isolation test)

### S12-F15 · Website API keys and 2FA recovery codes survive an HMAC_KEY rotation (S11-F13) 🔒
Ref §5 · Mod identity, platform · Dep S11-F13
**Build:** both are stored HMAC lookups without the dual-key window, so a rotation breaks every website API key and recovery code; look them up with `hmacSha256Candidates` during the window and rehash on use (or issue a rehash job).
**Done when:** with a rotation window open, an API key and a recovery code issued under the previous key still work (tests); runbook updated

### S12-F16 · One pinned search_path for every SECURITY DEFINER function (S11 review) 🔒
Ref §5 · Mod db · Dep S11-F5
**Build:** definers in 0130, 0133, 0135, 0136 use `pg_catalog, public`; S11-F5 set `pg_catalog, pg_temp`. Re-create them (`create or replace`, never edit applied migrations); drop the unused `definerSync` policies (`definer_update` on `chat_messages`, `definer_append` on `viewing_requests`) by letting the registry name only the operations used.
**Done when:** a catalog test asserts every `prosecdef` function in `public` has `search_path=pg_catalog, pg_temp`; no unused definer policy (rls test)

### S12-F17 · Validate `leads_assignee_member_fk` (S11-F5)
Ref §5 · Mod db, crm · Dep S11-F5
**Build:** 0138 added the leads member FK `NOT VALID` (orphan perf-seed leads on the shared test DB); clean the residue (and make `tests/perf/crm-filters` clean up after a crash), then `VALIDATE CONSTRAINT` in a new migration.
**Done when:** `pg_constraint.convalidated` is true for all six S11-F5 FKs (test)

### S12-F18 · One keyset helper and shared small helpers (S11 review)
Ref §5 · Mod core, mls, crm, chat, network, notifications · Dep S11-F9
**Build:** `rowAfter` is defined three times (crm/keyset, mls repo, mls viewings-repo) next to `pagination.ts keysetAfterRaw`; `userIdOf` 11 copies, `escapeHtml` 6, `line` 4, `wasNotSent` 2. Move to `pagination.ts`, `core/src/member.ts` and an e-mail text helper; one place per module for job bodies (`jobs.ts`).
**Done when:** grep finds one definition of each; existing EXPLAIN tests green

### S12-F19 · Test hygiene: scoped outbox dispatcher, wall-clock budgets out of the int run (S11 review)
Ref §15 · Mod platform, realtime, tests · Dep S11-03
**Build:** `apps/realtime/src/chat-e2e.int.test.ts` runs a global outbox dispatcher on the shared DB and claims other suites' events — add an `agencyIds` test scope; move wall-clock assertions (`network-board`, `chat-fanout`, `chat-e2e`, crm activities timeline) to the perf / smoke job, keep plan and query-count assertions in the int run.
**Done when:** the e2e test claims only its own agency's events; the int run has no `toBeLessThan(ms)` on wall-clock time

### S12-F20 · Raw keyset for the date_trunc-indexed lists (S11-F9) ⚡
Ref §5 · Mod properties, imports, developments, compliance, db · Dep S11-F9
**Build:** lists on `date_trunc` expression indexes (properties first, then imports, developments, bookmarks, tenants, impersonations, data exports) keep the cursor as a Filter under RLS; raw `(agency_id, created_at, id)` indexes (concurrent) or stored ms columns, then `keysetAfterRaw`.
**Done when:** the listings list's second page shows the cursor in the Index Cond under RLS on the scale seed (EXPLAIN test)

### S12-F21 · Collaborations show the target's reference (S11-06)
Ref §7 M10 · Mod mls, search, web · Dep S11-06
**Build:** the collaborations view shows a target as kind + id fragment; carry the listing / development reference and title from `listing_read_models` (no per-row join) into the registration and viewing DTOs.
**Done when:** the page shows the reference and title, list endpoints stay within budget (test)

### S12-F22 · ICS fingerprint index-only (S11-F7) ⚡
Ref §9.5 · Mod crm, db · Dep S11-F7
**Build:** the 304 fingerprint reads events by primary key (~5 buffers per event); a per-feed version column bumped by event / attendee / contact-name changes makes it one index-only read (and lets the hour bucket go).
**Done when:** a 304 at 2,000 events reads ≤ 10 buffers (test); renames reach subscribers without the hour bucket

### S12-F23 · Listing editor taxonomy at scale; test-DB prune covers taxonomy (S11 gate)
Ref §5 §15 · Mod web, taxonomy, db · Dep S2-04
**Build:** the listing editor renders every location as an option and every feature as a checkbox (~9,000 accessibility nodes with the shared test DB's 2.5k locations / 2.3k features — real Spanish location data is in the thousands too): a searchable location picker and grouped, lazily rendered features; the test-DB prune also clears stale shared taxonomy rows.
**Done when:** the editor renders < 1,500 DOM nodes with 5,000 locations (test); `[S3-05]` e2e well under its timeout (< 60 s)

### S12-F24 · `quality.recomputeListings` Redis script error; stale jobs after a prune (S11 gate)
Ref §9 · Mod quality, platform, tests · Dep S8
**Build:** the e2e worker logged 293 `quality.recomputeListings` failures "ERR value is not an integer or out of range" (a Redis script argument) and ~2,000 `crm.recordActivity` retries hitting FKs of pruned agencies; find the script bug, and make jobs for agencies that no longer exist finish (no retry) instead of failing.
**Done when:** a regression test reproduces the Redis error and passes; a job for a deleted agency completes without retries (test)

### S12-F25 · Minimum-commission edits limited and audited (S7-F10 security review) 🔒
Ref §3 #21 · Mod websites, compliance, contracts · Dep S7-F10
**Build:** a site's minimum commission (CUSTOM site) can change only a few times a day per agency (limit in config, platform limiter), answering a neutral `RATE_LIMITED` with retry-after; every change writes a `compliance.audit` entry (actor, site, old → new basis points). Decision 2026-10-25 (Shahzaib: limit and log) — stops binary-searching another agency's commission.
**Done when:** the edit past the daily limit is refused (test); each accepted edit has one audit row with old and new values (test)

---

## S13 — Billing, staff console, onboarding, support

### S13-01 · Stripe billing core
Ref §3 #28 §7 M19 · Mod billing · Dep S1-02 · [H3] · 🔒
**Build:** plans/add-ons catalog synced to Stripe, Checkout, Customer Portal, card + SEPA Direct Debit, Stripe Tax + VAT ID, webhooks (signature, idempotency, out-of-order safe), invoices list.
**Done when:** E2E in Stripe test mode: subscribe Pro annual with SEPA → active; cancel → falls back to Free at period end with data intact

### S13-02 · Plan gates, seats, trial, price locks, grants
Ref §11 §3 #29 · Mod billing · Dep S13-01
**Build:** `requirePlan(feature)` with plan matrix from §11; seat enforcement; 14-day Pro trial for new non-migrated signups; founding price-lock coupons; staff manual grants with expiry; dunning grace period (no access cut mid-deal without notice).
**Done when:**
- Each gated feature returns `PLAN_REQUIRED` with the required tier (table-driven test from the plan matrix)
- Trial expiry downgrades to Free without data loss

### S13-03 · Staff console operations
Ref §7 M20 · Mod admin · Dep S1-09 S5-03 S6-08
**Build:** bulk ops (reindex, rebuild read models, re-import, replay outbox range), feature flags UI, plan grants, feed and queue health, AI spend per tenant.
**Done when:** each bulk op runs as an audited job with progress and can be cancelled

### S13-04 · Onboarding
Ref §7 M21 · Mod onboarding, web · Dep S1-10
**Build:** role-based checklist (import listings, connect website, invite team, share first listing, verify agency), lightweight product tours (small library, dynamically imported), contextual help links, progress visible to staff.
**Done when:** checklist steps complete automatically from real events (not manual ticks)

### S13-05 · Support tickets
Ref §7 M21 · Mod support · Dep S1-09
**Build:** tickets with categories, priority, attachments (R2, 10 MB × 5), staff queue, internal notes, email notifications.
**Done when:** agency users see only their agency's tickets; internal notes are never visible to agencies

### S13-F1 · Selection reads locked to the link token (S12 review) 🔒
Ref §7 M13 · Mod presentations, db · Dep S12-04
**Build:** `app_public` can read every agency's live `selections` / `selection_items` (titles, messages, item notes that can name clients), and `app_public` also serves feed-api, export downloads and websites. A `selection_by_token(hashes text[])` SECURITY DEFINER function (pinned search_path, S12-F16 pattern) or a token-hash term in the public read predicate; revoke the plain SELECT.
**Done when:** isolation shows `app_public` without the token hash reads 0 rows from both tables; selections tests green

### S13-F2 · Selection token path redacted in logs (S12 review) 🔒
Ref §5 · Mod platform · Dep S12-04
**Build:** `SECRET_PATHS` / `SECRET_PATHS_IN_TEXT` miss `/s/<token>` (a bearer secret): add the `/s/` prefix to both.
**Done when:** `redactPath('/s/…')` and `redactPathsInText` give `/s/[REDACTED]` (unit test)

### S13-F3 · Worker-written tables: no member writes (S12 review) 🔒
Ref §5 · Mod db, matching, presentations · Dep S5-06 S12-04
**Build:** `saved_search_alerts` lets app_user INSERT/UPDATE (forged alerts), `matching_listing_states` gives app_user full CRUD (worker-only), `selection_interactions` lets members UPDATE/DELETE the client history intake writes: alerts read + delete for the member, states no app_user grant (or read-only), interactions immutable.
**Done when:** the generated isolation suite asserts 42501 on each now-forbidden write

### S13-F4 · Client Mode allow-lists pinned for the S12 modules (S12 review) 🔒
Ref §3 #56 · Mod identity, social, matching, presentations, documents, ai-features · Dep S12-06
**Build:** a test per module pinning `CLIENT_MODE_ALLOWED`, plus a contract check that a Client Mode token gets 403 on `/v1/social/*`, `/v1/selections*`, `/v1/saved-searches*` and `/v1/listings/:id/studio`.
**Done when:** both green; adding an action to an allow-list fails the pin test

### S13-F5 · Social: revoke the Meta grant by Meta user id (S12 review) 🔒
Ref §7 M25 · Mod social, db · Dep S12-07
**Build:** disconnect no longer revokes (a Meta login can serve several agencies; `MetaGraphClient.revokePermissions` is unused, TODO in `social/accounts.ts`). Store the Meta user id at connect (migration); revoke only when no non-disconnected account in any agency has it, or revoke only the Page connection.
**Done when:** the last account of a Meta user revokes once (test); another agency's account with the same user keeps working (test); TODO gone

### S13-F6 · AI pool fairness: bulk white-label work apart from interactive jobs (S12 review) ⚡
Ref §9 · Mod ai-features, platform · Dep S12-03
**Build:** fair share is per pool + agency, so ~50 queued `sanitizeTexts` jobs after an import put the agency's next Listing Studio / caption request behind them. Own group namespace (`wl:<agency>`) or an `ai-bulk` pool for sanitize; interactive jobs keep the agency group.
**Done when:** with 50 queued sanitize jobs for agency A, A's `generateListingCopy` starts within one free slot (p95 < 5 s, perf test)

### S13-F7 · White-label pass only for network-shown documents; backfill (S12 review) ⚡
Ref §8 #2 · Mod search, ai-features · Dep S12-03
**Build:** every `search.publicDocs.changed` queues a job that reads 100 targets × locales of detail JSON before filtering `shownOnNetwork` (a full rebuild = ~20k jobs, almost none with a model call). Carry `networkShownIds` in the event (the `networkAudience` rule); skip events with none; optionally skip unchanged text hashes. Add the backfill sweep (per agency, fair share, `ai.batch`) for existing documents and imports. Index the search docs through the same removals or record why not (agent first names still match free text).
**Done when:** a price-only edit and a private/own-only change queue zero `sanitizeTexts` jobs (test); ≈ 0 jobs per 1k unchanged targets on a rebuild (perf test); existing network docs get removals via the backfill (test)

### S13-F8 · S12-F20b: drop the 16 date_trunc indexes (S12 review) ⚡
Ref §5 · Mod db, properties, imports, developments, crm · Dep S12-F20
**Build:** contract step of S12-F20, next release: drop the 16 old date_trunc indexes concurrently (`DROPPED_INDEXES`, 0106 pattern); move crm contact notes and contact imports to raw keyset.
**Done when:** migration applied, `properties` ≤ 21 indexes, the list EXPLAIN tests still show the cursor in the Index Cond, import throughput no slower than before 0152

### S13-F9 · Retention for the S12 growth tables (S12 review) ⚡
Ref §5 · Mod platform, presentations, social, matching, db · Dep S12-01 S12-04 S12-07 S5-06
**Build:** daily maintenance prunes in batches: `ai_jobs` 13 months (totals live in `ai_usage_monthly`; or monthly partitions), `selection_interactions` 12 months after expiry/revoke, `social_posts` PUBLISHED/FAILED older than 12 months; `saved_search_alerts` monthly partitions and a per-search daily alert cap (needs an index). Each delete index-backed.
**Done when:** an int test per table keeps recent rows and deletes old ones; each delete EXPLAINs as an Index Scan

### S13-F10 · Scale perf tests for the S12 hot paths (S12 review) ⚡
Ref §15 · Mod presentations, website-api, matching, ops · Dep S12-04 S12-08 S5-06
**Build:** `tests/perf/selection-page.int.test.ts` (50 items, own + network, scale seed); `/v2/search/ai` (warm) and `/s/<token>` in `scripts/perf/smoke.ts`; an outbox fan-out case for a 10k-listing import (matching + white-label + read models). Re-measure S12-08 (uncached < 600 / cached < 150 ms) and the S12-05 20-page portfolio on a quiet runner, and S12-F5 on the H4 box.
**Done when:** selection page p95 < 150 ms with 5 statements, each SQL p95 < 20 ms; smoke thresholds pass for both routes; ≤ 2 events per 100 listings and outbox lag under threshold

### S13-F11 · One white-label helper and one "present public docs" read (S12 review)
Ref §8 #2 · Mod core, properties, social, presentations, documents, website-api · Dep S12-03
**Build:** a single async `whiteLabelListingText(tx, listing, viewerAgencyId, texts)` (identity + `ownerRefsOf` + cached removals) used by properties content, social and presentations; one website-api function (`publicDocs` + `sitePresenter` + `viewWith` + `serializeDetail`) used by selections and the PDF render.
**Done when:** one implementation each, one test covering every consumer

### S13-F12 · Small shared helpers and scaffold leftovers (S12 review)
Ref §5 · Mod core, chat, presentations, documents, web · Dep S12-F18
**Build:** drop the `memberUserId as userIdOf` aliases (chat, matching, mls viewings, network, notifications) and fold `actorId` / `requireUser` into `memberUserId` (a lint rule bans the alias); one WhatsApp share constant; one `placeText`; web `requireSession` / `settle` / `cents` into `apps/web/src/server/actions.ts`; remove the empty `presentationsJobs` (or add the expiry sweep); merge `white-label-jobs.ts` into ai-features `jobs.ts`; job bodies in each module's `jobs.ts` (the rest of S12-F18).
**Done when:** grep finds one definition of each; gen:module layout and module contents agree

### S13-F13 · Selections dashboard pages; real Lighthouse on the page (S12-04)
Ref §7 M13 · Mod web, presentations · Dep S12-04
**Build:** create a selection from search results or a bookmark folder, list, stats (views/likes/enquiries), rotate/revoke, share buttons (WhatsApp/e-mail), on the existing API, EN + ES; Lighthouse through the perf project on `/s/<token>` instead of static proxies; a staging run with the real app + CDN.
**Done when:** each route ≤ 250 KB first-load gzip; e2e of create → share link → client view counted; Lighthouse ≥ 90 asserted by the test

### S13-F14 · Listing Studio batch submit idempotent; studio auto-drafts (S12-02)
Ref §8 #1 · Mod ai-features, platform · Dep S12-02
**Build:** a crash between `ai.batch` and saving the provider batch id can double-submit: an idempotency key through the gateway/provider (or a submitted marker the collect job reconciles); optional auto-draft on create/update behind a flag (§3 #15); the bulk UI.
**Done when:** a crash-after-submit test submits once; the auto-draft flag is off by default and tested on

### S13-F15 · CRM report rollups rebuilt for pre-0137 data (S12-F7)
Ref §5 · Mod crm, ops · Dep S11-F10
**Build:** migration 0137's backfill ran as app_owner under forced RLS and copied nothing, and the nightly stage sweep only visits agencies that already have rows. A one-off ops job running `crm.rebuildReportRollups` per agency with leads; the sweep also visits agencies with leads but no rollup rows; the S14-02 legacy lead load calls the rebuild per agency.
**Done when:** an agency with old leads and no rollups gets them from the sweep (test)

### S13-F16 · i18n drafts for the S12 namespaces; widget AI box (S12 review)
Ref §3 · Mod i18n, sdk · Dep S12-08 S0-11
**Build:** `pnpm i18n:draft` for the other content locales of the new namespaces (chat, network board, notifications, social, documents, selections, Client Mode) with review; the website widget's AI search box on `/v2/search/ai` (S8-F8's reminder test became an SDK-has-the-operation check).
**Done when:** `i18n:check` lists no missing keys for enabled locales; a widget e2e searches by sentence

### S13-F17 · AI features switched on and off per agency, one toggle per feature (Shahzaib, 2026-10-25)
Ref §8 · Mod agencies, ai-features, website-api, social, web · Dep S12-01 S12-02 S12-03 S12-07 S12-08
**Build:** per-agency settings, one toggle per AI feature, each default **off** (admin-only, every change audited): **website AI search** (off → `/v2/search/ai` answers the keyword search), **white-label model pass** (off → deterministic pass only), **Listing Studio** (off → panel hidden, API `AI_NOT_ENABLED`), **social captions** (off → caption request refused, manual captions only), **translation drafts**. Each call site checks its own toggle before any model call (one cached read). Every feature stays on the FAST tier (the cheapest configured model); no SMART-tier use without a recorded decision. Settings page with the toggles, EN + ES.
**Done when:** per feature: toggle off → zero provider calls for that agency, toggle on → calls happen, other features unaffected (test per feature); each change has one audit row


### S13-F18 · Retire catalog prices in Stripe (S13-01 review)
Ref §3 #28 · Mod billing · Dep S13-01
**Build:** `upsertCatalog` deactivates active prices missing from the input; a retired price that has a Stripe id is deactivated in Stripe by `billing.syncCatalog` (`POST /v1/prices/:id active=false`, tracked by a `stripe_retired_at` column) so no new Checkout or portal switch can use it; existing subscriptions keep it.
**Done when:** a changed or removed catalog price can no longer be bought in Checkout or the portal; subscribers on it are unaffected (test)

### S13-F19 · Product tax codes in the catalog (S13-01 review)
Ref §3 #28 · Mod billing · Dep S13-01 · [H3]
**Build:** a `taxCode` per catalog item (data, `billing-catalog.json`; SaaS default `txcd_10103001`), sent when the product is created and updated on change.
**Done when:** Stripe Tax computes IVA on a Checkout without relying on the account's preset tax code (test against the fake; real check with H3)

### S13-F20 · Stripe webhook rate limit after the signature (S13-01 security review)
Ref §12 · Mod billing, api · Dep S13-01
**Build:** confirm `TRUST_PROXY` in the production deploy; give signed webhook deliveries their own bucket (unsigned requests counted separately), so junk from one address cannot push Stripe's deliveries into 429.
**Done when:** a flood of unsigned requests from Stripe's egress range leaves signed deliveries accepted (test)

### S13-F21 · Plan quotas and the remaining gates (S13-02)
Ref §11 · Mod billing, websites, social, crm, matching, developments, ai-features, website-api · Dep S13-02
**Build:** per-plan quotas as catalog data (`limits` per plan: sites, social accounts, Free CRM contacts, AI Listing Studio listings/month) checked by `billing.requireQuota(ctx, key, used)`; `requirePlan` at the entry points not gated yet (client matching REVIEW / AUTO_SEND, speed-to-lead, new-build database full view, CRM full vs basic, reports tiers) and on every new paid feature as it ships; a site of an agency whose plan lost `website_api` keeps serving for a notice period, then answers 402 (feed-api reads the plan through the cached site scope — no extra query per request). AI budgets by plan (`AI_BUDGETS_BY_PLAN`) never apply today: every AI caller passes `plan: null` or `'none'` (worker jobs, Listing Studio, captions, white-label; website AI search via the site scope) — resolve `billing.planOf` once per job / cached site scope and pass it into the `AiCtx` (commit security review, S13-02).
**Done when:** each quota refuses the first item over the plan's limit with `PLAN_REQUIRED` (table-driven test); a downgraded agency's site serves until the notice ends, then refuses (test); an AI call of a Pro agency is metered against the Pro budget (test)

### S13-F22 · Billing notices to admins (S13-02)
Ref §11 · Mod notifications, billing · Dep S13-02
**Build:** the agency's admins get an in-app notification and an email (EN/ES) on `billing.dunning.started` (grace end date, link to the billing page) and 3 days before a trial or staff grant ends (a daily sweep), and when `billing.plan.changed` lands on Free.
**Done when:** each notice reaches the admins once per event (test); members who are not admins get none

### S13-F23 · Founding coupon follows the locked price only (S13-02 security review)
Ref §11 · Mod billing · Dep S13-02 · [H3]
**Build:** the founding coupon is limited to the locked plan's product (done in S13-02), but a Customer Portal switch to another interval or currency of that plan keeps it (a yearly-sized amount off a monthly invoice). `billing.applyStripeEvent` removes a `founding_` discount from a subscription whose plan price no longer matches its lock (`DELETE /v1/subscriptions/:id/discount`, idempotent) and alerts; the portal configuration (H3) disables interval switching for locked agencies if Stripe allows it.
**Done when:** a locked subscription switched to the monthly price loses the founding discount on its next event (test against the fake); the yearly one keeps it

### S13-F24 · Chat send deadlock on network threads (CI e2e, 2026-10-25)
Ref §7 M18 · Mod chat, db · Dep S11-05
**Build:** two messages sent at once into the same cross-agency thread (each side's `chat_messages` insert + mirror trigger) deadlock (`40P01`, e2e `collaboration.spec.ts` → 500 on `POST /v1/chat/threads/:id/messages`, CI run on 2b4c41fc). Take the thread's locks in one fixed order (e.g. lock the thread row / both agencies' thread rows by id before inserting), or serialise per thread; a deadlock that still happens is retried once, never a 500.
**Done when:** concurrent sends from both agencies into one network thread all succeed (int test with parallel sends); the S11 e2e flow passes repeatedly

### S13-F25 · White-label backfill on the batch API; owner changes re-run it (S13-F7)
Ref §8 #2 · Mod ai-features, agencies, db · Dep S13-F7
**Build:** a STRICT `white_label_batches` table (id, agency_id, provider_batch_id, items jsonb, cursor jsonb, state, created_at; tenant registry) so the backfill walk submits pages through `ai.batch` (half price) and collects them later instead of `ai.structured`; an owner identity change (agency rename, new or renamed agent — the agencies / identity events) queues that agency's backfill walk early.
**Done when:** a backfill page goes through `ai.batch` and its removals land after collect (test against the fake provider); renaming an agent queues the agency's walk once (test)

### S13-F26 · Onboarding backfill for existing agencies (S13-04)
Ref §7 M21 · Mod onboarding · Dep S13-04
**Build:** a one-off, batched, idempotent backfill (script or staff operation) that completes onboarding steps for agencies that did them before S13-04 shipped — from current state, not events: any listing or development (IMPORT_LISTINGS), any SHARED / PUBLIC listing with scope ALL (SHARE_LISTING), any site (CONNECT_WEBSITE), any invite or second member (INVITE_TEAM), VERIFIED status (VERIFY_AGENCY), with the earliest known timestamp; also run after the legacy import (S14).
**Done when:** an agency with existing data shows the matching steps done after the backfill, a rerun changes nothing (test)
---

## S14 — Migration tooling

### S14-01 · Legacy extract
Ref §14 Path A · Mod migration · Dep S2-06 · [H1]
**Build:** read-only extract scripts from the legacy dump into staging schemas; entity inventory report.
**Done when:** extract is repeatable and never writes to the legacy database

### S14-02 · Transform and load
Ref §14 · Mod migration · Dep S14-01 S3-04 S10-01 S4-04
**Build:** per-agency idempotent batches: agencies, users (password reset flow), listings (+ media re-ingest via the media pipeline), contacts, leads, developments; `legacy_id_maps`; `migration_batches`.
**Done when:** re-running a batch produces no duplicates; failures resume from the last checkpoint

### S14-03 · Validation reports
Ref §14 · Mod migration, admin · Dep S14-02
**Build:** per-agency report: counts per entity, sampled field diffs, media counts, URL checks; staff UI with pass/fail and drill-down.
**Done when:** dry run of all agencies produces < 0.5% unexplained differences *(manual review of report)*

### S14-04 · Delta sync
Ref §14 · Mod migration · Dep S14-02
**Build:** hourly incremental sync legacy → new during the parallel run, change detection by timestamps/hashes.
**Done when:** a change in legacy appears in the new system within 70 minutes

### S14-05 · Redirect maps
Ref §14 §7 M14 · Mod migration, websites · Dep S14-02
**Build:** `legacy_url_redirects` for inmolink.es and plugin URLs (per locale), hit counters, resolver used by portal and WP plugin.
**Done when:** 100% of a crawl sample of legacy URLs resolves to 301 targets that return 200

### S14-06 · Cutover tooling and runbooks
Ref §14 Path A/B §9.3 · Mod migration, ops · Dep S14-03 S8-02 · [H11]
**Build:** per-agency cutover checklist automation (freeze, final delta, validation, enable dashboard access, notify), Path B tools (renewal date tracking, parallel inventory mode on websites), DNS switch and rollback runbooks.
**Done when:** *(staging rehearsal)* cutover and rollback of a test agency each complete in < 30 minutes

### S14-F1 · One "plan in force" and one grace-start helper (S13 review)
Ref §11 · Mod billing · Dep S13-02
**Build:** the SQL `planInForce` is the only definition of the plan in force — `effectivePlan` keeps just the "unknown plan → Free" mapping and the add-on units path (`service.ts`) uses the SQL; one exported `graceStart(now)` (config) replaces the inline copies in jobs; `endPlanGrants` reads the plans of all claimed agencies in one batched `plansInForce(tx, ids[])` (`distinct on (agency_id)`), not one query per agency.
**Done when:** a PAST_DUE subscription with a null `past_due_since` gets the same plan from every path (test); `endPlanGrants` runs a fixed number of statements per batch (test)

### S14-F2 · Staff role sets in one place (S13 review)
Ref §3 #2 · Mod contracts, db, admin, billing, support · Dep S13-03 S13-05
**Build:** the staff role sets (super admin; operators; support agents) live in contracts; the registry builds its SQL predicates from them with a `staffRoleSql(roles)` helper and every staff policy uses the same sets, so RLS and policy cannot drift.
**Done when:** a test asserts each staff RLS predicate and its policy accept exactly the same roles

### S14-F3 · Shared-DB-safe tests (S13 review)
Ref §15 · Mod crm, onboarding · Dep S13-F26
**Build:** `crm.sweepContactImports` takes an agency scope used by tests (its +25 h run expires other files' uploads); the onboarding backfill walk test asserts on its own agencies only with a fixed page bound; grep the integration tests for other whole-database sweeps / counts and scope them.
**Done when:** the crm and onboarding suites pass with any number of parallel files (run with the full core suite twice)

### S14-F4 · One AI batch poll helper (S13 review)
Ref §8 · Mod ai-features · Dep S13-F14 S13-F25
**Build:** the Listing Studio and white-label batch-collect jobs share one `pollBatch()` (poll, give up after the limit, re-enqueue with delay).
**Done when:** both collect paths keep their tests green on the shared helper

### S14-F5 · Selections in the sidebar (S13-F13)
Ref §7 M13 · Mod identity, web · Dep S13-F13
**Build:** a `selections` dashboard section (identity contracts + policy, Client Mode hidden) and its sidebar entry; a "Create selection" action on the listings bulk bar (`?listingIds=`).
**Done when:** members reach `/selections` from the sidebar and from a listing selection (e2e)

### S14-F6 · Redundant no-store headers removed (S13 review)
Ref §5 · Mod api · Dep S13 review (5360769e)
**Build:** the `noStorePlugin` now sets `Cache-Control: no-store` on every private `/v1/*` route; remove the ~137 per-route `reply.header('cache-control', 'no-store')` calls it makes redundant (keep routes that set another cache policy).
**Done when:** the api suite and the no-store tests pass with the per-route calls gone

### S14-F7 · Scope the public AI-toggle read; Studio batch grants (S13 review, low)
Ref §5 · Mod agencies, ai-features, db · Dep S13-F17 S13-F14
**Build:** `agency_ai_features(uuid)` (app_public, SECURITY DEFINER) answers only for an agency that has a live website site (or only the website-search toggle), not any agency id; `listing_studio_batches` drops member UPDATE / DELETE if Studio can write through a narrower path.
**Done when:** an agency without a site gets nothing from the function (test); isolation covers the batch table's grants

### S14-F8 · Perf re-measures on a quiet box / staging (S13 review)
Ref §15 · Mod ops · Dep S13-F10 · [H4]
**Build:** re-run `pnpm perf:smoke selection` (p95 ≤ 150 ms; it measured 155–188 ms only on a box at 100 % CPU), the k6 `website-api` baseline (the k6 container did not start locally), the S12-08 AI search and S12-05 portfolio figures, and S12-F5 on the staging-sized search box.
**Done when:** each figure is recorded in STATUS within its budget, or a fix task is filed

### S14-F9 · Scale-seed EXPLAINs for the S13 backfills (S13 review)
Ref §5 · Mod onboarding, crm, properties · Dep S13-F26 S13-F15 S13-F8
**Build:** run `pnpm ops:onboarding-backfill` against the dev scale seed and EXPLAIN (ANALYZE, BUFFERS) its grouped reads (`earliest*ByAgency`), the S13-F15 rollup sweep (`unbuiltRollupAgencies`) and the S13-F8 contact notes / imports keyset lists; fix any Seq Scan on a > 10k-row table.
**Done when:** the plans are recorded in STATUS, each index-backed and within budget

### S14-F10 · Developments sitemap test under parallel load (S13-F21)
Ref §15 · Mod website-api · Dep S13-F21
**Build:** `[S8-F24]` (website-api developments sitemap) fails every time the whole module runs in parallel and passes alone (a failed sitemap query) — find the cause (pool exhaustion, a shared fixture, or the S13-F21 site-plan change) and fix it.
**Done when:** the website-api suite passes three full parallel runs in a row

---

## S15 — Public portal MVP

### S15-01 · Portal search, detail and location pages
Ref §3 #63 §7 M14 PATTERNS §19 · Mod websites (portal), public · Dep S5-03 S7-02 · ⚡
**Build:** inmolink.es on Next.js: locale-prefixed search (filters, map dynamic import), listing detail (ISR, JSON-LD, OG), location landing pages (4 levels + groups), development pages.
**Done when:**
- Lighthouse ≥ 90 (SEO, accessibility) on search, detail, location pages; performance at the level measured in S15-01 (84–87 locally) until the staging measurement (H4) — ADR 0019 (A)
- Public JS: framework ≤ 149 KB gzip, route ≤ 30 KB gzip, chunks cached `immutable` (ADR 0013)
*(Parity reference, Shahzaib 2026-10-25: the live legacy portal, e.g. https://inmolink.es/alicante — every agency's PUBLIC listings; province → comarca → town landing pages (`/alicante/costa-blanca-south`) with an intro text giving live counts per property type and a list of child locations; filters price min/max (fixed steps), grouped property types (Apartments: apartment, duplex, penthouse, studio; Houses: bungalow, country home, semi-detached, townhouse, villa, village house; plot), bedrooms and bathrooms min/max, min build size, features (sea view, golf); sort latest / price ↑ / price ↓; numbered pages (`?page=N`, crawlable); cards with photo, title "<Type> in <Town>", price, excerpt, beds, baths, build / plot / terrace m², and the listing agency linking to its profile (S15-03). Old URL shapes `/property-details/<ref>/<slug>` and `/agent/<id>/<name>` get 301s in S15-02.)*

### S15-02 · Portal enquiries, sitemaps, redirects
Ref §7 M14 §3 #12 · Mod public · Dep S15-01 S14-05 S10-02
**Build:** enquiry form (Turnstile) routed to listing owner (marketplace rule), per-locale sitemaps generated by a job to R2, hreflang/canonicals, legacy URL 301s, robots.txt.
**Done when:**
- Portal lead routes to the listing owner with source MARKETPLACE
- Sitemaps validate and include only PUBLIC listings

### S15-03 · Agency and agent profile pages
Ref §7 M14 · Mod public · Dep S15-01 S1-06
**Build:** public agency/agent pages with their PUBLIC listings, register numbers, languages, contact form; JSON-LD `RealEstateAgent`.
**Done when:** profile pages only show PUBLIC listings and verified agencies

---

### S15-F1 · Legacy toolkit shared helpers (S14 review)
Ref §14 · Mod migration · Dep S14-02
**Build:** one `migration/legacy-rows.ts` for the helpers repeated across the legacy loaders and validation (`cents`, `idsOf` / `idOf`, the legacy-agency lookup) and one script helper for argument parsing (`--map`, `--agency`) shared by the legacy scripts; route the S4-04 `legacy:developments` entry point through the streamed `stagedSource` (or remove it in favour of `legacy:load`).
**Done when:** the migration suite passes with each helper defined once (grep check)

### S15-F2 · Developments legacy load: fixed statements on a bad row (S14 review)
Ref §14 · Mod developments · Dep S4-04
**Build:** `importLegacyDevelopments` retries a failing batch one row per savepoint (up to batch-size statements); validate rows with the contracts schemas before writing and bisect a failing batch instead.
**Done when:** a batch with one bad row loads the rest in a bounded number of statements (countQueries test)

### S15-F3 · Shared-DB-safe migration tests (S14 review)
Ref §15 · Mod migration · Dep S14-04 S14-06
**Build:** scope the cutover `due` list (`DUE_LIMIT`), `legacyDnsReadiness` and `deltaAgencies` test calls to the test's agencies (agency / after parameter) or clean their rows in `afterAll`, so the suites stay correct as the shared test DB grows.
**Done when:** the migration suite passes twice in a full parallel core run

### S15-F4 · Legacy DB adapter for the delta reader (S14-04)
Ref §14 · Mod platform, migration, worker · Dep S14-04 · [H1]
**Build:** move the read-only legacy pg reader into a `platform/legacy-db` adapter (read-only session, statement timeout, connection limit) and register it at worker start from `LEGACY_DATABASE_URL`, so `migration.scheduleLegacyDeltas` queues real deltas; the dump engine (PostgreSQL assumed) confirmed with H1.
**Done when:** with a legacy URL configured the hourly job queues one delta per non-cut-over agency (test against the fixture DB)

### S15-F5 · Website-feed e2e intermittent in full runs (S14 review)
Ref §15 · Mod web, e2e · Dep S7-F8
**Build:** `[S7-F8]` (tests/e2e/website-feed.spec.ts) intermittently fails in the login helper (`tests/e2e/two-factor.ts`): after "Log in" neither the dashboard heading nor the 2FA view appears within 15 s (local full run, the suite's last spec), and once in CI 2FA enrolment showed no recovery codes. It passes alone. Find the cause (a slow cold route, session cookie / redirect race, or the S13-04 dashboard home checklist) and fix it — not by raising the timeout alone.
**Done when:** the full e2e suite passes three times in a row locally and on CI

### S15-F6 · Portal cards read the card document only (S15-01 review)
Ref §7 M14 · Mod search, read-models · Dep S15-01
**Build:** `docPart('portal')` (`search/repo.ts`) reads `detail ->> 'description'` and `detail -> 'terraceM2'` for every card, loading the whole detail JSON (media list included) for 20 rows per page. Put the excerpt and terrace into the card document when the read model is built and read `m.card` only.
**Done when:** the portal search reads no `detail` column; EXPLAIN on the scale proxy shows no detoast of `detail`; portal int tests green

### S15-F7 · Portal metadata in core, cache invalidation (S15-01 review; ADR 0019 accepted: A)
Ref PATTERNS §19 · Mod website-api, public · Dep S15-01, ADR 0019
**Build:** move titles, metadata and JSON-LD building from `apps/public/src/portal/{seo,meta}.ts` into `website-api/portal.ts` (`portal.metadataFor` / `portal.jsonLd`, PATTERNS §19). Invalidate on change: listing withdrawn / price change / agency standing or contact change → purge the page (Next `revalidateTag` with a bounded or shared cache handler — ADR 0019 (A)), and clear the in-process agency-contact cache on the agency-profile event.
**Done when:** a withdrawn listing disappears from its page and from search pages within one minute; no unbounded per-instance page cache; tests

### S15-F8 · Zone member and type caps at save (S15-01 review)
Ref §7 M14 · Mod taxonomy · Dep S15-01
**Build:** zones with more than `PORTAL_ZONE_MAX_MEMBERS` members (and type groups over 50 ids) are cut at read time with a warning. Refuse them when the zone / group is saved (staff taxonomy editor), with a clear error.
**Done when:** saving an oversize zone is refused with a test; the read-time warning never fires on seeded data

### S15-F9 · Development page LCP and the S12-04 e2e intermittent (S15-01)
Ref §7 M14 · Mod public, e2e · Dep S15-01
**Build:** the development page's LCP is 2.41 s locally with no image — find the LCP element and fix it. `[S12-04]` (public selection price poll, 60 s predicate) failed in several full e2e runs and once in a two-spec run, then passed on rerun — find the cause (a read-model rebuild that never runs after a worker crash? the poll interval?).
**Done when:** development page LCP < 2.0 s in the local Lighthouse run; `[S12-04]` passes in three consecutive full e2e runs

### S15-F10 · Portal agent (member) profiles and agency logos (S15-03)
Ref §7 M14 · Mod agencies, public · Dep S15-03
**Build:** members get an opt-in published profile (name, photo, languages, phone / e-mail they choose to publish) shown on the portal at `/{locale}/agent/{id}/{name}` and on their agency's profile; agency logos on the portal (copy the logo to a public variant on publish — the logo sits in the private bucket today). Only verified, listed agencies; nothing unpublished.
**Done when:** a member who publishes a profile has a portal page linked from the agency profile; one who has not has none; the agency logo shows on cards and the profile; tests

### S15-F11 · CDN purge of portal listing and development pages (S15-F7)
Ref §7 M14 · Mod website-api, platform · Dep S15-F7
**Build:** the S15-F7 subscribers that mark a listing / development / agency tag also queue a CDN purge of that page's URLs in every locale (reuse `queueEdgePurge`, batched, rate-limited); make the page-cache cap configurable (env); update PATTERNS §19 to show `tagPage(portalPageTags(page))` and the 404 code tag.
**Done when:** a withdrawn listing's page is gone at the edge within one minute (test against the edge adapter's fake); the cap is an env setting; PATTERNS updated

## S16 — Hardening

### S16-01 · Full load suite
Ref §15 · Mod tests · Dep S15-02 · ⚡
**Build:** all k6 scenarios from §15 on staging with the 5,000-agency seed; results stored in `docs/build/reviews/load-R1.md`.
**Done when:** every §15 target met; any miss has a fix merged and re-run

### S16-02 · Chaos drills
Ref §15 §5.4 · Mod ops · Dep S16-01
**Build:** scripted drills: kill search, kill feed-api origin, promote standby, restart redis-queue, AI provider 100% errors, PITR restore to a fresh server.
**Done when:** each drill matches the degradation matrix; RTO/RPO measured and recorded

### S16-03 · Security hardening
Ref §12 · Mod all · Dep S16-01 · [H8] · 🔒
**Build:** dependency audit, secrets scan, CSP nonces and headers review, CORS review, rate-limit coverage report, `security-auditor` pass over the whole codebase, external pen-test fixes.
**Done when:** no Critical/High findings open

### S16-04 · GDPR flows and legal pages
Ref §13 · Mod compliance, public, imports · Dep S10-08, S7-F1 · [H7]
**Build:** data subject export (GDPR_SUBJECT job), erasure (anonymize PII, keep deal/audit with anonymized actor; agency offboarding/erasure also calls `imports.deleteAgencySheets(agencyId)` after its commit — S7-F1), consent records, retention jobs, sub-processor list page, privacy/cookie/terms pages, cookie consent.
**Done when:** erasure of a contact removes PII from all tables, search and read models (verified by a scan test); agency erasure leaves no object under `imports/sheets/<agency>/` (`imports.deleteAgencySheets`, which has no caller until then — S8-F4) (test)

### S16-05 · Operations readiness
Ref §17 · Mod ops · Dep S16-02
**Build:** Grafana dashboards per service, SLO burn-rate alerts, queue-age alerts, backup and replication alerts, public status page, runbooks complete.
**Done when:** *(manual)* each alert fires in a staged test and links to its runbook

---

## S17 — Pilot

### S17-01 · Pilot cutover
Ref §14 · Mod migration · Dep S16-05 S14-06 · [H11]
**Build:** cut over 15–20 agencies in one area using the runbooks; daily metrics (website availability, leads, errors, support tickets); fix list.
**Done when:** zero website outages; all pilot agencies active after 2 weeks

### S17-02 · Go/no-go report
Ref §16 §21 · Mod docs · Dep S17-01
**Build:** report with KPIs, incidents, fixes, remaining risks, wave plan for the remaining agencies.
**Done when:** *(manual)* Shahzaib signs off go/no-go in STATUS
