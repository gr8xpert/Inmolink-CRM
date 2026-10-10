import { Button } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { redirect as localeRedirect } from '@/i18n/navigation';
import { fetchMe } from '@/server/api';
import { logoutAction } from './(auth)/actions';

export default async function HomePage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const me = await fetchMe(session.user.id, session.user.sessionVersion);
  // Password reset or deactivation: the web session can no longer mint tokens — end it.
  if (me === 'revoked') redirect('/session/expired');
  const t = await getTranslations('auth');
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('home.title')}</h1>
        <form action={logoutAction}>
          <Button type="submit" variant="outline" size="sm">
            {t('home.logout')}
          </Button>
        </form>
      </div>
      <p className="text-sm">{t('home.signedInAs', { email: session.user.email })}</p>
      <p data-testid="api-check" role="status" className="rounded-md bg-muted p-3 text-sm">
        {me ? t('home.apiOk', { userId: me.userId }) : t('home.apiFailed')}
      </p>
    </main>
  );
}
