/**
 * billing events (PATTERNS §8): `defineEvent('billing.<entity>.<verb>', 1, schema)` from
 * `@inmolink/platform/outbox`, emitted with `emit(ctx.tx, …)` in the same transaction. IDs only.
 */
export const billingEvents = {};
