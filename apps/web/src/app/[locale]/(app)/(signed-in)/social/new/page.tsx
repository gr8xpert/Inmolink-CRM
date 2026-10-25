import { CONTENT_LOCALES } from '@inmolink/i18n';
import { Button, EmptyState, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchAgencyAiFeatures, sessionRef } from '@/server/api';
import { fetchSocialAccounts } from '@/server/social-api';
import { createPostAction } from '../actions';
import { SocialNotice } from '../notice';

/**
 * Compose a social post from a listing (S12-07): the account, the language, a caption (or AI drafts in the chosen
 * languages — a worker writes them; the cover and the next images go), and when it publishes (empty: a draft). The
 * API checks the listing is public and its images are ready.
 */
export default async function NewSocialPostPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const listingId = z.uuid().safeParse(params.listingId).success ? params.listingId : '';
  const [accounts, ai] = await Promise.all([
    fetchSocialAccounts(sessionRef(session.user)),
    fetchAgencyAiFeatures(sessionRef(session.user)),
  ]);
  if (accounts === 'revoked') redirect('/session/expired');
  // S13-F17: AI captions only when the agency switched them on; captions are typed by hand otherwise.
  const aiCaptions = ai !== 'revoked' && ai.ok && ai.data.features.SOCIAL_CAPTIONS;
  const t = await getTranslations('social');
  const usable = accounts.ok ? accounts.data.items.filter((a) => a.status === 'ACTIVE') : [];

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('compose.title')}</h1>
      <SocialNotice error={params.error} />
      {usable.length === 0 ? (
        <EmptyState title={t('compose.noAccounts')} />
      ) : (
        <form action={createPostAction} className="flex flex-col gap-3" data-testid="social-compose">
          <div className="flex flex-col gap-1">
            <Label htmlFor="listingId">{t('compose.listing')}</Label>
            <Input id="listingId" name="listingId" defaultValue={listingId} required className="font-mono text-xs" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="accountId">{t('compose.account')}</Label>
            <select
              id="accountId"
              name="accountId"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              required
            >
              {usable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {t(`platforms.${a.platform}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="locale">{t('compose.locale')}</Label>
            <select
              id="locale"
              name="locale"
              defaultValue={CONTENT_LOCALES.includes(locale as never) ? locale : CONTENT_LOCALES[0]}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              {CONTENT_LOCALES.map((l) => (
                <option key={l} value={l}>
                  {l.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="caption">{t('compose.caption')}</Label>
            <textarea
              id="caption"
              name="caption"
              rows={5}
              maxLength={2200}
              className="rounded-md border bg-background p-2 text-sm"
            />
          </div>
          {aiCaptions ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">{t('compose.aiCaptions')}</legend>
              <div className="flex flex-wrap gap-3 text-sm">
                {CONTENT_LOCALES.slice(0, 8).map((l) => (
                  <label key={l} className="flex items-center gap-1">
                    <input type="checkbox" name="captionLocales" value={l} /> {l.toUpperCase()}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t('compose.aiHint')}</p>
            </fieldset>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor="scheduledAt">{t('compose.when')}</Label>
            <Input id="scheduledAt" name="scheduledAt" type="datetime-local" />
            <p className="text-xs text-muted-foreground">{t('compose.whenHint')}</p>
          </div>
          <div className="flex gap-2">
            <Button type="submit">{t('compose.submit')}</Button>
            <Link href="/social" className="self-center text-sm underline-offset-4 hover:underline">
              {t('compose.back')}
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}
