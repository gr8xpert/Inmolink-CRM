import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const socialErrors = [
  'SOCIAL_NOT_ENABLED',
  'SOCIAL_ACCOUNT_NOT_FOUND',
  'SOCIAL_POST_NOT_FOUND',
  'SOCIAL_ACCOUNT_NEEDS_RECONNECT',
  'SOCIAL_POST_NOT_EDITABLE',
  'SOCIAL_CONNECT_FAILED',
  'SOCIAL_PROVIDER_UNAVAILABLE',
  'VERSION_CONFLICT',
  'VALIDATION_FAILED',
  'FORBIDDEN',
] as const satisfies readonly ErrorCode[];
