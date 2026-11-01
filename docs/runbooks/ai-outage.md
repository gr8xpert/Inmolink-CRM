# AI outage (S16-05)

PLAN §17 runbook list, §8. Every model call goes through `platform/ai` (gateway: per-tenant budget, cache, circuit
breaker, timeout). An AI outage never stops a core flow: features wrapped in `aiOrFallback` keep the owner text, show
"try later" or skip the AI step; website AI search falls back to keyword search (chaos drill `ai-provider`,
docs/build/reviews/chaos-R1.md). Metrics: `inmolink_ai_provider_calls_total{outcome}` and the usage-record failure
counters (infra/monitoring/rules/ai.yml); dashboards *Service · worker / api / feed-api*.

## AI provider failing

`AiProviderFailing` (warning): over half of the provider calls in 10 minutes failed (`unavailable`: timeout, 5xx, 529
overloaded, network) or were refused by the open breaker (`circuit_open`) — for 5 minutes, with more than 20 calls in
the window. `rejected` (4xx: AI provider rejecting) and `rate_limited` are not counted: they say nothing about the
provider's health.

1. Provider status: the provider's status page (Anthropic: status.anthropic.com). A provider-wide incident → nothing to
   fix on our side; post a notice on our status page only if agencies ask (AI is not a status page component).
2. Only us? `kamal app logs -c infra/kamal/worker.yml -d production | grep 'ai'` — `401`/`403`: the key was revoked or
   rotated (`ANTHROPIC_API_KEY` in the Kamal secrets of api, feed-api and worker; redeploy after fixing). Timeouts only:
   egress from the app host (`curl -sS https://api.anthropic.com` from the host).
3. Rate limits (`outcome="rate_limited"` rising, no alert): the account's tier limits; bulk work belongs in `ai.batch`
   in the `ai` pool — check that a feature did not start bulk calls on the request path.
4. Queued AI jobs (translations, site content) retry with backoff and land in `ai.dead` after their last attempt;
   after the outage replay them (queues.md › A job dead-lettered). Batches in flight are reconciled by `collectBatch`.
5. Nothing to switch off: the breaker opens after its failure threshold and probes every `openMs`. To stop AI entirely
   (cost incident, provider misbehaving): set `AI_PROVIDER=none` on api, feed-api and worker and redeploy — every
   feature takes its fallback.

## AI provider rejecting

`AiProviderRejecting` (critical): over 90 % of the provider calls in 10 minutes (more than 20 calls) were refused with a
4xx (`outcome="rejected"`), for 5 minutes. The breaker does not open on these and nothing retries them into success:
it does not recover by itself. Features still take their fallbacks, so agencies see "try later" until it is fixed.

1. The status code is in the worker / feed-api log (`kamal app logs … | grep -i 'ai'`): **401 / 403** — the key was
   revoked, rotated or belongs to another workspace; **400 with a billing / credit message** — the account's credit is
   exhausted or its spend limit reached (provider console › Billing); **400 / 404 naming the model** — `AI_MODEL_FAST` /
   `AI_MODEL_SMART` / `AI_EMBED_MODEL` name a model the account may not use or that was retired.
2. Key: create a new one in the provider console, put it in the Kamal secrets (`ANTHROPIC_API_KEY`) of api, feed-api
   and worker, redeploy all three. Credit: top up or raise the limit (owner action), no deploy needed.
3. Model: set a valid model id in the env of the three apps and redeploy; never hard-code one (.claude/rules/ai.md).
4. One feature only (the other features' calls succeed): a request the API no longer accepts — a code fix; the share
   stays under 90 % unless that feature is most of the traffic.
5. Afterwards: queued AI jobs that failed meanwhile are in `ai.dead`; replay them (queues.md › A job dead-lettered).

## AI usage records failing

`AiUsageRecordFailing` (warning): an AI call succeeded but its usage row (`ai_jobs`, counted into `ai_usage_monthly`)
could not be written, or (request path: feed-api, api) could not even be queued as an `ai.recordUsage` job. Until it is
written that spend is not metered against the agency's monthly cap.

1. Rows that failed the first write are retried through the queue (`ai.recordUsage` in the `ai-usage` queue): check the
   queue drains (*Service · worker*, jobs failed by queue) and `ai-usage.dead` stays empty.
2. Enqueue failures (`inmolink_ai_usage_record_enqueue_failures_total`): redis-queue unreachable or the `feed_ai` ACL
   user refused (website-api.md › Redis memory; `redis-cli ACL LOG`). The full row (`job`) is in the error log line
   `ai usage record could not be queued (replay it by hand)`. After the fix, re-enqueue each logged row through the
   job's `defineJob(...).enqueue(payload)` from a script (queues.md › A job dead-lettered) — the row id makes it
   idempotent.
3. Postgres refusing the insert (permissions after a migration, a full disk): fix it, then the queued retries succeed.
