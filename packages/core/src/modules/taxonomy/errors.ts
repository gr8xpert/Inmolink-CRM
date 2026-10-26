import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const taxonomyErrors = [
  'LOCATION_NOT_FOUND',
  'LOCATION_PARENT_INVALID',
  'LOCATION_SLUG_TAKEN',
  'LOCATION_ALIAS_TAKEN',
  'TAXONOMY_NOT_FOUND',
  'TAXONOMY_KEY_TAKEN',
  'TAXONOMY_SLUG_TAKEN',
  'TAXONOMY_ALIAS_TAKEN',
  'LOCATION_POLYGON_INVALID',
  'TAXONOMY_ORDER_INVALID',
  'LOCATION_ZONE_TOO_LARGE',
  'TAXONOMY_GROUP_TOO_LARGE',
] as const satisfies readonly ErrorCode[];
