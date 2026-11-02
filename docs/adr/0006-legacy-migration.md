# ADR 0006 — Legacy migration: golden-file shim, idempotent ETL, DNS cutover

- **Status:** Accepted (design; implemented in S8-01, S8-02 and S14-01 to S14-06; needs H1, H2, H11)
- **Date:** 2026-10-11
- **Task:** S0-16 (PLAN §2 #8, §9.3, §14)
- **Amended 2026-11-01 (S17-F4, product-owner decision):** the old Inmolink system never runs beside v2. Decisions 1,
  2, 3 and 5 are withdrawn: no golden files, no `/v1` shim (feed-api answers `/v1/*` with 404), no DNS cutover of the
  legacy API hostname, no parallel run or hourly delta. Decisions 4, 6, 7 and 8 stand: the one-time import from a
  restored dump (`legacy_id_maps`, validation report), the legacy URL 301s, Path B. A later restored dump may still be
  loaded once by hand (`legacy:delta`, the cutover's `FINAL_DELTA`). Legacy client websites move to the v2 API.

## Context

Existing Inmolink agencies run websites (WordPress plugin v1 and custom sites) against the legacy API. We do not control those sites, and many have no developer on hand. Principle 8 says moving in is a one-day, done-for-you job. A migration that needs every site to change its integration would take months and lose customers.

## Decision

1. **Capture the contract before writing the shim.** Analyse real legacy API logs (endpoints, parameters, frequency per site). Record normalized responses for representative requests as **golden files** in `tests/golden/`, covering ≥ 99% of traffic.
2. **`/v1` shim on feed-api.** It maps legacy parameters to v2 services and reshapes the responses. CI requires 100% golden-file parity. `/v1` is frozen and gets a 12-month deprecation notice (PLAN §3 #43).
3. **Cutover by DNS.** Point the legacy API hostname at feed-api, and every site migrates without being touched. Rollback is a DNS flip back within minutes during the cutover window.
4. **ETL in `scripts/legacy-migration/` and the `migration` module.** Read-only extract from a legacy dump (never from the live database), transform to v2 models, staging, validation, then merge. Per-agency batches are idempotent and resume from the last checkpoint. `legacy_id_maps` keeps every old ID and reference. Media is re-ingested through the normal pipeline, where dedup applies (ADR 0002). Users get a password-reset flow, because legacy hashes are not imported as-is.
5. **Parallel run with an hourly delta sync** (legacy → v2, change detection by timestamps and hashes). Target: a legacy change is visible in v2 within 70 minutes.
6. **Validation report per agency:** counts per entity, sampled field diffs, media counts and URL checks. Target: under 0.5% unexplained differences before cutover.
7. **Redirects:** `legacy_url_redirects` (per locale) 301s inmolink.es and plugin URLs to their v2 targets.
8. **Path B** (agencies coming from Resales Online or other CRMs): import their own listings and CSV contacts, run both inventories in parallel, and switch at their renewal date.
9. **Decommission** legacy after 90 stable days. A final encrypted archive is kept in R2.

## Consequences

- Golden files are the spec of `/v1`. Any shim change that breaks parity fails CI, even where legacy behaviour looks wrong.
- Real client data never enters the repo. Dumps and API logs live outside it, and golden files are normalized and scrubbed (CLAUDE.md "Never").
- `legacy_id_maps` and the redirect tables are permanent: old references keep working after decommission.
- Migration is blocked on human inputs (legacy dump, API logs, cutover windows). Until they arrive, the toolkit is built and tested against fixtures.
