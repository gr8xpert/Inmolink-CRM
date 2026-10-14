import { Button } from '@inmolink/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { sessionRef } from '@/server/api';
import { hasImpersonationCookie, readImpersonation } from '@/server/impersonation';
import { fetchStaffMe } from '@/server/staff-api';
import { dismissEndedImpersonationAction, endImpersonationAction } from './(app)/staff/actions';
import { ImpersonationCountdown } from './impersonation-countdown';

/**
 * Shown on every page while a staff member acts as someone else (S1-09, PLAN §12): who, where, until
 * when, and a button that ends it. Rendered by the locale template, so it re-renders on every navigation,
 * and from the live session (`GET /v1/staff/me`, only while this browser holds an impersonation cookie):
 * a session that ended elsewhere shows as ended, with a button that clears it.
 */
export async function ImpersonationBanner() {
  if (!(await hasImpersonationCookie())) return null;
  const session = await auth();
  if (!session?.user?.id) return null;
  const stored = await readImpersonation(session.user.id, { includeExpired: true });
  if (!stored) return null;
  const me = await fetchStaffMe(sessionRef(session.user));
  const live = me !== 'revoked' && me.ok ? me.data.impersonation : null;
  const t = await getTranslations('staff');
  const format = await getFormatter();
  const className =
    'flex flex-wrap items-center justify-between gap-3 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-950';

  if (!live || live.id !== stored.id) {
    return (
      <div role="status" data-testid="impersonation-banner" className={className}>
        <p>{t('impersonation.bannerEnded', { user: stored.userName, agency: stored.agencyName })}</p>
        <form action={dismissEndedImpersonationAction}>
          <Button type="submit" size="sm" variant="outline">
            {t('impersonation.dismiss')}
          </Button>
        </form>
      </div>
    );
  }
  const seconds = Math.max(0, Math.ceil((Date.parse(live.expiresAt) - Date.now()) / 1_000));
  return (
    <div role="status" data-testid="impersonation-banner" className={className}>
      <p>
        {t('impersonation.banner', {
          user: live.userName,
          agency: live.agencyName,
          time: format.dateTime(new Date(live.expiresAt), { timeStyle: 'short' }),
        })}{' '}
        <ImpersonationCountdown
          expiresAt={live.expiresAt}
          initialSeconds={seconds}
          template={t('impersonation.left', { time: '{time}' })}
        />
      </p>
      <form action={endImpersonationAction}>
        <Button type="submit" size="sm" variant="outline">
          {t('impersonation.end')}
        </Button>
      </form>
    </div>
  );
}
