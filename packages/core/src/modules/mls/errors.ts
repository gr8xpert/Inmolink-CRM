import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const mlsErrors = [
  'REGISTRATION_CONFLICT',
  'REGISTRATION_TARGET_NOT_FOUND',
  'REGISTRATION_NOT_FOUND',
  'VIEWING_REQUEST_NOT_FOUND',
  'VIEWING_REQUEST_OPEN',
  'VIEWING_REQUEST_STATE',
  'VIEWING_TERMS_INCOMPLETE',
  'DEAL_NOT_FOUND',
  'DEAL_VIEWING_NOT_ELIGIBLE',
  'DEAL_STATE',
  'DEAL_DISPUTE_NOT_FOUND',
  'DEAL_DISPUTE_STATE',
] as const satisfies readonly ErrorCode[];
