# Load suite R1 (S16-01, PLAN §15)

Status: **scripted, unit-tested and run locally as slices; the acceptance runs wait on staging (H4)** with the
5,000-agency scale seed. How to run each scenario: [`docs/runbooks/load-suite.md`](../../runbooks/load-suite.md).

## Targets and where each is judged

| Scenario | PLAN §15 target | Thresholds as code | Acceptance profile |
|---|---|---|---|
| Website API mix | 1,000 rps origin sustained; 2,000 rps spike via edge; p95 per SLO (< 150 ms) | `tests/load/lib/website-mix.ts` | `staging` (+ `spike`, `degraded`) |
| Dashboard | 5,000 concurrent users; API p95 < 300 ms | `tests/load/lib/dashboard-mix.ts` | `staging` |
| Import storm | 500 feeds at once; no tenant's queue age > 15 min | `scripts/perf/lib/storm.ts` | `staging` |
| Matching storm | 10k listing changes in 5 min vs 1M profiles; processed < 10 min | `scripts/perf/lib/storm.ts` | `staging` |
| Realtime | 5,000 sockets; fan-out p95 < 500 ms | `tests/load/lib/realtime-mix.ts` | `staging` |
| Soak | 24 h at 50 %; no memory growth, no connection exhaustion | `tests/load/lib/soak.ts` + the k6 `soak` profiles | `soak` (all three) |

Acceptance profiles refuse overrides; every other run's summary says it is not the acceptance run.

## Local slices (2026-11-01, Windows + Docker Desktop 6 CPU / 8 GB, `test` stack, 40-agency scale seed)

Indicative only: apps under tsx, Docker Desktop's network hop, one worker process, a 40-agency seed.

| Scenario | Run | Result |
|---|---|---|
| Website API mix | `perf:smoke website-api`, 20 rps × 60 s, Postgres fallback | **PASS** — p50 21.5 / p95 58.5 / p99 122.4 ms; 1,202 requests, 0 errors, 0 dropped; 1.84 statements / request |
| Dashboard | `perf:smoke dashboard`, 20 members × 60 s | **PASS** — p50 19.4 / p95 57.4 / p99 83 ms; 168 requests, 0 errors; 4.52 statements / request; network search p95 97.6 ms (slowest endpoint) |
| Realtime | `perf:smoke realtime`, 50 sockets, 20 notifications / s × 60 s | **PASS** — connect p95 13 ms (100 % ok); fan-out p50 3 / p95 6 / p99 20 ms; 3,000 / 3,000 expected steady deliveries; 0 unexpected disconnects, 0 duplicates |
| Import storm | `perf:storm import --test`, 20 feeds over 19 tenants | **PASS** — 20 / 20 runs succeeded; queued by the scheduler in 0.8 s; drained in 17.0 s (44.6 listings / s); worst tenant queue age 16.2 s; worst trigger → start 16.9 s |
| Matching storm | `perf:storm matching --test`, 200 changes / 60 s over 38 agencies, 10,000 profiles | **PASS** — 200 / 200 matched, processed 1 min 02 s from the first change (2.1 s after the last); lag p50 2.3 / p95 3.0 / max 4.2 s |
| Soak | sampler 10 min + website 20 rps × 540 s | memory / connections **PASS** (no series grew; pools steady). Website latency over the 9 minutes **missed**: p95 160 ms (budget 150), p99 310 ms — see open item 2 |

## Open items

1. **The scale seed lacks the data three scenarios need** (S16-F4): no feed connections and no client profiles (the
   storms provision their own for the run), and no contacts, leads, tasks, notifications or calendar rows (the
   dashboard's CRM endpoints answer empty pages, so their p95 means little). The staging acceptance run needs the seed
   to cover PLAN §15's 10M contacts and 1M client profiles first.
2. **Website latency over a longer local run.** The same mix at the same rate held p95 58 ms over 60 s but 160 ms over
   540 s with the sampler polling `docker stats` every 10 s. A second 540 s run overlapped four build agents and is
   void (p95 2.1 s, Redis command timeouts). To re-run on an idle machine in the S16 review (soak-slice profile); if
   the latency still grows with run length, investigate (feed-api under tsx, pg pool, Redis limits) before staging.
3. **Staging prerequisites (H4):** a load-generator host; for the dashboard, `TRUST_PROXY` one hop deeper for the run
   window (members' office IPs in `X-Forwarded-For`) or a distributed generator; for the import storm, a public
   HTTPS endpoint for the fixture feeds (safeFetch: ports 80 / 443, no private ranges); the token service behind TLS
   (`--public-url https://…`) or an SSH tunnel.

## Staging acceptance runs (H4) — to fill in

| Scenario | Date | Profile | Result | Notes |
|---|---|---|---|---|
| Website API mix | | `staging` / `spike` / `degraded` | | |
| Dashboard | | `staging` | | |
| Import storm | | `staging` | | |
| Matching storm | | `staging` | | |
| Realtime | | `staging` | | |
| Soak | | `soak` | | |

Any miss: fix merged, then the scenario re-run and recorded here (S16-01 "Done when").
