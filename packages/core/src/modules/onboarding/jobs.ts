/**
 * onboarding worker jobs (PATTERNS §12): `defineJob({ name: 'onboarding.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 */
export const onboardingJobs = {};
