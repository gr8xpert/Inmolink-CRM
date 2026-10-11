import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';

/** Who may do what in billing (PATTERNS §6). Deny by default; services call `assertCan`. */
export type BillingAction = 'billing.read';

export function can(ctx: Ctx, action: BillingAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'billing.read':
      return sameAgency;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
