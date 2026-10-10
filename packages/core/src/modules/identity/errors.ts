import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const identityErrors = [
  'INVALID_CREDENTIALS',
  'EMAIL_NOT_VERIFIED',
  'TOKEN_INVALID',
  'SESSION_REVOKED',
] as const satisfies readonly ErrorCode[];
