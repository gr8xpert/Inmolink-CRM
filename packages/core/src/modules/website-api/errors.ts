import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const websiteApiErrors = [
  'API_KEY_SITE_REQUIRED',
  'SITE_NOT_FOUND',
  'LISTING_NOT_FOUND',
  'DEVELOPMENT_NOT_FOUND',
  'CHANGES_EXPIRED',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'TURNSTILE_FAILED',
  'IDEMPOTENCY_KEY_REUSED',
] as const satisfies readonly ErrorCode[];
