import { AI_FEATURES } from '@inmolink/contracts';
import { Button } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchAgencyAiFeatures, sessionRef } from '@/server/api';
import { inClientMode, isAgencyAdmin } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { setAiFeatureAction } from './actions';

/**
 * AI features (S13-F17): one toggle per AI feature, every one off until an administrator switches it on. Every member
 * sees the toggles; only admins change them: the buttons are off for the others (S17-F34), the API refuses them anyway
 * and records each change in the audit log).
 * Plain forms posting to a server action: no client JavaScript.
 */
export default async function AiFeaturesPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const admin = shell !== null && isAgencyAdmin(shell.identity);
  const res = await fetchAgencyAiFeatures(sessionRef(session.user));
  if (res === 'revoked') redirect('/session/expired');
  const query = await searchParams;
  const t = await getTranslations('agency');

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('aiFeatures.title')}</h1>
        <Link href="/settings" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('aiFeatures.intro')}</p>
      {query.saved === '1' ? (
        <p role="status" className="text-sm">
          {t('aiFeatures.saved')}
        </p>
      ) : null}
      {admin ? null : (
        <p className="rounded-md bg-muted p-3 text-sm" data-testid="admin-only">
          {t('membersReadOnly')}
        </p>
      )}
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error === 'forbidden' ? t('aiFeatures.adminOnly') : t('errors.generic')}
        </p>
      ) : null}
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {res.status === 403 ? t('errors.forbidden') : t('errors.generic')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="ai-features">
          {AI_FEATURES.map((feature) => {
            const on = res.data.features[feature];
            return (
              <li key={feature} className="flex items-start justify-between gap-4 rounded-md border p-4">
                <div className="flex flex-col gap-1">
                  <p className="font-medium">{t(`aiFeatures.features.${feature}.title`)}</p>
                  <p className="text-sm text-muted-foreground">{t(`aiFeatures.features.${feature}.description`)}</p>
                  <p className="text-sm" data-testid={`ai-feature-${feature}`}>
                    {on ? t('aiFeatures.on') : t('aiFeatures.off')}
                  </p>
                </div>
                <form action={setAiFeatureAction}>
                  <input type="hidden" name="feature" value={feature} />
                  <input type="hidden" name="enabled" value={on ? 'false' : 'true'} />
                  <Button type="submit" variant={on ? 'outline' : 'default'} disabled={!admin}>
                    {on ? t('aiFeatures.switchOff') : t('aiFeatures.switchOn')}
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
