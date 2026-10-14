import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';

/** Who may do what in migration (PATTERNS §6). Deny by default; services call `assertCan`. */
export type MigrationAction = 'migration.read';

/** Client Mode is read-only (PATTERNS §6): list every read action here, never a write. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<MigrationAction> = new Set<MigrationAction>(['migration.read']);

export function can(ctx: Ctx, action: MigrationAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'migration.read':
      return sameAgency;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
