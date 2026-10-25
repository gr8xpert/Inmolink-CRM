/** onboarding DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';
import { MemberRole } from './identity';

/**
 * The onboarding checklist (S13-04, PLAN §7 M21). Steps complete from the agency's real events (listings imported or
 * added, a website created, a teammate invited, a listing shared, the verification approved) — never a manual tick.
 */
export const ONBOARDING_STEPS = [
  'VERIFY_AGENCY',
  'IMPORT_LISTINGS',
  'CONNECT_WEBSITE',
  'INVITE_TEAM',
  'SHARE_LISTING',
] as const;
export const OnboardingStep = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const OnboardingStepDto = z.object({
  step: OnboardingStep,
  /** When the agency's event completed it; null: still to do. */
  completedAt: z.iso.datetime().nullable(),
});
export type OnboardingStepDto = z.infer<typeof OnboardingStepDto>;

const OnboardingProgress = z.object({
  steps: z.array(OnboardingStepDto),
  completed: z.number().int().min(0),
  total: z.number().int().min(0),
});

/**
 * `GET /v1/onboarding`: the caller's checklist — the steps of their role (PLAN §3 #2), in order. `role` lets the
 * dashboard point each step at the right page (a developer's inventory is its developments).
 */
export const OnboardingChecklistDto = OnboardingProgress.extend({ role: MemberRole });
export type OnboardingChecklistDto = z.infer<typeof OnboardingChecklistDto>;

/** `GET /v1/staff/agencies/:agencyId/onboarding`: every step of the agency (staff console tenant page). */
export const StaffOnboardingDto = OnboardingProgress.extend({ agencyId: z.uuid() });
export type StaffOnboardingDto = z.infer<typeof StaffOnboardingDto>;
