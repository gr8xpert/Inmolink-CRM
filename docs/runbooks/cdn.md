# Website API edge cache — Cloudflare (S7-06)

The website API (`feed-api`, `/v2`) is cached at Cloudflare's edge so websites keep serving when the origin is slow or
down (ADR 0012 #5, PLAN §5.3 #4, §9.2). Four parts, all in the repository:

| Part | Where | What it does |
|---|---|---|
| Origin headers | `apps/feed-api/src/plugins/site-response.ts` (`SITE_CACHE_POLICY`, `edgeCacheable`), `WEBSITE_EDGE_CACHE` | First pages and details requested with a valid `_k`: `public, max-age=0, s-maxage=<ttl>, stale-while-revalidate=<ttl>, stale-if-error=86400`, strong `ETag`, `Vary: Accept-Encoding, X-Api-Key, Authorization`, `Cache-Tag`. Everything else is `private` (with `Vary: …, Origin`) or `no-store`. |
| Key token `_k` | SDK `createWebsiteClient` (automatic), `edgeKeyToken` | base64url(SHA-256(`<api key>\n<Origin or empty>`)), first 22 characters, in the query of every read. |
| Cache rule | `infra/cloudflare/cache-rules.json`, applied by `pnpm ops:cdn-rules` | Caches `/v2/` GETs of the feed-api host only when the origin says so. The cache key is the URL (sorted query) plus the exact `X-Api-Key` and `Authorization` values. Any other `Vary` header (`Origin` included) bypasses the cache. |
| Purge | worker `indexing` pool, `websiteApi.purgeEdgeCache` | Purges the tags of what changed: listings and units (`t…`), developments (`d…`), sites (`s…`), API keys (`k…`). |

## How a cached answer stays with its key

The site comes from the API key, so one URL answers differently per site. Two safeguards each prevent sharing:

1. **The URL.** The origin answers `public` only when the query carries `_k` and it matches the request's key and
   `Origin`. A missing or wrong token gets `private`. So the cached URLs differ per key and browser origin, and with no
   `_k` nothing is cacheable, even if the rule were dropped or a zone-wide "cache everything" rule appeared.
2. **The rule.** Cache Rules' `vary` setting (every plan) passes the exact `X-Api-Key` and `Authorization` values
   into the cache key and bypasses any other varying header. `Origin` is not passed through; the token carries it, and
   private answers list `Origin` in `Vary`, so the rule bypasses them.

**The WordPress plugin** and any other client without the SDK must add `_k` itself:
`_k = base64url(sha256(api_key + "\n" + origin))[0:22]`, where `origin` is the empty string server-side. In PHP:
`substr(rtrim(strtr(base64_encode(hash('sha256', $key . "\n", true)), '+/', '-_'), '='), 0, 22)`. Without the token,
the plugin still works; it just does not get edge-cached answers.

**Taxonomy** (`/v2/taxonomy/*`) is the same for every key and site. It stays public without `_k`, keyed per key header.
Its query schema strips unknown parameters, so a URL with any parameter other than `lang`, `cursor` or `_k` answers
`private` (no cache-busting copies).

**Per-site XML feeds** (S7-07, `/v2/feeds/<token>/kyero.xml|inmolink.xml`) carry no key header: the per-site token is
in the path, so the URL alone is the cache key. They answer `public, s-maxage=900` with `Vary: Accept-Encoding` only,
`Cache-Tag` `s` (site) and `f` (feed). A new run, a token rotation or revocation purges `f`; an agency or site change
purges `s`. A rotated token's URL answers 404 at the origin (never cached), so after the purge it stops at the edge too.
With `WEBSITE_EDGE_CACHE` off, a feed poll that accepts gzip is answered `302` to a signed storage URL of the stored
file (2 minutes, `Content-Encoding: gzip`, `Content-Type: application/xml`; S8-F1), so a feed (up to 64 MiB gzip)
never streams through feed-api on every poll; clients without gzip get the decompressed stream (rate-limited per
token). Feeds are exempt from the 150 KB JSON budget of website answers: a whole inventory by design.

**Never turn `WEBSITE_EDGE_CACHE` on before the rule is live and `--verify` passed for that environment.**

## Feed token URLs and logs (S8-F1)

The per-site feed token is a credential in the URL **path**, so every log that records paths must leave it out:

| Where | Retention / handling |
|---|---|
| feed-api request logs (pino) | Credential path segments redacted (`redactPath` in `packages/platform/src/logger`); query strings dropped. |
| kamal-proxy | Its access log always records the path and cannot leave one out, so the proxy container's log is off: `proxy.run` in every `infra/kamal/<app>.yml` (one proxy per host) sets `options.log-driver: none` and `log_max_size: ""` — Kamal 2.12 skips `--log-opt max-size=…` for a blank value, and a log option next to the `none` driver must not reach `docker run`. Apply per host with `kamal proxy reboot -c infra/kamal/api.yml -d <env>` (a few seconds without traffic: quiet window; **staging first**). Check on the host: `docker inspect kamal-proxy --format '{{.HostConfig.LogConfig.Type}} {{.HostConfig.LogConfig.Config}}'` prints `none map[]`, `docker logs kamal-proxy` prints nothing, and `kamal proxy details -c infra/kamal/api.yml -d <env>` shows the proxy running. If the reboot fails, remove the `run` block from all five configs and `kamal proxy reboot` again (logs back on, tokens in them: rotate feed tokens after the fix). |
| Sentry | Request URLs, breadcrumb URLs and messages, exception messages and transaction names are scrubbed before sending: query strings dropped and `/v2/feeds/<token>` redacted wherever it appears (`scrubErrorEvent` in `packages/platform/src/telemetry/errors.ts`, same segments as `redactPath`). |
| Cloudflare analytics (dashboard, GraphQL) | Top paths are kept, sampled, for the zone plan's analytics retention window (record the actual window per zone in the H5 setup notes), visible to account members only. Accepted: zone access is restricted to ops staff. |
| Cloudflare Logpush / Log Explorer | **Not enabled** for the feed-api hostname. If it ever is, the job must filter out `ClientRequestPath` starting with `/v2/feeds/` (Logpush filter) or omit `ClientRequestPath`/`ClientRequestURI`; retention then follows the destination bucket's lifecycle rule. |
| Cloudflare Instant Logs | Live stream only, nothing stored; ops staff only. |

A token that may have leaked (a log shared outside ops, a screenshot): rotate it from the dashboard (Website → XML
feed → Rotate). The old URL answers 404 at once and its edge copies are purged.

## What is never edge-cached

- Pages with a `cursor`, including an empty `cursor=` (deep pages must pass the origin's paging rules and
  anti-scraping, S7-04).
- `/v2/changes` (a cursor poll).
- Answers to suspicious callers (`private, no-store`, no ETag; they may carry a honeytoken). Suspicion is decided on
  paged requests. A flagged caller's first page carries no honeytoken and is the same answer every caller of the key
  gets.
- Errors, 401s and 429s (`private, no-store` from `edgeSafeErrors`; the rule's `bypass_by_default` caches nothing
  without a `Cache-Control`).
- Lead and viewing-request posts (POST, `no-store`).

Requests the edge answers never reach the origin, so they do not count against quotas or the paging rules (S7-04). This
is accepted: only first pages and details are cached, an entry is per key, and re-reading the same URL within its TTL
extracts nothing new. Every deep page, every new query and every detail not cached for that key still reaches the
origin and is counted.

## Lifetimes, purging and the real worst case

`WEBSITE_API_TTL` (core `website-api/edge.ts`): listings 60 s, detail 300 s, developments 60 s / 300 s, units 60 s,
sitemap 240 s. The usual path takes seconds: read model rebuilt → `search.publicDocs.changed` (outbox, same
transaction) → the agency's pending purge set → `websiteApi.purgeEdgeCache` → tag purge.

**Worst case without a purge** (the purge failed or was dropped): an answer is fresh for its TTL. The first request
after that gets the stale copy once while the edge revalidates (`stale-while-revalidate` = TTL), so an edit can take up
to 2 × TTL, which is 10 minutes for a detail. **While the origin is down**, cached answers keep being served for up to
24 h (`stale-if-error`); that is intended. A revoked key or a suspended agency is purged by tag (`k…` / `s…`, never
dropped for its age). Without the purge, a revocation takes effect at the next revalidation: a 401 is not cacheable and
replaces the entry (to be confirmed on staging, below).

- Lists are tagged with the targets on them, so one tag purges every page showing a listing on every site, with no
  fan-out per site. A listing new to a list's results appears within the list TTL (60 s).
- The sitemap carries only the site and key tags and follows its 240 s TTL.
- **Coalescing and per-tenant budget:** tags wait in the agency's pending set on redis-cache (`inl:edge-purge:{agency}`,
  latest change time per tag). The agency's purge job is throttled to one run per 5 s (`EDGE_PURGE_THROTTLE_MS`). A run
  sends at most 100 tags in one request, so one tenant is held to 12 requests a minute and cannot spend the account
  budget alone.
- **Horizon:** listing and development tags older than `EDGE_PURGE_HORIZON_MS` (2 × the longest TTL = 10 min) are
  dropped, because every copy has expired by then. This bounds a full rebuild. Site and key tags are never dropped.
- **Account-wide pace:** purge rate limits are per account (Free 5 / min, Pro 5 / s, Business 10 / s; 100 tags per
  request). The job runs one at a time across the pool (`globalConcurrency: 1`, a Redis lease), and the adapter holds
  that slot for `CDN_PURGE_MIN_INTERVAL_MS` (250 ms; set 12000 on Free) after each request. The pace therefore holds
  for any number of worker processes. A 429 fails the attempt and its tags go back to the set; BullMQ retries with
  backoff.

### Purge failing

`WebsiteEdgePurgeFailing` fires when a purge failed its last attempt (`inmolink_website_edge_purge_failed_total`, the
worker log line `alert: WebsiteEdgePurgeFailing` names the agency). Cached answers then live out their TTL, and the
tags wait for the agency's next run. Check the worker log for the status (401/403: the token was revoked or lost
"Cache Purge"; 429: the account rate, see `CDN_PURGE_MIN_INTERVAL_MS`; 0: Cloudflare API unreachable). For a
revocation that must take effect now, purge the key's site from the dashboard (Caching → Purge → by hostname, or
everything).

## Setup per environment (H3, H5)

1. Zone settings: SSL Full (strict) as for the rest of the API, **Always Online off** (it disables
   `stale-while-revalidate` and `stale-if-error`), and Rules → Settings → Normalize URLs to origin on.
2. Create two API tokens scoped to the zone:
   - `CLOUDFLARE_RULES_TOKEN`: Zone → Cache Rules: Edit. This one is for operators and never goes on a server.
   - `CLOUDFLARE_PURGE_TOKEN`: Zone → Cache Purge. This one goes to the worker.
3. Check the rule: `pnpm ops:cdn-rules --env staging` prints it (dry run).
4. Apply it: `CLOUDFLARE_ZONE_ID=… CLOUDFLARE_RULES_TOKEN=… pnpm ops:cdn-rules --env staging --apply`.
   - Other rules on the zone are kept in their order. Ours go last (later rules win).
   - The script warns about any other rule that may match `/v2`.
   - It reads the ruleset back and fails if our rule is not last or lacks its vary block.
5. Add the Kamal secrets `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN` (`.kamal/secrets`) and deploy the worker.
6. Set `WEBSITE_EDGE_CACHE: "true"` in `infra/kamal/feed-api.<env>.yml` (`env.clear`) and deploy feed-api.
7. **Verify, per environment (production included):**
   `CDN_VERIFY_KEY_A=… CDN_VERIFY_KEY_B=… pnpm ops:cdn-rules --env staging --verify`, using secret keys of two
   different sites. The check passes when:
   - key A twice gives a `HIT`;
   - key B on A's URL is never a HIT;
   - key A from another origin (its own token) is never a HIT;
   - a request without `_k` is never a HIT.

   If it fails, set the flag back to `false` at once.

## Staging acceptance (S7-06, open until H3/H4/H5)

1. Run `--verify` (setup step 7). Then fetch a first page twice with the SDK or with `_k` by hand; the second answer has
   `cf-cache-status: HIT`.
2. **Origin stopped:** `kamal app stop -c infra/kamal/feed-api.yml -d staging`.
   - The same requests keep answering 200 with the cached body (`cf-cache-status: STALE` or `UPDATING`).
   - Uncached URLs fail.
   - Then run `kamal app boot`.
3. **Edit visible within 5 min:** change a listing's price in the dashboard and note the time. Within 5 minutes the
   detail and the first page show the new price through the CDN. It is normally seconds: check the worker log for
   `edge cache purged`.
4. **Revocation:** cache a detail with a test key, then stop the worker's purges by unsetting `CLOUDFLARE_PURGE_TOKEN`
   for the test, and revoke the key. After the TTL, the next request answers 401 and the entry is gone: the request
   after it is a `MISS` / 401, not a HIT. Restore the token afterwards.
5. **No override rule (S8-F2 review):** in the zone's Cache Rules, Page Rules and Workers, check that no "Cache
   Everything" or Edge TTL override covers `/embed/*` or `/v2/*`. The origin's `Cache-Control` decides alone: a
   `private` answer (a non-canonical URL, a cursor page, an answer without `_k`) must stay `cf-cache-status: BYPASS` /
   `DYNAMIC`. Check it with `curl -sI '<host>/v2/taxonomy/catalog?lang=en&x=1'` and an embed URL with an unknown
   parameter.
6. Record the results in STATUS (S7-06 row) and turn `WEBSITE_EDGE_CACHE` on for production the same way. Production
   needs `--apply` and `--verify` too.

## JS widget script (S8-F8, open until H3)

The widget (`inmolink-widget.iife.js`) is served from the media host at a versioned, immutable URL.

1. **Media host first (once):** the media host's WAF rule and `X-Content-Type-Options: nosniff` header from
   `docs/runbooks/media-public-host.md` (steps 2–3) must be in place. The rule's second clause
   (`^/vwidget/[0-9a-f]{32}/inmolink-widget\.iife\.js$`) is what lets the widget through. Without it the URL answers 403.
2. **Token:** create an R2 API token for the publish only: Object Read & Write on `inmolink-media`, nothing else. R2
   tokens are scoped by bucket and cannot be limited to the `vwidget/` prefix, so give it a short TTL (or revoke it after
   the publish) and never put it in an app's secrets.
3. **Publish** from a clean checkout of the deployed commit: `pnpm ops:widget-publish` with that token as
   `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, the environment's other `S3_*` values and `MEDIA_CDN_URL`. It refuses
   uncommitted changes and fails without credentials (`--local` only for the local stack). It builds the script, puts it
   at `vwidget/<32 hex of its SHA-256>/inmolink-widget.iife.js` with `Cache-Control: public, max-age=31536000,
   immutable`, and prints the URL and the commit. Give that URL to sites for their `<script>` tag. Old versions stay, so
   a page that pins one keeps working.
4. **Check:** `curl -sI <url>`: expect 200, `content-type: text/javascript; charset=utf-8`,
   `x-content-type-options: nosniff`, the immutable `cache-control`, and `cf-cache-status: HIT` on the second request.
5. **Sites:** for the lead form a site adds `data-turnstile-site-key="<the Turnstile widget's site key>"` (H3) and
   optionally `data-privacy-url`, on the same element as the key/URL pair (script tag or widget element). The
   Turnstile widget's hostnames must include the site's domains. The page's CSP must allow
   `https://challenges.cloudflare.com` for `script-src` and `frame-src`. Turnstile's `api.js` is loaded without SRI
   (Cloudflare changes it in place and does not support pinning it). The widget pins its origin and the host's CSP
   limits it (accepted risk, STATUS Decisions S8-F8).

## Rollback

Set `WEBSITE_EDGE_CACHE: "false"` and deploy feed-api. Answers turn `private` at once. Cached entries expire within
their TTL, or purge everything from the dashboard. The rule can stay: with no `public` answers it caches nothing.
