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
