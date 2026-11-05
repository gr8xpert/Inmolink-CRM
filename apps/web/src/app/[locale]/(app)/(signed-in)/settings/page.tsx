import { CONTENT_LOCALES } from '@inmolink/i18n';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { getPathname, Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchAgencySettings, sessionRef } from '@/server/api';
import { inClientMode, isActingAsMember, isAgencyAdmin } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { SettingsForm } from './settings-form';
import { settingsValues } from './values';

/**
 * Agency settings (S1-06): default commission, registration and viewing days, published locales,
 * white-label and Client Mode options. Every member sees them; only admins can change them: the form is read-only for
 * the others (S17-F34) and the API refuses them anyway.
 */
export default async function SettingsPage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const admin = shell !== null && isAgencyAdmin(shell.identity);
  // S17-F48: `agencies.settings.update` is refused to staff acting as a member: say so, not "only an administrator".
  const acting = shell !== null && isActingAsMember(shell.identity);
  const res = await fetchAgencySettings(sessionRef(session.user));
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('agency');
  const lang = await getTranslations('onboarding');

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
        <Link href="/" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('settings.intro')}</p>
      {/* S13-F17: the AI feature toggles have their own page. */}
      <Link href="/settings/ai" className="text-sm font-medium underline-offset-4 hover:underline">
        {t('aiFeatures.link')}
      </Link>
      {/* S16-F5: the data retention period (step-up, grace window) has its own page. */}
      <Link href="/settings/retention" className="text-sm font-medium underline-offset-4 hover:underline">
        {t('retention.link')}
      </Link>
      {res.ok && !admin ? (
        <p className="rounded-md bg-muted p-3 text-sm" data-testid="admin-only">
          {acting ? (await getTranslations('shell'))('actingUnavailable') : t('membersReadOnly')}
        </p>
      ) : null}
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {res.status === 403 ? t('errors.forbidden') : t('errors.generic')}
        </p>
      ) : (
        <fieldset disabled={!admin} className="contents">
          <SettingsForm
            version={res.data.version}
            values={settingsValues(res.data)}
            labels={{
              commission: {
                title: t('settings.commission.title'),
                type: t('settings.commission.type'),
                types: {
                  PCT: t('settings.commission.types.PCT'),
                  FIXED: t('settings.commission.types.FIXED'),
                },
                percent: t('settings.commission.percent'),
                amount: t('settings.commission.amount'),
                currency: t('settings.commission.currency'),
                currencyPlaceholder: t('settings.commission.currencyPlaceholder'),
                includesVat: t('settings.commission.includesVat'),
                split: t('settings.commission.split'),
                splitHint: t('settings.commission.splitHint'),
              },
              registrationValidityDays: t('settings.fields.registrationValidityDays'),
              viewingResponseDays: t('settings.fields.viewingResponseDays'),
              enabledLocales: t('settings.fields.enabledLocales'),
              timeZone: t('settings.fields.timeZone'),
              whiteLabel: {
                title: t('settings.whiteLabel.title'),
                referencePrefix: t('settings.whiteLabel.referencePrefix'),
                showPoweredBy: t('settings.whiteLabel.showPoweredBy'),
                emailSenderName: t('settings.whiteLabel.emailSenderName'),
              },
              clientMode: {
                title: t('settings.clientMode.title'),
                intro: t('settings.clientMode.intro'),
                pinMinLength: t('settings.clientMode.pinMinLength'),
                pinMaxAttempts: t('settings.clientMode.pinMaxAttempts'),
              },
              submit: t('settings.submit'),
            }}
            // Every content locale has a label in the onboarding catalog.
            locales={CONTENT_LOCALES.map((l) => ({ value: l, label: lang(`languages.${l}` as never) }))}
            errors={{
              invalidInput: t('errors.invalidInput'),
              conflict: t('errors.conflict'),
              forbidden: t('errors.forbidden'),
              generic: t('errors.generic'),
            }}
            savedMessage={t('settings.saved')}
            loginHref={getPathname({ href: '/login', locale })}
          />
        </fieldset>
      )}
    </div>
  );
}
