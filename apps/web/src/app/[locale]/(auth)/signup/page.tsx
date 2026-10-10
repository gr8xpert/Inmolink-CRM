import { PASSWORD_MIN_LENGTH } from '@inmolink/contracts';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { formErrors } from '@/server/form-errors';
import { signupAction } from '../actions';
import { AuthForm } from '../auth-form';

export default async function SignupPage() {
  const t = await getTranslations('auth');
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">{t('signup.title')}</h1>
      <AuthForm
        action={signupAction}
        submitLabel={t('signup.submit')}
        errors={await formErrors()}
        doneMessage={`${t('signup.checkEmailTitle')}. ${t('signup.checkEmailBody')}`}
        fields={[
          { name: 'name', label: t('signup.name'), autoComplete: 'name' },
          { name: 'email', label: t('signup.email'), type: 'email', autoComplete: 'email' },
          {
            name: 'password',
            label: t('signup.password'),
            type: 'password',
            autoComplete: 'new-password',
            hint: t('signup.passwordHint', { min: PASSWORD_MIN_LENGTH }),
          },
        ]}
      />
      <p className="mt-4 text-sm">
        <Link href="/login" className="underline-offset-4 hover:underline">
          {t('signup.haveAccount')}
        </Link>
      </p>
    </>
  );
}
