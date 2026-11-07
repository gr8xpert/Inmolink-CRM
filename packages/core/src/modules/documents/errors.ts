import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws (`packages/contracts/src/errors.ts`, PATTERNS §9). */
export const documentsErrors = [
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_LISTINGS_INVALID',
  'FORMS_NOT_ENABLED',
  'FORM_DOCUMENT_NOT_FOUND',
  'FORM_DATA_INCOMPLETE',
  'ESIGN_NOT_ENABLED',
  'SIGNATURE_REQUEST_NOT_FOUND',
  'FORM_NOT_READY',
  'FORM_ALREADY_SIGNED',
  'SIGNERS_INVALID',
  'AGREEMENT_IN_SIGNATURE',
] as const satisfies readonly ErrorCode[];
