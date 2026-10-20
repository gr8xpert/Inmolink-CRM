/**
 * websites worker jobs (PATTERNS §12): `defineJob({ name: 'websites.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 */
export const websitesJobs = {};
