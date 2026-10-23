import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws; defined in `packages/contracts/src/errors.ts` (PATTERNS §9). */
export const pluginUpdatesErrors = ['PLUGIN_RELEASE_NOT_FOUND'] as const satisfies readonly ErrorCode[];
