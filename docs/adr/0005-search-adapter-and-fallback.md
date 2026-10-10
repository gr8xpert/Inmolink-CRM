# ADR 0005 — Search: one adapter, one listings index, Postgres fallback

- **Status:** Accepted (design; implemented in S5-01 to S5-04)
- **Date:** 2026-10-11
- **Task:** S0-16 (PLAN §3 #16, §5.3, §5.4, §5.5)

## Context

Website search, network search and the portal all filter and facet the same listings. Plan v1 used one index per locale, which multiplied documents and indexing work by about 9. Meilisearch is the simplest engine to run at Stage A, but its HA story may not fit Stage C (a 3-node cluster), so the engine must be swappable. Principle 1 says agency websites never go dark, so search being down must not mean "no results".

## Decision

1. **`platform/search` adapter.** Modules call a small interface (upsert, delete, query with filters, facets, geo and sort, apply settings). Meilisearch is the first implementation. OpenSearch or Typesense can replace it without touching modules.
2. **A single listings index.** One document per listing or new-build unit. It holds localized searchable fields (`title_es`, `title_en`, …), and the query picks the fields for the request locale. Filterable fields: location path, type, price, beds, baths, features, visibility, share scope, owner agency, development, status and geo. Index settings are applied by code, idempotently, at boot.
3. **The index finds IDs; read models answer.** Results are hydrated from `listing_read_models`, which hold per-locale card and detail JSON with a version and an ETag, by primary key. The index never stores client-facing fields that would need white-labelling.
4. **Outbox-driven indexer.** It batches upserts and deletes and debounces per listing. A nightly drift check compares counts and sampled versions and repairs differences. Freshness target: an edit is searchable in under 10 s p95.
5. **Postgres fallback.** A circuit breaker switches to basic filter search over read models and indexes when the engine is down or slow. Ranking is simpler. A metric and an alert fire on the switch. The fallback covers the filters websites use, not full-text relevance.
6. **The feed-api gets a search-only key** (S0-15 follow-up), never the master key.

## Consequences

- One document per listing keeps the index around 2M documents at the design target, and translation edits are one upsert.
- Search ranking and filters can differ slightly between the engine and the fallback. That is acceptable under "degrade, don't fail".
- Every engine feature used must be expressible in the adapter. Engine-specific tricks belong inside the implementation, not in modules.
- Moving to another engine means writing the adapter and running a full reindex from read models. No data lives only in the index.
