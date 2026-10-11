import { SPANISH_REGIONS } from '@inmolink/contracts';
import { CONTENT_LOCALES } from '@inmolink/i18n';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchMyAgency, sessionRef } from '@/server/api';
import { OnboardingForm } from './onboarding-form';

/** Company details for staff verification (S1-01): name, CIF/NIF, address, region, languages. */
export default async function OnboardingPage() {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const res = await fetchMyAgency(sessionRef(session.user));
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('onboarding');
  if (!res.ok) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {res.status === 403 ? t('errors.forbidden') : t('errors.generic')}
        </p>
      </main>
    );
  }
  const agency = res.data;
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <span data-testid="agency-status" className="rounded-full bg-muted px-3 py-1 text-xs">
          {t(`status.${agency.status}`)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <OnboardingForm
        version={agency.version}
        values={{
          name: agency.name,
          taxId: agency.taxId ?? '',
          addressLine: agency.addressLine ?? '',
          city: agency.city ?? '',
          postalCode: agency.postalCode ?? '',
          region: agency.region ?? '',
          languages: agency.languages.length > 0 ? agency.languages : [locale],
        }}
        labels={{
          name: t('fields.name'),
          taxId: t('fields.taxId'),
          taxIdHint: t('fields.taxIdHint'),
          addressLine: t('fields.addressLine'),
          city: t('fields.city'),
          postalCode: t('fields.postalCode'),
          region: t('fields.region'),
          languages: t('fields.languages'),
          submit: t('submit'),
        }}
        regions={SPANISH_REGIONS.map((r) => ({ value: r, label: t(`regions.${r}`) }))}
        // Every content locale has a label in the catalog.
        languages={CONTENT_LOCALES.map((l) => ({ value: l, label: t(`languages.${l}` as never) }))}
        errors={{
          invalidInput: t('errors.invalidInput'),
          taxIdFormat: t('errors.taxIdFormat'),
          taxIdControl: t('errors.taxIdControl'),
          conflict: t('errors.conflict'),
          forbidden: t('errors.forbidden'),
          generic: t('errors.generic'),
        }}
        savedMessage={t('saved')}
        loginHref={getPathname({ href: '/login', locale })}
      />
    </main>
  );
}
