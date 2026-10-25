import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchHome, sessionRef } from '@/server/api';
import { fetchResponseTimeKpi } from '@/server/crm-api';
import { fetchOnboarding } from '@/server/onboarding-api';
import { OnboardingChecklist } from './onboarding-checklist';
import { ResponseTimeCard } from './response-time-card';

/** Dashboard home: who is signed in, the agency's verification step, the API session check. */
export default async function HomePage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  // S10-09: the response-time KPI of the last 30 days is fetched alongside; a member without CRM access (or an API
  // error) sees no card, and neither does a user without an agency
  const ref = sessionRef(session.user);
  const kpiTo = new Date();
  // S13-04: the onboarding checklist too (refused in Client Mode and for users without an agency: no card)
  const [home, kpiResult, onboardingResult] = await Promise.all([
    fetchHome(ref),
    fetchResponseTimeKpi(ref, new Date(kpiTo.getTime() - 30 * 86_400_000), kpiTo),
    fetchOnboarding(ref),
  ]);
  // Password reset or deactivation: the web session can no longer mint tokens — end it.
  if (home === 'revoked') redirect('/session/expired');
  const { me } = home;
  const pending = home.agency?.status === 'PENDING' ? home.agency : null;
  const kpi = home.agency && kpiResult !== 'revoked' && kpiResult.ok ? kpiResult.data : null;
  const checklist = home.agency && onboardingResult !== 'revoked' && onboardingResult.ok ? onboardingResult.data : null;
  const t = await getTranslations('auth');
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('home.title')}</h1>
      <p className="text-sm">{t('home.signedInAs', { email: session.user.email })}</p>
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
      {checklist ? <OnboardingChecklist checklist={checklist} /> : null}
      {kpi ? <ResponseTimeCard kpi={kpi} /> : null}
      <p data-testid="api-check" role="status" className="rounded-md bg-muted p-3 text-sm">
        {me ? t('home.apiOk', { userId: me.userId }) : t('home.apiFailed')}
      </p>
    </div>
  );
}
