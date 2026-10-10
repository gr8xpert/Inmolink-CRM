# ADR 0010 — Modular monolith with enforced boundaries

- **Status:** Accepted (enforced since S0-12)
- **Date:** 2026-10-11
- **Task:** S0-12, S0-16 (PLAN §3 #38 #51, §5.2, §5.7)

## Context

The product has about 30 domain modules (PLAN §5.7) and is built mostly by AI agents, one task per session, over hundreds of sessions. Microservices would add network calls, distributed transactions and deploy overhead that a small team cannot carry. A plain monolith drifts into a tangle when each session is free to reach into any table. We still need workload isolation, so website traffic must not starve the dashboard.

## Decision

1. **One codebase, several deployables.** `apps/web`, `public`, `api`, `feed-api`, `realtime` and `worker` (one process per pool) are separate images with their own DB pool budgets and statement timeouts (bulkheads).
2. **Apps are thin transports.** They authenticate, validate (Zod), call a service and serialize. All business logic lives in `packages/core/src/modules/<module>/` with a fixed layout: `index.ts` (public API), `service.ts`, `repo.ts`, `policy.ts`, `events.ts`, `jobs.ts`, `errors.ts`, `__tests__/`. New modules come from `pnpm gen:module <name>`.
3. **Boundaries:**
   - A module imports another module only through its `index.ts`.
   - A repo queries only its own `packages/db/src/schema/<module>.ts`.
   - Cross-module reactions go through outbox events emitted in the same transaction (PATTERNS §8).
   - Layering: `apps → core → (db, platform, contracts)`, `platform → (config, contracts)`, `ui → contracts`. Infrastructure is reached only through `packages/platform` adapters.
4. **Enforced in CI** by dependency-cruiser (`.dependency-cruiser.cjs`, `pnpm check:boundaries`). The rules are generic (one `$1` capture per rule), so new modules need no config. `pnpm test:boundaries` plants violations in a sandbox copy and fails if any of them pass.
5. **Every service function takes `ctx`** (tx, tenant, actor, locale, requestId, clientMode). There are no globals for tenant or user.

## Consequences

- One deploy, one transaction model and one type system. Refactors across modules are compile-time checked.
- A module can later move out to a service along its `index.ts` and its events, without untangling shared tables.
- Some cross-module reads cost an extra call or an event-fed read model instead of a join. That is the price of the rule, and read models (ADR 0012) are where joins are paid once.
- Known gap: `tx.query.<otherTable>` (ADR 0009). Code review covers it.
