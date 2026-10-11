# ADR 0014 — Outbox wake-up without NOTIFY in business transactions

- **Status:** Proposed (needs approval — S0 sprint review)
- **Date:** 2026-10-11
- **Task:** S0 review; changes S0-06 (outbox), decide before S6 (imports)

## Context

S0-06 built the dispatcher with a LISTEN/NOTIFY wake-up: `emit()` runs `notify outbox` inside every business transaction that emits an event, and the dispatcher polls only as a fallback. Postgres serialises the commits of all transactions that sent a NOTIFY, because it takes one database-wide lock on the notification queue at commit. Every write path emits events (PATTERNS §8), so later imports, CRM writes and matching would all commit one at a time. Each emit also costs one extra round trip. Nothing has measured the effect yet; the S0 perf review flagged it from the known Postgres behaviour. LISTEN also needs a session connection that bypasses PgBouncer (`DATABASE_URL_LISTEN`).

## Decision

Proposed, pending approval. The options:

1. **Poll only (recommended).** `emit()` no longer sends NOTIFY. Each dispatcher lane polls every 250 ms through the existing index `outbox_events_pending_idx`, and keeps going without a pause while batches are full. Event latency is ≤ 250 ms, compared with about 10 ms with NOTIFY. `DATABASE_URL_LISTEN` and `packages/db/src/listen.ts` are removed.
2. **Coalesced NOTIFY.** A small process sends at most one `pg_notify` per 100 ms when new rows exist, outside any business transaction. This keeps low latency, but adds a moving part that also has to poll.
3. **Keep NOTIFY.** First measure commit throughput with NOTIFY against polling in the S6 import load test, and decide then.

## Consequences

- Option 1 changes the S0-06 build spec ("LISTEN/NOTIFY wake-up"). The test `[S0-06] NOTIFY wakes an idle dispatcher immediately` becomes "an idle dispatcher picks up an event within one poll interval". The ≥ 2,000 events/s acceptance check stays as it is.
- Idle cost under option 1: 4 lanes × 4 polls/s on an index that is empty when idle, a few microseconds each.
- Auth emails and other user-visible events wait up to 250 ms longer.
- The STATUS follow-up "dedicated `app_listen` role" is no longer needed under option 1.
