/** API error codes the billing page explains (`billing.errors.<code>`); anything else is `generic`. */
export const BILLING_NOTICE_ERRORS = [
  'BILLING_NOT_ENABLED',
  'BILLING_PRICE_UNAVAILABLE',
  'BILLING_ALREADY_SUBSCRIBED',
  'BILLING_NO_CUSTOMER',
  'BILLING_PROVIDER_UNAVAILABLE',
  'FORBIDDEN',
] as const;
