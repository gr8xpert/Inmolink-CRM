import type { ListingColumn, ListingSummaryDto } from '@inmolink/contracts';
import { buttonVariants, EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getMessages, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchListingsPage, sessionRef } from '@/server/api';
import { listSearch, parseListState } from './list-query';
import { type ListingRowView, ListingsTable } from './listings-table';
import { ListingsToolbar } from './listings-toolbar';
import { listingTaxonomy } from './taxonomy';

/**
 * The agency's listings (S3-05, S3-07): filters, sort, saved views and a column chooser — all in the URL, so a
 * view is a link — 50 per page (keyset cursor), and bulk actions on the selected rows or on every listing
 * matching the filters, run as a job with progress. Cells are formatted here; the client parts only select.
 */
export default async function ListingsPage(props: { searchParams: Promise<Record<string, string | string[]>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const state = parseListState(await props.searchParams);
  const res = await fetchListingsPage(sessionRef(session.user), state);
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('listings');
  const format = await getFormatter();
  const messages = (await getMessages()) as unknown as { listings: Record<string, unknown> };
  const names = listingTaxonomy(res.taxonomy);
  const members = res.members ?? [];
  const memberName = new Map(members.map((m) => [m.userId, m.name]));
  const dash = '—';

  const cell = (l: ListingSummaryDto, column: ListingColumn): string => {
    switch (column) {
      case 'ref':
        return l.ref;
      case 'type':
        return names.typeName(l.propertyTypeId) ?? dash;
      case 'location':
        return names.locationName(l.locationId)?.split(' › ').at(-1) ?? dash;
      case 'price':
        return l.price
          ? format.number(l.price.amountCents / 100, { style: 'currency', currency: l.price.currency })
          : dash;
      case 'status':
        return t(`editor.options.status.${l.status}`);
      case 'visibility':
        return t(`editor.options.visibility.${l.visibility}`);
      case 'shareScope':
        return t(`editor.options.shareScope.${l.shareScope}`);
      case 'bedrooms':
        return l.bedrooms === null ? dash : format.number(l.bedrooms);
      case 'bathrooms':
        return l.bathrooms === null ? dash : format.number(l.bathrooms);
      case 'builtM2':
        return l.builtM2 === null ? dash : t('units.m2', { value: format.number(l.builtM2) });
      case 'owner':
        return memberName.get(l.ownerUserId) ?? dash;
      case 'tags':
        return l.tags.join(', ') || dash;
      case 'created':
        return format.dateTime(new Date(l.createdAt), { dateStyle: 'medium' });
      case 'updated':
        return format.dateTime(new Date(l.updatedAt), { dateStyle: 'medium' });
    }
  };
  const rows: ListingRowView[] = res.listings.ok
    ? res.listings.data.items.map((l) => ({
        id: l.id,
        cells: Object.fromEntries(state.columns.map((c) => [c, cell(l, c)])) as Record<ListingColumn, string>,
      }))
    : [];
  const next = res.listings.ok ? res.listings.data.nextCursor : null;
  const filtered = Object.keys(state.filter).length > 0;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/bookmarks" className={buttonVariants({ variant: 'outline' })}>
            {t('bookmarks.open')}
          </Link>
          <Link href="/listings/new" className={buttonVariants()}>
            {t('new')}
          </Link>
        </div>
      </div>
      <ListingsToolbar
        state={{ filter: state.filter, sort: state.sort, columns: state.columns }}
        propertyTypes={names.propertyTypes}
        locations={names.locations}
        members={members.map((m) => ({ id: m.userId, label: m.name }))}
        views={res.views?.items ?? []}
        messages={messages.listings}
      />
      {!res.listings.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {res.listings.status === 403
            ? t('errors.FORBIDDEN')
            : res.listings.status === 422
              ? t('errors.VALIDATION_FAILED')
              : t('errors.generic')}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState title={filtered ? t('filters.none') : t('empty')} />
      ) : (
        <ListingsTable
          rows={rows}
          columns={state.columns}
          filter={state.filter}
          members={members.filter((m) => m.status === 'ACTIVE').map((m) => ({ id: m.userId, label: m.name }))}
          messages={messages.listings}
        />
      )}
      {next ? (
        <Link
          href={`/listings?${listSearch(state, next)}`}
          className="self-end text-sm underline-offset-4 hover:underline"
        >
          {t('more')}
        </Link>
      ) : null}
    </div>
  );
}
