import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const matchingErrors = [
  'SAVED_SEARCH_NOT_FOUND',
  'SAVED_SEARCH_LIMIT',
  'NETWORK_GIVE_TO_GET_LOCKED',
  'VERIFICATION_REQUIRED',
  'CLIENT_PROFILE_NOT_FOUND',
  'CLIENT_PROFILE_LIMIT',
  'CLIENT_PROFILE_MATCH_NOT_FOUND',
  'CLIENT_PROFILE_MATCH_STATE',
  'CLIENT_PROFILE_MATCH_EXPIRED',
  'CONTACT_NOT_FOUND',
  'VERSION_CONFLICT',
] as const satisfies readonly ErrorCode[];
