# Queues, dead letters and outbox replay

PLAN §5.3 #5–#7, §17. Background work flows **outbox (Postgres) → dispatcher (worker pool `outbox`) → BullMQ jobs (redis-queue) → workers**. Postgres is the source of truth. A job lost in Redis can be rebuilt from the outbox.

## Where things are

| What | Where |
|---|---|
| Pending and processed events | `outbox_events` (Postgres; dead-lettered events have `dead_at` set) |
| Queues | redis-queue, key prefix `inl`, one BullMQ queue per pool (`imports`, `media`, `email`, …) |
| Dead letters | queue `<pool>.dead`, one entry per final failure: `{ jobId, payload, error, attemptsMade, failedAt }`. Kept 30 days, nothing consumes it |
| Metrics | queue depth and age per pool (worker `/metrics`, BullMQ OTel metrics); alerts on queue age (PLAN §5.6) |

## Jobs pile up (queue age alert)

1. Find which pool and which tenant. Check the worker logs for `job dead-lettered` and slow job spans in the trace backend (Jaeger locally). Fair share caps each tenant, so one big import cannot block the pool (PLAN §3 #39).
2. Check that the worker for that pool is running: `/healthz` and `/readyz` on the worker health port, and that `WORKER_POOLS` includes the pool.
3. If the pool is healthy but saturated, add a worker process or node for that pool (scale trigger in PLAN §5.6). Do not raise per-tenant caps.

## A job dead-lettered

A job lands in `<pool>.dead` after its last retry, or straight away for a permanent failure (invalid payload, or the handler throws `UnrecoverableError` from `@inmolink/platform/queue`).

1. Inspect it: for example `redis-cli -u $REDIS_QUEUE_URL --scan --pattern 'inl:<pool>.dead:*'`. Better, open the queue in a BullMQ UI pointed at redis-queue (read-only), and read `error` and `payload`.
2. Fix the cause (code, data or the external service), and deploy if needed.
3. Re-run it. Jobs are idempotent (CLAUDE.md worker budget), so re-running is safe:
   - **When an outbox event produced the job (most cases):** replay the event, `pnpm ops:replay-outbox --id <event id>`, or by type and time window `--type <t> --since <iso> --until <iso>`. Add `--dry-run` first to see the count.
   - **When the job was enqueued directly** (no outbox event): re-enqueue it from a script through the job's `defineJob(...).enqueue(payload)`, so it goes through the same schema and fair-share path. Never push raw entries into BullMQ keys.
4. Remove the handled entries from `<pool>.dead`, or leave them to expire after 30 days.

## Outbox events dead-lettered

The dispatcher marks an event dead after its retries (consumer failing). After the fix:

```sh
pnpm ops:replay-outbox --dead --dry-run   # how many
pnpm ops:replay-outbox --dead             # re-queue them
```

Filter with `--type`, `--agency <uuid>` or `--since/--until` to replay one slice.

## redis-queue lost data (crash without AOF, or restored from scratch)

1. Bring redis-queue back (Ansible role `redis_queue`; AOF on, `noeviction`).
2. Replay the outbox for the gap: `pnpm ops:replay-outbox --since <last good time> --until <now>`. Consumers are idempotent, so overlap is harmless.
3. Directly enqueued jobs in that window are not in the outbox. Their owning modules re-create them from their own state on the next scheduled run (nightly or drift jobs). Check the module runbook if one exists.

## Feed imports wait in the queue (ImportQueueWaitHigh, S6-08)

Feed runs run one per agency at a time, at most `IMPORT_RUNS_PER_PROCESS` (default 2) in one worker process — so a
process stays under 512 MB RSS — and at most `IMPORT_MAX_CONCURRENT_RUNS` (default 24) across every `imports` worker.
Runs at once are therefore min(24, 2 × `imports` processes): keep about 12 processes running the `imports` pool for
the full 24. The staff console's **Import health** page shows queued/running runs, the oldest wait and the failures.

1. Many runs queued, few running: workers are down or busy — check the `imports` pool containers and their logs.
2. Running at the cap for long: add `imports` worker processes (each adds `IMPORT_RUNS_PER_PROCESS` runs), raise
   `IMPORT_MAX_CONCURRENT_RUNS` (watch the database write load) once processes × runs per process exceeds it; do not
   raise `IMPORT_RUNS_PER_PROCESS` without checking the container's memory (a 100 MB run adds about 150 MB); the fair share keeps one agency's many feeds from blocking the others either way.
3. One huge feed per agency is normal (S6-02: a 100 MB feed takes about a minute); hours of waiting are not.

## A feed was paused (ImportFeedPaused, S6-08)

The anomaly guard paused a connection: a run read more than `IMPORT_ANOMALY_SPIKE_FACTOR` (5) × the feed's typical
item count, or more than `IMPORT_ANOMALY_DROP_RATIO` (30 %) of its listings vanished at once, or (`EMPTY_FEED`,
S7-F1) a run stored no valid item — the feed was empty or every item failed — while the connection still has live
listings. Nothing past the spike was written and nothing was withdrawn. The agency sees the notice on its feed page.

1. Open **Import health** in the staff console: the paused feed, its reason and counts.
2. Ask the agency whether the change is real (portfolio sold, feeds merged). Agency admins resume it themselves; data
   ops and super admins can resume it from the dashboard with a reason (the ticket, what was checked; S7-F1: stored
   on the connection for staff, the audit row only records that one was given). "Accept the change" lets the next run
   skip the guard once; without it the next run is checked again. An accepted empty run still withdraws nothing.
3. `EMPTY_FEED`: check the feed URL answers with listings (a CRM export that broke, a moved file, an expired key).

## Never

- Never `FLUSHALL` redis-queue. It holds jobs, fair-share state and dead letters.
- Never edit `outbox_events` rows by hand. Use `ops:replay-outbox`.
