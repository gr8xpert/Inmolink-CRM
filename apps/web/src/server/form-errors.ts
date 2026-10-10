import type { Translate } from '@inmolink/i18n';
import type { FormState } from '@/app/(auth)/actions';

/** Translated messages for every `FormState.error` code. */
export function formErrors(t: Translate): Record<NonNullable<FormState['error']>, string> {
  return {
    invalidInput: t('errors.invalidInput'),
    rateLimited: t('errors.rateLimited'),
    invalidCredentials: t('errors.invalidCredentials'),
    emailNotVerified: t('errors.emailNotVerified'),
    tokenInvalid: t('errors.tokenInvalid'),
    verifyPassword: t('errors.verifyPassword'),
    generic: t('errors.generic'),
  };
}
