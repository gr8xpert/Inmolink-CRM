import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const billingErrors = [
  'BILLING_NOT_ENABLED',
  'BILLING_PRICE_UNAVAILABLE',
  'BILLING_ALREADY_SUBSCRIBED',
  'BILLING_NO_CUSTOMER',
  'BILLING_PROVIDER_UNAVAILABLE',
  'BILLING_WEBHOOK_INVALID',
  'BILLING_GRANT_NOT_FOUND',
  'PLAN_REQUIRED',
] as const satisfies readonly ErrorCode[];
