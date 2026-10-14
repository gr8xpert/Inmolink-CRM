import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const taxonomyErrors = [
  'LOCATION_NOT_FOUND',
  'LOCATION_PARENT_INVALID',
  'LOCATION_SLUG_TAKEN',
  'LOCATION_ALIAS_TAKEN',
] as const satisfies readonly ErrorCode[];
