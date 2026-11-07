# Load suite (S16-01, PLAN §15)

The six PLAN §15 load scenarios, their scripts, and how to run them locally (a slice, indicative) and on staging (the
acceptance run, H4, against the 5,000-agency scale seed). Results go in `docs/build/reviews/load-R1.md`.

| Scenario | Target (PLAN §15) | Script | Local | Staging profile |
|---|---|---|---|---|
| Website API mix | 1,000 rps origin sustained (15 min), 2,000 rps spike via edge; p95 < 150 ms | `tests/load/website-api.js` (k6) | `pnpm perf:smoke website-api` | `PROFILE=staging`, `spike`, `degraded` |
| Dashboard | 5,000 concurrent users; API p95 < 300 ms | `tests/load/dashboard.js` (k6) | `pnpm perf:smoke dashboard` | `PROFILE=staging` |
| Import storm | 500 feeds at once; no tenant's queue age > 15 min | `scripts/perf/storm.ts import` (Node) | `pnpm perf:storm import --test` | `--profile staging` |
| Matching storm | 10k listing changes in 5 min against 1M profiles; processed < 10 min | `scripts/perf/storm.ts matching` (Node) | `pnpm perf:storm matching --test` | `--profile staging` |
| Realtime | 5,000 sockets; fan-out p95 < 500 ms | `tests/load/realtime.js` (k6) + `scripts/perf/realtime-publisher.ts` | `pnpm perf:smoke realtime` | `PROFILE=staging` |
| Soak | 24 h at 50 % load; no memory growth, no connection exhaustion | k6 `PROFILE=soak` (website + dashboard + realtime) + `scripts/perf/soak-sampler.ts` | a 10-min slice | `PROFILE=soak` |

Every acceptance profile (`staging`, `degraded`, every `soak`) **refuses overrides**: its numbers are the
check. Any other run's summary says "NOT the acceptance profile". k6 is the pinned image **`grafana/k6:1.3.0`**
everywhere (it has `k6/experimental/websockets`, not `k6/websockets`). Thresholds are code (`tests/load/lib/*.ts`,
`scripts/perf/lib/storm.ts`, unit-tested); k6 exits 99 and the Node drivers exit 1 when one fails.

Locally the numbers are indicative only (Windows, Docker Desktop's network hop, apps under tsx, a 40-agency seed,
one worker process). The local suite needs the `test` stack (`pnpm infra:up:test`) and the scale seed that
`pnpm perf:smoke` writes (40 agencies; run `perf:smoke website-api` first, then the others with `--skip-seed`).

## Website API mix

Runbook: [website-api.md › Load test](website-api.md#load-test-s7-08). `PROFILE=soak` is 500 rps for 24 h at origin
with the same budgets (no overrides); `PROFILE=soak-slice` is a 10-minute local slice (overrides allowed).

## Dashboard

`tests/load/dashboard.js`: one VU per member (closed model, `ramping-vus`), think time 2–16 s (mean ~6.7 s, so 5,000
members send ~700 rps), the request mix of a working agent (`tests/load/lib/dashboard-mix.ts`: listings 34 %,
contacts 23 %, CRM 23 %, notifications 10 %, network search 9 %, saved searches 1 %; lists followed by cursor to
pages 2–5). Thresholds on the steady phase: p95 < 300 ms overall and per endpoint, failed < 0.1 %, checks > 99.9 %,
and a minimum request count (a slow API fails the run, not only a slow p95).

Tokens: `pnpm perf:load:tokens` mints access tokens (audiences `api` and `realtime`) for scale-seed **agents** through
`identity.issueAccessToken` (the service behind the web app's `/session/token`: membership, account status and session
version checked) and writes `tests/load/.data/dashboard-users.json` (git-ignored; secrets — delete after the run).
`--serve` keeps a small refresh service (`GET /tokens/<index>`, `Bearer <per-run secret>`, constant-time compare,
127.0.0.1 unless `--host`) so 15-minute tokens last a 24-hour run; k6 refreshes 2–3 min before expiry and after a 401
(refresh requests tagged `phase: auth`, never judged). Never in production (`assertLoadTarget`: the environment's names and, since S17-F2,
every `DATABASE_URL_*` host — never a production host of the deploy config; loopback for a local run; loopback or a
staging server of `infra/ansible/inventories/staging` for `--staging`).
The service binds 127.0.0.1; to serve a k6 on another host bind `--host 0.0.0.0` **behind a TLS proxy** and pass
`--public-url https://…` (a plain-http public URL is refused: it would carry the refresh secret and live tokens in
clear) — or keep 127.0.0.1 and use an SSH tunnel. Refresh mints run at most 16 at a time. `PROFILE=soak` takes no
overrides; a local slice is `PROFILE=soak-slice` (20 members, 10 min; `VUS` / `DURATION` / `RAMP` allowed).

**Local:** `pnpm perf:smoke dashboard [--users 20] [--duration 60] [--skip-seed]` — starts apps/api on the test stack,
prints p50 / p95 / p99 per endpoint and **statements per request** (`app_user` + `app_auth`; over 10 fails).

**Staging (H4):**
1. On a host the load generator reaches: `NODE_ENV=production DEPLOY_ENV=staging pnpm perf:load:tokens --staging
   --users 5000 --serve --host 0.0.0.0 --public-url http://<host>:4790`. Keep it running for the whole run.
2. `k6 run -e BASE_URL=https://<api origin> -e PROFILE=staging -e USERS_FILE=… -e SUMMARY_FILE=dash.json
   tests/load/dashboard.js` (the 24 h soak: `PROFILE=soak`).
3. Each member's requests carry `X-Forwarded-For` set to its agency's office address (`10.x.y.z`): for the run window
   the API must trust exactly one hop more than the real proxy chain (`TRUST_PROXY`), or the generator runs
   distributed with one source IP per office; otherwise every request counts against one IP's limits (600 / min per
   route group) and the run fails on 429s. Put it back afterwards.
4. Stop the token service (Ctrl+C); delete the users file.

CRM pages (S16-F4): the scale seed fills every agent's contacts, contact timelines, activity feed, board and inbox,
open tasks, calendar (the weeks around the seed day) and notifications, and their saved searches
([scale-seed.md](scale-seed.md)). k6 counts, per CRM endpoint, the pages that answered 200 and those with at least one
item (`list_pages` / `list_pages_with_items`, `dashboard-mix.ts › ITEM_ENDPOINTS`); the summary prints both, and
`perf:smoke dashboard` **fails when a CRM endpoint answered only empty pages** (`emptyItemEndpoints`) — a check of what
was sent, not a rate, so an endpoint the 60-second run did not reach is not judged. The calendar's events lie from
4 weeks before to 12 weeks after the seed day; `perf:load:tokens` writes the span the members' agencies share into the
users file (`calendarWindow`; k6 `CALENDAR_FROM` / `CALENDAR_TO` override it) and the calendar action asks for this
week while it lies inside, else the nearest full week inside it — an old seed still answers full weeks.

## Import and matching storms

Not k6: neither has an HTTP surface whose latency is the target (k6 can neither serve the feeds the workers fetch nor
read queue ages or match states). `scripts/perf/storm.ts` drives the real stack from Node and reports in the k6 runs'
style.

- **import:** N synthetic Kyero v3 feeds served by a fixture HTTP server in the driver, one connection per feed on
  scale-seed agencies (some agencies hold 8 or 2 feeds). S16-F4: every feed runs on a **seeded** connection (off:
  `scripts/seed/imports.ts`; the seed gives the acceptance storm's 7 eight-feed and 25 two-feed tenants that many) —
  the storm gives each tenant an agency with enough of them, points them at its feeds, turns them on and, at the end,
  off again with their seeded URL back (journalled in `tests/load/.data/storm-feeds-<run>.json` first). A connection is
  provisioned for the run only for what the seed lacks (with a warning). All made due in one UPDATE and picked up by the real scheduler
  (`imports.scheduleFeeds` → dispatcher → `imports.runFeed` with its fair-share caps). A tenant's queue age is the
  longest any of its runs waited between `created_at` (as ImportQueueWaitHigh counts it) and `started_at`. PASS: worst
  tenant ≤ 15 min, every run SUCCEEDED, no timeout. Scheduler lag counts too: the worst run's trigger → start must also be ≤ 15 min.
  Each connection is judged by its first run since the trigger (a seeded connection keeps earlier storms' runs; later
  runs are reported, not judged). The storm connections are deleted afterwards (the `STORM-*` listings stay; a re-run
  updates them).
- **matching:** 1 % price drops through `properties.updateListing`, paced over the window, so outbox → read-model
  rebuild → `search.listings.changed` → `matching.matchListings` runs as in production, against at least `profiles`
  active saved searches — S16-F4: the scale seed's client profiles (200 DAILY per agency: 1M at 5,000 agencies, 8,000
  for the 40-agency local seed, the smoke profile's number); only a shortfall is provisioned (DAILY, with a warning,
  deleted after the run). A change is processed
  when `matching_listing_states.version` reaches it. PASS: last change matched ≤ 10 min after the first.
  The original prices are journalled in `tests/load/.data/storm-prices-<run>.json` and restored at the end;
  seeded and provisioned profiles are DAILY, so no instant alerts fire (searches already in the database are untouched — on
  staging check outbound email is sandboxed).

**Local:** `pnpm perf:storm import --test` and `pnpm perf:storm matching --test` start the real worker
(`apps/worker/src/main.ts`) for the pools they need, with the e2e loopback allowance for the fixture feed origin only.

**Staging (H4):** 5,000-agency seed, `VACUUM (ANALYZE)` first; deployed workers do the work.
`NODE_ENV=production DEPLOY_ENV=staging pnpm perf:storm import --staging --listen 0.0.0.0:8080 --feed-base-url
https://<public host>` (safeFetch allows ports 80 / 443 only and no private ranges: put a TLS proxy or tunnel in front
of 8080), then `pnpm perf:storm matching --staging`. `pnpm perf:storm cleanup [--staging]` removes what an interrupted
run left (and puts seeded connections it left on back: their seeded URL from the run's journal, then off). `cleanup` also restores price journals left by an interrupted matching storm;
`cleanup --listings` soft-deletes the imported `STORM-*` listings (purged after the 30-day restore window).

## Client-profile matching storm (R2-02f)

The R2-02 acceptance (10k listing changes vs 1M client profiles in < 10 min) measures the match engine itself, not the
outbox path above: `scripts/perf/matching-storm.ts` seeds a synthetic Costa del Sol market in set-based SQL and calls
`matching.matchListingsToProfiles` — the `matching.matchListingsToProfiles` job's entry point — once per
`search.listings.changed` event (the owner's changed listings, ≤ 100 an event). Synthetic ids start with `57024f`.

```
pnpm perf:matching-storm seed [--test|--staging] [--agencies 5000] [--profiles 1000000] [--facts 200000] [--changes 10000] [--past-matches 500000]
pnpm perf:matching-storm plans [--test|--staging]                          # EXPLAIN (ANALYZE, BUFFERS) of the hot statements
pnpm perf:matching-storm run [--test|--staging] [--changes 10000] [--concurrency 4] [--out storm.json]
pnpm perf:matching-storm reset [--test|--staging]                          # drops the run's matches: run again
pnpm perf:matching-storm cleanup [--test|--staging]                        # removes everything the seed wrote
```

- The seed needs `DATABASE_URL_ADMIN` for its closing `VACUUM (ANALYZE)` (the app roles hold no MAINTAIN); without it,
  vacuum the matching tables by hand before measuring.
- Run `plans` twice: the first run reads from disk. The `run` report gives wall time, per-event p50 / p95 / max, ms per
  listing, matches written and the INSTANT deliveries that would be queued (counted, never enqueued: nothing is sent).
  `run` prints PASS / FAIL against the 10-minute budget (extrapolated linearly when fewer than 10k changes run) and
  exits 1 on FAIL. `reset` drops the run's matches but leaves the facts and read models it refreshed (version 2, new
  `updated_at`), so a second run on the same seed is close to, not identical with, the first; reseed for a clean number.
- **Staging (H3):** the seed is ≈ 2.5 GB (1M profiles, 200k facts, 500k past matches) and takes ≈ 6 min; run it off
  hours, with `NODE_ENV=production DEPLOY_ENV=staging` and the staging database URLs, `--concurrency` = the matching
  pool's slots one worker runs (10), then `cleanup --staging`. The vector part (semantic score) needs real embeddings
  for profiles and listings — until H3 the engine scores without vectors (neutral 0.5), as the local run does.

## Realtime

`tests/load/realtime.js` speaks Socket.io v4 / Engine.IO v4 over a plain WebSocket (`tests/load/lib/realtime-mix.ts`):
one socket per VU on the notifications namespace, opened evenly over the ramp with the dashboard `ORIGIN` header. The
publisher (`pnpm perf:realtime:publish`) sends per-user notifications through `publishUserEvents` on redis-cache — the
workers' path — as valid `NotificationPush` payloads carrying `sentAt`; k6 records receive time − `sentAt`. Both read
one shared start (`START_AT` / `--start-at`) so they agree on the steady phase. k6 and the publisher **run on the same
host** (one clock); k6 counts negative latencies so skew shows. Sockets swap to a fresh token before expiry (new socket
first) from the dashboard token service. Thresholds: steady fan-out p95 < 500 ms, connect success > 99.9 %, no
unexpected disconnects, ≥ 99.9 % of the expected deliveries. k6 derives the deliveries the publisher owes (event rate × steady seconds
× sockets ÷ connected members) and prints "received N of M expected". `START_AT` (k6) and `--start-at` (publisher)
are **required** for `staging` and `soak` — the same ms epoch for both.

**Local:** `pnpm perf:smoke realtime [--sockets 50] [--rate 20] [--duration 60]`.

**Staging (H4):** tokens with the refresh service on (`pnpm perf:load:tokens --staging --users 1250 --serve`: ≤ 4
sockets per member, the server allows 10 per member per node); `START=$(($(date +%s%3N)+30000))`; publisher:
`DEPLOY_ENV=staging pnpm perf:realtime:publish --staging --profile staging --start-at $START --summary pub.json`; k6:
`k6 run -e BASE_URL=https://<realtime> -e ORIGIN=https://<dashboard> -e PROFILE=staging -e START_AT=$START -e
USERS_FILE=… -e SUMMARY_FILE=rt.json tests/load/realtime.js`. PASS: every k6 threshold (delivery included); `pub.json`'s
`failed` publishes explain any shortfall.

## Soak

Run the three k6 soak profiles together for 24 h (website `PROFILE=soak` 500 rps, dashboard `PROFILE=soak` 2,500
members, realtime `PROFILE=soak` 2,500 sockets) and, started **at the same time** on **each** app / worker host, the
sampler, sized to the k6 runs (5 min ramp + 24 h steady = 86,700 s) so it stops when the load does:

```
NODE_ENV=production DEPLOY_ENV=staging pnpm perf:soak:sample --staging --interval 60 --seconds 86700 \
  --containers '^(api|feed-api|realtime|public|web|worker)-' --out soak-<host>.jsonl
```

Samples after the load's end are never judged (an idle tail would make the last hour look flat): the end is
`--seconds`, or `--load-until <ISO time>` when re-judging a file with `--report`. **Do not redeploy during the soak**:
a new container name is a series that appears mid-run and fails the verdict, as does a series that vanishes or a
probe gap over three intervals (a per-role Postgres series counts 0 when the role has no session).

It appends one sample a minute: `mem:<container>` (docker stats; `--pid name=pid` for a local process),
`pg:<role>` client connections and `pg:total` (pg_stat_activity, read-only; max_connections as the limit),
`redis:<queue|cache|limits>:clients` / `:mem` (INFO; maxclients as the limit; a Redis whose ACL refuses INFO is logged
and skipped). On exit — `--seconds` reached or Ctrl+C — and with `pnpm perf:soak:sample --report <file>` it prints the
verdict (`tests/load/lib/soak.ts`; 23 h or more judged is the acceptance soak): after a 30-minute warm-up, memory may grow ≤ 10 % from the first hour to the last
and, on runs ≥ 6 h, its fitted trend may not add > 10 % per 24 h; connections stay under 80 % of their limit and the
last hour's median within 20 % (≥ 5) of the first. The k6 summaries must pass their own thresholds over the whole
24 h too.

**Local slice:** start the sampler (`--test --interval 10 --seconds 600 --containers 'inmolink-.*-test'
--warmup-minutes 1`), then `pnpm perf:smoke website-api --skip-seed --rate 20 --duration 540` (keep other work off
the machine: Docker Desktop shares its CPUs).
