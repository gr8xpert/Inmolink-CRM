import { getTranslations } from 'next-intl/server';
import type { FormErrorMessages } from '@/app/[locale]/(auth)/auth-form';
import type { TwoFactorFormState } from '@/app/[locale]/(auth)/two-factor/actions';

/** Translated messages for every `FormState.error` code, in the request locale. */
export async function formErrors(): Promise<FormErrorMessages> {
  const t = await getTranslations('auth.errors');
  return {
    invalidInput: t('invalidInput'),
    rateLimited: t('rateLimited'),
    challengeRequired: t('challengeRequired'),
    challengeFailed: t('challengeFailed'),
    invalidCredentials: t('invalidCredentials'),
    emailNotVerified: t('emailNotVerified'),
    tokenInvalid: t('tokenInvalid'),
    verifyPassword: t('verifyPassword'),
    inviteEmailInUse: t('inviteEmailInUse'),
    generic: t('generic'),
    fieldInvalid: t('fieldInvalid', { field: '{field}' }),
  };
}

/** Translated messages for every `TwoFactorFormState.error` code (S1-04). */
export async function twoFactorErrors(): Promise<Record<NonNullable<TwoFactorFormState['error']>, string>> {
  const t = await getTranslations('security.errors');
  return {
    invalid: t('invalid'),
    input: t('input'),
    rate_limited: t('rateLimited'),
    forbidden: t('forbidden'),
    password: t('password'),
    generic: t('generic'),
  };
}
