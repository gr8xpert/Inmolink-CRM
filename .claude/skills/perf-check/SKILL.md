---
name: perf-check
description: Check the current change against Inmolink performance budgets — query plans, query counts, endpoint latency, bundle size and job throughput. Use after changing feed-api, search, imports, matching, media, read models, list endpoints or public pages.
argument-hint: "[scope e.g. feed-api | search | imports | web-route /path]"
---

# Performance check — scope: `$ARGUMENTS` (default: everything touched by the uncommitted diff)

Budgets are in `CLAUDE.md`. Use the `scale` seed (`pnpm db:seed:scale --agencies=1000` locally; 5,000 on staging) — never judge performance on the dev fixture.

1. **Find hot code in the diff**: `git diff --stat` and `git diff` → list new/changed queries, endpoints, jobs, pages.

2. **SQL**: for each new or changed query on a hot path run `EXPLAIN (ANALYZE, BUFFERS)` with realistic parameters (via `pnpm db:explain <file>` or psql). Flag: Seq Scan on tables > 10k rows, rows-removed-by-filter ≫ rows returned, sorts spilling to disk, nested loops over large sets, execution > 20 ms. Fix with indexes or query changes, then re-run.

3. **Query count**: run the endpoint's integration test with `countQueries()`; assert ≤ 3 (feed-api) or ≤ 10 (dashboard). Look for N+1 patterns (queries inside loops, per-item lookups).

4. **Latency**: `pnpm perf:smoke <scenario>` (k6, 60 s) for affected endpoints; record p50/p95/p99 and error rate.

5. **Frontend** (if pages changed): `pnpm --filter <app> analyze` → first-load JS per affected route vs budget (public: framework ≤ 149 KB + route ≤ 30 KB gzip, ADR 0013; JS chunks served `immutable` for 1 year); check that heavy components are dynamically imported.

6. **Jobs** (if workers changed): run the job on the scale seed; record throughput, peak RSS and whether other tenants' jobs were delayed (fair share).

7. **Report** as a table — check · result · budget · pass/fail — plus fixes made. Paste the summary line into the task's STATUS entry. Any remaining failure blocks DONE.
