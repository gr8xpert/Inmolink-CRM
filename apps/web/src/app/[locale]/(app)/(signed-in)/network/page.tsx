import type { NetworkCommission, NetworkSearchItem } from '@inmolink/contracts';
import { buttonVariants, EmptyState, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getMessages, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchNetworkPage, sessionRef } from '@/server/api';
import { webConfig } from '@/server/env';
import { BookmarkButton } from '../listings/[id]/bookmark-button';
import { listingTaxonomy } from '../listings/taxonomy';
import { MapView } from './map-view';
import { type NetworkState, networkBody, networkSearch, parseNetworkState } from './query';

const SORTS = ['newest', 'price_asc', 'price_desc', 'beds_desc', 'area_desc'] as const;
const select = 'h-9 rounded-md border bg-background px-2 text-sm';

/**
 * Network search (S5-05, PLAN §3 #5 #7 #57): other agencies' shared listings and new-build units with the commission
 * terms upfront — total, split and what the caller earns — and the listing agent (agent side only; the API refuses
 * Client Mode). Filters live in the URL (a plain GET form, so a search is a link); the map view loads MapLibre on
 * demand. Below the give-to-get threshold after the grace period the API answers LOCKED: an upsell, not results.
 */
export default async function NetworkPage(props: { searchParams: Promise<Record<string, string | string[]>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const state = parseNetworkState(await props.searchParams);
  const res = await fetchNetworkPage(sessionRef(session.user), networkBody(state));
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('network');
  const format = await getFormatter();
  const messages = (await getMessages()) as unknown as { listings: Record<string, unknown> };
  const names = listingTaxonomy(res.taxonomy);
  const config = await webConfig();

  const money = (m: { amountCents: number; currency: string }) =>
    format.number(m.amountCents / 100, { style: 'currency', currency: m.currency, maximumFractionDigits: 0 });
  const percent = (bp: number) => format.number(bp / 10_000, { style: 'percent', maximumFractionDigits: 2 });
  const commissionText = (c: NetworkCommission | null): string[] => {
    if (!c) return [t('commission.none')];
    const split = c.splitBp === null ? t('commission.splitUnknown') : percent(c.splitBp);
    const head =
      c.type === 'PCT' && c.totalBp !== null
        ? t('commission.pct', { total: percent(c.totalBp), split })
        : c.fixed
          ? t('commission.fixed', { amount: money(c.fixed), split })
          : t('commission.none');
    return [
      c.includesVat ? `${head} (${t('commission.vat')})` : head,
      c.viewerEarnings ? t('commission.earn', { amount: money(c.viewerEarnings) }) : t('commission.earnUnknown'),
    ];
  };
  const hrefOf = (i: NetworkSearchItem) =>
    i.card.kind === 'LISTING' ? `/listings/${i.id}` : `/developments/${i.card.development.id}`;
  const priceOf = (i: NetworkSearchItem) =>
    i.card.price.onRequest || i.card.price.amountCents === null
      ? t('results.priceOnRequest')
      : money({ amountCents: i.card.price.amountCents, currency: i.card.price.currency });
  const placeOf = (i: NetworkSearchItem) => {
    const p = i.card.place;
    return [p.area, p.city, p.region].flatMap((x) => (x ? [x.name] : [])).join(', ');
  };
  const factsOf = (i: NetworkSearchItem) =>
    [
      i.card.propertyType.name,
      i.card.bedrooms === null ? null : t('results.beds', { count: i.card.bedrooms }),
      (i.card.kind === 'LISTING' ? i.card.builtM2 : i.card.internalM2) === null
        ? null
        : t('results.m2', {
            value: format.number((i.card.kind === 'LISTING' ? i.card.builtM2 : i.card.internalM2) as number),
          }),
    ].filter((x): x is string => Boolean(x));
  const link = (change: Partial<NetworkState>) => `/network?${networkSearch(state, { cursor: undefined, ...change })}`;

  const result = res.result;
  const error = !result.ok
    ? (() => {
        const code = result.error?.code;
        return code && t.has(`errors.${code}` as never) ? t(`errors.${code}` as never) : t('errors.generic');
      })()
    : null;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        <nav className="flex items-center gap-2" aria-label={t('view.list')}>
          <Link
            href={link({ view: 'list' })}
            aria-current={state.view === 'list' ? 'page' : undefined}
            className={buttonVariants({ variant: state.view === 'list' ? 'default' : 'outline' })}
          >
            {t('view.list')}
          </Link>
          <Link
            href={link({ view: 'map' })}
            aria-current={state.view === 'map' ? 'page' : undefined}
            className={buttonVariants({ variant: state.view === 'map' ? 'default' : 'outline' })}
          >
            {t('view.map')}
          </Link>
          {/* S5-06: save the current filters as a search with alerts (the saved searches page reads them) */}
          <Link
            href={`/network/saved-searches?${new URLSearchParams({
              ...(state.type ? { type: state.type } : {}),
              ...(state.location ? { location: state.location } : {}),
              ...(state.min !== undefined ? { min: String(state.min) } : {}),
              ...(state.max !== undefined ? { max: String(state.max) } : {}),
              ...(state.beds !== undefined ? { beds: String(state.beds) } : {}),
            })}`}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('savedSearches.saveThis')}
          </Link>
        </nav>
      </div>

      {result.ok && result.data.status === 'LOCKED' ? (
        <section className="flex flex-col items-start gap-3 rounded-md border p-6" aria-labelledby="network-locked">
          <h2 id="network-locked" className="text-lg font-semibold">
            {t('gate.lockedTitle')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('gate.lockedBody', {
              shared: format.number(result.data.gate.sharedListings),
              threshold: format.number(result.data.gate.threshold),
            })}
          </p>
          <Link href="/listings" className={buttonVariants()}>
            {t('gate.lockedCta')}
          </Link>
        </section>
      ) : (
        <>
          <form method="get" aria-label={t('filters.label')} className="flex flex-wrap items-end gap-3">
            {state.view === 'map' ? <input type="hidden" name="view" value="map" /> : null}
            <div className="flex flex-col gap-1">
              <Label htmlFor="net-q">{t('filters.text')}</Label>
              <Input id="net-q" name="q" defaultValue={state.q ?? ''} maxLength={100} className="w-56" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="net-kind">{t('filters.kind')}</Label>
              <select id="net-kind" name="kind" defaultValue={state.kind ?? ''} className={select}>
                <option value="">{t('filters.kindAll')}</option>
                <option value="LISTING">{t('filters.kindListing')}</option>
                <option value="UNIT">{t('filters.kindUnit')}</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="net-type">{t('filters.type')}</Label>
              <select id="net-type" name="type" defaultValue={state.type ?? ''} className={select}>
                <option value="">{t('filters.typeAll')}</option>
                {names.propertyTypes.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="net-location">{t('filters.location')}</Label>
              <select id="net-location" name="location" defaultValue={state.location ?? ''} className={select}>
                <option value="">{t('filters.locationAll')}</option>
                {names.locations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="net-min">{t('filters.min')}</Label>
              <Input id="net-min" name="min" type="number" min={0} defaultValue={state.min ?? ''} className="w-32" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="net-max">{t('filters.max')}</Label>
              <Input id="net-max" name="max" type="number" min={0} defaultValue={state.max ?? ''} className="w-32" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="net-beds">{t('filters.beds')}</Label>
              <Input
                id="net-beds"
                name="beds"
                type="number"
                min={0}
                max={50}
                defaultValue={state.beds ?? ''}
                className="w-24"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="net-sort">{t('filters.sort')}</Label>
              <select id="net-sort" name="sort" defaultValue={state.sort} className={select}>
                {SORTS.map((s) => (
                  <option key={s} value={s}>
                    {t(`filters.sorts.${s}`)}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex h-9 items-center gap-2 text-sm">
              <input type="checkbox" name="preferred" value="1" defaultChecked={state.preferred} />
              {t('filters.preferred')}
            </label>
            <label className="flex h-9 items-center gap-2 text-sm">
              <input type="checkbox" name="newBuilds" value="1" defaultChecked={state.newBuilds} />
              {t('filters.newBuilds')}
            </label>
            <button type="submit" className={buttonVariants()}>
              {t('filters.submit')}
            </button>
            <Link
              href={state.view === 'map' ? '/network?view=map' : '/network'}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('filters.reset')}
            </Link>
          </form>

          {result.ok && result.data.status === 'OK' && result.data.gate.state === 'GRACE' ? (
            <p role="status" className="rounded-md border bg-muted p-3 text-sm">
              {t('gate.grace', {
                date: format.dateTime(new Date(result.data.gate.graceEndsAt), { dateStyle: 'medium' }),
                threshold: format.number(result.data.gate.threshold),
              })}
            </p>
          ) : null}
          {result.ok && result.data.status === 'OK' && result.data.gate.state === 'EXEMPT' ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('gate.exempt')}
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : result.ok && result.data.status === 'OK' ? (
            result.data.items.length === 0 ? (
              <EmptyState title={t('results.none')} />
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t('results.count', { count: result.data.total })}</p>
                {state.view === 'map' ? (
                  <MapView
                    styleUrl={config.MAP_STYLE_URL}
                    failedText={t('view.mapFailed')}
                    pins={result.data.items.flatMap((i) =>
                      i.card.geo
                        ? [
                            {
                              id: i.id,
                              lat: i.card.geo.lat,
                              lng: i.card.geo.lng,
                              label: `${i.card.title} · ${priceOf(i)}`,
                              href: `/${locale}${hrefOf(i)}`,
                            },
                          ]
                        : [],
                    )}
                  />
                ) : null}
                <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {result.data.items.map((i) => (
                    <li key={i.id} className="flex flex-col gap-2 rounded-md border p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <Link href={hrefOf(i)} className="font-medium underline-offset-4 hover:underline">
                            {i.card.title}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {i.card.ref}
                            {i.kind === 'UNIT' ? ` · ${t('results.unit')}` : ''}
                          </p>
                        </div>
                        <p className="shrink-0 font-semibold">{priceOf(i)}</p>
                      </div>
                      <p className="text-sm">{[placeOf(i), ...factsOf(i)].filter(Boolean).join(' · ')}</p>
                      <div className="rounded-md bg-muted p-2 text-sm">
                        {commissionText(i.commission).map((line, n) => (
                          <p key={line} className={n === 1 ? 'font-semibold' : undefined}>
                            {line}
                          </p>
                        ))}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span>
                          {t('results.owner', { name: i.ownerAgency.name })}
                          {i.preferred ? (
                            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                              {t('results.preferred')}
                            </span>
                          ) : null}
                        </span>
                        {i.kind === 'LISTING' ? <BookmarkButton listingId={i.id} messages={messages.listings} /> : null}
                      </div>
                    </li>
                  ))}
                </ul>
                {result.data.nextCursor ? (
                  <Link
                    href={`/network?${networkSearch(state, { cursor: result.data.nextCursor })}`}
                    className="self-end text-sm underline-offset-4 hover:underline"
                  >
                    {t('results.more')}
                  </Link>
                ) : null}
              </>
            )
          ) : null}
        </>
      )}
    </div>
  );
}
