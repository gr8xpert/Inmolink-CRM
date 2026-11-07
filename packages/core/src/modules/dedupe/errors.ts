import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const dedupeErrors = [
  'DEDUPE_REVIEW_NOT_FOUND',
  'DEDUPE_REVIEW_STATE',
  'DEDUPE_LISTING_NOT_CLUSTERED',
  'DEDUPE_DISPUTE_CONFLICT',
  'DEDUPE_DISPUTE_NOT_FOUND',
  'DEDUPE_DISPUTE_STATE',
] as const satisfies readonly ErrorCode[];
