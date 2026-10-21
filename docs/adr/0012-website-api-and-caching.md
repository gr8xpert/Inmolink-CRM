# ADR 0012 — Website API and caching

- **Status:** Accepted (design; implemented in S5-01, S7-01 to S7-08, S8-02)
- **Date:** 2026-10-11
- **Task:** S0-16 (PLAN §2 #1 #2, §3 #6 #20 #43 #54, §4.2, §5.3, §9)

> The backlog numbered this "0004 website API & caching". ADR 0004 already held the authentication decision (S0-09), so this one took the next free number.

## Context

Agency websites are the revenue engine and the highest-traffic surface: 1,000 rps at the origin and 2,000 rps at the edge at the design target, with 99.95% availability (PLAN §4). Principle 1 says websites never go dark. Principle 2 says buyers see only the presenting agency, never the owner of a network listing, its commission or its contacts. Per-request joins over raw listing, media, translation and agency tables would neither meet the budget nor make white-labelling reliable.

## Decision

1. **Separate deployable `apps/feed-api`.** It is read-only and connects only as `app_public` (2 s statement timeout) on its own pool budget, so website load cannot starve the dashboard (ADR 0010). It serves `/v2`, the frozen `/v1` legacy shim (ADR 0006) and the per-site XML feeds.
2. **Read models on the hot path.** `listing_read_models` hold one document per listing or unit and locale: card JSON, detail JSON, version and ETag. They are built from outbox events (debounced), never go backwards in version, and never contain owner contacts or private fields. Filtered queries go to the search adapter (ADR 0005), which returns IDs, hydrated by primary key. Budget: ≤ 3 queries, p95 < 150 ms at origin, ≤ 150 KB gzip.
3. **Per-site serialization** applies the presenting agency's branding, contacts and reference prefix. Text precedence is agency override, then site content, then owner text. Duplicate clusters collapse to the canonical listing, and the sanitizer runs on the output. White-labelling is server-side, so no client-side flag can reveal the owner.
4. **Auth:** secret keys (server to server, e.g. WordPress) or publishable keys plus an origin allowlist (browser widget). Keys are stored hashed, scoped and rotatable, with per-key daily quotas, burst limits, anomaly detection for sequential paging, and honeytoken listings per site.
5. **Edge caching (Cloudflare).**
   - The cache key is site scope + normalized query + locale. TTL is 60–300 s, with `stale-while-revalidate` and `stale-if-error` of 24 h.
   - Every response sets `Cache-Control` and `ETag`, and conditional requests get 304.
   - Purging uses per-listing tags where the plan supports them, otherwise short TTLs plus versioned keys.
   - Target: an edit is visible through the CDN within 5 minutes.
   - *Implemented in S7-06 (runbook `docs/runbooks/cdn.md`).* The site comes from the API key header, and custom
     header cache keys are Enterprise-only. So the site scope enters the cache key twice. First, an answer is public
     only when its URL carries `_k`, a token of the API key and browser origin. Second, the origin's
     `Vary: X-Api-Key, Authorization` is passed through by a Cache Rule on every plan, and any other varying header,
     `Origin` included, bypasses the cache. The key is one site with one inventory policy, so this is the site scope
     at key granularity. Query normalization combines strict query schemas (unknown parameters are refused) with Cloudflare's
     sorted query string. Tag purge is available on every plan, so it is used. Lists and details are tagged with the
     keyed hashes of the listings they show, which purges every site's copies with one tag. Only first pages and
     details are cached; cursor pages, the change feed, errors, 429s and answers to suspicious callers never are.
6. **Defense in depth for "never dark":** the CDN serves stale content when the origin is down, the WordPress plugin keeps a local cache with stale fallback, and search has a Postgres fallback.
7. **Versioning:** `/v1` is frozen. `/v2` follows the OpenAPI generated from Fastify, and the typed SDK in `packages/sdk` is regenerated (`pnpm sdk:generate`) whenever it changes. Deprecations get 12 months' notice.
8. **Writes are narrow:** `POST /v2/leads` and `/v2/viewing-requests`, with Turnstile, idempotency keys, and the presenting agency as lead owner. A lead is stored and acknowledged, and everything else happens in jobs.

## Consequences

- An origin outage is invisible for up to 24 h for cached pages. Uncached long-tail queries fail during an outage, and that is accepted.
- Freshness is bounded by the read-model lag plus the CDN TTL, about 5 minutes, not instant. Agents are told this.
- Every new client-facing field must be added to the read model and the serializer, and must pass the white-label property test (S7-02). That is deliberate friction.
- `app_public` can read only `PUBLIC_READ` rows and global `publicRead` tables (ADR 0011), so a feed-api bug cannot leak private rows.
