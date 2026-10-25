/** billing — public API (PATTERNS §1). The only import path for other modules and apps. */
export { billingConfig, billingFromEnv, configureBilling } from './config';
export { billingErrors } from './errors';
export { billingEvents } from './events';
export { billingJobs } from './jobs';
export { effectivePlan, planGate } from './plan';
export { BILLING_ACTIONS, can, canStaff } from './policy';
export { type CatalogInput, type PlanInForce, upsertCatalog } from './repo';
export {
  assertSeat,
  getBillingOverview,
  grantPlan,
  listAgencyBillingForStaff,
  listInvoices,
  lockSeats,
  openCustomerPortal,
  planOf,
  receiveStripeWebhook,
  requirePlan,
  revokePlanGrant,
  setPriceLock,
  startCheckout,
} from './service';
export { isSignedStripeDelivery } from './webhook';
