import { PASSWORD_MIN_LENGTH } from '@inmolink/contracts';
import Link from 'next/link';
import { formErrors } from '@/server/form-errors';
import { authT } from '@/server/locale';
import { signupAction } from '../actions';
import { AuthForm } from '../auth-form';

export default async function SignupPage() {
  const t = await authT();
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">{t('signup.title')}</h1>
      <AuthForm
        action={signupAction}
        submitLabel={t('signup.submit')}
        errors={formErrors(t)}
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
