---
name: new-module
description: Scaffold a new Inmolink domain module with the standard layout (core module files, Drizzle schema file, contracts, routes, tests, boundary rules). Use when a task introduces a module that does not exist yet.
argument-hint: "<module-name>"
---

# Scaffold module `$0`

Module names are kebab-case and must match PLAN §5.7 (`packages/core/src/modules/`).

1. Run `pnpm gen:module $0` (add `--no-routes` if the module has no dashboard endpoints). It refuses to overwrite anything, formats the files with Biome, and creates:
   - `packages/core/src/modules/$0/` → `index.ts` (public API: errors, events, jobs; add service functions as you write them), `service.ts`, `repo.ts`, `policy.ts` (deny-by-default `can`/`assertCan`), `events.ts`, `jobs.ts`, `errors.ts`, `__tests__/policy.test.ts`
   - `packages/db/src/schema/$0.ts`, re-exported from `packages/db/src/schema/index.ts`
   - `packages/contracts/src/$0.ts`, re-exported from the contracts index
   - `apps/api/src/routes/$0/routes.ts`, registered in `apps/api/src/app.ts`

2. Then, as the task needs them: tables in the schema file + entries in `packages/db/src/tenancy/registry.ts` with the right policy kind (`pnpm db:generate && pnpm db:migrate && pnpm db:rls`); DTOs in contracts; use cases in `service.ts` exported from `index.ts`; `__tests__/service.int.test.ts` with the first use case.

3. Boundaries need no per-module config: `.dependency-cruiser.cjs` rules are generic. The module may import `@inmolink/db/schema/$0` (no other schema file), `@inmolink/db`, `@inmolink/platform`, `@inmolink/contracts`, and other modules **only** via `@inmolink/core/modules/<other>` (their `index.ts`).

4. Run `pnpm check:boundaries && pnpm typecheck`. Commit with the task that introduced the module.
