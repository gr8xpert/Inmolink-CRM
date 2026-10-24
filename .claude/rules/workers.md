---
paths:
  - "apps/worker/**"
  - "packages/core/src/modules/**/jobs.ts"
  - "packages/platform/src/queue/**"
  - "packages/platform/src/outbox/**"
---

# Worker & job rules (BullMQ)

- Pools (separate processes, deployable to separate nodes): `imports`, `media`, `indexing`, `matching`, `exports`, `email`, `realtime`, `digest`, `ai`, `social`, `pdf`, `maintenance`, `outbox`.
  - `realtime` is the live-push lane (chat messages, read receipts, in-app notifications) and `digest` the notification e-mail digests: a bursty, deferrable job kind gets its own pool rather than a per-process cap inside a latency pool (S11 review: capped jobs bounce through delayed and share the pool's fair-share backlog).
- Job handlers live in the owning module's `jobs.ts`; `apps/worker/src/processors/<pool>.ts` only wires queue → handler.
- Payloads carry IDs and small parameters only (< 10 KB). Load data inside the job.
- **Idempotent always**: a job may run twice. Use natural idempotency keys (`jobId = <type>:<entityId>:<version>`) and upserts.
- **Fair share**: tenant-scoped jobs use the tenant as the group key; per-tenant concurrency caps from `platform/queue/fairness.ts`. One agency's 100 MB feed must never delay others.
- Retries: exponential backoff (5 attempts default); permanent errors (`AppError` with `retryable: false`) fail fast to the dead-letter queue with a reason.
- Timeouts on every external call; circuit breakers from `platform` for search, AI, email, portals, Meta.
- Batch work: process in chunks (≤ 1,000 rows / ≤ 100 API calls), commit per chunk, report progress (`job.updateProgress`).
- Never hold a DB transaction open across a network call.
- `withSystem(reason)` is allowed in workers for cross-tenant jobs (matching, dedupe, indexing); write the reason, scope queries tightly.
- Scheduled jobs use repeatable jobs with a stable `jobId`; document the schedule in the module's `jobs.ts` header.
- Graceful shutdown: stop taking jobs, finish or release in-flight jobs within 30 s.

## Outbox
- Producers call `emit(tx, event)` inside the business transaction. Event types are declared in the module's `events.ts` with a Zod payload schema and a version.
- The dispatcher polls every 250 ms (no LISTEN/NOTIFY, ADR 0014), claims events with `FOR UPDATE SKIP LOCKED` shared fairly between agencies, fans out to subscriber queues, and marks them processed. Consumers must tolerate duplicates and out-of-order delivery (compare `version`/`updatedAt`).
- Delivery is tracked per event, not per subscriber: a failing subscriber makes the retry re-run every subscriber of that event. Each subscriber must be idempotent on its own (stable `jobId`, upsert, check-then-act).
- Debounce high-frequency events (listing edits) per entity before expensive work (reindex, read-model rebuild, matching).
