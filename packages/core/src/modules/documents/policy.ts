import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/**
 * Who may do what with PDF documents (PATTERNS §6). Deny by default; services call `assertCan`. Brochures and
 * portfolios are client-facing and white-labelled (no commission, owner or internal note in them), so any member makes
 * them — in Client Mode too (an agent hands the client a brochure from the screen they are showing).
 *
 * R2-05a, forms: listing and collaboration agreements state the commission, so Client Mode opens no form. A form binds
 * the agency's client or partner to terms: staff impersonating a member may read forms, never make one.
 */
export const DOCUMENTS_ACTIONS = [
  'documents.create',
  'documents.read',
  'documents.forms.create',
  'documents.forms.read',
] as const;
export type DocumentsAction = (typeof DOCUMENTS_ACTIONS)[number];

/** Client Mode (PATTERNS §6): brochures and portfolios carry nothing Client Mode hides; forms do. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<DocumentsAction> = new Set<DocumentsAction>([
  'documents.create',
  'documents.read',
]);

export const DOCUMENTS_IMPERSONATION: ImpersonationRules<DocumentsAction> = {
  'documents.create': 'allowed',
  'documents.read': 'allowed',
  'documents.forms.create': 'forbidden',
  'documents.forms.read': 'allowed',
};

/** Members who work clients (a `PARTNER` membership does not): forms hold client data and commission. */
const MEMBER_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function can(ctx: Ctx, action: DocumentsAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, DOCUMENTS_IMPERSONATION, action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'documents.create':
    case 'documents.read':
      return sameAgency;
    case 'documents.forms.create':
    case 'documents.forms.read':
      return sameAgency && MEMBER_ROLES.has(ctx.actor.role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
