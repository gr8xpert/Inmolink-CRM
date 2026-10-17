import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const developmentsErrors = [
  'DEVELOPMENT_NOT_FOUND',
  'DEVELOPMENT_REF_TAKEN',
  'UNIT_NOT_FOUND',
  'UNIT_REF_TAKEN',
  'DEVELOPMENT_UNIT_LIMIT',
  'PRICE_LIST_NOT_FOUND',
  'PRICE_LIST_REVIEWED',
  'PRICE_LIST_SUPERSEDED',
  'DEVELOPMENT_DOCUMENT_NOT_FOUND',
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_LIMIT_REACHED',
  'PAYLOAD_TOO_LARGE',
] as const satisfies readonly ErrorCode[];
