import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const chatErrors = [
  'CHAT_THREAD_NOT_FOUND',
  'CHAT_PARTICIPANTS_INVALID',
] as const satisfies readonly ErrorCode[];
