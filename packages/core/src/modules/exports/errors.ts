import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const exportsErrors = [
  'PORTAL_CONNECTION_NOT_FOUND',
  'PORTAL_CHANNEL_UNAVAILABLE',
  'PORTAL_CONNECTION_LIMIT_REACHED',
  'PORTAL_CONNECTION_NAME_TAKEN',
  'PORTAL_OVERRIDE_LIMIT_REACHED',
  'PORTAL_FEED_NOT_FOUND',
  'LISTING_NOT_FOUND',
  'VERSION_CONFLICT',
  'VALIDATION_FAILED',
] as const satisfies readonly ErrorCode[];
