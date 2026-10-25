import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';

/**
 * Who may do what in presentations (PATTERNS §6). Deny by default; services call `assertCan`. Selections are the
 * agency's: any member reads and makes them; Client Mode reads none (a selection names its client and what they did).
 */
export type PresentationsAction = 'presentations.read' | 'presentations.write';

/** Client Mode is read-only (PATTERNS §6): list every read action here, never a write. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<PresentationsAction> = new Set<PresentationsAction>([]);

export function can(ctx: Ctx, action: PresentationsAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'presentations.read':
    case 'presentations.write':
      return sameAgency;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
