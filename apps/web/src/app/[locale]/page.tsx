import { Button } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchHome, sessionRef } from '@/server/api';
import { logoutAction } from './(auth)/actions';

export default async function HomePage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const home = await fetchHome(sessionRef(session.user));
  // Password reset or deactivation: the web session can no longer mint tokens — end it.
  if (home === 'revoked') redirect('/session/expired');
  const { me } = home;
  const pending = home.agency?.status === 'PENDING' ? home.agency : null;
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
      <nav className="flex gap-4">
        <Link href="/account/security" className="text-sm font-medium underline-offset-4 hover:underline">
          {t('home.security')}
        </Link>
        {home.agency ? (
          <>
            <Link href="/team" className="text-sm font-medium underline-offset-4 hover:underline">
              {t('home.team')}
            </Link>
            <Link href="/api-keys" className="text-sm font-medium underline-offset-4 hover:underline">
              {t('home.apiKeys')}
            </Link>
            <Link href="/profile" className="text-sm font-medium underline-offset-4 hover:underline">
              {t('home.profile')}
            </Link>
            <Link href="/settings" className="text-sm font-medium underline-offset-4 hover:underline">
              {t('home.settings')}
            </Link>
            <Link href="/preferred-agencies" className="text-sm font-medium underline-offset-4 hover:underline">
              {t('home.preferred')}
            </Link>
          </>
        ) : (
          // No agency: staff (or a user without one). The page 404s for non-staff (S1-03).
          <Link href="/staff/verification" className="text-sm font-medium underline-offset-4 hover:underline">
            {t('home.staffVerification')}
          </Link>
        )}
      </nav>
      {pending ? (
        <div data-testid="agency-pending" role="status" className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <p>{t('home.agencyPending', { agency: pending.name })}</p>
          {pending.onboarded ? (
            <Link href="/verification" className="font-medium underline-offset-4 hover:underline">
              {t('home.verify')}
            </Link>
          ) : (
            <Link href="/onboarding" className="font-medium underline-offset-4 hover:underline">
              {t('home.completeOnboarding')}
            </Link>
          )}
        </div>
      ) : null}
      <p data-testid="api-check" role="status" className="rounded-md bg-muted p-3 text-sm">
        {me ? t('home.apiOk', { userId: me.userId }) : t('home.apiFailed')}
      </p>
    </main>
  );
}
