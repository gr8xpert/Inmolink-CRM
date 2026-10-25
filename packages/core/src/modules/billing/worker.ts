/**
 * billing — worker-only entry (`@inmolink/core/modules/billing/worker`, S13-02): the outbox subscriptions that start
 * trials. They import `agencies`, which (through compliance and identity) imports billing's public `index.ts`, so they
 * live here rather than in it (no import cycle). Only `apps/worker`, tests and scripts import this file.
 */
export { registerBillingSubscriptions, unregisterBillingSubscriptions } from './subscriptions';
