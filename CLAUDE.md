# Inmolink v2 — Claude operating manual

AI-native MLS + CRM + website engine for Spanish estate agencies and developers. TypeScript on Node.js + PostgreSQL, built as a **modular monolith**. Must scale to 5,000 agencies (~2M listings, ~60M media, 1,000 rps website API at origin) without a redesign.

- **What and why:** `PLAN.md` — read only the sections a task cites.
- **What to build next:** `docs/build/STATUS.md` → the task in `docs/build/BACKLOG-R1.md` or `docs/build/BACKLOG-R2-R4.md`.
- **How to write it:** `docs/build/PATTERNS.md` — copy these shapes; do not invent new ones.
- Detailed rules load automatically from `.claude/rules/` when you touch matching files.

## Session protocol
1. Read `docs/build/STATUS.md`. Work on the task under **Now**. If empty, take the first `TODO` task in sprint order whose dependencies are all `DONE`.
2. Read that task, the PLAN sections it cites, and the PATTERNS sections it needs. Nothing else unless required.
3. Write a short plan: files to create/change, and one test per acceptance check. Then implement.
4. Run `pnpm verify`. Fix until green. Run `/perf-check` if the task touches a hot path (see budgets).
5. Update STATUS (task → `DONE` + one-line summary, next task under **Now**), add a CHANGELOG line, commit: `feat(<module>): <summary> [S3-02]`.
6. One task per session where possible. When context gets long: finish, commit, then suggest `/clear`.

## Commands (created in S0-01; add new ones to root `package.json`)
- `pnpm dev` (starts the docker `dev` stack, then apps) · `pnpm build` · `pnpm verify` (typecheck + lint + boundaries + unit + integration + isolation for affected packages; needs Docker)
- `pnpm infra:up` · `pnpm infra:down` · `pnpm infra:health` · `pnpm infra:up:test` · `pnpm infra:health:test`
- `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:rls` · `pnpm db:seed` · `pnpm db:seed:scale --agencies=5000`
- `pnpm gen:module <name>` · `pnpm test` · `pnpm test:int` · `pnpm test:isolation` · `pnpm test:e2e` · `pnpm perf:smoke`
- `pnpm i18n:draft` · `pnpm ai:eval <feature>` · `pnpm sdk:generate`

## Architecture — golden rules
1. Business logic lives only in `packages/core/src/modules/<module>/`. Apps (`apps/*`) are thin: authenticate, validate, call a service, serialize.
2. Module layout: `index.ts` (public API) · `service.ts` · `repo.ts` · `policy.ts` · `events.ts` · `jobs.ts` · `errors.ts` · `__tests__/`. Create with `pnpm gen:module`.
3. A module imports another module only through its `index.ts`. A repo queries only its own `packages/db/src/schema/<module>.ts` tables. Cross-module reactions go through outbox events.
4. Every service function takes `ctx` (tx, tenant, actor, locale, requestId, clientMode). Never read tenant or user from globals.
5. Every tenant table has `agency_id`, is in the tenant registry, and gets RLS from `pnpm db:rls`. Runtime uses `withTenant()`; `withSystem()` only in workers/scripts with an audit reason.
6. Changes others react to emit an outbox event in the **same** transaction. Never call search, email, AI or external HTTP inside a DB transaction.
7. Anything slow (> ~100 ms) or external runs in a worker job, not in the request.
8. DTOs and error codes live in `packages/contracts` (Zod). Routes declare request **and** response schemas.
9. Public read paths (feed-api, portal, selections) read `listing_read_models` and the search adapter — never per-request joins over raw tables.
10. Infrastructure only via `packages/platform` adapters (cache, queue, outbox, search, storage, email, pdf, ai, safe-fetch, flags, crypto).

## Performance budgets — a task is not done if it breaks one
| Path | Budget |
|---|---|
| feed-api endpoint | p95 < 150 ms at origin · ≤ 3 queries · ≤ 150 KB gzip · Cache-Control + ETag set |
| Dashboard API endpoint | p95 < 300 ms · ≤ 10 queries · no N+1 · cursor pagination, max 100 |
| SQL on a hot path | p95 < 20 ms on the scale seed · no Seq Scan on tables > 10k rows · only needed columns |
| Public page | LCP < 2.0 s mobile · first-load JS ≤ 120 KB gzip |
| Dashboard route | first-load JS ≤ 250 KB gzip · maps/charts/editors via dynamic import |
| Worker job | idempotent · per-tenant fair share · batched · RSS < 512 MB |

Hot paths: feed-api, search, imports, matching, media, read models, any list endpoint, anything in a loop over listings or contacts.

## Security — always
- Zod-validate every input. SQL only through Drizzle or the `sql` template — never string concatenation.
- Authorize inside services via `policy.ts` (`can(ctx, action, resource)`), not only in routes.
- No secrets or PII in logs. Encrypt stored credentials with `platform/crypto`.
- User-supplied URLs only through `safeFetch`; XML only through the XXE-safe streaming parser; uploads checked by magic bytes and size.
- Client-facing outputs are white-labelled: never expose owner agency, commission, owner contacts or internal notes to buyers. Client Mode strips them server-side.

## Definition of Done
- [ ] Every acceptance check of the task has a named test: `it('[S3-02] owner-only writes', ...)`
- [ ] `pnpm verify` green; no skipped tests
- [ ] Migrations generated and applied; new tenant tables registered, RLS generated, isolation suite covers them
- [ ] Contracts + OpenAPI updated; `pnpm sdk:generate` if the website API changed
- [ ] Budgets met (`/perf-check` output pasted into the STATUS entry for hot-path tasks)
- [ ] UI strings in `packages/i18n` — EN and ES written, other locales via `pnpm i18n:draft`
- [ ] STATUS.md and CHANGELOG.md updated; ADR if a decision changed
- [ ] Committed with the task ID

## Never
- Business logic in apps, route handlers or React components.
- Bypassing RLS in request paths, or connecting as the owner/migration role at runtime.
- OFFSET pagination on large tables, `SELECT *` on hot paths, unbounded queries, queries inside loops.
- Hard-coded AI model IDs, prices, commission values, locales or URLs.
- AI writing prices, commission, legal text or facts — those come from data.
- Changing a PLAN §3 decision silently — write a proposed ADR and flag it in STATUS.
- Marking a task DONE with failing, skipped or missing tests.
- Committing `.env`, keys, database dumps or real client data. Legacy dumps live outside the repo.
- Hand-editing generated files (applied migrations, SDK output, RLS SQL).
- Adding a heavy dependency when a platform adapter or a small library does the job; note every new dependency in CHANGELOG.

## When blocked or unsure
- Missing human input (`docs/build/HUMAN-ACTIONS.md`): build against fixtures or mocks behind a feature flag, mark the task `BLOCKED-HUMAN Hn` in STATUS, move to the next unblocked task.
- Ambiguity: pick the option most consistent with PLAN §2 principles and §3 decisions; record the assumption under **Decisions** in STATUS.
- A pattern does not fit: propose the change in STATUS; do not fork a new pattern silently.

## Reviews
- After a module-sized task, run the `code-reviewer` subagent on the diff. Tasks touching auth, RLS, API keys, imports, uploads, payments or webhooks also run `security-auditor`.
- End of sprint: `/sprint-review`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
