# Website API — quotas and anti-scraping (S7-04, S7-F7)

Limits live in `packages/core/src/modules/website-api/config.ts` (`DEFAULT_WEBSITE_LIMITS`) on top of the per-minute
key tiers in identity `API_KEYS` (S1-05). All of a request's rules go to the limits Redis (redis-queue, `inl:rl:*`,
identities HMAC'd) in one script call, its keys in the agency's Cluster hash slot (`inl:rl:{<agency hash>}:…`). A Redis
outage lets requests through (fail open, one sampled warning per 10 s naming the rules); it never takes websites
offline.

| Rule | Who | Limit (STANDARD / HIGH) | Over it |
|---|---|---|---|
| `feed.key.<tier>`, `feed.agency` | key, agency | 600 / 3,000 per min; 3,000 per agency | 429 `RATE_LIMITED` |
| `feed.burst.<tier>` | key | 100 / 500 per 5 s | secret: 429 · publishable: alert only |
| `feed.quota.<tier>` | key | 100,000 / 1,000,000 per UTC day | secret: 429 `QUOTA_EXCEEDED` (`resetAt`) · publishable: alert only |
| `feed.browser`, `.burst`, `.day` | publishable key × client IP /64 | 300 / min, 60 / 5 s, 10,000 / day | 429 (scope `ip`; the day: `QUOTA_EXCEEDED`) |
| `feed.deep.flag`, `feed.deep` | key (secret) or browser, `/v2/listings` at depth ≥ 50 | flag at once; 100 deep pages / hour | flagged; then throttled 1 h + alert |
| `feed.paging.browser.flag`, `feed.paging.browser` | publishable browser, paged | 600 / 1,800 per 10 min | flagged; throttled 1 h + alert |
| `feed.paging.pk.<tier>` | publishable key, paged | 3,000 / 15,000 per hour | alert only |
| `feed.agency.quota` | agency (all its sites and secret keys) | 2,000,000 per UTC day | 429 `QUOTA_EXCEEDED` (scope `tenant`) |
| `feed.agency.pk.day` | agency (all its publishable keys) | 2,000,000 per UTC day | alert only |
| `feed.slice.browser.flag`, `feed.slice.browser` | publishable browser, distinct filtered first pages of `/v2/listings` and `/v2/developments` | 150 / 500 per clock hour | flagged; throttled 1 h + alert |
| `feed.slice.key.<tier>` | key, distinct filtered first pages | 5,000 / 25,000 per clock hour | alert only |
| `feed.sync.browser.flag`, `feed.sync.browser` | publishable browser, details + sitemap pages | 300 / 1,000 per hour (no credit) | flagged; throttled 1 h + alert |
| `feed.sync.key.<tier>` | key, details + sitemap pages | 10,000 / 50,000 per hour (+ change-feed credit, secret keys) | alert only |

A paged request is a `cursor` on `/v2/listings`, `/v2/developments`, `/v2/developments/{ref}/units`, `/v2/sitemap` or
`/v2/changes` (S7-F7: a secret key's plugin polls it all day, which paging volume never flags; a browser crawling it
meets its per-browser paging limits). `/v2/listings` cursors carry a signed page depth bound to the site. Daily quotas count only
requests every enforced rule allowed. A throttled caller still gets first pages and details. Volume never flags a
secret key: a server-rendered site pages for all its visitors.

**S7-F7 extraction budgets.** *Filter-slicing*: a scraper slices the inventory by filters (location × type × price
band) so no cursor chain gets deep; the limits count **distinct** filtered first pages of `/v2/listings` and
`/v2/developments` per identity and clock hour — the slice signature is the query as the route's schema parses it
(only filter fields and the listings sort, canonical: numbers normalized, lists sorted, text case-folded; unknown
parameters make the request a 400, so `_=…`, `utm_*` cannot inflate it) — in one HyperLogLog per identity and hour
(the flag and the throttle share it; ≤ ~14.5 KB, about 1 % error). Only served requests record a signature.
*Detail / sync*: details (`/v2/listings/{ref}`, `/v2/developments/{ref}`) and sitemap pages per hour. A **secret**
key's allowance grows by one per change-feed entry (`ref` + `changedAt`, UPSERTs) it was sent and not credited for in
the last 24 h — re-reading a page or the whole feed earns nothing again — for an hour, at most 20,000, so a WordPress
plugin syncing from `/v2/changes` never trips it; a sitemap + detail crawl does. Publishable keys earn no credit. The
credit is one Redis call made after the change page is built and not awaited (failures counted, `RateLimitFailing`).
*Agency day*: keyed by the agency, so rotating a key (same id) or adding keys starts no new budget; publishable traffic
counts apart (alert only) so browsers cannot lock out the agency's servers. Every request still makes exactly one
awaited Redis call (its limit script).

## Rate limits failing

`RateLimitFailing` (critical): the limiter's script calls fail (`inmolink_rate_limit_failures_total` by `call`), so every
website limit **fails open** (S7-04: a Redis problem must not take websites offline) — quotas, throttles and scraping
detection are off. feed-api's readiness check `rateLimitScripts` (it runs both scripts once as the `limits` user)
fails on the same cause, so a broken deploy does not take traffic.

1. feed-api log `rate limit check failed` (sampled, one line per 10 s) names the rules and the error.
2. `NOPERM`: the `limits` ACL (`redis_limits_acl`, infra/ansible group_vars) lacks a command the scripts use — re-run
   the Ansible play (`redis_queue` role) before feed-api; `PFADD` / `PFCOUNT` came with S7-F7.
3. `OOM command not allowed`: redis-queue is full — see *Redis memory*.
4. Timeouts / connection refused: redis-queue down or unreachable (WireGuard) — see `queues.md`.

**Client IPs** come from `X-Forwarded-For` only through trusted hops: feed-api's `TRUST_PROXY` lists the Cloudflare
ranges and the kamal network (`infra/kamal/feed-api.yml`), and the origin lock (`infra/ansible/roles/docker`,
`inmolink-origin-lock`, DOCKER-USER chain) lets only Cloudflare and the private network reach 80/443 — a client cannot
spoof its browser bucket. Keep both lists in step with https://www.cloudflare.com/ips/.

## Scraping detected

`WebsiteScrapingDetected` (by `action`): `flagged` — a caller paged deep (or a browser paged a lot, sliced the
inventory by filters, or crawled details) and now gets honeytokens; `throttled` — it is in the one-hour penalty box;
`observed` — a key-wide budget is over (alert only: a publishable key's paging, burst or quota; any key's slicing or
detail budget, `feed.slice.key.*` / `feed.sync.key.*`; `scope="agency"`: the agency's publishable day). The feed-api log line `alert: WebsiteScrapingDetected` names `keyId`, `agencyId`,
`siteId` and the rule.

1. Look up the key (dashboard → API keys of the agency, or `api_keys` by id): the agency's own WordPress plugin (a
   secret key) rebuilding a cache, or unknown traffic?
2. A legitimate plugin that pages its whole inventory: it should sync from `/v2/changes` and fetch details, not page
   search results. If it must, raise the key's tier to HIGH (staff) and tell the agency.
3. Unknown traffic on a secret key: the key has leaked — ask the agency to rotate it (or revoke it as staff).
4. `observed` on a publishable key (many IPs, key-wide): a distributed scrape using the site's widget key. Ask the
   agency to rotate the widget key; per-browser limits keep throttling each IP meanwhile. Consider a Cloudflare WAF
   rule for the source ASN.
5. `feed.sync.key.*` on a secret key: the site fetches more details than its change feed explains. A plugin that
   rebuilds from `/v2/sitemap` after a `scope` change does this once (expected); a steady stream is a crawl. A busy
   server-rendered site without its own page cache also does it — raise the tier or ask the agency to cache.
6. `feed.slice.key.*` on a secret key: many distinct searches. A busy site's visitors do this too; compare with the
   site's traffic before acting.
7. `QUOTA_EXCEEDED` with `scope: "tenant"`: the agency's day over all keys. New keys do not help (by design); raise
   `agencyDailyQuota` in config or the agency's keys' tier after checking the traffic is theirs.

## Honeytoken hit

`WebsiteHoneytokenHit`: someone asked for a honeytoken listing's detail. Honeytokens appear only for a caller that
tripped a flag (a `/v2/listings` chain at depth ≥ 50, or a flagged publishable browser), on its pages at depth ≥ 10,
where one card is replaced by its own clone (shifted price, size and point). They are never in the sitemap, the change
feed, developments, totals or facets, never stored anywhere, and answers to such callers are `private, no-store`.
References look like the cloned card's: `<site prefix>-<code>` or the agency's own pattern with check digits; both are
derived from the site (`HMAC_KEY`), so they identify the site whose inventory was scraped. The detail answers the 404 of
a withdrawn listing (a code-style hit is first confirmed to be no real public code).

1. The log line `alert: WebsiteHoneytokenHit` names `ref`, `siteId`, `agencyId` and the `keyId` that asked.
2. Find the scraping key: the `WebsiteScrapingDetected` lines for the same site shortly before.
3. A honeytoken reference seen on another website or portal: `websiteApi.honeytokenSiteOf(HMAC_KEY, siteIds, code)`
   tells which site it was scraped from (check first that the code is no real one: `listing_public_codes`).

Turn honeytokens off with `WEBSITE_HONEYTOKENS=false` on feed-api: no page carries one; hits on old ones still alert.
Rotating `HMAC_KEY` changes every site's honeytoken codes and invalidates search cursors once (422, start again).

## Redis memory

`RedisMemoryHigh` (> 80 % of `maxmemory` for 10 min) / `RedisMemoryCritical` (> 95 % for 2 min), by `instance`
(`redis-queue`, `redis-cache`). redis-queue runs `noeviction` with `maxmemory` = `redis_queue_maxmemory` (staging 1 GB,
production 8 GB): when full, writes fail — BullMQ queues stop and website limits fail open. redis-cache evicts (LRU,
4 GB): high there only means the cache is small. Rate-limit counters cost about **5 keys and ~760 bytes per website
browser** (S7-04: the daily key ~150 B until UTC midnight, the rest 2–20 min) plus **up to 4 keys and ~800 bytes** for
a browser that searches with filters and views details (S7-F7: two slicing HyperLogLogs ≤ 1 h, two sync keys ≤ 2 h),
and per key ≤ ~14.5 KB for its slicing HyperLogLog (dense, once a key has thousands of distinct searches in an hour).
Worst case at 5,000 agencies: ≈ 0.75 GB (STATUS › Decisions S7-F7) — under 10 % of production's ceiling.

1. `INFO memory` on redis-queue, then the counters' share: `redis-cli --scan --pattern 'inl:rl:*' | head -2000 | xargs
   -n1 redis-cli MEMORY USAGE` (a sample) against `INFO keyspace` — counters or queues?
2. Counters: a scrape from very many IPs. Block the source at Cloudflare; raise `redis_queue_maxmemory` (headroom; the
   db host has 64–128 GB). If counters stay above ~25 % of the ceiling, move them to their own noeviction Redis
   (`REDIS_LIMITS_URL` is already separate config; S7-F7 Decision).
3. Queues: see `queues.md`.

**Exporters (S7-F7):** `redis-queue-exporter` (Ansible role `redis_queue`, `<db wg_ip>:9121`) and the api's Kamal
accessory `redis-cache-exporter` (`<redis_cache_host wg_ip>:9122`), each logging in as a keyless `exporter` ACL user
(INFO / SLOWLOG / LATENCY only, no key, no CONFIG; vault `vault_redis_exporter_password`, Kamal secret
`REDIS_CACHE_EXPORTER_PASSWORD`); Prometheus job `redis`. Only the monitoring host(s) reach the ports (ufw on db hosts,
the `INMOLINK-METRICS` DOCKER-USER chain on the app host); `/scrape?target=` is disabled
(`REDIS_EXPORTER_DISABLE_SCRAPE_ENDPOINT`: it would log in to any target with the exporter's password).
`RedisExporterDown` (critical, 5 min) fires when a target or its Redis stops answering — the memory alerts are blind
then. Check: Prometheus → Status → Targets, job `redis` both UP; `redis_memory_max_bytes{instance="redis-queue"}`
equals the ceiling.

**Staging acceptance (H4):** once staging exists — (1) `ansible-playbook site.yml -i inventories/staging` (sets
`maxmemory 1gb`, the `exporter` user, the exporter container, the firewall rules) and, with `REDIS_CACHE_EXPORTER_PASSWORD`
in `.kamal/secrets.staging`, `kamal accessory reboot redis-cache -c infra/kamal/api.yml -d staging` (its new
`exporter` user; the cache starts empty) and `kamal accessory boot redis-cache-exporter -c infra/kamal/api.yml -d
staging`; (2) both `redis` targets UP; (3) make the alert fire from the real series: on
staging-1 `redis-cli -a <queue password> CONFIG SET maxmemory <INFO used_memory × 1.1>` (used ≈ 91 % of max) → after
10 min `RedisMemoryHigh{instance="redis-queue"}` fires in Alertmanager (e-mail); then `CONFIG SET maxmemory <used ×
1.03>` (≈ 97 %) → `RedisMemoryCritical` within 2 min; (4) restore `CONFIG SET maxmemory 1gb` (or re-run the play) and
see both resolve; record the times in STATUS. Do it outside business hours: near the ceiling, BullMQ writes may fail.

## Load test (S7-08)

PLAN §15 "Website API mix": `tests/load/website-api.js` (k6, image **`grafana/k6:1.3.0`**) sends search 60 %, detail
30 %, taxonomy / changes 10 % over many sites, the way websites do: sites drawn Zipf-weighted (a few busy, a long
tail; each capped below its key's limits), first pages with filters, next pages that follow each VU's own search by
`nextCursor` to a random depth, map views, the sites' languages, sitemap references, plugins polling `/v2/changes`
(their own cursor, or catching up with `since` anywhere in the 30-day log). Thresholds are the
acceptance check — judged on the steady phase after a warm-up ramp: **p95 < 150 ms** (overall, per scenario, per
endpoint), **failed requests < 0.1 %** (anything but 200 / 304), **≥ 99 % of the planned requests sent** (1,000 rps ×
900 s) and ≤ 1 % dropped. k6 exits 99 when a threshold fails. Profiles: `smoke` (local, 20 rps, 60 s), `staging`
(1,000 rps, 15 min, origin — the acceptance profile: it refuses `RATE` / `DURATION` / `WARMUP` / `EDGE` / `P95_MS`
overrides, and every other run's summary says "NOT the acceptance profile"), `spike` (2,000 rps through the CDN with
`_k`; PLAN §15, not the acceptance check), `degraded` (S7-F9: the acceptance numbers with the search engine stopped —
step 5b; it refuses overrides too).

**No bypass.** The run goes through the real key check and limiter. `pnpm perf:load:setup` provisions one site and one
**SECRET key on the HIGH tier** per scale-seed agency (members `…@s<seed>.scale.inmolink.test` only; never a real
agency), named `load-test`, rotating the policies OWN_ONLY / OWN_PLUS_NETWORK / CUSTOM network / CUSTOM with a 3 %
minimum commission. It makes enough keys that no limit trips (each key ≤ 80 % of its tier, the agency ceiling, the
burst and the daily quota): **at least 25 at 1,000 rps**; a realistic working set needs far more (500). k6's setup
refuses fewer, or more Zipf weight on one key than its limits allow. The tier is set through
`identity.setApiKeyRateTier` (system context only, audited, cached lookups dropped). The script runs only when
`DEPLOY_ENV` / `NODE_ENV` say explicitly development, test or staging (NODE_ENV=production only with
`DEPLOY_ENV=staging` and `--staging`); both unset or anything else is refused. The keys file
holds secrets: keep it off the repo (`tests/load/.data/` is git-ignored) and delete it after the run.

**Local:** `pnpm perf:smoke` scale-seeds 40 agencies on the `test` stack (idempotent), rebuilds their read models,
provisions 8 sites, starts the real feed-api (Postgres search fallback; `--engine` for Meilisearch), runs the `smoke`
profile in Docker, prints feed-api's **statements per request** (`pg_stat_statements` for `app_public`, transaction
control left out; over 3 fails the run) and revokes the keys. Options: `--rate`, `--duration`, `--sites`, `--agencies`, `--skip-seed`,
`--keep-keys`. Integration suites prune old agencies from the test database (the scale seed's included), so use
`--skip-seed` only right after a smoke run. Locally the numbers are indicative only (Windows, Docker Desktop's network
hop, feed-api under tsx, leftover rows of other suites): the acceptance numbers come from staging.

**Staging (H4) — the acceptance run:**

1. Data (a staging app box, staging secrets): `NODE_ENV=production DEPLOY_ENV=staging SEED_SCALE_PASSWORD=<secret store>
   pnpm db:seed:scale --agencies=5000 --seed=1 --staging` (or `--agencies=11112` for the 2M-listing design target),
   then `pnpm ops:rebuild-read-models`. Wait until the `indexing` queue is empty and the listings index holds as many
   documents as `listing_search_docs` (search runbook), then `VACUUM (ANALYZE)` the seeded tables (scale-seed runbook).
2. Keys: `NODE_ENV=production DEPLOY_ENV=staging pnpm perf:load:setup --staging --rate 1000 --sites 500
   --out /secure/website-keys.json` (500 sites: the working set of a real fleet, Zipf-weighted; 25 is the minimum).
2b. Query budget: on the primary, `select pg_stat_statements_reset();` just before the run (or note the sum below).
   After it: `select sum(calls) from pg_stat_statements where userid = 'app_public'::regrole and query !~*
   '^\s*(begin|commit|rollback|set |reset|show|discard|deallocate|select set_config)';` ÷ the run's `http_reqs` count
   (summary JSON) must be **≤ 3** — record it with the summary.
3. Run from a **separate load-generator box** in the same region (≥ 8 vCPU; not an app server), against the **origin**
   (feed-api behind kamal-proxy, not the Cloudflare hostname — each answer is checked for `cf-cache-status`):
   ```sh
   docker run --rm --ulimit nofile=65536:65536 -v "$PWD/tests/load:/load" -v /secure:/data \
     -e BASE_URL=https://<feed-api origin host> -e PROFILE=staging \
     -e KEYS_FILE=/data/website-keys.json -e SUMMARY_FILE=/data/summary-staging.json \
     grafana/k6:1.3.0 run /load/website-api.js
   ```
   **Background write load:** about 3 minutes into the steady phase, start one large feed import on a scale-seed
   agency (≥ 50k items — the S6 feed-import perf fixture served to a staging feed connection, run from the dashboard's
   *Run now*): its read-model rebuilds, index pushes and change-log rows land while the website traffic runs, as they
   do in production. Note when it ran in the record.
   Watch Grafana while it runs: feed-api CPU and event-loop lag, PgBouncer waiting clients, Postgres CPU / connections,
   Meilisearch latency, the limits Redis, `WebsiteScrapingDetected` (must stay silent).
4. Record the printed summary (rps held, error rate, p50 / p95 / p99 per scenario and endpoint, statements per
   request) in the STATUS row of S7-08 and mark it DONE when every threshold held and the budget is ≤ 3.
   **Cold sitemap page (S7-F9):** on the same box, `WEBSITE_PERF_ROWS=2000000 pnpm test:perf:root` logs
   `sitemapColdPageMs` (a never-read network sitemap page of 250 — the default since S7-F10 — half-way down) — it must be **< 400 ms** (the origin
   SLO, PLAN §4.2; locally 377–463 ms with 128 MB of shared buffers). Record it with the summary; over it, the deep
   sitemap needs the code-index walk on cold data (S7-F10). A failed threshold: the summary names it; fix and re-run.
5. Edge spike (optional, needs S7-06 live): `-e PROFILE=spike -e BASE_URL=https://feed.inmolink.es` (adds `_k`, reports
   the edge hit rate).
5b. **Degraded engine (S7-F9, PLAN §15 chaos drill "kill search → Postgres fallback serves"):** the acceptance run with
   Meilisearch stopped, so every website search comes from the Postgres fallback (search runbook › *Fallback active*).
   Keys from step 2 (still valid), the same data. Stop the engine on the search host (`docker stop` the `meilisearch`
   container — stop, never remove: the index volume stays), wait until `SearchFallbackActive` fires (every feed-api
   process's breaker open), reset `pg_stat_statements` (step 2b), then run step 3's command with
   `-e PROFILE=degraded -e SUMMARY_FILE=/data/summary-degraded.json` (no other override: the profile refuses them).
   Thresholds: S7-08's, unchanged, plus `search_degraded` > 99.9 % — every search answered `degraded: true`, so a run
   where the engine still answered fails. Watch Postgres CPU, `listing_search_docs` statement times
   (`pg_stat_statements`, none near the 2 s timeout) and PgBouncer waiting clients. **Start the engine again** right
   after (`docker start`), check `/health` and that `SearchFallbackActive` resolves (each breaker closes within 30 s of
   its next probe). Record the summary and statements per request in the STATUS row of S7-F9 and mark it DONE with
   the 2M fallback check (`FALLBACK_PERF_ROWS=2000000 pnpm test:perf:root`, S5-04). Locally `pnpm perf:smoke` is this
   run at a low rate (the fallback unless `--engine`; it passes `DEGRADED=1`).
6. Clean up: `NODE_ENV=production DEPLOY_ENV=staging pnpm perf:load:setup --teardown --staging`, delete
   `/secure/website-keys.json`.

## Legacy v1 shim (S8-02)

`/v1/*` on feed-api answers legacy client websites unchanged (PLAN §9.3): `GET /v1/properties`, `/v1/properties/{id}`
(a legacy property id or a site reference) and `/v1/types`. Answers are `private, no-cache` with a strong ETag; errors
are `{ "status": "error", "message": … }`.

- **Keys.** A key may come as the legacy `api_key` query parameter only when it is marked as a migrated legacy key
  (`api_keys.legacy_query_key`, set by the legacy key import or `pnpm legacy:key-flag --agency <id> --prefix <prefix>
  --on --reason <code>`); any other key there is a 401. Header keys work for every key. App logs never carry query
  strings and redact `api_key`.
- **Legacy ids.** Taxonomy maps (location, property type, feature) are loaded whole into each feed-api process at boot
  and reloaded in the background every 5 min: a new migration batch's filter ids work within 5 min, no restart.
  Listing and unit ids go through the SECURITY DEFINER lookups `legacy_target_ids` / `legacy_ids_of`; `app_public`
  cannot read those maps.
- **Shapes are assumed** until H2: `tests/golden/synthetic/` holds hand-derived golden files for the assumed contract
  (contracts `legacy-v1.ts`). Recorded files (`pnpm legacy:record`) go to `tests/golden/<endpoint>/` with
  `tests/golden/fixture.json` (the test account's read-path rows after its migration); `pnpm test:golden` replays all
  of them byte for byte (and checks `traffic.json`'s 99% set is covered); CI runs it in `test:int:root`.
- **Paging.** Legacy `page` numbers are engine offsets (≤ 10,000 results). While the search engine is down (the
  Postgres fallback answers, keyset only), pages after the first are empty rather than repeating page 1.
- **Capacity.** `/v1` is never edge-cached (the URL carries the key): every legacy request reaches the origin, ETag
  revalidation saves only the body. Size feed-api for the legacy sites' full request rate until they move to v2/the
  plugin (load test: add `/v1` to `tests/load` before cutover).

### Cutover checklist (legacy hostname)

1. Mark every migrated site's key as a legacy key (the import does it; check `select count(*) from api_keys where
   legacy_query_key`).
2. Cloudflare on the legacy hostname: a transform rule rewriting `/api/*` to `/v1/*` (`legacyShimPath`), and **strip
   `api_key` from logs**: Logpush/log fields exclude the query string (or `ClientRequestURI`), and the origin proxy
   (kamal-proxy) logs no query strings.
3. Flip DNS to feed-api; rollback is the DNS flip (cutover.md › DNS switch: `pnpm legacy:cutover dns-check` first;
   each agency's own cutover is `pnpm legacy:cutover run`).
4. After cutover, as each site moves to the plugin or header keys: rotate its key (the old one has lived in URLs) and
   clear its legacy flag (`pnpm legacy:key-flag … --off`).
5. Change a `/v1` answer only with an approved golden update in STATUS.
