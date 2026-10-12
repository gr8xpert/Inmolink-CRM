import { AGENCY_LOGO_TYPES } from '@inmolink/contracts';
import { Button } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname, Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchAgencyLogoUrl, fetchAgencyProfile, fetchAgencySettings, sessionRef } from '@/server/api';
import { removeLogoAction, uploadLogoAction } from './actions';
import { ProfileForm } from './profile-form';

const LOGO_ERRORS = [
  'invalidInput',
  'forbidden',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'generic',
] as const;
const NOTICES = ['logoUploaded', 'logoRemoved'] as const;

/**
 * Agency profile (S1-06): logo, brand colours, contact details and texts per language — what clients
 * see on white-labelled outputs. Every member sees it; only admins save (the API refuses others). The
 * logo preview is a 5-minute signed link (stub until the media pipeline, S3-03).
 */
export default async function ProfilePage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const ref = sessionRef(session.user);
  const [res, settings] = await Promise.all([fetchAgencyProfile(ref), fetchAgencySettings(ref)]);
  if (res === 'revoked' || settings === 'revoked') redirect('/session/expired');
  const t = await getTranslations('agency');
  const lang = await getTranslations('onboarding');
  const params = await searchParams;
  const notice = NOTICES.find((n) => n === params.notice);
  const error = LOGO_ERRORS.find((e) => e === params.error);

  if (!res.ok) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {res.status === 403 ? t('errors.forbidden') : t('errors.generic')}
        </p>
      </div>
    );
  }
  const profile = res.data;
  const logoUrl = profile.logo ? await fetchAgencyLogoUrl(ref) : null;
  // Text blocks for the published locales, plus any locale that already has texts.
  const enabled = settings.ok ? settings.data.enabledLocales : [];
  const locales = [...new Set([...enabled, ...profile.translations.map((x) => x.locale)])];
  const languageName = (l: string) => lang(`languages.${l}` as never);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('profile.title')}</h1>
        <Link href="/" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('profile.intro')}</p>
      <p className="text-sm">
        {t('detailsLink')}{' '}
        <Link href="/onboarding" className="font-medium underline-offset-4 hover:underline">
          {t('detailsLinkLabel')}
        </Link>
      </p>
      {notice ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`profile.notices.${notice}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      <section aria-labelledby="logo-heading" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="logo-heading" className="font-medium">
          {t('profile.logo.title')}
        </h2>
        {logoUrl && logoUrl !== 'revoked' && logoUrl.ok ? (
          // A short-lived signed link to the private object: not something next/image can optimise.
          // biome-ignore lint/performance/noImgElement: signed private URL, stub until S3-03 variants
          <img src={logoUrl.data.url} alt={t('profile.logo.current')} className="h-16 w-auto self-start" />
        ) : (
          <p className="text-sm text-muted-foreground">{t('profile.logo.none')}</p>
        )}
        <form action={uploadLogoAction} className="flex flex-col gap-2">
          <label htmlFor="logo" className="text-sm">
            {t('profile.logo.file')}
          </label>
          <input id="logo" name="logo" type="file" accept={AGENCY_LOGO_TYPES.join(',')} required className="text-sm" />
          <Button type="submit" size="sm" className="self-start">
            {t('profile.logo.upload')}
          </Button>
        </form>
        {profile.logo ? (
          <form action={removeLogoAction}>
            <Button type="submit" variant="outline" size="sm">
              {t('profile.logo.remove')}
            </Button>
          </form>
        ) : null}
      </section>

      <ProfileForm
        version={profile.version}
        values={{
          primaryColor: profile.primaryColor ?? '',
          accentColor: profile.accentColor ?? '',
          contactEmail: profile.contactEmail ?? '',
          contactPhone: profile.contactPhone ?? '',
          websiteUrl: profile.websiteUrl ?? '',
          texts: Object.fromEntries(
            profile.translations.map((x) => [x.locale, { tagline: x.tagline ?? '', description: x.description ?? '' }]),
          ),
        }}
        locales={locales.map((l) => ({ value: l, label: languageName(l) }))}
        labels={{
          primaryColor: t('profile.fields.primaryColor'),
          accentColor: t('profile.fields.accentColor'),
          contactEmail: t('profile.fields.contactEmail'),
          contactPhone: t('profile.fields.contactPhone'),
          websiteUrl: t('profile.fields.websiteUrl'),
          texts: t('profile.fields.texts'),
          tagline: Object.fromEntries(
            locales.map((l) => [l, t('profile.fields.tagline', { language: languageName(l) })]),
          ),
          description: Object.fromEntries(
            locales.map((l) => [l, t('profile.fields.description', { language: languageName(l) })]),
          ),
          submit: t('profile.submit'),
        }}
        errors={{
          invalidInput: t('errors.invalidInput'),
          conflict: t('errors.conflict'),
          forbidden: t('errors.forbidden'),
          generic: t('errors.generic'),
        }}
        savedMessage={t('profile.saved')}
        loginHref={getPathname({ href: '/login', locale })}
      />
    </div>
  );
}
