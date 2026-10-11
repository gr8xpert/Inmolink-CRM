/**
 * agencies worker jobs (PATTERNS §12): `defineJob({ name: 'agencies.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 */
export const agenciesJobs = {};
