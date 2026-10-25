import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const matchingErrors = [
  'SAVED_SEARCH_NOT_FOUND',
  'SAVED_SEARCH_LIMIT',
  'NETWORK_GIVE_TO_GET_LOCKED',
  'VERIFICATION_REQUIRED',
] as const satisfies readonly ErrorCode[];
