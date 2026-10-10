# Troubleshooting

Known problems and their fixes. **Every incident gets an entry here** (PLAN §18): symptom, cause, fix and the task or commit that found it. Production incidents also link the runbook used.

## Local stack

### Containers stay in "Created", or `pnpm infra:up` hangs
- **Cause:** Docker Desktop's engine is wedged, often after sleep or a crash during a heavy build.
- **Fix:** `docker desktop restart` (or quit and start Docker Desktop), then `pnpm infra:up` again.

### `pnpm verify` fails at random with OOM kills, connection resets or timeouts
- **Cause:** Docker has less than 8 GB of memory. `verify` runs the test stack and several integration suites in parallel.
- **Fix:** Docker Desktop → Settings → Resources → Memory ≥ 8 GB. On WSL2, set `memory=8GB` (or more) in `%UserProfile%\.wslconfig` and run `wsl --shutdown`.

### Docker Desktop crashes while building app images locally
- **Cause:** the per-app image build (`turbo prune` + install) is heavy, and Docker Desktop on Windows has crashed twice on it (S0-14).
- **Fix:** let CI build images. Locally, only build the Postgres image when you need it.

### Ports already in use
- **Cause:** another project is using 3000–3002, 5432 or 6379.
- **Fix:** the web apps use 3100 and 3101 for this reason. For infra ports, stop the other service. Ports are listed in [README.md](README.md#prerequisites).

### `pnpm db:migrate` or the apps fail on boot with missing or invalid env variables
- **Cause:** a `.env` copied before a later task added variables, for example the S0-09 auth keys or `DATABASE_URL_APP_AUTH`.
- **Fix:** compare it with `.env.example` and copy any missing keys (the example values are local-only), then `pnpm db:migrate && pnpm db:rls`. Boot errors name each missing variable.

### Variables exported in your shell are ignored by `pnpm dev`
- **Cause:** Turborepo runs tasks in strict env mode and passes only declared variables. The apps then fall back to the root `.env` (S0-16 setup dry run).
- **Fix:** put local settings in `.env`, not in shell exports. Scripts run directly with `pnpm <script>` (outside Turbo), such as `db:migrate`, do see shell variables.

### A role's statement timeout change has no effect
- **Cause:** PgBouncer server connections keep the old role settings until they recycle.
- **Fix:** connect to the PgBouncer admin console and run `RECONNECT`, or restart the `pgbouncer` container.

### Queries through `app_user` return no rows (or permission denied) after a schema change
- **Cause:** the new table is not in the tenant registry, or `pnpm db:rls` was not run. App roles get grants only from `db:rls` (ADR 0011).
- **Fix:** register the table in `packages/db/src/tenancy/registry.ts`, then `pnpm db:rls`. The guard lists unregistered tables.

## Tests and tooling

### Integration tests crash with `0xC0000409` on Windows
- **Cause:** Vitest fork workers abort under parallel load on Windows (S0-08, S0-14).
- **Fix:** the affected Vitest projects in `vitest.config.ts` already use `pool: 'threads'`. Do the same for a new project that shows it. Linux CI is unaffected.

### A random Turbo task fails with `Unexpected end of JSON input` reading `.pnpm-workspace-state-v1.json`
- **Cause:** parallel `pnpm` processes race on the workspace state file (Windows).
- **Fix:** run it again. It does not happen on CI.

### Playwright e2e pages reload in a loop or a server action takes over 15 s
- **Cause:** a `next dev` issue under Playwright (S0-11, still open). Repeated navigations and `ECONNRESET` aborts show in the trace.
- **Fix:** re-run, or run e2e against `next build` + `next start`. E2E stays out of CI until it runs on build output.

### `require('pg-pool')` resolves to an ESM build and crashes under Vitest
- **Cause:** Vitest SSR conditions included `import`, which it forwarded to Node (S0-04).
- **Fix:** already fixed in the preset (`['@inmolink/source', 'node']`). Do not add `import` back.

### `pnpm` reports a version switch failure on Windows
- **Cause:** pnpm 10's automatic switch to the `packageManager` version fails when the user profile path contains a space (ADR 0001).
- **Fix:** install the pinned version globally (`npm i -g pnpm@10.33.2`) or enable Corepack.

### Boundary check fails on an import you think is fine
- **Cause:** a module imported another module's internals (not its `index.ts`), a repo touched another module's schema, or an app imported `core` internals.
- **Fix:** import through the other module's `index.ts`, or react to its outbox event (ADR 0010). `pnpm check:boundaries` prints the rule name.

## Operations

| Situation | Runbook |
|---|---|
| Deploy, rollback | [docs/runbooks/deploy.md](docs/runbooks/deploy.md) |
| Primary database down | [docs/runbooks/failover.md](docs/runbooks/failover.md) |
| Restore to a point in time | [docs/runbooks/pitr-restore.md](docs/runbooks/pitr-restore.md) |
| Jobs stuck, dead letters, outbox replay | [docs/runbooks/queues.md](docs/runbooks/queues.md) |
| CI or branch protection | [docs/runbooks/ci.md](docs/runbooks/ci.md) |

## Incident log

<!-- Newest first. Date · symptom · cause · fix · follow-up task -->
- none yet
