# Inmolink v2

AI-native MLS + CRM + website engine for Spanish estate agencies and developers. TypeScript on Node.js and PostgreSQL, built as a modular monolith that scales to 5,000 agencies without a redesign.

- **Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md) · decisions in [docs/adr](docs/adr/README.md)
- **Plan and backlog:** [PLAN.md](PLAN.md) · [docs/build/STATUS.md](docs/build/STATUS.md) · [docs/build/PATTERNS.md](docs/build/PATTERNS.md)
- **Operations:** [docs/runbooks](docs/runbooks) · **Problems:** [TROUBLESHOOTING.md](TROUBLESHOOTING.md) · **Changes:** [CHANGELOG.md](CHANGELOG.md)
- **Working with Claude Code:** [CLAUDE.md](CLAUDE.md)

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 24 LTS (`.nvmrc`; 22 also works) |
| pnpm | 10.33.2. Enable Corepack (`corepack enable`) or run `npm i -g pnpm@10.33.2` |
| Docker | Docker Desktop or Engine with Compose v2. Give it **at least 8 GB of memory**: `pnpm verify` runs the test stack and the suites in parallel |
| Git | any recent version |

Free local ports: 3100–3101, 4000–4003, 5432, 6379–6380, 6432, 7700, 8025, 9000–9001, 16686. The test stack uses 55432, 56432, 56379, 56380, 57700 and 59000.

## Setup in 10 steps

```sh
# 1. Clone
git clone https://github.com/gr8xpert/Inmolink-CRM.git InmolinkCRM && cd InmolinkCRM

# 2. Use the pinned Node version
nvm use            # or fnm use / volta; any Node 24

# 3. Install dependencies (also installs the git hooks)
pnpm install

# 4. Local environment: the example holds working local-only values
cp .env.example .env

# 5. Start the dev stack: Postgres + PgBouncer, 2× Redis, Meilisearch, MinIO, Mailpit, OTel collector, Jaeger
pnpm infra:up

# 6. Check that every service answers
pnpm infra:health

# 7. Create the database roles, run migrations, then generate and apply RLS
pnpm db:migrate && pnpm db:rls

# 8. Seed demo agencies and users (prints the logins and the shared password)
pnpm db:seed

# 9. Start every app in watch mode
pnpm dev

# 10. Open the dashboard and log in with a seeded user
#     http://localhost:3100   (emails land in Mailpit: http://localhost:8025)
```

| App | URL |
|---|---|
| Dashboard (`apps/web`) | http://localhost:3100 |
| Public portal (`apps/public`) | http://localhost:3101 |
| Dashboard API (`apps/api`) | http://localhost:4000 (OpenAPI UI at `/docs`) |
| Website API (`apps/feed-api`) | http://localhost:4001 |
| Realtime (`apps/realtime`) | http://localhost:4002 |
| Worker health (`apps/worker`) | http://localhost:4003/healthz |
| Mailpit · Jaeger · MinIO console | http://localhost:8025 · http://localhost:16686 · http://localhost:9001 |

`pnpm infra:down` stops both stacks. Data stays in Docker volumes; `docker compose --profile dev down -v` wipes it.

## Checking your work

```sh
pnpm infra:up:test   # optional: the test stack (own ports and volumes); integration suites also start it
pnpm verify          # typecheck, lint, boundaries, unit, integration, isolation (packages changed vs main)
pnpm verify:all      # everything, as CI does on main
pnpm test:e2e        # Playwright against the dev servers
```

Other commands: `pnpm db:generate` (after a schema change), `pnpm gen:module <name>` (new domain module), `pnpm db:seed:scale --agencies=5000` (scale data, see [docs/runbooks/scale-seed.md](docs/runbooks/scale-seed.md)), `pnpm ops:replay-outbox` and `pnpm ops:restore-drill` (operations). The full list is in [CLAUDE.md](CLAUDE.md#commands-created-in-s0-01-add-new-ones-to-root-packagejson).

## Repository layout

```
apps/       thin transports: web, public (Next.js), api, feed-api, realtime (Fastify / Socket.io), worker (BullMQ), wp-plugin
packages/   core (all business logic) · db (Drizzle, registry, RLS) · platform (infra adapters) · contracts (Zod)
            i18n · ui · sdk · config
infra/      Postgres image, Ansible, Kamal, monitoring, Grafana
scripts/    ops · seed · ci · gen · boundaries
tests/      workspace, isolation, boundaries, e2e, ops, golden
docs/       adr · runbooks · build (plan execution) · api
```

If something breaks, check [TROUBLESHOOTING.md](TROUBLESHOOTING.md) first.
