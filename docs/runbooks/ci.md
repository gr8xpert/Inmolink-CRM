# CI pipeline (S0-14)

`.github/workflows/ci.yml` runs on every pull request to `main`, on every push to `main` and on demand
(`workflow_dispatch`). Each job runs on its own `ubuntu-24.04` runner, so the database-heavy suites
never share a Postgres with each other.

| Job | What it runs | Needs Docker |
|---|---|---|
| `static` | `turbo run typecheck typecheck:root lint lint:root test test:root build` + `pnpm i18n:check` | no |
| `boundaries` | `pnpm check:boundaries` + `pnpm test:boundaries` | no |
| `isolation` | `pnpm test:isolation` (tenant isolation suite + RLS guard) | Postgres, PgBouncer |
| `integration` | package `test:int` (one at a time), `pnpm test:int:root`, `pnpm test:perf:root` | full `test` profile |
| `migrations` | `pnpm db:generate` must not change `packages/db/migrations`; `pnpm ci:migrations --test` | Postgres |
| `required` | fails unless every job above succeeded | — |
| `images` | main only, after `required`: one image per app → `ghcr.io/<owner>/inmolink-<app>:{sha-<sha>,main}` | buildx |

- **Pull requests** run Turbo tasks for affected packages only (`--affected`, diffed against the PR's
  base commit). The root suites (isolation, boundaries, workspace integration, migrations) always run.
- **Caches:** pnpm store (`actions/setup-node`), Turbo local cache (`.turbo/cache`, one scope per job),
  Docker layers (`type=gha`, one scope per app).
- **Services** are the repo's own `docker compose --profile test` stack, not `services:` blocks: CI
  then runs the same images, ports and init scripts as local `pnpm verify` (custom Postgres image with
  PostGIS/pgvector/pg_partman, PgBouncer config).
- **E2E** (`pnpm test:e2e`) is not in CI yet: the `next dev`-based stack reloads pages intermittently
  (STATUS › Decisions). Add it once e2e runs against `next build` output.

## Migration check

`pnpm ci:migrations [--from=<ref>] [--test]` (`scripts/ci/`) creates throwaway databases on the
stack's Postgres (with the extensions from `infra/docker/postgres/initdb`), then:

0. **Journal:** the previous release's journal must be an unchanged prefix of the current one (same
   tags, timestamps and SQL), and timestamps must increase. Drizzle skips a migration older than the
   last applied one and never re-reads applied files, so a reordered or edited migration would
   otherwise pass both scenarios below and be silently skipped in production.
1. **Empty database:** applies every migration, runs the RLS guard, re-applies (must be a no-op).
2. **Upgrade:** applies the migrations of the previous release (`--from`, default: newest `v*` tag,
   else the fork point from `origin/main`, else `HEAD~1`), then the current ones, then the guard —
   the order a deploy runs them in.

Any SQL error, journal or guard problem exits 1. The databases (named per process) are dropped
afterwards. `--test` always uses the test stack's env; the check refuses a non-local admin host
unless `CI=true`, because it bootstraps the cluster's shared roles. PLAN §18's
"production-shaped snapshot" check replaces the upgrade scenario's schema with a restored snapshot
once S0-15 backups exist.

## Branch protection (one-time, repo admin)

Required so that a failing isolation or boundary check blocks merge. GitHub → Settings → Branches →
`main` (or a ruleset targeting `main`):

- Require a pull request before merging.
- Require status checks to pass: **`required`** (it fails if `isolation`, `boundaries` or any other
  job fails or is skipped). Require branches to be up to date.
- Do not allow bypassing the above settings.

With the GitHub CLI:

```sh
gh api -X PUT repos/gr8xpert/Inmolink-CRM/branches/main/protection \
  -H "Accept: application/vnd.github+json" --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["required"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null
}
EOF
```

While solo, `enforce_admins: true` means direct pushes to `main` are refused too: work on a branch
and merge through a PR.

## When CI fails

- **`migrations` → "schema changed without a migration":** run `pnpm db:generate`, review, commit.
- **`isolation` / `boundaries`:** the failure names the table or the import rule; fix the code, never
  the rule (CLAUDE.md › Never).
- **`integration`:** the "Stack logs on failure" step prints the last 200 lines per container.
- A flaky test is a bug: fix it, do not re-run until green (`.claude/rules/testing.md`).
