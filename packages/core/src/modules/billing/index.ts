/** billing — public API (PATTERNS §1). The only import path for other modules and apps. */
export { billingConfig, billingFromEnv, configureBilling } from './config';
export { billingErrors } from './errors';
export { billingEvents } from './events';
export { billingJobs } from './jobs';
export { effectivePlan } from './plan';
export { BILLING_ACTIONS, can } from './policy';
export { type CatalogInput, upsertCatalog } from './repo';
export {
  assertSeat,
  getBillingOverview,
  listInvoices,
  openCustomerPortal,
  receiveStripeWebhook,
  startCheckout,
} from './service';
