import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getMessages, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchBookmarksPage, sessionRef } from '@/server/api';
import { listingTaxonomy } from '../listings/taxonomy';
import { BookmarkItem, type BookmarkView } from './bookmark-item';
import { FolderControls } from './folder-controls';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The member's bookmarks (S3-09): folders on the side, the open folder's listings (`?folder=`, 50 per page,
 * keyset) with notes. A listing that left the member's view stays in the folder, marked unavailable, with its
 * note. Cells are formatted here; the client parts only edit.
 */
export default async function BookmarksPage(props: { searchParams: Promise<Record<string, string | string[]>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await props.searchParams;
  const folderParam = one(params.folder);
  const cursorParam = one(params.cursor);
  const folderId = folderParam && UUID.test(folderParam) ? folderParam : undefined;
  const cursor = folderId && cursorParam && CURSOR.test(cursorParam) ? cursorParam : undefined;
  const res = await fetchBookmarksPage(sessionRef(session.user), folderId, cursor);
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('listings');
  const format = await getFormatter();
  const messages = (await getMessages()) as unknown as { listings: Record<string, unknown> };
  const names = listingTaxonomy(res.taxonomy);
  const errorText = (code: string | undefined) =>
    code && t.has(`bookmarks.errors.${code}` as never)
      ? t(`bookmarks.errors.${code}` as never)
      : t('bookmarks.errors.generic');

  const folders = res.folders.ok ? res.folders.data.items : [];
  const current = folders.find((f) => f.id === folderId) ?? null;
  const items: BookmarkView[] =
    res.bookmarks?.ok === true
      ? res.bookmarks.data.items.map((b) => {
          const l = b.listing;
          const facts = l
            ? [
                names.typeName(l.propertyTypeId),
                names.locationName(l.locationId)?.split(' › ').at(-1),
                l.price
                  ? format.number(l.price.amountCents / 100, { style: 'currency', currency: l.price.currency })
                  : null,
                l.bedrooms === null ? null : t('bookmarks.bedrooms', { count: format.number(l.bedrooms) }),
                l.builtM2 === null ? null : t('units.m2', { value: format.number(l.builtM2) }),
                t(`editor.options.status.${l.status}`),
              ].filter((x): x is string => Boolean(x))
            : [];
          return {
            id: b.id,
            listingId: b.listingId,
            note: b.note,
            available: b.available,
            ref: l?.ref ?? null,
            own: l?.own ?? false,
            facts,
            saved: format.dateTime(new Date(b.createdAt), { dateStyle: 'medium' }),
          };
        })
      : [];
  const next = res.bookmarks?.ok === true ? res.bookmarks.data.nextCursor : null;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">{t('bookmarks.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('bookmarks.intro')}</p>
      </div>
      {!res.folders.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(res.folders.error?.code)}
        </p>
      ) : (
        <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
          <nav aria-label={t('bookmarks.folders')} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">{t('bookmarks.folders')}</h2>
            {folders.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('bookmarks.noFolders')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {folders.map((f) => (
                  <li key={f.id}>
                    <Link
                      href={`/bookmarks?folder=${f.id}`}
                      aria-current={f.id === folderId ? 'page' : undefined}
                      className="flex justify-between rounded-md px-2 py-1 text-sm hover:bg-accent aria-[current=page]:bg-accent aria-[current=page]:font-medium"
                    >
                      <span className="truncate">{f.name}</span>
                      <span className="text-muted-foreground">{format.number(f.count)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <FolderControls current={current} messages={messages.listings} />
          </nav>
          <section className="flex flex-col gap-3">
            {!current ? (
              <EmptyState title={t('bookmarks.pickFolder')} />
            ) : res.bookmarks && !res.bookmarks.ok ? (
              <p role="alert" className="text-sm text-destructive">
                {errorText(res.bookmarks.error?.code)}
              </p>
            ) : items.length === 0 ? (
              <EmptyState title={t('bookmarks.empty')} />
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((b) => (
                  <BookmarkItem key={b.id} bookmark={b} messages={messages.listings} />
                ))}
              </ul>
            )}
            {current && next ? (
              <Link
                href={`/bookmarks?folder=${current.id}&cursor=${next}`}
                className="self-end text-sm underline-offset-4 hover:underline"
              >
                {t('bookmarks.more')}
              </Link>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
