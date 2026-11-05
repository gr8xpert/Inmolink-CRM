import { MEMBER_PHOTO_TYPES } from '@inmolink/contracts';
import { CONTENT_LOCALES } from '@inmolink/i18n';
import { Button, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchMyPublicProfile, sessionRef } from '@/server/api';
import { isActingAsMember } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { removePhotoAction, savePublicProfileAction, uploadPhotoAction } from './actions';

const ERRORS = [
  'invalidInput',
  'conflict',
  'forbidden',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'generic',
] as const;
const NOTICES = ['saved', 'photoUploaded', 'photoRemoved'] as const;

/**
 * The member's portal profile (S15-F10): one switch to publish it on inmolink.es (off until they turn it on), the name,
 * languages and the phone / e-mail they choose to publish, and a photo. Server forms only (no client JavaScript); the
 * API decides who may change it (the member themselves, never in Client Mode or while staff act as them).
 */
export default async function PublicProfilePage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const res = await fetchMyPublicProfile(sessionRef(session.user));
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('team.publicProfile');
  const lang = await getTranslations('onboarding');
  const params = await searchParams;
  const notice = NOTICES.find((n) => n === params.notice);
  const error = ERRORS.find((e) => e === params.error);

  if (!res.ok) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {res.status === 403 ? t('errors.forbidden') : t('errors.generic')}
        </p>
      </div>
    );
  }
  const shell = await loadShell();
  if (shell && isActingAsMember(shell.identity)) {
    // S17-F48: staff acting as the member cannot change it (the API refuses): say so instead of offering the form.
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p role="status" className="rounded-md bg-muted p-3 text-sm" data-testid="public-profile-acting">
          {(await getTranslations('shell'))('actingUnavailable')}
        </p>
      </div>
    );
  }
  const profile = res.data;
  const spoken = new Set(profile.languages);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Link href="/" className="text-sm underline-offset-4 hover:underline">
          {(await getTranslations('security'))('account.back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {notice ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`notices.${notice}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      <p data-testid="public-profile-status" className="text-sm font-medium">
        {profile.published ? t('status.live') : t('status.off')}
      </p>

      <form action={savePublicProfileAction} className="flex flex-col gap-4 rounded-md border p-4">
        <input type="hidden" name="version" value={profile.version} />
        <div className="flex items-start gap-3">
          <input
            id="published"
            name="published"
            type="checkbox"
            defaultChecked={profile.published}
            className="mt-1 size-4"
          />
          <div>
            <Label htmlFor="published">{t('published')}</Label>
            <p className="text-xs text-muted-foreground">{t('publishedHint')}</p>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="displayName">{t('displayName')}</Label>
          <Input id="displayName" name="displayName" defaultValue={profile.displayName} required maxLength={80} />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t('languages')}</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {CONTENT_LOCALES.map((l) => (
              <label key={l} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="languages" value={l} defaultChecked={spoken.has(l)} className="size-4" />
                {lang(`languages.${l}` as never)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="phone">{t('phone')}</Label>
          <Input id="phone" name="phone" type="tel" defaultValue={profile.phone ?? ''} maxLength={24} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">{t('email')}</Label>
          <Input id="email" name="email" type="email" defaultValue={profile.email ?? ''} maxLength={254} />
          <p className="text-xs text-muted-foreground">{t('contactHint')}</p>
        </div>
        <Button type="submit" className="self-start">
          {t('save')}
        </Button>
      </form>

      <section aria-labelledby="photo-heading" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="photo-heading" className="font-medium">
          {t('photo.title')}
        </h2>
        {profile.version === 0 ? (
          <p className="text-sm text-muted-foreground">{t('photo.saveFirst')}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{profile.photo ? t('photo.current') : t('photo.none')}</p>
            <form action={uploadPhotoAction} className="flex flex-col gap-2">
              <label htmlFor="photo" className="text-sm">
                {t('photo.file')}
              </label>
              <input
                id="photo"
                name="photo"
                type="file"
                accept={MEMBER_PHOTO_TYPES.join(',')}
                required
                className="text-sm"
              />
              <Button type="submit" size="sm" className="self-start">
                {t('photo.upload')}
              </Button>
            </form>
            {profile.photo ? (
              <form action={removePhotoAction}>
                <Button type="submit" variant="outline" size="sm">
                  {t('photo.remove')}
                </Button>
              </form>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
