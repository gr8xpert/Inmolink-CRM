import { CONTENT_LOCALES } from '@inmolink/i18n';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname, Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchAgencySettings, sessionRef } from '@/server/api';
import { SettingsForm } from './settings-form';
import { settingsValues } from './values';

/**
 * Agency settings (S1-06): default commission, registration and viewing days, published locales,
 * white-label and Client Mode options. Every member sees them; only admins save (the API refuses others).
 */
export default async function SettingsPage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
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
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {res.status === 403 ? t('errors.forbidden') : t('errors.generic')}
        </p>
      ) : (
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
      )}
    </div>
  );
}
