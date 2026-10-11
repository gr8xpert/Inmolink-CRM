/**
 * Tables owned by the billing module (PATTERNS §2). Only `packages/core/src/modules/billing` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */
