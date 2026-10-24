import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const complianceErrors = [
  'DATA_EXPORT_NOT_FOUND',
  'DATA_EXPORT_IN_PROGRESS',
] as const satisfies readonly ErrorCode[];
