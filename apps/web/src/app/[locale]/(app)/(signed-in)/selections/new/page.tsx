import { CONTENT_LOCALES } from '@inmolink/i18n';
import { Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchBookmarkFolders } from '@/server/selections-api';
import { createSelectionAction } from '../actions';
import { errorLabels, shareLabels } from '../labels';
import { ShareForm } from '../share-form';

const ids = z.array(z.uuid());

/**
 * Create a selection (S13-F13): from a bookmark folder (`?folder=` preselects it) or from listing ids (`?listingIds=`,
 * comma-separated: search results hand their picks over here), a title, a message, the client's language and the days
 * the link lives. The link is shown once, with the WhatsApp and e-mail buttons.
 */
export default async function NewSelectionPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const ref = sessionRef(session.user);
  const folders = await fetchBookmarkFolders(ref);
  if (folders === 'revoked') redirect('/session/expired');
  const t = await getTranslations('selections');
  const raw = (params.listingIds ?? '').split(',').filter(Boolean);
  const listingIds = ids.safeParse(raw).success ? raw.join(', ') : '';
  const folder = z.uuid().safeParse(params.folder).success ? params.folder : '';
  const contactId = z.uuid().safeParse(params.contactId).success ? params.contactId : '';
  const tt = t as unknown as (key: string) => string;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('create.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('create.intro')}</p>
      <ShareForm
        action={createSelectionAction}
        submit={t('create.submit')}
        errors={errorLabels(tt)}
        share={shareLabels(tt)}
        openLabel={t('create.open')}
      >
        {contactId ? <input type="hidden" name="contactId" value={contactId} /> : null}
        <div className="flex flex-col gap-1">
          <Label htmlFor="title">{t('create.name')}</Label>
          <Input id="title" name="title" required maxLength={200} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="fromFolderId">{t('create.folder')}</Label>
          <select
            id="fromFolderId"
            name="fromFolderId"
            defaultValue={folder}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">{t('create.noFolder')}</option>
            {folders.ok
              ? folders.data.items.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.count})
                  </option>
                ))
              : null}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="listingIds">{t('create.listingIds')}</Label>
          <Input id="listingIds" name="listingIds" defaultValue={listingIds} className="font-mono text-xs" />
          <p className="text-xs text-muted-foreground">{t('create.listingIdsHint')}</p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="message">{t('create.message')}</Label>
          <textarea
            id="message"
            name="message"
            rows={3}
            maxLength={2000}
            className="rounded-md border bg-background p-2 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="locale">{t('create.locale')}</Label>
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
            <Label htmlFor="expiresInDays">{t('create.days')}</Label>
            <Input id="expiresInDays" name="expiresInDays" type="number" min={1} max={365} defaultValue={30} />
          </div>
        </div>
      </ShareForm>
      <Link href="/selections" className="text-sm underline-offset-4 hover:underline">
        {t('back')}
      </Link>
    </div>
  );
}
