import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect } from '@/i18n/navigation';
import { formErrors } from '@/server/form-errors';
import { loginAction } from '../actions';
import { AuthForm } from '../auth-form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  if (await auth()) return redirect({ href: '/', locale: await getLocale() });
  const t = await getTranslations('auth');
  const params = await searchParams;
  const notice = params.verified
    ? t('login.verified')
    : params.reset
      ? t('login.resetDone')
      : params.joined
        ? t('login.joined')
        : null;
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">{t('login.title')}</h1>
      {notice ? (
        <p role="status" className="mb-4 rounded-md bg-muted p-3 text-sm">
          {notice}
        </p>
      ) : null}
      <AuthForm
        action={loginAction}
        submitLabel={t('login.submit')}
        errors={await formErrors()}
        fields={[
          { name: 'email', label: t('login.email'), type: 'email', autoComplete: 'username' },
          { name: 'password', label: t('login.password'), type: 'password', autoComplete: 'current-password' },
        ]}
      />
      <div className="mt-4 flex flex-col gap-2 text-sm">
        <Link href="/forgot-password" className="underline-offset-4 hover:underline">
          {t('login.forgot')}
        </Link>
        <Link href="/signup" className="underline-offset-4 hover:underline">
          {t('login.noAccount')}
        </Link>
      </div>
    </>
  );
}
