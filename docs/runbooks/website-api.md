# Website API — quotas and anti-scraping (S7-04)

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

A paged request is a `cursor` on `/v2/listings`, `/v2/developments`, `/v2/developments/{ref}/units` or `/v2/sitemap`
(not `/v2/changes`). `/v2/listings` cursors carry a signed page depth bound to the site. Daily quotas count only
requests every enforced rule allowed. A throttled caller still gets first pages and details. Volume never flags a
secret key: a server-rendered site pages for all its visitors.

**Client IPs** come from `X-Forwarded-For` only through trusted hops: feed-api's `TRUST_PROXY` lists the Cloudflare
ranges and the kamal network (`infra/kamal/feed-api.yml`), and the origin lock (`infra/ansible/roles/docker`,
`inmolink-origin-lock`, DOCKER-USER chain) lets only Cloudflare and the private network reach 80/443 — a client cannot
spoof its browser bucket. Keep both lists in step with https://www.cloudflare.com/ips/.

## Scraping detected

`WebsiteScrapingDetected` (by `action`): `flagged` — a caller paged deep (or a browser paged a lot) and now gets
honeytokens; `throttled` — it is in the one-hour penalty box; `observed` — a publishable key's key-wide paging, burst
or quota is over (alert only). The feed-api log line `alert: WebsiteScrapingDetected` names `keyId`, `agencyId`,
`siteId` and the rule.

1. Look up the key (dashboard → API keys of the agency, or `api_keys` by id): the agency's own WordPress plugin (a
   secret key) rebuilding a cache, or unknown traffic?
2. A legitimate plugin that pages its whole inventory: it should sync from `/v2/changes` and fetch details, not page
   search results. If it must, raise the key's tier to HIGH (staff) and tell the agency.
3. Unknown traffic on a secret key: the key has leaked — ask the agency to rotate it (or revoke it as staff).
4. `observed` on a publishable key (many IPs, key-wide): a distributed scrape using the site's widget key. Ask the
   agency to rotate the widget key; per-browser limits keep throttling each IP meanwhile. Consider a Cloudflare WAF
   rule for the source ASN.

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

`RedisMemoryHigh` (> 80 % of `maxmemory` for 10 min) / `RedisMemoryCritical` (> 95 % for 2 min). redis-queue runs
`noeviction`: when full, writes fail — BullMQ queues stop and website limits fail open. Rate-limit counters cost about
**5 keys and ~760 bytes per website browser** (key × IP): the daily key (~150 B) lives until UTC midnight, the minute
and 10-minute keys 2–20 min — 1M distinct browsers a day ≈ 150 MB resident plus minute-scale churn.

1. `redis-cli --scan --pattern 'inl:rl:*' | head` and `INFO memory` on redis-queue: counters or queues?
2. Counters: a scrape from very many IPs. Raise `maxmemory` (headroom), block the source at Cloudflare; S7-F7 decides
   on a separate limits Redis.
3. Queues: see `queues.md`.

The alerts need `redis_exporter` scraped next to each Redis (follow-up S7-F7); until then they have no series.

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
`_k`; PLAN §15, not the acceptance check).

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
   request) in the STATUS row of S7-08 and mark it DONE when every threshold held and the budget is ≤ 3. A failed threshold: the summary names it; fix and re-run.
5. Edge spike (optional, needs S7-06 live): `-e PROFILE=spike -e BASE_URL=https://feed.inmolink.es` (adds `_k`, reports
   the edge hit rate). Degraded engine (S7-F9): the same run with Meilisearch stopped measures the Postgres fallback.
6. Clean up: `NODE_ENV=production DEPLOY_ENV=staging pnpm perf:load:setup --teardown --staging`, delete
   `/secure/website-keys.json`.
