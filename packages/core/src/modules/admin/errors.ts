import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const adminErrors = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'STAFF_OPERATION_NOT_FOUND',
  'STAFF_OPERATION_ACTIVE',
  'OUTBOX_REPLAY_TYPE_REFUSED',
] as const satisfies readonly ErrorCode[];
