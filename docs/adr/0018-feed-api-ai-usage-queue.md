# ADR 0018 — feed-api enqueues AI usage jobs (an AI-only queue connection)

- **Status:** Proposed — S12-08 (needs approval: it amends PLAN §5.3)
- **Date:** 2026-10-25
- **Task:** S12-08 (PLAN §8 #3, §9.1); builds on S12-01's request-path metering

## Context

PLAN §5.3 keeps feed-api (public website traffic) behind bulkheads: `app_public` and the narrow `app_intake` role, a
`limits`-only Redis ACL user, and **no queue**. `GET /v2/search/ai` (S12-08) is the one request path that calls the AI
gateway. Every tenant AI call must be metered (`.claude/rules/ai.md`: budget check before, `ai_jobs` +
`ai_usage_monthly` after), but feed-api may not use `withSystem` and has no `app_system` connection.

S12-01's request-safe store does this without a database write: the budget comes from a Redis-cached month spend
(the spend mirror), and usage is recorded by a queued job (`ai.recordUsage`, worker `ai` pool); a cold mirror enqueues
`ai.refreshSpend` and fails closed for that request. Both need a producer connection to redis-queue in feed-api.

## Decision

- feed-api gets an **optional** `REDIS_QUEUE_URL`, used **only when AI is on** (`AI_PROVIDER` ≠ `none`): boot calls
  `configureQueue` then `configureAiRequestRuntime`. Without it (or with AI off) no gateway is installed and AI search
  answers with a keyword search. `apps/feed-api/src/app.test.ts` pins that the variable stays optional.
- In production it authenticates as a dedicated **`feed_ai` ACL user** that can only produce jobs on the
  **`ai-usage` queue** (S12-01 follow-up — alternative 3 adopted): keys `~inl:ai-usage:*` and the pool's fair-share
  keys `~inl:fair:ai-usage:*` (the queue prefix is `inl`, not BullMQ's default `bull`; the colon keeps them from
  matching the `ai` pool's `inl:ai:*`), the commands a BullMQ producer needs (`+@read +@write +@scripting +@connection
  +@transaction`), no `@blocking` (it never consumes), no admin, no key listing. Defined in `infra/ansible`
  (`redis_feed_ai_acl`, role `redis_queue`); the user is created only once the vault holds
  `vault_redis_feed_ai_password` (human step, below).
- The `ai-usage` queue holds only `ai.recordUsage` and `ai.refreshSpend` (worker pool `ai-usage`, `apps/worker`
  `POOL_JOBS`); the `ai` pool's jobs (Listing Studio, sanitizer, batches, worker-path usage retries
  `ai.retryUsageRecord`) are out of feed-api's reach. Redis ACLs scope by key, not job name, so the worker treats every
  `ai-usage` payload as untrusted: `ai.recordUsage` accepts only request-path features (`REQUEST_PATH_AI_FEATURES`),
  single calls within `REQUEST_PATH_RECORD_LIMITS` (≤ 1 USD, ≤ 200k input / 16k output tokens), no batches, this or
  last month, for an agency that exists — anything else is dead-lettered unwritten; `ai.refreshSpend` seeds only
  existing agencies' recent months. **Residual risk:** a compromised feed-api can inflate a real agency's recorded AI
  spend in small plausible steps (it already holds that agency's budget through AI search itself), never plant a large
  cost, a batch or another queue's job.
- The Kamal entries (`infra/kamal/feed-api.yml`) ship **commented out**: AI search stays off in every destination
  until this ADR is accepted, the ACL user exists (`infra/ansible`), and the `AI_*` variables are set.

- Cost is bounded before the gateway's budget (S12-08 review): only cache misses reach the model, and misses are
  counted per API key, per browser (publishable keys), per site and per agency per 30 days (this feature's share of
  the plan's hard cap, `SEARCH_AI_BUDGET_SHARE_BP`); the limits fail closed (limiter down → keyword search). At most
  `SEARCH_AI_MAX_LATE_CALLS` model calls keep running after their request answered, and feed-api's gateway ends a
  call after 3 s with no retries (`AI_TIMEOUT_MS` / `AI_MAX_RETRIES` defaults in feed-api; the gateway has no
  per-call timeout yet).

## Alternatives considered

1. **No metering on the request path** (`ctx.unmetered`) — rejected: website visitors would spend an agency's AI
   budget unchecked, against `.claude/rules/ai.md`.
2. **A usage stream drained by the worker** — feed-api `XADD`s usage records to a capped Redis stream on redis-cache
   (already connected, no new connection) and a worker job drains it into `ai_jobs` / `ai_usage_monthly`. Keeps
   feed-api queue-free, but adds a second delivery mechanism next to BullMQ (its own retries, dead letters, lag
   alerts, idempotency) and puts durable accounting on the evicting cache instance. A good fallback if a queue
   connection is not acceptable.
3. **A dedicated `ai-usage` queue** holding only `ai.recordUsage` / `ai.refreshSpend`, with the ACL on its keys
   alone — **adopted** (S12-01 follow-up, 2026-10-25): it closes the gap where `feed_ai` could reach every `ai` job.
4. **Make the AI call from a worker** (feed-api enqueues the parse, polls the cache) — rejected: an uncached search
   would wait on queue latency, breaking the 600 ms p95 budget.

## Consequences

- feed-api has one more outbound dependency when AI is on; redis-queue being down makes AI search degrade to keyword
  search (enqueue errors fail the AI step, never the request).
- **Global answer cache — a timing probe:** one understood sentence serves every site, so a caller can tell from the
  latency (a cache hit answers ~0.3–0.5 s faster) whether *someone* on *some* site searched that exact sentence in
  the last 7 days. Accepted: sentences carry no site or visitor identity (normalized search text only; the model
  never sees ids), the probe reveals no site or time, and each probe of a new sentence costs the prober its own miss
  budget. A per-site cache would remove the probe at the cost of the hit rate (and model spend) across 5,000 sites.
- **Human steps (ops):** generate `vault_redis_feed_ai_password` (`openssl rand -hex 32`) and run the `redis_queue`
  role; store `REDIS_QUEUE_URL_FEED_AI` (`redis://feed_ai:<password>@<db-1 WireGuard IP>:<port>`) and
  `ANTHROPIC_API_KEY` as feed-api secrets; set the `AI_*` variables; uncomment the Kamal entries.
