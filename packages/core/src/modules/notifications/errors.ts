import type { ErrorCode } from '@inmolink/contracts';

/** Codes this module throws (PATTERNS §9): only shared ones — a member's own notifications have no not-found case. */
export const notificationsErrors = ['FORBIDDEN', 'VALIDATION_FAILED'] as const satisfies readonly ErrorCode[];
