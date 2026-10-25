import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const supportErrors = [
  'NOT_FOUND',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_LIMIT_REACHED',
] as const satisfies readonly ErrorCode[];
