import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; define them in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const migrationErrors = [] as const satisfies readonly ErrorCode[];
