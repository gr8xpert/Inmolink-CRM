/**
 * developments worker jobs (PATTERNS §12): `defineJob({ name: 'developments.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 */
export const developmentsJobs = {};
