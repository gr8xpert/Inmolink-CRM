import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const importsErrors = [
  'FEED_CONNECTION_NOT_FOUND',
  'FEED_RUN_NOT_FOUND',
  'FEED_MAPPING_PROFILE_NOT_FOUND',
  'FEED_CONNECTOR_UNKNOWN',
  'FEED_URL_NOT_ALLOWED',
  'FEED_RUN_ACTIVE',
  'FEED_CONNECTION_DISABLED',
] as const satisfies readonly ErrorCode[];
