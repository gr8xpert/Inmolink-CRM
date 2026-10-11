import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const identityErrors = [
  'INVALID_CREDENTIALS',
  'EMAIL_NOT_VERIFIED',
  'TOKEN_INVALID',
  'SESSION_REVOKED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'INVITE_EMAIL_IN_USE',
  'ALREADY_MEMBER',
  'VERIFICATION_REQUIRED',
  'MFA_REQUIRED',
  'MFA_CODE_INVALID',
  'MFA_ALREADY_ENABLED',
  'API_KEY_INVALID',
  'API_KEY_ORIGIN_DENIED',
  'API_KEY_SCOPE_DENIED',
  'API_KEY_LIMIT_REACHED',
] as const satisfies readonly ErrorCode[];
