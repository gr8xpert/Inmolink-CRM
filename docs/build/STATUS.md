# Build status

Single source of truth for progress. Claude updates this at the end of every task. Keep **Now**, **Current sprint** and **Blocked** short — the session-start hook injects them.

## Now
- **Task:** S0-04 · Database package
- **Started:** —
- **Notes:** S0-03 done. Platform subpaths: `@inmolink/platform/{config,logger,errors,ids,clock,crypto,crypto/password,http}`. Load DB URLs with `loadConfigOrExit({ ...coreEnv, ...databaseEnv })`; `APP_ROLE` is already validated (`withSystem` refusal). Drizzle 0.45.4 / drizzle-kit 0.31.11 per ADR 0001. Use `newId()` for UUIDv7 defaults.

## Current sprint
- **Sprint:** S0 — Foundation
- **Exit criteria:** Login works on staging; restore drill passes; boundary and isolation checks fail on planted violations (PLAN §16)
- **Progress:** 3 / 16 tasks done

## Blocked
- none

## Task log
<!-- One line per task: ID · STATE · date · summary (· perf numbers for ⚡ tasks) -->
| Task | State | Date | Summary |
|---|---|---|---|
| S0-01 | DONE | 2026-10-10 | pnpm + Turbo workspace with 6 Node/Next apps + 8 packages building; TS/Biome/Vitest presets in `@inmolink/config`; husky + lint-staged; `pnpm verify` uses `--affected`; later-task scripts stubbed (fail loudly); versions in ADR 0001 |
| S0-02 | DONE | 2026-10-10 | `docker-compose.yml` with `dev`/`test` profiles (own ports + volumes): PG 18.6 + PostGIS 3.6 + pgvector + pg_trgm + pg_partman + pg_stat_statements (init script), PgBouncer 1.26 transaction mode, redis-queue (noeviction, AOF) / redis-cache (allkeys-lru), Meilisearch, MinIO + buckets, Mailpit, OTel collector → Jaeger (dev only); all ports bound to 127.0.0.1; `scripts/ops/health.ts`; `pnpm dev` starts infra then apps; `test:int:root` brings up the test profile and runs in `verify` |
| S0-03 | DONE | 2026-10-10 | `@inmolink/platform` subpath adapters: `config` (composable Zod env sections, all problems reported at once, keyring + prod dev-key checks, `loadConfigOrExit`), `logger` (pino, redaction list ≤3 levels, pg-error serializer, request-id child), `errors` (re-export of contracts `AppError`/`ErrorCodes`), `ids` (own monotonic UUIDv7, `INL-` Crockford refs), `clock` (swappable/fake), `crypto` (AES-256-GCM keyring with key IDs/rotation/required AAD, purpose-scoped HMAC via HKDF, `newToken`; Argon2id in `crypto/password`), `http` (cache-control builders, strong ETag + weak If-None-Match). ADR 0003. 44 unit tests; code-reviewer + security-auditor findings fixed |
| S0-04 | TODO | | |
| S0-05 | TODO | | |
| S0-06 | TODO | | |
| S0-07 | TODO | | |
| S0-08 | TODO | | |
| S0-09 | TODO | | |
| S0-10 | TODO | | |
| S0-11 | TODO | | |
| S0-12 | TODO | | |
| S0-13 | TODO | | |
| S0-14 | TODO | | |
| S0-15 | TODO | | |
| S0-16 | TODO | | |

*(Add the next sprint's rows when a sprint closes in `/sprint-review`.)*

## Decisions
<!-- Assumptions Claude made where the plan was silent, and proposed ADRs awaiting approval. -->
- 2026-10-10 · **Pricing is configurable.** €800/yr and every other price, cap and reward in PLAN are working figures, not fixed values. Plans, prices, limits and add-ons are data (catalog synced to Stripe, staff-editable); never constants in code. PLAN §0 and §11 annotated. (Shahzaib)
- 2026-10-10 · **Node.js 24 LTS** for dev and CI; production servers support 22 and 24, so root `engines.node` is `>=22 <25`. Record in ADR 0001. PLAN §5.8 updated. (Shahzaib)
- 2026-10-10 · **PostgreSQL 17+** (PLAN §5.1 said 16; §5.8, S0-02 and PATTERNS §13 `MERGE … RETURNING merge_action()` need 17). §5.1 corrected.
- 2026-10-10 · **Next.js latest stable** (PLAN §5.2 said 15; §5.8 says latest stable). §5.2 corrected; exact version pinned in ADR 0001.
- 2026-10-10 · **Email and storage adapters** have no S0 task. Build `platform/email` (Resend/SES drivers, Mailpit locally) inside S0-09, and `platform/storage` (R2/MinIO, private buckets, signed URLs) inside S1-03, both following the platform adapter pattern. (Shahzaib approved)
- 2026-10-10 · **Forward dependencies:** S3-10 depends on S4-02, and S5-06 depends on S11-04. S3 and S5 can close with those two tasks marked `BLOCKED S4-02` / `BLOCKED S11-04`; each task finishes when its dependency is DONE.
- 2026-10-10 · Repo path is `E:\Repos\InmolinkCRM` (docs said `E:\Repos\Inmolink`; PLAN §22 and BUILD-GUIDE fixed). Remote: `https://github.com/gr8xpert/Inmolink-CRM.git`.
- 2026-10-10 · **TypeScript 6.0.3, not 7.0** (S0-01). TS 7 has no JS compiler API yet, and Next API-mode type checking, dependency-cruiser, SDK codegen and tsdown d.ts depend on it. Revisit at each sprint review (ADR 0001).
- 2026-10-10 · **pnpm 10.33.2 pinned, pnpm 12 deferred** (S0-01). pnpm 10's auto-switch to `pnpm@12.10.1` fails on this machine because the user path contains a space (`Shah PC`). Upgrade after installing pnpm 12 globally (ADR 0001).
- 2026-10-10 · **Package exports use a `@inmolink/source` condition** (S0-01). Typecheck, Vitest and tsx resolve TypeScript source; builds and Next resolve tsdown `dist/`. App packages are named `@inmolink/app-<name>`. `apps/wp-plugin` stays outside the pnpm workspace (PHP tooling).
- 2026-10-10 · **Stubbed root scripts exit 1** with the owning task ID, so nothing silently pretends to work. `verify` gains `check:boundaries` (S0-12) and `test:isolation` (S0-05) when those tasks land.
- 2026-10-10 · **PostgreSQL 18** (S0-02). PG 18.6 is the newest major with PostGIS 3.6, pgvector 0.8.7 and pg_partman 5.5 all packaged (PGDG), within "17+". Image `inmolink/postgres:18-3.6` is built from `postgis/postgis:18-3.6`. Production must run the same major (S0-15).
- 2026-10-10 · **MinIO image from `pgsty/minio`** (S0-02). Upstream MinIO stopped publishing Docker images; `pgsty/minio` and `pgsty/mc` are the community builds of the same server and client. Local/CI only — production storage is R2. If that fork stalls, swap to any S3-compatible server; the storage adapter (S1-03) only speaks S3.
- 2026-10-10 · **`pnpm verify` needs Docker** (S0-02). Root `test:int:root` (tests/infra) runs in `verify` and its global setup runs `docker compose --profile test up -d --wait`. Package integration tests from S0-04 on use the same test stack. The stack stays up between runs; `pnpm infra:down` stops both profiles.
- 2026-10-10 · **Bootstrap superuser `postgres` is for ops only** (S0-02). `DATABASE_URL_ADMIN(_POOLED)` serve health checks and scripts. App roles (`app_owner`, `app_user`, `app_system`, `app_public`) are created in S0-04. PgBouncer finds them through `auth_query`, so S0-04 does not need to edit `userlist.txt`.
- 2026-10-10 · **pg and ioredis were added in S0-02**, earlier than planned, for the health script. Versions match ADR 0001: pg 8.23.1 and ioredis 6.0.0. ioredis 6 defaults to RESP3, and the health script passes `protocol: 2`. S0-06 must choose the protocol on purpose for BullMQ.
- 2026-10-10 · graphify knowledge-graph hooks live in `.claude/settings.local.json` (machine-specific, not committed); `graphify-out/` is git-ignored.

- 2026-10-10 · **Log redaction censors values** (`[REDACTED]`) rather than deleting keys (S0-03). The value is gone from the log, and the key shows a field was present, which helps debugging. Matching is by exact key name, 3 levels deep (pino wildcard cost on feed-api), so PII fields use canonical names (`email`, `phone`, …). `key` is redacted by design, so log cache and S3 keys as `cacheKey` or `objectKey`.
- 2026-10-10 · **UUIDv7 is generated in-house** (S0-03, ~40 lines, no dependency): RFC 9562 method 1, with a 12-bit counter, so IDs stay strictly ordered within a process even when the clock steps back.
- 2026-10-10 · **Dev crypto keys are marked by convention** (S0-03). `.env.example` uses key ID `dev1` and `HMAC_KEY=dev-…`. Config refuses both under `NODE_ENV=production`.
- 2026-10-10 · **Inbound request IDs are trusted only from the edge.** `requestIdFrom()` keeps any well-formed inbound ID. S0-08 must call it only for the trusted proxy/CDN header and log client-sent IDs separately.

## Human actions
<!-- H-number · date done · details (see HUMAN-ACTIONS.md) -->
- none yet

## Sprint history
| Sprint | Closed | Report |
|---|---|---|
