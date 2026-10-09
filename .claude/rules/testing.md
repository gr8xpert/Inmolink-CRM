---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
  - "tests/**"
  - "packages/core/test/**"
---

# Testing rules

- **Name tests after acceptance checks:** `it('[S6-02] respects field locks on re-import', ...)`. Every acceptance check in the backlog task has at least one such test.
- **Unit tests** (Vitest): pure logic (policies, calculators, mappers, parsers). No network, no DB. Fake clock via `vi.useFakeTimers()`.
- **Integration tests** (Vitest, `*.int.test.ts`): services + repos against real Postgres and Redis from the docker `test` profile. Each file gets a fresh schema or truncation; use factories from `packages/core/test/factories`. Never mock the database.
- **Isolation suite** (`tests/isolation`): generated from the tenant registry — for every tenant table, tenant B cannot read, update or delete tenant A's rows through `withTenant`. New tables are covered automatically once registered; do not hand-write exceptions.
- **External HTTP** (portals, Meta, Stripe, AI, feeds): MSW handlers with recorded fixtures in `tests/fixtures/<provider>/`. AI tests use recorded responses; real-model checks live in `pnpm ai:eval`.
- **E2E** (Playwright, `tests/e2e`): only critical flows listed in PLAN §15, against the full local stack with seeded data.
- **Golden tests** (`tests/golden`): legacy v1 API responses; normalized comparison; updating goldens requires a STATUS note.
- **Load** (k6, `tests/load`): scenario per hot path; `pnpm perf:smoke` runs a 60-second version locally against the scale seed.
- Query-count assertions for hot paths: wrap the call in `countQueries()` from `platform/testing` and assert the budget.
- No snapshot tests for business logic. No `test.skip` / `it.only` in commits. Flaky test = bug: fix it, don't retry it.
