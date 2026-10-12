/**
 * API key form error values (S1-05): i18n keys under `apiKeys.errors`. In their own module because a
 * `'use server'` file may export only async functions (S1-10: `next build` refused the constant).
 */
export const KEY_ERRORS = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VERIFICATION_REQUIRED',
  'API_KEY_LIMIT_REACHED',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'generic',
] as const;
export type KeyError = (typeof KEY_ERRORS)[number];
