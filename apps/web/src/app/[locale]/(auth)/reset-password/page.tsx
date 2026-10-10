import { PASSWORD_MIN_LENGTH } from '@inmolink/contracts';
import { getTranslations } from 'next-intl/server';
import { formErrors } from '@/server/form-errors';
import { resetPasswordAction } from '../actions';
import { AuthForm } from '../auth-form';

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const t = await getTranslations('auth');
  const { token } = await searchParams;
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">{t('reset.title')}</h1>
      {token ? (
        <AuthForm
          action={resetPasswordAction}
          hidden={{ token }}
          submitLabel={t('reset.submit')}
          errors={await formErrors()}
          fields={[
            {
              name: 'password',
              label: t('reset.password'),
              type: 'password',
              autoComplete: 'new-password',
              hint: t('signup.passwordHint', { min: PASSWORD_MIN_LENGTH }),
            },
          ]}
        />
      ) : (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.tokenInvalid')}
        </p>
      )}
    </>
  );
}
