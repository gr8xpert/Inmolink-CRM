import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const networkErrors = [
  'NETWORK_POST_NOT_FOUND',
  'NETWORK_POST_CLOSED',
  'NETWORK_SUBSCRIPTION_NOT_FOUND',
  'NETWORK_SUBSCRIPTION_LIMIT',
] as const satisfies readonly ErrorCode[];
