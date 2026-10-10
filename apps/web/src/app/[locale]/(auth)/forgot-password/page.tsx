import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { formErrors } from '@/server/form-errors';
import { forgotPasswordAction } from '../actions';
import { AuthForm } from '../auth-form';

export default async function ForgotPasswordPage() {
  const t = await getTranslations('auth');
  return (
    <>
      <h1 className="mb-2 text-xl font-semibold">{t('forgot.title')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('forgot.body')}</p>
      <AuthForm
        action={forgotPasswordAction}
        submitLabel={t('forgot.submit')}
        errors={await formErrors()}
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
