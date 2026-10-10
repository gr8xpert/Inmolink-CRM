# Seeds: dev and scale

Code: `scripts/seed/` (S0-13). Run `pnpm db:migrate && pnpm db:rls` first. Add `--test` to target the docker `test` stack.

## Dev seed: `pnpm db:seed`

5 demo agencies × 5 users (admin, agent1–3, assistant), plus listings, contacts and leads once those modules ship. Logins are printed at the end, e.g. `admin@costa-homes.demo.inmolink.test`. The password is `Inmolink-demo-2026`; set `SEED_DEMO_PASSWORD` to change it. Re-running it writes nothing. To reset a demo user, delete it and seed again. The seed refuses to run with `NODE_ENV=production`.

## Scale seed: `pnpm db:seed:scale --agencies=N [--seed=1] [--chunk=100] [--staging]`

- **Ratios:** PLAN §4.1, per agency (`scripts/seed/profile.ts`). That is 5 users, 150 own listings, 30 new-build units, 30 media per listing, 2,000 contacts, 200 client profiles and 1 feed connection.
- **Deterministic:** IDs are UUIDv7-shaped and derived from `(seed, namespace, index)`. Each agency gets its own PRNG, so `--chunk` does not change the output. Synthetic emails embed the seed (`a<agency>-u<n>@s<seed>.scale.inmolink.test`), so two seeds can live side by side.
- **Idempotent and resumable:** each chunk of agencies is one `withSystemClient` transaction. The chunk skips IDs that already exist and COPYs the rest. After an interrupted run, start the same command again.
- **Passwords:** all synthetic users share one Argon2 hash of `SEED_SCALE_PASSWORD`. Locally it defaults to the demo password; staging requires a real one.

### Profile at 5,000 agencies (staging)

| Entity | Rows | Seeded from |
|---|---|---|
| agencies | 5,000 | S1-01 |
| users | 25,000 | S0-13 ✅ |
| listings (own + new-build) | 900,000 | S3 (listings) |
| media rows (metadata only) | 27,000,000 | S5 (media) |
| contacts | 10,000,000 | CRM contacts task |
| client profiles | 1,000,000 | matching task |
| feed connections | 5,000 | S6 (imports) |

PLAN §15 asks for 2M listings and 60M media in the full design-target dataset. To get there, run `--agencies=11112`, which gives about 2M listings and 60M media.

### Timings

| Run | Where | Time | Notes |
|---|---|---|---|
| `--agencies=1000` | local (Windows, Docker PG 18) | 3.3 s; re-run 0.7 s | only `users` exists yet (5,000 rows). The `[S0-13]` perf test enforces < 15 min. |
| `--agencies=5000` | staging | — | Record the time here on the first staging run (S0-15 / load-test task). |

As each module adds a seeder, re-run `--agencies=1000` and update this table. Each chunk is one transaction under `app_system`'s 60 s statement timeout, and its rows are built in memory. For high-ratio entities (media at about 5,400 rows per agency), use a smaller `--chunk` or a per-seeder chunk size, not a larger one. When a run gets close to the 15-minute budget, generate rows in SQL instead of streaming them from Node (`insert … select … from generate_series(…)`).

### Staging procedure

1. Check that `DATABASE_URL_APP_SYSTEM` points at **staging**. The seed writes active, verified fake users.
2. `NODE_ENV=production DEPLOY_ENV=staging SEED_SCALE_PASSWORD=<from the secret store> pnpm db:seed:scale --agencies=5000 --seed=1 --staging`. With `NODE_ENV=production`, the seed refuses to run unless all three hold: `--staging`, `DEPLOY_ENV=staging` and a non-default password. The dev seed never runs there.
3. `VACUUM (ANALYZE)` the seeded tables before taking `EXPLAIN` or k6 numbers.
4. Disk: allow roughly 25 GB for 27M media rows plus indexes, and check free space first.
