/**
 * exports worker jobs (PATTERNS §12): `defineJob({ name: 'exports.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 */
export const exportsJobs = {};
