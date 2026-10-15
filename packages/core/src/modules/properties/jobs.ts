/**
 * properties worker jobs (PATTERNS §12): `defineJob({ name: 'properties.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 */
export const propertiesJobs = {};
