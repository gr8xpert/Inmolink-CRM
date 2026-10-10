# ADR 0001 — Stack and pinned versions

- **Status:** Accepted
- **Date:** 2026-10-10
- **Task:** S0-01 (PLAN §5.8, §18)

## Context

PLAN §5.8 locks the stack but leaves exact versions to S0. AI-written code needs one known version per library: patterns, Context7 lookups and reviews all assume it. Floating ranges cause silent API drift between clean clones.

## Decision

1. **Exact pins.** Every dependency uses an exact version (no `^`/`~`). Upgrades are deliberate PRs that update this ADR.
2. **Runtime.** Node.js 24 LTS for dev and CI (`.nvmrc`). Root `engines.node` is `>=22 <25` because production servers run 22 and 24.
3. **Package manager.** pnpm workspaces, pinned through `packageManager`. Build scripts are allowed only for packages listed in `allowBuilds` in `pnpm-workspace.yaml`.
4. **TypeScript 6.0, not 7.0.** TypeScript 7 (the native Go port) is the latest stable release, but it ships no JavaScript compiler API. Next.js API-mode type checking, dependency-cruiser (S0-12), OpenAPI/SDK codegen and tsdown declaration emit depend on that API. TypeScript 6.0 is the last JavaScript release and already enforces the 7.0 option removals (`baseUrl`, `node10` resolution, ES5 target). Move to 7.x once those tools support its API. Revisit at each sprint review.
5. **Builds.** Libraries and Node apps build with tsdown (Rolldown) to ESM `dist/` with `.d.ts`. Next.js apps use `next build`. Packages export TypeScript source under the `@inmolink/source` condition, so typecheck, Vitest and `tsx` dev runs need no prior build. Production and `next build` resolve `dist/`.
6. **Module resolution.** `moduleResolution: "Bundler"` with extensionless relative imports, as PATTERNS shows. Everything that runs in Node is either bundled by tsdown or loaded through tsx/Vitest.
7. **Lint and format.** Biome only (no ESLint/Prettier). The preset is `packages/config/biome.preset.json`, extended by the root `biome.json`.
8. **Tasks.** Turborepo runs per-package `build`, `typecheck`, `lint`, `test`, `test:int` tasks plus root (`//#…:root`) tasks. `pnpm verify` adds `--affected`, so only packages changed against `main` (including uncommitted changes) run. `pnpm verify:all` runs everything.

### Versions installed in S0-01

| Tool | Version |
|---|---|
| Node.js | 24 LTS (24.15.0 locally) |
| pnpm | 10.33.2 |
| TypeScript | 6.0.3 |
| Turborepo | 2.11.7 |
| Biome | 2.5.15 |
| Vitest | 5.0.3 |
| tsdown | 0.23.0 |
| tsx | 4.23.15 |
| husky / lint-staged | 9.1.7 / 17.6.0 |
| @types/node | 24.19.2 (matches the Node 24 runtime, not the latest major) |
| Next.js | 16.4.0 |
| React / React DOM | 19.3.0 |

### Added in S0-02

| Tool | Version |
|---|---|
| pg / @types/pg | 8.23.1 / 8.23.1 (root, for ops scripts; S0-04 reuses it) |
| ioredis | 6.0.0 (RESP3 by default; health script uses `protocol: 2`) |

Local stack images (`docker-compose.yml`, exact tags):

| Service | Image |
|---|---|
| PostgreSQL 18.6 + PostGIS 3.6 + pgvector 0.8.7 + pg_partman 5.5 | `inmolink/postgres:18-3.6-walg3.0.9` (+ WAL-G 3.0.9, S0-15) built from `postgis/postgis:18-3.6` |
| PgBouncer 1.26 | `edoburu/pgbouncer:v1.26.0-p0` |
| Redis 7.4 | `redis:7.4.11-alpine` |
| Meilisearch | `getmeili/meilisearch:v1.54.3` |
| MinIO / mc | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` / `pgsty/mc:RELEASE.2026-09-16T00-00-00Z` (upstream stopped publishing images) |
| Mailpit | `axllent/mailpit:v1.31.4` |
| OpenTelemetry collector | `otel/opentelemetry-collector-contrib:0.162.0` |
| Jaeger | `jaegertracing/jaeger:2.22.0` |

### Added in S0-03

| Library | Version |
|---|---|
| Zod | 4.6.5 (contracts, platform/config) |
| pino | 10.4.0 (platform/logger) |
| @node-rs/argon2 | 2.2.2 (platform/crypto passwords; prebuilt binaries, see ADR 0003) |
| OpenTelemetry API / SDK (trace, metrics, resources, core) | 1.9.1 / 2.12.0 (platform/telemetry, S0-10) |
| OpenTelemetry exporters (OTLP/HTTP traces, Prometheus) and `@opentelemetry/instrumentation`, `-http` | 0.223.0 |
| OpenTelemetry instrumentations pg / ioredis / undici | 0.75.0 / 0.71.0 / 0.33.0 |
| @opentelemetry/semantic-conventions | 1.43.0 |
| bullmq-otel | 2.0.1 |
| @sentry/node | 11.6.0 (errors only; tracing stays with OpenTelemetry) |

### Current stable versions on 2026-10-10 for later tasks

Pin these exactly when the task that adds them lands. If a newer stable exists by then, update this table in the same PR.

| Library | Version | Lands in |
|---|---|---|
| Fastify / @fastify/swagger | 5.12.5 / 9.9.2 | S0-08 |
| Zod | 4.6.5 | S0-03 |
| Drizzle ORM / drizzle-kit | 0.45.4 / 0.31.11 | S0-04 |
| BullMQ | 6.3.12 | S0-06 |
| pino | 10.4.0 | S0-03 |
| Socket.io | 4.8.4 | S0-08 |
| Auth.js (next-auth) | 5.0.0-beta.32 | S0-09 |
| next-intl | 4.14.9 | S0-11 |
| dependency-cruiser | 18.5.0 | S0-12 |
| TanStack Query | 5.104.1 | S0-08 |
| Playwright / MSW | 1.64.0 / 3.0.2 | S0-14 |
| Meilisearch JS | 0.62.0 | search adapter |
| sharp / Puppeteer / Stripe | 0.35.5 / 25.13.0 / 23.0.0 | media / pdf / billing |
| MapLibre GL | 6.13.0 | maps |

## Consequences

- A clean clone builds, typechecks, lints and tests with `pnpm i && pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
- Auth.js v5 is still a beta tag. S0-09 must confirm it is production-ready or record an alternative.
- **pnpm 12 is deferred.** pnpm 12.10.1 is the current stable, but pnpm 10's automatic switch to the `packageManager` version fails on Windows when the user profile path contains a space. The repo stays on 10.33.2 until pnpm 12 is installed globally (or Corepack is enabled). Then bump `packageManager`, rename `allowBuilds` if needed, and update this ADR.
- tsdown is pre-1.0. If it breaks, the fallback is `tsc` declaration emit plus Rolldown, with no change to package exports.
