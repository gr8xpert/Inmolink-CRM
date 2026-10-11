# Architecture

Short map of how Inmolink v2 fits together. The reasoning lives in [PLAN.md](PLAN.md) §5 and the [ADRs](docs/adr/README.md). The code shapes to copy live in [docs/build/PATTERNS.md](docs/build/PATTERNS.md).

## Logical architecture (PLAN §5.1)

```
 CLIENTS   Agent PWA · Agency websites (WP plugin / JS widget / hosted) · inmolink.es
           Developer portal · Portals pulling XML · Staff console
                                   │
 EDGE      Cloudflare: DNS · WAF · DDoS · CDN cache · Turnstile · R2 media
                                   │
                         Load balancer (Stage B+)
       ┌──────────┬──────────┬─────┴──────┬────────────┬────────────┐
     web        public      api        feed-api     realtime      (stateless,
   Next.js     Next.js    Fastify      Fastify     Socket.io      horizontally
  dashboard    portal +   dashboard   website API  chat + notif.  scalable)
               hosted     API         v1/v2 + XML
               sites (R3)             portal feeds
       └──────────┴──────────┴─────┬──────┴────────────┴────────────┘
                                   │
 DATA      PgBouncer → Postgres 18 primary ──WAL──► hot standby (other DC)
           (PostGIS · pg_trgm · pgvector · pg_partman)      │
           redis-queue (BullMQ) · redis-cache (LRU)        WAL-G → R2 (PITR)
           Search (Meilisearch → cluster) · R2 (media, exports, backups)
                                   │
 WORKERS   outbox · imports · media · indexing · matching · exports · email · ai · social · pdf · maintenance
```

## Deployables

| App | Role | DB role (ADR 0011) | Notes |
|---|---|---|---|
| `apps/web` | Agent, agency, developer and staff dashboard (Next.js) | — (calls `api`) | Auth.js sessions; signs 15-minute access tokens (ADR 0004) |
| `apps/public` | inmolink.es portal, selections, client portal, iFrame embeds | — (calls `feed-api`/`api`) | Public pages: LCP < 2.0 s, JS ≤ 120 KB |
| `apps/api` | Dashboard API, staff API, inbound webhooks | `app_user`, `app_staff`, `app_auth` | p95 < 300 ms, ≤ 10 queries |
| `apps/feed-api` | Website API `/v2`, legacy `/v1` shim, XML feeds | `app_public` only | Read models + search, CDN-cached (ADR 0012) |
| `apps/realtime` | Chat and notifications (Socket.io + Redis adapter) | `app_user` (from S11) | JWT handshake, origin allowlist |
| `apps/worker` | BullMQ pools selected by `WORKER_POOLS` | `app_system` | One process per pool in production; per-tenant fair share |
| `apps/wp-plugin` | WordPress plugin v2 (PHP) | — | Local cache with stale fallback |

Node apps expose `/healthz`, `/readyz` and a private Prometheus `/metrics`; the Next.js apps expose `/healthz`. Each app is a separate image deployed by Kamal (ADR 0007).

## Code layers

```
apps/*  ──►  packages/core  ──►  packages/db · packages/platform · packages/contracts
(thin)       (all business       (Drizzle +     (adapters)        (Zod DTOs,
              logic, modules)     registry)                         error codes)
packages/ui ──► packages/contracts          packages/platform ──► packages/config · contracts
```

- **Apps** authenticate, validate, call one service and serialize. They hold no business logic.
- **`packages/core/src/modules/<module>/`**: `index.ts` (the only import surface), `service.ts`, `repo.ts`, `policy.ts`, `events.ts`, `jobs.ts`, `errors.ts`, `__tests__/`. Every service function takes `ctx`.
- **`packages/db`**: Drizzle client per role, `schema/<module>.ts`, migrations, tenant registry → generated RLS, `withTenant`, `withSystem`, `withPublicRead`, `withAuth`.
- **`packages/platform`**: the only path to infrastructure — `cache`, `queue`, `outbox`, `rate-limit`, `flags`, `crypto`, `jwt`, `email`, `server`, `telemetry`, `logger`, `config`, `ids`, `clock`. Planned: `search`, `storage`, `ai`, `pdf`, `safe-fetch`.
- **`packages/contracts`**: request and response schemas plus error codes, shared by apps, the OpenAPI output and `packages/sdk`.

dependency-cruiser enforces these rules in CI (`pnpm check:boundaries`, ADR 0010).

## Module map

| Module | Owns | Release | State |
|---|---|---|---|
| `identity` | users, auth tokens, sign-up, login, sessions | R1 | **built** (S0-09) |
| `agencies` | agencies, settings, verification, preferred agencies | R1 | S1 |
| `taxonomy` | locations, property types, features, aliases | R1 | S2 |
| `properties` · `media` | listings, overrides, bookmarks, quality · content-addressed media (ADR 0002) | R1 | S3 |
| `developments` | developments, phases, units, price lists | R1 | S4 |
| `search` | read models, search index, fallback (ADR 0005) | R1 | S5 |
| `imports` | connectors, bulk loader, fair scheduler | R1 | S6 |
| `websites` | sites, inventory policies, serializer, API keys, leads in (ADR 0012) | R1 | S7–S8 |
| `exports` | portal feeds | R1 | S9 |
| `crm` | contacts, leads, pipeline, tasks, calendar | R1 | S10 |
| `mls` · `network` · `chat` · `notifications` | registrations, viewings, terms · AMS board · chat · notifications | R1 | S11 |
| `ai-features` · `presentations` · `documents` · `social` | Listing Studio, sanitizer, AI search · selections, PDFs · social posting | R1 | S12 |
| `billing` · `onboarding` · `support` · `admin` | Stripe, plans, seats · onboarding · tickets · staff console | R1 | S13 |
| `migration` | legacy ETL, delta sync, redirects (ADR 0006) | R1 | S14 |
| `matching` · `dedupe` · `quality` · `reports` · `client-portal` · `referrals` | — | R2 | later |
| `marketing` · `compliance` | — | R3 | later |

## Key flows

- **Write path:** route → `withRequestCtx` → service (policy check) → repo inside `withTenant` → `emit(event)` in the **same** transaction → commit. The outbox dispatcher then delivers events to subscribers and jobs (search indexing, read models, cache purge, notifications). Consumers are idempotent and replayable (`pnpm ops:replay-outbox`).
- **Website read path:** CDN (keyed by site + query + locale, `stale-if-error` 24 h) → feed-api → search adapter for IDs → `listing_read_models` by primary key → per-site white-label serializer. At most 3 queries.
- **Slow or external work** (imports, media, AI, email, PDFs, portal feeds) always runs in a worker job, never inside a request or a DB transaction.

## Tenancy and security

The agency is the tenant. Every tenant table has `agency_id`, forced RLS generated from the registry, and an entry in the generated cross-tenant isolation suite. Runtime roles never bypass RLS; only workers and scripts use `app_system`, and they must give a reason. Details: ADR 0011, ADR 0003 (crypto), ADR 0004 (auth), `.claude/rules/security.md`.

## Environments

| | Local | CI | Staging / production |
|---|---|---|---|
| Services | `docker-compose.yml` profile `dev` | compose profile `test` | Ansible hosts (db, redis-queue, monitoring) + Kamal apps |
| Postgres | same image everywhere: `inmolink/postgres:18-3.6-walg3.0.9` | ← | ← plus a streaming standby in another DC |
| Config | `.env` from `.env.example` | `.env.test.example` | secret store; production refuses dev keys |

Runbooks: [ci](docs/runbooks/ci.md) · [deploy](docs/runbooks/deploy.md) · [failover](docs/runbooks/failover.md) · [PITR restore](docs/runbooks/pitr-restore.md) · [queues](docs/runbooks/queues.md) · [scale seed](docs/runbooks/scale-seed.md).
