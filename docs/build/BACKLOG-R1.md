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
**Build:** profile (logo, colours, contact, register number, languages, translations), settings (default commission, registration validity days, viewing response days, enabled locales, white-label options, Client Mode PIN policy).
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
**Build:** per-tenant fairness in the claim query (one agency's burst must not delay others' events); per-table autovacuum settings for `outbox_events`; either per-subscriber delivery tracking or a PATTERNS §8 rule that each subscriber is idempotent on its own (a retry re-runs all subscribers); one shared `PLATFORM_AGENCY_ID` (now in `db/tenancy/rls.ts` and `platform/outbox/emit.ts`); implement ADR 0014 once decided.
**Done when:**
- With 10 agencies, one agency emitting 50,000 events does not delay another agency's event by more than one batch
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
**Build:** PgBouncer `query_wait_timeout` ≈ 5 s and `max_db_connections` below `max_connections`; `idle_in_transaction_session_timeout` 10–30 s for `app_user`, `app_auth`, `app_public`; rate-limit counters on a Redis that does not evict (redis-queue with a prefix, or a `volatile-lru` split); scale seed throughput (bigger chunks, buffered COPY writes; 25k users took 15.2 s).
**Done when:**
- A saturated pool returns an error within 6 s instead of waiting 120 s
- `pnpm db:seed:scale --agencies=5000` users phase runs ≥ 5× faster

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
**Build:** create/update/soft-delete/restore (30 days), status lifecycle, visibility + share scope (verification gate), per-listing share commission (bp or fixed, VAT flag), field locks, optimistic `version`, price/status history, events, CEE energy rating required for PUBLIC. Dashboard API routes.
**Done when:**
- Only the owner agency writes; agents edit only their own listings unless AGENCY_ADMIN
- PUBLIC without CEE rating fails with `ENERGY_RATING_REQUIRED`
- Stale `version` → 409; history rows written for price and status changes
- PREFERRED scope visible only to agencies that list the owner as preferred
- `properties.listing.*` events emitted in the same transaction
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
**Build:** network search API + UI: commission shown, owner agency (agent-side only), filters incl. preferred agencies only, new-builds, map view (dynamic import), bookmarks; give-to-get gate (threshold from config, grace period, exemption flag).
**Done when:**
- Agency below the give-to-get threshold after grace sees a clear upsell state, not results
- Results never include PRIVATE listings or PREFERRED listings from non-preferring owners
- API p95 < 300 ms on the scale seed

### S5-06 · Saved searches and alerts
Ref §7 M9 · Mod matching · Dep S5-05 S11-04
**Build:** agent saved searches; alerts on new listing, price drop, back on market (event-driven + daily digest); notification + email.
**Done when:** a new matching listing produces exactly one alert per saved search (deduplicated)
*(Note: depends on S11-04 notifications — build alert generation first, delivery when S11-04 is done.)*

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

---

## S7 — Website API v2

### S7-01 · Website sites and inventory policies
Ref §9.1 §6 Website delivery · Mod websites · Dep S5-01 S1-05
**Build:** `website_sites` (domains, mode, inventory policy OWN_ONLY / OWN_PLUS_NETWORK / CUSTOM with filters, reference prefix, locales, contact overrides); config UI; API keys bound to a site.
**Done when:** changing a site's policy changes its results within 60 s (cache)

### S7-02 · Website serializer
Ref §3 #6 #54 §9.1 · Mod websites · Dep S7-01 S3-10 · 🔒
**Build:** per-site serialization of read-model documents: presenting agency branding and contacts, reference prefix, overrides precedence (override > site content > owner text), canonical-only for duplicate clusters (no-op until R2 dedupe), sanitizer hook (S12-03).
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

### S7-05 · Lead intake and speed-to-lead
Ref §3 #12 #60 §7 M8 · Mod websites, crm · Dep S7-03 · 🔒
**Build:** `POST /v2/leads`, `POST /v2/viewing-requests` (Turnstile, validation, idempotency); store as inbound leads (completed into CRM in S10-02); auto-acknowledgement email in the buyer's language within 60 s with 3 similar listings from the same site's inventory; agent notification.
**Done when:**
- Lead from site A for a network listing belongs to agency A (presenting agency)
- Auto-ack is sent in < 60 s p95 and uses the site's branding
- Duplicate submissions with the same idempotency key create one lead

### S7-06 · CDN caching and purge
Ref §9.2 §5.3 (4) · Mod websites, infra · Dep S7-03
**Build:** Cloudflare cache rules for feed-api, cache keys by site scope + query + locale, purge on listing events (tags where available, else short TTL + versioned keys), `stale-if-error`.
**Done when:**
- *(staging)* origin stopped → website API keeps serving cached responses
- Listing edit visible through the CDN within 5 min

### S7-07 · Per-site XML feed and iFrame embed
Ref §9.5 · Mod websites, public · Dep S7-03
**Build:** token-protected XML feed per site (Kyero-format + generic) generated by a job to R2 and served via CDN; iFrame pages in `apps/public` (search, results, detail) themed with agency branding, leads routed to the site's agency.
**Done when:**
- XML feed validates against the Kyero schema fixture
- iFrame detail page passes the white-label test and Lighthouse ≥ 90

### S7-08 · Website API load test
Ref §4.2 §15 · Mod tests · Dep S7-06 · ⚡
**Build:** k6 scenario mix (search 60%, detail 30%, taxonomy/changes 10%) against staging scale seed.
**Done when:** 1,000 rps origin sustained 15 min with p95 < 150 ms and error rate < 0.1% *(staging)*

---

## S8 — Legacy shim & WordPress plugin v2

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

### S8-06 · JS widget
Ref §9.5 · Mod sdk · Dep S7-03
**Build:** embeddable widget (search + results + detail modal) built on the SDK with publishable keys, SPW-AI natural-language search box when `/v2/search/ai` exists (R1: structured search only if AI not ready).
**Done when:** widget bundle ≤ 60 KB gzip; works on a plain HTML page with an allowlisted origin

---

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

### S10-03 · Pipeline
Ref §7 M8 · Mod crm, web · Dep S10-02
**Build:** agency-customizable stages, board and list views, drag to change stage, stage history.
**Done when:** stage changes are recorded in activity and visible in reports data

### S10-04 · Activity timeline
Ref §6 CRM · Mod crm · Dep S10-01 S1-08
**Build:** partitioned `activities` (polymorphic: contact, lead, listing), writers from other modules via events, timeline UI with filters.
**Done when:** timeline for a contact with 5,000 activities loads first page in < 300 ms (keyset)

### S10-05 · Tasks and reminders
Ref §7 M8 · Mod crm · Dep S10-01
**Build:** tasks linked to contact/lead/listing, due dates, assignees, reminders (notification + email), my-tasks view.
**Done when:** reminders fire once at the due time (scheduled job, idempotent)

### S10-06 · Calendar
Ref §7 M8 · Mod crm · Dep S10-05
**Build:** events (viewing, meeting, call), attendees (users, contacts), reminders, per-user ICS feed (secret URL) for Google/Outlook subscription.
**Done when:** ICS feed validates and reflects changes within 15 min; revoking the URL token stops access

### S10-07 · Acquisition board
Ref §7 M8 · Mod crm, web · Dep S10-03 S3-02
**Build:** seller prospects (board, list, calendar views), confidential notes, one-click convert to a DRAFT listing with seller linked in `property_privates`.
**Done when:** conversion creates the listing and links the seller contact without exposing it to other tenants

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

## S11 — MLS collaboration & network board

### S11-01 · Client registration
Ref §3 #8 §7 M10 · Mod mls · Dep S10-01 S5-05 · 🔒
**Build:** `client_registrations`: introducer registers a contact to a listing/development; fingerprint = HMAC(normalized email/phone); encrypted client details; validity from agency settings; conflict rule (first valid wins); owner sees “registered by Agency X”, not the client.
**Done when:**
- Second agency registering the same client for the same target gets `REGISTRATION_CONFLICT`
- Expired registrations no longer block
- Fingerprints are not reversible without the HMAC key (no raw identifiers stored outside encrypted fields)

### S11-02 · Viewing requests and terms snapshot
Ref §3 #9 §7 M10 · Mod mls · Dep S11-01
**Build:** request → accept/decline/reschedule → scheduled → outcome; terms snapshot (commission, split, VAT, validity) accepted by both sides; immutable; simple PDF of accepted terms via PDF service when available (stub until S12-05); expiry job.
**Done when:**
- Terms snapshot cannot change after both acceptances (DB constraint + test)
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
**Build:** create from search/bookmarks; ordered items; branded live page in `apps/public` (prices/status live from read models, white-labelled, client language); share via WhatsApp deep link/email; view/like/enquire events → CRM timeline; expiry.
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

---

## S15 — Public portal MVP

### S15-01 · Portal search, detail and location pages
Ref §3 #63 §7 M14 PATTERNS §19 · Mod websites (portal), public · Dep S5-03 S7-02 · ⚡
**Build:** inmolink.es on Next.js: locale-prefixed search (filters, map dynamic import), listing detail (ISR, JSON-LD, OG), location landing pages (4 levels + groups), development pages.
**Done when:**
- Lighthouse ≥ 90 (performance, SEO, accessibility) on search, detail, location pages
- Public first-load JS ≤ 120 KB gzip

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
Ref §13 · Mod compliance, public · Dep S10-08 · [H7]
**Build:** data subject export (GDPR_SUBJECT job), erasure (anonymize PII, keep deal/audit with anonymized actor), consent records, retention jobs, sub-processor list page, privacy/cookie/terms pages, cookie consent.
**Done when:** erasure of a contact removes PII from all tables, search and read models (verified by a scan test)

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
