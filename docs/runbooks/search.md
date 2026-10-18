# Search runbook

Website search runs on Meilisearch, with a Postgres fallback behind a circuit breaker (S5-04, ADR 0005 #5, PLAN §5.4).
Code: `packages/core/src/modules/search/website.ts`. Alerts: `infra/monitoring/rules/search.yml`.

## Fallback active

`SearchFallbackActive`: a process's breaker has been open (or probing) for over 2 minutes.
`SearchFallbackShareHigh`: over 5 % of website searches were answered by the fallback for 10 minutes. The engine
keeps failing or slowing down on single queries, but not for long enough to keep the breaker open.

What users see: search keeps working, but results are sorted only by the chosen order, text search matches only
references, and facet counts are missing. Detail pages and cached pages are not affected.

1. Is the engine up? `curl -s $MEILI_URL/health` from the app host should print `{"status":"available"}`.
   `docker ps` on the search host shows whether the `meilisearch` container is up and healthy.
2. Is it slow? Any query slower than 250 ms counts as a failure. Check the host's CPU, memory and disk (the index
   must fit in the page cache). Also check for a large indexing backlog: `GET /tasks?statuses=enqueued,processing`.
3. Is the index there? `GET /indexes/listings/stats`. If it is missing (`index_not_found`), every query fails:
   restart the worker (it applies the index settings at boot), then run `pnpm ops:rebuild-read-models` or the
   repair walk (`search.repairIndex`) to queue every document.
4. Once the engine answers, each process closes its breaker on its own: after 30 s one request probes the engine,
   and its success switches that process back. You don't need to restart anything.

The fallback reads `listing_search_docs`, which is written in the same transaction as the read models, so it is
never stale. If it ever looks wrong, `pnpm ops:rebuild-read-models` rebuilds it along with the read models.
