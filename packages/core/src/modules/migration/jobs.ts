/**
 * migration worker jobs (PATTERNS §12): `defineJob({ name: 'migration.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 */
export const migrationJobs = {};
