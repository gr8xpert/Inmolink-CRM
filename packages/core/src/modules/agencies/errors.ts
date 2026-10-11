import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const agenciesErrors = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'VERIFICATION_REQUIRED',
  'AGENCY_DETAILS_LOCKED',
] as const satisfies readonly ErrorCode[];
