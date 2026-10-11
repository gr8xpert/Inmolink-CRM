import { getTranslations } from 'next-intl/server';
import type { FormState } from '@/app/[locale]/(auth)/actions';

/** Translated messages for every `FormState.error` code, in the request locale. */
export async function formErrors(): Promise<Record<NonNullable<FormState['error']>, string>> {
  const t = await getTranslations('auth.errors');
  return {
    invalidInput: t('invalidInput'),
    rateLimited: t('rateLimited'),
    invalidCredentials: t('invalidCredentials'),
    emailNotVerified: t('emailNotVerified'),
    tokenInvalid: t('tokenInvalid'),
    verifyPassword: t('verifyPassword'),
    inviteEmailInUse: t('inviteEmailInUse'),
    generic: t('generic'),
  };
}
