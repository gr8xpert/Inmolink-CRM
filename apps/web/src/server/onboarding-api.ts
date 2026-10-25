import { type MemberRole, OnboardingChecklistDto, type OnboardingStep, StaffOnboardingDto } from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * Onboarding checklist (S13-04): the member's checklist (`/v1/onboarding`) and an agency's progress for the staff
 * console (`/v1/staff/agencies/:id/onboarding`). Transport only — steps complete from the agency's events.
 */

export function fetchOnboarding(session: SessionRef): Promise<ApiResult<OnboardingChecklistDto>> {
  return apiRequest(session, '/v1/onboarding', OnboardingChecklistDto);
}

export function fetchStaffOnboarding(session: SessionRef, agencyId: string): Promise<ApiResult<StaffOnboardingDto>> {
  return apiRequest(session, `/v1/staff/agencies/${encodeURIComponent(agencyId)}/onboarding`, StaffOnboardingDto);
}

/**
 * Where each step is done in the dashboard (the checklist's action link and the tour's target nav item) and its
 * help-centre article (`HELP_CENTER_URL/<locale>/<article>`).
 */
export const STEP_LINKS: Readonly<Record<OnboardingStep, { href: string; article: string }>> = {
  VERIFY_AGENCY: { href: '/verification', article: 'verify-your-agency' },
  IMPORT_LISTINGS: { href: '/listings', article: 'import-listings' },
  CONNECT_WEBSITE: { href: '/websites', article: 'connect-your-website' },
  INVITE_TEAM: { href: '/team', article: 'invite-your-team' },
  SHARE_LISTING: { href: '/listings', article: 'share-a-listing' },
};

/** Where a member does a step: a developer's inventory is its developments, everyone else's its listings. */
export function stepHref(step: OnboardingStep, role: MemberRole): string {
  if (step === 'IMPORT_LISTINGS' && (role === 'DEVELOPER_ADMIN' || role === 'DEVELOPER_AGENT')) return '/developments';
  return STEP_LINKS[step].href;
}

/** The help-centre link of a step, or null when no help centre is configured. */
export function helpLink(base: string | undefined, locale: string, step: OnboardingStep): string | null {
  return base ? `${base}/${encodeURIComponent(locale)}/${STEP_LINKS[step].article}` : null;
}
