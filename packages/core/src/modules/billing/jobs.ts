/**
 * billing worker jobs (PATTERNS §12): `defineJob({ name: 'billing.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 */
export const billingJobs = {};
