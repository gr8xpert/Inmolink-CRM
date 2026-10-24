import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const websitesErrors = [
  'SITE_NOT_FOUND',
  'SITE_LIMIT_REACHED',
  'SITE_FEED_NOT_FOUND',
  'VERSION_CONFLICT',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
] as const satisfies readonly ErrorCode[];
