import { formErrors } from '@/server/form-errors';
import { authT } from '@/server/locale';
import { verifyEmailAction } from '../actions';
import { AuthForm } from '../auth-form';

/**
 * Confirmation happens on an explicit POST, not on page load: mail scanners that prefetch links
 * must not burn the single-use token. It also needs the account password (pre-account hijack, ADR 0004).
 */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const t = await authT();
  const { token } = await searchParams;
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">{t('verify.title')}</h1>
      {token ? (
        <AuthForm
          action={verifyEmailAction}
          hidden={{ token }}
          intro={t('verify.body')}
          fields={[
            { name: 'password', label: t('verify.password'), type: 'password', autoComplete: 'current-password' },
          ]}
          submitLabel={t('email.verify.action')}
          errors={formErrors(t)}
        />
      ) : (
        <p role="alert" className="text-sm text-destructive">
          {t('verify.failed')}
        </p>
      )}
    </>
  );
}
