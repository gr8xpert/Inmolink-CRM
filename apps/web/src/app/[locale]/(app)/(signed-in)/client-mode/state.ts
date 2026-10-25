/** Why a Client Mode form did not go through (i18n keys under `shell.clientModeControl.errors`, S12-06). */
export const CLIENT_MODE_ERRORS = [
  'pin_invalid',
  'pin_mismatch',
  'pin_short',
  'wrong',
  'rate_limited',
  'forbidden',
  'generic',
] as const;
export type ClientModeError = (typeof CLIENT_MODE_ERRORS)[number];

export interface ClientModeFormState {
  error?: ClientModeError;
}
