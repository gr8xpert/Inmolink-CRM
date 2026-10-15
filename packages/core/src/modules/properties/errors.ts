import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const propertiesErrors = [
  'LISTING_NOT_FOUND',
  'ENERGY_RATING_REQUIRED',
  'LISTING_STATUS_INVALID',
  'LISTING_RESTORE_UNAVAILABLE',
] as const satisfies readonly ErrorCode[];
