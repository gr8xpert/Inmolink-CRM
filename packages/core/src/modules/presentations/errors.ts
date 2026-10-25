import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws (`packages/contracts/src/errors.ts`, PATTERNS §9). */
export const presentationsErrors = [
  'SELECTION_NOT_FOUND',
  'SELECTION_GONE',
  'SELECTION_ITEMS_INVALID',
] as const satisfies readonly ErrorCode[];
