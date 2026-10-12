import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const agenciesErrors = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'VERIFICATION_REQUIRED',
  'AGENCY_DETAILS_LOCKED',
  'AGENCY_NOT_ONBOARDED',
  'VERIFICATION_ALREADY_SUBMITTED',
  'VERIFICATION_DOCUMENTS_REQUIRED',
  'VERIFICATION_NOT_OPEN',
  'VERIFICATION_STALE',
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_LIMIT_REACHED',
  'DOCUMENT_LOCKED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
] as const satisfies readonly ErrorCode[];
