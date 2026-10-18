import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what with developments (PATTERNS §6). Deny by default; services call `assertCan`. */
export const DEVELOPMENTS_ACTIONS = [
  'development.read',
  'development.create',
  /** Fields, units, phases and price list uploads. */
  'development.update',
  'development.delete',
  /** OPEN / PRIVATE_NETWORK and the allowed agencies. */
  'development.share',
  /** The development's or a unit's commission (the deal offered to collaborating agencies). */
  'development.commission',
  /** The owner's price list versions and diffs. */
  'priceList.read',
  /** Approve a price list version: its prices are applied to the units. */
  'priceList.approve',
  /**
   * Open a development's documents (S4-F4): the owner's all, another agency's the shared ones (RLS). Never in
   * Client Mode: documents are internal (a brochure may carry the owner's branding). The owner's non-shared ones
   * (contracts, internal price lists) need a writer role: PARTNER members read the shared ones only (S5-F1), as
   * they never open listing documents.
   */
  'developmentDocument.read',
  /** Upload, re-classify and delete the own development's documents. */
  'developmentDocument.manage',
  /** Make a document readable by collaborating agencies, or not (admins, like `development.share`). */
  'developmentDocument.share',
] as const;
export type DevelopmentsAction = (typeof DEVELOPMENTS_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6): list every read action here, never a write. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<DevelopmentsAction> = new Set<DevelopmentsAction>(['development.read']);

/**
 * Staff impersonating a member (S1-09): they may read and fix a development's data (units, prices, uploads), never
 * delete it, change who sees it, change the commission or approve a price list (the deal and its publication are
 * the agency's).
 */
export const DEVELOPMENTS_IMPERSONATION: ImpersonationRules<DevelopmentsAction> = {
  'development.read': 'allowed',
  'development.create': 'allowed',
  'development.update': 'allowed',
  'development.delete': 'forbidden',
  'development.share': 'forbidden',
  'development.commission': 'forbidden',
  'priceList.read': 'allowed',
  'priceList.approve': 'forbidden',
  // Like listing documents (S4-F1): private files are neither opened nor changed by staff.
  'developmentDocument.read': 'forbidden',
  'developmentDocument.manage': 'forbidden',
  'developmentDocument.share': 'forbidden',
};

/** Roles that administer the agency's developments. */
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);
/** Roles that maintain developments; PARTNER members only read. */
const WRITER_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

/** `shared` is a document's flag (`developmentDocument.read`); other actions ignore it. */
export function can(ctx: Ctx, action: DevelopmentsAction, resource?: { agencyId: string; shared?: boolean }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, DEVELOPMENTS_IMPERSONATION, action)) return false;
  const { role } = ctx.actor;
  // Only the owner agency writes (other agencies read shared developments through RLS, never write them).
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'development.read':
      return true; // RLS decides which developments are visible; the service picks the view
    case 'developmentDocument.read':
      // RLS shows other agencies the shared documents only; the own agency's internal ones need a writer.
      return !resource || !sameAgency || resource.shared === true || WRITER_ROLES.has(role);
    case 'development.create':
    case 'development.update':
    case 'priceList.read':
    case 'developmentDocument.manage':
      return sameAgency && WRITER_ROLES.has(role);
    case 'development.delete':
    case 'development.share':
    case 'developmentDocument.share':
    case 'development.commission':
    case 'priceList.approve':
      return sameAgency && ADMIN_ROLES.has(role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
