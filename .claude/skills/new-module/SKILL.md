---
name: new-module
description: Scaffold a new Inmolink domain module with the standard layout (core module files, Drizzle schema file, contracts, routes, tests, boundary rules). Use when a task introduces a module that does not exist yet.
argument-hint: "<module-name>"
---

# Scaffold module `$0`

Module names are kebab-case and must match PLAN §5.7 (`packages/core/src/modules/`).

1. If `pnpm gen:module` exists, run `pnpm gen:module $0` and then check the output against step 2. Otherwise create the files by hand following `docs/build/PATTERNS.md` §1.

2. The module must have:
   - `packages/core/src/modules/$0/` → `index.ts` (exports only the public service functions, types and event types), `service.ts`, `repo.ts`, `policy.ts`, `events.ts`, `jobs.ts`, `errors.ts`, `__tests__/service.int.test.ts`
   - `packages/db/src/schema/$0.ts` (tables owned by this module; re-exported from `packages/db/src/schema/index.ts`)
   - `packages/contracts/src/$0.ts` (Zod DTOs, re-exported from the contracts index)
   - `apps/api/src/routes/$0/routes.ts` (Fastify plugin, registered in the app) — only if the module has dashboard endpoints
   - Tenant tables added to `packages/db/src/tenancy/registry.ts` with the right policy kind

3. Add the module to the boundary config (`.dependency-cruiser.cjs`): it may import `@inmolink/db/schema/$0`, `@inmolink/db` (client/helpers), `@inmolink/platform`, `@inmolink/contracts`, and other modules **only** via `@inmolink/core/modules/<other>` (their `index.ts`).

4. Run `pnpm check:boundaries && pnpm typecheck`. Commit as `chore($0): scaffold module`.
