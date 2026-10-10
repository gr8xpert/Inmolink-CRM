import Link from 'next/link';
import { formErrors } from '@/server/form-errors';
import { authT } from '@/server/locale';
import { forgotPasswordAction } from '../actions';
import { AuthForm } from '../auth-form';

export default async function ForgotPasswordPage() {
  const t = await authT();
  return (
    <>
      <h1 className="mb-2 text-xl font-semibold">{t('forgot.title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('forgot.body')}</p>
      <AuthForm
        action={forgotPasswordAction}
        submitLabel={t('forgot.submit')}
        errors={formErrors(t)}
        doneMessage={t('forgot.sent')}
        fields={[{ name: 'email', label: t('forgot.email'), type: 'email', autoComplete: 'email' }]}
      />
      <p className="mt-4 text-sm">
        <Link href="/login" className="underline-offset-4 hover:underline">
          {t('login.title')}
        </Link>
      </p>
    </>
  );
}
