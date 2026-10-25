import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws (`packages/contracts/src/errors.ts`, PATTERNS §9). */
export const documentsErrors = [
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_LISTINGS_INVALID',
] as const satisfies readonly ErrorCode[];
