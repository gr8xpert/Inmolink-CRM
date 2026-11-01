# Seeds: dev and scale

Code: `scripts/seed/` (S0-13). Run `pnpm db:migrate && pnpm db:rls` first. Add `--test` to target the docker `test` stack.

## Dev seed: `pnpm db:seed`

5 demo agencies × 5 users (admin, agent1–3, assistant), plus listings, contacts and leads once those modules ship. Logins are printed at the end, e.g. `admin@costa-homes.demo.inmolink.test`. The password is `Inmolink-demo-2026`; set `SEED_DEMO_PASSWORD` to change it. Re-running it writes nothing. To reset a demo user, delete it and seed again. The seed refuses to run with `NODE_ENV=production`.

## Scale seed: `pnpm db:seed:scale --agencies=N [--seed=1] [--chunk=100] [--feed-base-url=https://…] [--staging]`

- **Ratios:** PLAN §4.1, per agency (`scripts/seed/profile.ts`). That is 5 users, 150 own listings, 30 new-build units, 30 media per listing, 2,000 contacts, 200 client profiles and 1 feed connection. S16-F4 adds the CRM ratios §4.1 does not fix (this seed's assumption, STATUS Decisions): 400 leads (one contact in five), 2,800 activities (one per contact, two more per lead), 150 tasks, 240 calendar events and 250 notifications.
- **What the load suite reads (S16-F4):**
  - *Feed connections* (`imports.feed_connections`): a Kyero connection per agency at `<--feed-base-url>/s<seed>/a<agency>[-<i>].xml` — default `https://load-feeds.invalid` (reserved, never resolves) — and for the acceptance import storm's multi-feed tenants more: the first 7 VERIFIED agencies 8, the next 25 VERIFIED ones 2 (`feedConnectionsOf`), so the storm provisions none. **5,074 connections over the 5,000 agencies.** **Off** (`enabled = false`, no `next_run_at`): the scheduler never fetches them. The import storm turns the ones it needs on for its run and off again with their seeded URL ([load-suite.md](load-suite.md)).
  - *Client profiles* (`matching.saved_searches`): 40 saved searches per member, **DAILY** (alerts go to the digest, never an instant notification), 30 % own stock / 50 % network / 20 % both, places from the seeded tree, keys from `matching.searchKeys`.
  - *CRM* (`crm.contacts`): contacts with their e-mails (`c<i>@a<agency>.s<seed>.contacts.inmolink.test`), phones and list facets; the default pipeline (unless the agency has stages); leads in it (status = stage, first stay in `lead_stage_history`); activities; tasks (`remind` off); calendar events with attendees (no reminders). Report rollups are not written (the worker rebuilds them on the first lead event).
  - *Notifications* (`notifications.notifications`): lead assignments (linking a lead of that member) and task reminders, in-app only, 40 % unread. Every seeded member also gets an **e-mail-off preference for every notification type** (in-app on; a member's own choice is kept): the DAILY profiles' digests and a load run's lead and task notices never e-mail a synthetic address — on staging they would reach the e-mail provider.
  - *Time-relative rows* sit around the seed day (start of today, UTC): contacts' activities in the 60 days before it, a lead's between its arrival (≤ 100 days back) and the seed day, lead answers before it, notifications in the 30 days before it (inside the monthly partitions pg_partman keeps — a database whose partitions start later refuses them), calendar events from 4 weeks before to 12 after it (the dashboard load test asks for a week inside that span: `perf:load:tokens` records it in the users file, so an older seed still answers full weeks), task due dates around it. Everything else is dated from 2026-01-01.
- **Deterministic:** IDs are UUIDv7-shaped and derived from `(seed, namespace, index)`. Each agency gets its own PRNG, so `--chunk` does not change the output. Synthetic emails embed the seed (`a<agency>-u<n>@s<seed>.scale.inmolink.test`), so two seeds can live side by side.
- **Idempotent and resumable:** each chunk of agencies is one `withSystemClient` transaction. The chunk skips IDs that already exist and COPYs the rest. After an interrupted run, start the same command again. The CRM seeder skips whole agencies instead (an agency's CRM is one transaction: its first or last contact or its last lead present means all of it is), 4 agencies (~45k rows) per transaction.
- **Passwords:** all synthetic users share one Argon2 hash of `SEED_SCALE_PASSWORD`. Locally it defaults to the demo password; staging requires a real one.

### Profile at 5,000 agencies (staging)

| Entity | Rows | Seeded from |
|---|---|---|
| agencies | 5,000 | S1-01 |
| users | 25,000 | S0-13 ✅ |
| listings (own + new-build) | 900,000 | S3 (listings) |
| media rows (metadata only) | 27,000,000 | S5 (media) |
| contacts (+ ~9M e-mails, ~7M phones, ~10.8M facets) | 10,000,000 | S16-F4 `crm.contacts` |
| leads (+ 2M stage-history rows) | 2,000,000 | S16-F4 `crm.contacts` |
| activities | 14,000,000 | S16-F4 `crm.contacts` |
| tasks | 750,000 | S16-F4 `crm.contacts` |
| calendar events (+ ~2.6M attendees) | 1,200,000 | S16-F4 `crm.contacts` |
| notifications | 1,250,000 | S16-F4 `notifications.notifications` |
| client profiles (saved searches) | 1,000,000 | S16-F4 `matching.saved_searches` |
| feed connections (5,000 agencies; 7 with 8, 25 with 2) | 5,074 | S16-F4 `imports.feed_connections` |

PLAN §15 asks for 2M listings and 60M media in the full design-target dataset. To get there, run `--agencies=11112`, which gives about 2M listings and 60M media.

### Timings

| Run | Where | Time | Notes |
|---|---|---|---|
| `--agencies=1000` | local (Windows, Docker PG 18) | 3.3 s; re-run 0.7 s | only `users` exists yet (5,000 rows). The `[S0-13]` perf test enforces < 15 min. |
| `--agencies=5000` | local (Windows, Docker PG 18) | 4.7–5.2 s: users 1.3–1.9 s, agencies 3.2–3.4 s | S1-F6: about 5k-row chunks, four in flight, buffered COPY. Before: users 6.1 s, agencies 15.0 s (S0 review: users 15.2 s). The `[S1-F6]` perf test keeps users < 3.04 s. |
| `--agencies=74` on a 54-agency seed (20 new) | local (Windows, Docker PG, `test` stack with other suites running) | S16-F4 seeders 34.6 s: feed connections 0.1 s, client profiles 1.9 s, CRM 29.9 s, notifications 2.7 s | about 11.6k rows per agency. Re-run of seeded agencies: CRM < 1 s per 50 agencies (one lookup per chunk). |
| `--agencies=5000` | local, **estimate** (linear from 20 agencies on a shared Docker Postgres) | ≈ 2.4 h for the S16-F4 seeders, plus the earlier ones | formula below; measure on staging (H4) |
| `--agencies=5000` | staging | — | Record the time here on the first staging run (S0-15 / load-test task). |

**S16-F4 seeders, time for N new agencies:** `t(N) ≈ N × (t_crm + t_profiles + t_notifications + t_feeds)` — linear (fixed ratios, 4 chunks in flight). Measured locally: t_crm ≈ 1.50 s, t_profiles ≈ 0.095 s, t_notifications ≈ 0.135 s, t_feeds ≈ 0.005 s per agency → **≈ 1.73 s per agency → 5,000 agencies ≈ 8,700 s ≈ 2.4 h locally (an estimate, linear from 20 agencies on a shared Docker Postgres; measure on staging, H4)** (with other test suites on the same Docker Postgres: 128 MB shared buffers, 1 GB max WAL; per-row cost is FK checks, ~50 index entries and the leads triggers, not the client). Staging hardware should be several times faster; record it above. The CRM is ~87 % of it (per agency, lane time: activities 34 %, leads 19 %, contacts with e-mails, phones and facets 35 %). **Budget note:** at `--agencies=1000` these seeders would add ≈ 29 min locally, so the `[S0-13]` perf test (`tests/perf/seed-scale.int.test.ts`, < 15 min) runs without them (`LOAD_SUITE_SEEDERS`); see STATUS.

As each module adds a seeder, re-run `--agencies=1000` and update this table. Each chunk is one transaction under `app_system`'s 60 s statement timeout, and its rows are built in memory. Low-ratio seeders write about 5k rows per chunk whatever `--chunk` says, and four chunks run at once (`forEachChunk`), so a run holds up to four app_system connections. For high-ratio entities (media at about 5,400 rows per agency), use a smaller `--chunk` or a per-seeder chunk size, not a larger one. When a run gets close to the 15-minute budget, generate rows in SQL instead of streaming them from Node (`insert … select … from generate_series(…)`).

### Staging procedure

1. Check that `DATABASE_URL_APP_SYSTEM` points at **staging**. The seed writes active, verified fake users.
2. `NODE_ENV=production DEPLOY_ENV=staging SEED_SCALE_PASSWORD=<from the secret store> pnpm db:seed:scale --agencies=5000 --seed=1 --staging`. With `NODE_ENV=production`, the seed refuses to run unless all three hold: `--staging`, `DEPLOY_ENV=staging` and a non-default password. The dev seed never runs there.
3. `VACUUM (ANALYZE)` the seeded tables before taking `EXPLAIN` or k6 numbers.
4. Disk: allow roughly 25 GB for 27M media rows plus indexes, and about as much again for the S16-F4 rows (~58M CRM, profile and notification rows with their indexes); check free space first.
