import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx } from '../../context';

/** Who may do what in taxonomy (PATTERNS §6). Deny by default; services call `assertCan`. */
export type TaxonomyAction = 'taxonomy.read';

/** Client Mode is read-only (PATTERNS §6): list every read action here, never a write. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<TaxonomyAction> = new Set<TaxonomyAction>(['taxonomy.read']);

export function can(ctx: Ctx, action: TaxonomyAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'taxonomy.read':
      return sameAgency;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}

/**
 * Staff actions on the platform taxonomy (S2-04). Every staff role may look; changing reference data every
 * agency shares is data ops work, so support does not (SUPER_ADMIN and STAFF_DATA_OPS).
 */
export type StaffTaxonomyAction = 'staff.taxonomy.read' | 'staff.taxonomy.write';

const TAXONOMY_WRITERS = new Set(['SUPER_ADMIN', 'STAFF_DATA_OPS']);

export function canStaff(ctx: StaffCtx, action: StaffTaxonomyAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.taxonomy.read':
      return true;
    case 'staff.taxonomy.write':
      return TAXONOMY_WRITERS.has(ctx.actor.role);
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}
