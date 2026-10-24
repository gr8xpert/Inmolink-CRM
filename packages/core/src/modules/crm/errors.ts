import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const crmErrors = [
  'CONTACT_NOT_FOUND',
  'CONTACT_DUPLICATE',
  'CONTACT_PHONE_INVALID',
  'CONTACT_MERGE_INVALID',
  'CONTACT_MERGE_LIMIT',
  'CONTACT_IMPORT_NOT_FOUND',
  'CONTACT_IMPORT_STARTED',
  'CONTACT_IMPORT_FILE_INVALID',
  'LEAD_NOT_FOUND',
  'LEAD_TARGET_NOT_FOUND',
  'ACTIVITY_DATE_OUT_OF_RANGE',
] as const satisfies readonly ErrorCode[];
