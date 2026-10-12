/**
 * File templates for `pnpm gen:module` (S0-12) — the PATTERNS §1 layout plus schema, contracts, route
 * plugin and a policy test. Templates hold structure and pointers to PATTERNS, not invented features:
 * the first task that uses the module adds its tables, DTOs, use cases and routes.
 */

export interface ModuleNames {
  /** kebab-case folder and file name, e.g. `saved-searches`. */
  kebab: string;
  /** camelCase import alias, e.g. `savedSearches`. */
  camel: string;
  /** PascalCase type prefix, e.g. `SavedSearches`. */
  pascal: string;
}

export const MODULE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function moduleNames(kebab: string): ModuleNames {
  if (!MODULE_NAME.test(kebab) || kebab.length > 40) {
    throw new Error(`Module name "${kebab}" must be kebab-case (a-z, 0-9, single dashes), at most 40 characters.`);
  }
  const camel = kebab.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return { kebab, camel, pascal: camel.charAt(0).toUpperCase() + camel.slice(1) };
}

/** New files, keyed by repo-relative path. */
export function moduleFiles(n: ModuleNames, opts: { routes: boolean }): Record<string, string> {
  const dir = `packages/core/src/modules/${n.kebab}`;
  const files: Record<string, string> = {
    [`${dir}/index.ts`]: `/** ${n.kebab} — public API (PATTERNS §1). The only import path for other modules and apps. */
export { ${n.camel}Errors } from './errors';
export { ${n.camel}Events } from './events';
export { ${n.camel}Jobs } from './jobs';
// Export service functions and DTO-facing types here as they are added. Never export repo or schema.
`,
    [`${dir}/service.ts`]: `/**
 * ${n.kebab} use cases (PATTERNS §7): \`(ctx: Ctx, input) → DTO\`. Authorize with \`assertCan\`, read and
 * write through \`./repo\`, emit outbox events in the same transaction, never call the network.
 */
`,
    [`${dir}/repo.ts`]: `/**
 * ${n.kebab} queries (PATTERNS §5). Takes \`tx\`, selects only the columns it needs, paginates by cursor.
 * Queries only \`@inmolink/db/schema/${n.kebab}\` — other modules' tables fail \`pnpm check:boundaries\`.
 */
`,
    [`${dir}/policy.ts`]: `import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';

/** Who may do what in ${n.kebab} (PATTERNS §6). Deny by default; services call \`assertCan\`. */
export type ${n.pascal}Action = '${n.camel}.read';

/** Client Mode is read-only (PATTERNS §6): list every read action here, never a write. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<${n.pascal}Action> = new Set<${n.pascal}Action>(['${n.camel}.read']);

export function can(ctx: Ctx, action: ${n.pascal}Action, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case '${n.camel}.read':
      return sameAgency;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
`,
    [`${dir}/events.ts`]: `/**
 * ${n.kebab} events (PATTERNS §8): \`defineEvent('${n.camel}.<entity>.<verb>', 1, schema)\` from
 * \`@inmolink/platform/outbox\`, emitted with \`emit(ctx.tx, …)\` in the same transaction. IDs only.
 */
export const ${n.camel}Events = {};
`,
    [`${dir}/jobs.ts`]: `/**
 * ${n.kebab} worker jobs (PATTERNS §12): \`defineJob({ name: '${n.camel}.<verb><Entity>', … })\` from
 * \`@inmolink/platform/queue\`. Idempotent, batched, per-tenant fair share.
 */
export const ${n.camel}Jobs = {};
`,
    [`${dir}/errors.ts`]: `import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in \`packages/contracts/src/errors.ts\` (PATTERNS §9). */
export const ${n.camel}Errors = [] as const satisfies readonly ErrorCode[];
`,
    [`${dir}/__tests__/policy.test.ts`]: `import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { CLIENT_MODE_ALLOWED, can } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';

function ctxAs(actor: Ctx['actor']): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor,
    locale: 'en',
    requestId: 'test',
    clientMode: false,
  };
}

const user = ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role: 'AGENT' });

describe('${n.kebab} policy', () => {
  it('lets a user read their own agency', () => {
    expect(can(user, '${n.camel}.read')).toBe(true);
    expect(can(user, '${n.camel}.read', { agencyId: AGENCY })).toBe(true);
  });

  it('denies other agencies and non-user actors', () => {
    expect(can(user, '${n.camel}.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), '${n.camel}.read')).toBe(false);
  });

  it('Client Mode is read-only (PATTERNS §6): only read actions are allowed, and they still work', () => {
    for (const action of CLIENT_MODE_ALLOWED) expect(action).toMatch(/\\.(read|list|get)$/);
    expect(can({ ...user, clientMode: true }, '${n.camel}.read')).toBe(true);
  });
});
`,
    [`packages/db/src/schema/${n.kebab}.ts`]: `/**
 * Tables owned by the ${n.kebab} module (PATTERNS §2). Only \`packages/core/src/modules/${n.kebab}\` imports
 * this file (\`pnpm check:boundaries\`). Register each table in \`../tenancy/registry.ts\`, then run
 * \`pnpm db:generate && pnpm db:migrate && pnpm db:rls\`.
 */
`,
    [`packages/contracts/src/${n.kebab}.ts`]: `/** ${n.kebab} DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
`,
  };
  if (opts.routes) {
    files[`apps/api/src/routes/${n.kebab}/routes.ts`] = `import type { FastifyZod } from '@inmolink/platform/server';

/**
 * ${n.kebab} dashboard routes (PATTERNS §10): request and response schemas from \`@inmolink/contracts\`,
 * \`onRequest: [app.requireSession]\`, and a one-expression handler:
 * \`(req) => app.withCtx(req, (ctx) => ${n.camel}.someUseCase(ctx, req.body))\`.
 */
export async function ${n.camel}Routes(_app: FastifyZod): Promise<void> {}
`;
  }
  return files;
}

/** Barrel files that re-export the new schema and contracts files. */
export function barrelEdits(n: ModuleNames): { path: string; line: string }[] {
  return [
    { path: 'packages/db/src/schema/index.ts', line: `export * from './${n.kebab}';` },
    { path: 'packages/contracts/src/index.ts', line: `export * from './${n.kebab}';` },
  ];
}
