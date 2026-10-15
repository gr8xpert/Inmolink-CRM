import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const mediaErrors = [
  'MEDIA_TYPE_NOT_ALLOWED',
  'MEDIA_NOT_UPLOADED',
  'MEDIA_LIMIT_REACHED',
  'MEDIA_NOT_FOUND',
  'MEDIA_ORDER_STALE',
  'PAYLOAD_TOO_LARGE',
] as const satisfies readonly ErrorCode[];
