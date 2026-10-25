import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const aiFeaturesErrors = [
  'FORBIDDEN',
  'LISTING_NOT_FOUND',
  'VALIDATION_FAILED',
  'AI_BUDGET_EXCEEDED',
  'AI_UNAVAILABLE',
] as const satisfies readonly ErrorCode[];
