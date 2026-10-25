/** onboarding — public API (PATTERNS §1). The only import path for other modules and apps. S13-04: the checklist. */
export {
  BACKFILL_EVENT_ID,
  BACKFILL_MAX_BATCH,
  type BackfillProgress,
  backfillAgency,
  backfillAgencySteps,
  backfillOnboarding,
} from './backfill';
export { onboardingErrors } from './errors';
export { onboardingEvents } from './events';
export { onboardingJobs } from './jobs';
export {
  CLIENT_MODE_ALLOWED,
  can,
  canStaff,
  type OnboardingAction,
  ROLE_STEPS,
  type StaffOnboardingAction,
  stepsForRole,
} from './policy';
export { getChecklist, getStaffOnboarding } from './service';
export { recordStep, registerOnboardingSubscriptions, unregisterOnboardingSubscriptions } from './subscriptions';
// Never export repo or schema.
