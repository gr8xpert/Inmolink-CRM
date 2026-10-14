/**
 * taxonomy worker jobs (PATTERNS §12): `defineJob({ name: 'taxonomy.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 */
export const taxonomyJobs = {};
