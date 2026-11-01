# Chaos drills — R1 go-live (S16-02)

PLAN §15 (chaos drills before R1 go-live, then quarterly) against the degradation matrix (PLAN §5.4).
Runner: `pnpm ops:drill <search|feed-origin|postgres-primary|redis-queue|ai-provider|pitr|all> --local | --staging`
(`scripts/ops/drill.ts`; drill catalog, targets, recorder, guarded injectors and the Postgres write ticker in
`scripts/ops/chaos.ts`, marker jobs in `scripts/ops/chaos-markers.ts`, staging drills in `scripts/ops/chaos-staging.ts`,
local drills in `tests/ops/chaos.int.test.ts`).

The local drills are their own vitest project, `ops-chaos`: not part of `test:int:root`, so CI never runs them per push
(they stop Meilisearch and restart / kill redis-queue of the shared test stack). Run them by hand before a release.

Targets: RPO ≤ 5 min and RTO ≤ 30 min in R1 (PLAN NFR table, §3 #36); Postgres failover runbook ≤ 15 min (`failover.md`).

## Local runs (Windows, Docker Desktop 6 CPU / 8 GB, shared with other suites)

Run A: 2026-10-31 22:33–22:37 UTC, quiet machine. Run B: 23:17–23:29 UTC, after the review fixes, with other lanes'
suites loading Docker (timings 2–4× slower; same verdicts).

| Drill | Matrix row expects | Observed | RTO (A / B) | RPO (A / B) | Result |
|---|---|---|---|---|---|
| Kill search | Postgres fallback for basic filters; cached pages keep serving | Meilisearch stopped ~8 s: every website search answered (0 errors), `degraded: true`, same results as the engine (price order); detail unaffected. The breaker probed and closed on its own 2.1 / 8.9 s after the engine started | 0.66 / 2.68 s to fallback | – (read path) | PASS |
| Kill feed-api origin | CDN serves stale up to 24 h | Every public site/taxonomy route sends `public, s-maxage=…, stale-while-revalidate=…, stale-if-error=86400`; the S7-06 Cloudflare-model test serves cached answers `STALE` at 1 h and 23 h with the origin down, `DOWN` at 25 h and for uncached URLs | – | – | PASS (model) |
| Kill Postgres primary | Promote standby (runbook); dashboard read-only for minutes | Throwaway primary (production image and settings) + hot standby on slot `db_2` under a write ticker; primary SIGKILLed; `pg_ctl promote -D "$PGDATA"`; first write on the standby. 74 / 78 acknowledged writes, 0 lost, gap-free prefix | 3.4 / 10.0 s (promotion only) | 0 / 0 s | PASS |
| Restart redis-queue (graceful) | AOF; outbox replays missed events | `docker restart` (5.2 / 15.1 s) with 300 marker jobs not yet run and 100 outbox events committed during the restart: all 400 ran, 0 duplicates, 0 dead-lettered | 22.2 / 35.3 s to all work done | 0 jobs lost | PASS |
| Crash redis-queue (`docker kill`) | AOF; outbox replays missed events | Run B only: 300 marker jobs enqueued > 1 s before the kill (past `appendfsync everysec`) and 100 events emitted across the crash; Redis ready again 5.8 s after the kill. All 400 ran, none lost before the replay step (so no replay was needed), 0 dead-lettered | 24.4 s | 0 jobs lost | PASS |
| AI provider 100 % errors | AI shows "try later"; core flows never wait on AI | Real gateway over a provider failing every call (529): listing create + publish, website search and detail made no provider call. AI search answered a keyword search 6 / 6 times; the gateway breaker opened after 3 provider calls (`CIRCUIT_OPEN`) | 0 (no outage) | – | PASS (request path) |
| PITR to a fresh server | WAL-G PITR, RPO ≤ 5 min | Same killed primary: the WAL-G store on MinIO restored onto a fresh container (`restoreDrill`): writable, verified, `archive_mode=off`. Base fetch 34 / 111 s, replay + promote 8.4 / 37 s | 51.7 / 160.7 s | 9.9 / 9.7 s (52 / 32 acked writes after the last archived segment) | PASS |

### What was disrupted locally (test stack, short, restored)

- `inmolink-meilisearch-test-1`: stopped 22:25:25–22:25:36, 22:34:14–22:34:24 and 23:19:32–23:19:49 UTC; healthy after each.
- `inmolink-redis-queue-test-1`: restarted 22:26:33–38, 22:28:07–14, 22:34:26–31 and 23:20:03–18 UTC; killed and
  started 23:20:46–23:20:51 UTC; healthy after each.
- Postgres: only throwaway `chaos-pg-primary-*` / `chaos-pg-standby-*` containers and the drill's `inmolink-restore-*`
  "fresh server", all removed afterwards with their volumes and WAL-G prefix. The shared `inmolink-postgres-test-1` was
  never touched.

### What the local numbers mean

- **Search**: the RTO is the time to the first fallback answer; website search never failed. At real traffic the breaker
  opens after 5 failures or half of ≥ 10 calls in 10 s; `SEARCH_BREAKER_OPEN_MS` (30 s in production, 1 s in the drill)
  bounds the recovery after the engine returns.
- **Postgres failover**: the number is promotion only. The real RTO adds detection, fencing db-1, the inventory swap,
  repointing `DATABASE_URL_*` and a redeploy (failover.md steps 1, 3, 4). The local standby is in the same Docker VM, so
  lag ≈ 0; RPO across datacenters is the staging measurement.
- **PITR**: RPO is bounded by `archive_timeout` (10 s in the drill, 60 s in production → RPO ≈ 1 min + push time, inside
  the 5 min target). RTO here restores a few-MB base backup from a local MinIO; production's scales with the base backup
  size and R2 bandwidth.
- **redis-queue crash**: with `appendfsync everysec` an enqueue acknowledged within the last second before a crash can
  be lost while its outbox row is already marked processed. The drill measures it (`jobsLostBeforeReplay`, 0 in run B)
  and recovers any loss with the queues.md step (`replayOutboxBatch` / `ops:replay-outbox` for the crash window).
  Jobs enqueued directly (not from an event) in that last second are not recoverable that way (queues.md step 3).

### Not covered

- **AI: queued AI jobs retrying with backoff** (worker side, "Jobs queue and retry") is not exercised by this drill;
  only the request path is (core flows untouched, AI search degrades, gateway fails fast). The AI row passes for the
  request path only.

## Staging — BLOCKED-HUMAN H4

Each drill is scripted (`--staging`) and reports through the same recorder. S17-F2: a drill never touches a production host — every name, address and hostname of `infra/ansible/inventories/production` and `infra/kamal/*.production.yml` (and any name under a production hostname's domain, outside `staging.`) is refused even when listed in `CHAOS_STAGING_HOSTS`; the postgres-primary drill therefore needs a staging primary + standby pair (the staging inventory has no standby yet). Every drill that stops, kills or restarts
something requires `--confirm`, and every host must be listed in `CHAOS_STAGING_HOSTS` (comma-separated `ssh://` URLs).
The drill site's secret key comes from `CHAOS_API_KEY`. Only staging can show:

| Drill | Command (example) | Only staging shows |
|---|---|---|
| search | `ops:drill search --staging --confirm --search-host ssh://… --origin-listings-url https://…/v2/listings?…` + the k6 `degraded` profile (S7-F9) | breaker behaviour across real feed-api processes, `SearchFallbackActive`, p95 of the fallback at 1,000 rps on 2M rows |
| feed-origin | `ops:drill feed-origin --staging --confirm --feed-api-host ssh://… --edge-url '<CDN URL with _k>' --outage-seconds 90` | Cloudflare itself answering `STALE`/`UPDATING` with every feed-api container stopped (cdn.md "Staging acceptance"); the WP plugin's local cache |
| postgres-primary | `ops:drill postgres-primary --staging --confirm --db-primary-host ssh://<staging primary> --db-standby-host ssh://<staging standby> --dashboard-health-url https://…/readyz --edge-url …` | a write ticker on db-1 up to the kill: acknowledged writes lost and WAL bytes not received across datacenters (the real RPO); the full RTO through runbook steps 3–4 (the clock runs until the dashboard API is ready on db-2); the CDN probed continuously from the kill to the first write |
| redis-queue | `CHAOS_REDIS_QUEUE_URL=<tunnel> ops:drill redis-queue --staging --confirm --redis-host ssh://… --db-primary-host ssh://… --worker-health-url https://…/readyz` | the Ansible `redis_queue` role (AOF everysec, noeviction) on the real host: 250 marker jobs (drill-only prefix `inl-chaos`, run by the drill process) queued before and after the restart all run; the real outbox backlog of the window drains, no dead letters |
| ai-provider | set an invalid AI key on staging feed-api + worker, then `ops:drill ai-provider --staging --confirm --origin-listings-url … --origin-ai-search-url …/v2/search/ai?q=…` | the real provider SDK's retries and timeouts against a failing endpoint; the AI alerts |
| pitr | `ops:drill pitr --staging --image <ref> --walg-env <file> --fresh-host ssh://fresh-1` (also weekly: `.github/workflows/restore-drill.yml`) | R2 over the internet, a production-sized base backup, a really fresh server: the R1 RTO number |

Record the staging results in this file and the S16-02 row of STATUS.

## Quarterly

Re-run `ops:drill all --local` and each staging drill quarterly (PLAN §15); compare against this table.
