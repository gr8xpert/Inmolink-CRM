/**
 * presentations worker jobs (PATTERNS §12): `defineJob({ name: 'presentations.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 */
export const presentationsJobs = {};
