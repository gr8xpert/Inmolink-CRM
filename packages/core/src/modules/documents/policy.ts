import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';

/**
 * Who may do what with PDF documents (PATTERNS §6). Deny by default; services call `assertCan`. Brochures and
 * portfolios are client-facing and white-labelled (no commission, owner or internal note in them), so any member makes
 * them — in Client Mode too (an agent hands the client a brochure from the screen they are showing).
 */
export type DocumentsAction = 'documents.create' | 'documents.read';

/** Client Mode (PATTERNS §6): the documents carry nothing Client Mode hides. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<DocumentsAction> = new Set<DocumentsAction>([
  'documents.create',
  'documents.read',
]);

export function can(ctx: Ctx, action: DocumentsAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'documents.create':
    case 'documents.read':
      return sameAgency;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
