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
2. Is it slow? Any query slower than `SEARCH_SLOW_MS` (default 80 ms) counts as a failure, and from then on the
   fallback runs beside it — the first answer wins (`reason="engine_slow"` on `inmolink_search_queries_total`); the
   engine call is cut at `SEARCH_ENGINE_TIMEOUT_MS` (100 ms). The breaker opens on 5 failures in a row
   (`SEARCH_BREAKER_FAILURES`) or on half of ≥ 20 calls within 10 s (`SEARCH_BREAKER_FAILURE_RATIO`,
   `SEARCH_BREAKER_MIN_CALLS`, `SEARCH_BREAKER_WINDOW_MS`; S6-F3). Check the host's CPU, memory and disk (the index
   must fit in the page cache). Also check for a large indexing backlog: `GET /tasks?statuses=enqueued,processing`.
   While the engine is slow but the breaker still closed, each slow request also runs one fallback statement (the
   loser is not cancelled): at most `SEARCH_HEDGE_MAX_IN_FLIGHT` (16) at once per process, then requests wait for
   the engine up to its timeout. Expect extra Postgres load on `listing_search_docs` until the breaker opens.
3. Is the index there? `GET /indexes/listings/stats`. If it is missing (`index_not_found`), every query fails:
   restart the worker (it applies the index settings at boot), then run `pnpm ops:rebuild-read-models` or the
   repair walk (`search.repairIndex`) to queue every document.
4. Once the engine answers, each process closes its breaker on its own: after 30 s (`SEARCH_BREAKER_OPEN_MS`) one
   request probes the engine,
   and its success switches that process back. You don't need to restart anything.

The fallback reads `listing_search_docs`, which is written in the same transaction as the read models, so it is
never stale. If it ever looks wrong, `pnpm ops:rebuild-read-models` rebuilds it along with the read models.

## Network search rollout (S5-05)

Migration 0071 adds `listing_read_models.allowed_agency_ids` (who a PRIVATE_NETWORK development is shared with) and
the index gains the filterable field `allowedAgencyIds`. Existing rows have it null, so units of developments shared
before the deploy stay out of the partners' network search until rebuilt. After the first deploy with 0071:

1. Let the worker boot apply the index settings and wait until Meilisearch has finished the settings task (a new
   filterable attribute re-indexes the whole index; until then network search answers `503 SERVICE_UNAVAILABLE`,
   website search falls back to Postgres as usual).
2. Run `pnpm ops:rebuild-read-models` once (it rewrites unit read models whose `allowed_agency_ids` changed and queues
   their index pushes).
3. Check: a partner of a PRIVATE_NETWORK development finds its units with **New-builds only** on `/network`.

The api needs `MEILI_SEARCH_KEY` (search-only key) for network search; without it the route answers 503 and the api
logs `no MEILI_SEARCH_KEY` at boot. Give-to-get is configured by `NETWORK_GIVE_TO_GET_MIN_SHARED` (default 5) and
`NETWORK_GIVE_TO_GET_GRACE_DAYS` (default 30).

## Index-side network access (S6-F2)

Migration 0078 adds `listing_read_models.network_hidden` (a PUBLIC listing hidden from the network for freshness) and
`preferred_agency_ids` (on a PREFERRED listing: the agencies its owner prefers); the index gains the filterable
fields `networkHidden`, `preferredAgencyIds` and `id` (comparable, and `id` sortable: the repair walk pages by id).
Network search now filters PREFERRED listings by `preferredAgencyIds = caller` instead of passing the owners that
prefer the caller. After the first deploy with 0078:

1. Let the worker boot apply the index settings and wait until Meilisearch has finished the settings task (three new
   filterable attributes re-index the whole index; until then network search answers `503 SERVICE_UNAVAILABLE` —
   its filter names fields the index does not have yet — and website search falls back to Postgres as usual).
2. Run `pnpm ops:rebuild-read-models` once (one run also covers S6-F1): it writes the two columns where they are set
   and queues those targets' index pushes. Until then PREFERRED listings are missing from partners' network search
   and freshness-hidden PUBLIC listings still count in totals (and drop out of the page, as before).
3. Check: a partner of an agency that shares a listing to PREFERRED finds it on `/network`; the drift check
   (`search.checkIndexDrift`) reports no drift once the queue has drained.

A change to an agency's preferred list re-queues only its PREFERRED listings (`agencies.preferred.added` /
`.removed`).

## White-labelled index text (S7-F5)

The listings index matches free text on each document's title and description as the white-label sanitizer leaves
them: plain text without the owner's names (legal, directory, e-mail sender, its team's full names; in any case,
accents and spacing), office address, tax id, contact and team e-mails, phone, website (and its main label) or own
reference, and without any e-mail, URL, domain, phone number or Spanish tax id. Every document's `sourceHash`
includes the sanitizer version (`SANITIZER_VERSION` in `packages/core/src/white-label.ts`) and its owner's identity.
No migration and no index settings change.

**The full reindex is a required deploy step.** Until a document is pushed again, free text on a network site can
still match its owner's details. After the first deploy with S7-F5:

1. Deploy feed-api with `SEARCH_NETWORK_FREE_TEXT=false`: free text on sites showing network listings then matches
   the site's own listings only (network listings stay findable by filters and by `<prefix>-<code>`).
2. Once the worker is up, enqueue `search.repairIndex` (the nightly drift check would start it too: every
   `sourceHash` changed). It queues every document. Wait until `search_index_queue` has drained.
   `pnpm ops:rebuild-read-models` does **not** re-push unchanged documents. The Postgres fallback rows don't change
   (they hold no text).
3. Check: on a site showing network listings, searching an owner agency's name, phone or website host returns none
   of its listings. Then set `SEARCH_NETWORK_FREE_TEXT=true` (the default) and restart feed-api.

An agency's documents are re-pushed when its identity changes: `agencies.profile.updated` and
`agencies.details.updated` with `identityChanged` (contacts; name, tax id or address), `agencies.settings.changed`
with `whiteLabel` (sender name), and `agencies.verification.decided` APPROVED. Team changes are caught by the drift
check. If you change the sanitizer rules, raise `SANITIZER_VERSION` and repeat the reindex steps.
