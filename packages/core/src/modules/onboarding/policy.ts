import type { OnboardingStep } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx } from '../../context';

/**
 * Who may do what in onboarding (S13-04, PATTERNS §6). Deny by default; services call `assertCan` / `assertStaffCan`.
 * Every member reads their own checklist; Client Mode reaches nothing (the checklist is the agency's business, not a
 * client's). Nobody ticks a step: steps complete from the agency's events only.
 */
export const ONBOARDING_ACTIONS = ['onboarding.read'] as const;
export type OnboardingAction = (typeof ONBOARDING_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6) — and the checklist is not part of it at all. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<OnboardingAction> = new Set<OnboardingAction>();

export function can(ctx: Ctx, action: OnboardingAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'onboarding.read':
      return sameAgency;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}

/** Staff side: every staff role reads an agency's progress (support and data ops both onboard agencies). */
export type StaffOnboardingAction = 'staff.onboarding.read';

export function canStaff(ctx: StaffCtx, action: StaffOnboardingAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.onboarding.read':
      return true;
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}

/**
 * The checklist of each member role (PLAN §3 #2), in the order shown. Admins run the agency's set-up (verification,
 * website, team); agents bring in and share listings. Developers have no website step (their inventory reaches agencies
 * through the network, PLAN §7 M3). Partners (R4) have no checklist yet. Steps are agency-wide: an agent sees
 * "import listings" done when anyone of the agency did it.
 */
export const ROLE_STEPS: Readonly<Record<string, readonly OnboardingStep[]>> = {
  AGENCY_ADMIN: ['VERIFY_AGENCY', 'IMPORT_LISTINGS', 'CONNECT_WEBSITE', 'INVITE_TEAM', 'SHARE_LISTING'],
  AGENT: ['IMPORT_LISTINGS', 'SHARE_LISTING'],
  DEVELOPER_ADMIN: ['VERIFY_AGENCY', 'IMPORT_LISTINGS', 'INVITE_TEAM', 'SHARE_LISTING'],
  DEVELOPER_AGENT: ['IMPORT_LISTINGS', 'SHARE_LISTING'],
  PARTNER: [],
};

/** The steps of a member role; an unknown role gets none (deny by default). */
export function stepsForRole(role: string): readonly OnboardingStep[] {
  return Object.hasOwn(ROLE_STEPS, role) ? (ROLE_STEPS[role] ?? []) : [];
}
