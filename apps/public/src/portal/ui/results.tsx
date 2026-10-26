import type { PortalQuery, PortalSort, WebsiteListingCard } from '@inmolink/contracts';
import { PORTAL_SORTS } from '@inmolink/contracts';
import type { PortalCard } from '@inmolink/core/modules/website-api';
import { formatter } from '@inmolink/i18n';
import { getTranslations } from 'next-intl/server';
import { agencyPath, listingPath, queryString } from '../urls';
import { CARD_SIZES, Photo } from './picture';

type T = Awaited<ReturnType<typeof getTranslations<'portal'>>>;

/** The town a card names: the city, else the area, else the region. */
export const townOf = (place: WebsiteListingCard['place']) =>
  place.city?.name ?? place.area?.name ?? place.region?.name ?? place.country?.name ?? '';

/** "<Type> in <Town>": every card and listing page is titled from data, never from the owner's headline. */
export const titleOf = (t: T, card: Pick<WebsiteListingCard, 'propertyType' | 'place'>) =>
  t('card.title', { type: card.propertyType.name, town: townOf(card.place) });

export function priceOf(t: T, locale: string, price: WebsiteListingCard['price']): string {
  if (price.onRequest || price.amountCents === null) return t('card.onRequest');
  return formatter(locale).money(price.amountCents, price.currency);
}

/** The card's (or listing's) facts as short phrases: bedrooms, bathrooms, built, plot and terrace size. */
export function factsOf(
  t: T,
  locale: string,
  c: { bedrooms: number | null; bathrooms: number | null; builtM2: number | null; plotM2: number | null },
  terraceM2: number | null,
): string[] {
  const fmt = formatter(locale);
  const out: string[] = [];
  if (c.bedrooms !== null) out.push(t('card.beds', { n: c.bedrooms }));
  if (c.bathrooms !== null) out.push(t('card.baths', { n: c.bathrooms }));
  if (c.builtM2 !== null && c.builtM2 > 0) out.push(t('card.built', { area: fmt.area(c.builtM2) }));
  if (c.plotM2 !== null && c.plotM2 > 0) out.push(t('card.plot', { area: fmt.area(c.plotM2) }));
  if (terraceM2 !== null && terraceM2 > 0) out.push(t('card.terrace', { area: fmt.area(terraceM2) }));
  return out;
}

/** The result list: one row per listing (photo, title, price, facts, excerpt, listing agency). */
export async function ResultList(props: { locale: string; items: readonly PortalCard[] }) {
  const t = await getTranslations({ locale: props.locale, namespace: 'portal' });
  return (
    <ol className="divide-y divide-shore">
      {props.items.map((item, i) => {
        const { card } = item;
        const title = titleOf(t, card);
        const href = item.code ? listingPath(props.locale, title, item.code) : null;
        const facts = factsOf(t, props.locale, card, item.terraceM2);
        return (
          <li key={card.id} className="relative grid gap-4 py-6 first:pt-0 sm:grid-cols-[18rem_minmax(0,1fr)]">
            <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-shore">
              {card.cover ? (
                <Photo
                  image={card.cover}
                  alt=""
                  sizes={CARD_SIZES}
                  eager={i === 0}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="flex h-full items-center justify-center text-sm text-stone">{t('card.noPhoto')}</span>
              )}
              {card.imageCount > 1 ? (
                <span className="absolute bottom-2 left-2 rounded bg-ink/80 px-2 py-0.5 text-xs text-white">
                  {t('card.photos', { n: card.imageCount })}
                </span>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="text-lg font-semibold leading-snug">
                {href ? (
                  <a href={href} className="text-ink after:absolute after:inset-0 hover:text-sea">
                    {title}
                  </a>
                ) : (
                  title
                )}
              </h3>
              <p className="text-2xl font-bold tabular-nums tracking-tight text-sea-deep">
                {priceOf(t, props.locale, card.price)}
              </p>
              {facts.length > 0 ? (
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink">
                  {facts.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              ) : null}
              {item.excerpt ? <p className="line-clamp-3 text-sm leading-relaxed text-stone">{item.excerpt}</p> : null}
              {item.agency ? (
                <p className="relative z-10 mt-auto text-sm text-stone">
                  {t('card.listedBy')} <AgencyName locale={props.locale} agency={item.agency} />
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The listing agency's name, linked to its profile once the profiles are live (`AGENCY_PROFILES_LIVE`). */
function AgencyName(props: { locale: string; agency: { id: string; name: string } }) {
  const href = agencyPath(props.locale, props.agency);
  return href ? (
    <a href={href} className="font-medium text-sea hover:underline">
      {props.agency.name}
    </a>
  ) : (
    <span className="font-medium text-ink">{props.agency.name}</span>
  );
}

/** Sort as links (crawlable, no script); the current one is marked. */
export async function SortLinks(props: { locale: string; path: string; query: PortalQuery }) {
  const t = await getTranslations({ locale: props.locale, namespace: 'portal' });
  const current: PortalSort = props.query.sort ?? 'latest';
  return (
    <nav aria-label={t('sort.label')} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span className="text-stone">{t('sort.label')}</span>
      <ul className="flex flex-wrap gap-x-4">
        {PORTAL_SORTS.map((s) => (
          <li key={s}>
            <a
              href={`${props.path}${queryString(props.query, { sort: s, page: undefined })}`}
              aria-current={s === current ? 'true' : undefined}
              rel="nofollow"
              className={s === current ? 'font-semibold text-ink underline decoration-2' : 'text-sea hover:underline'}
            >
              {t(`sort.${s}`)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Pages shown around the current one. */
const WINDOW = 2;

/**
 * The numbers a pagination shows: first, last and a window around the current page; a gap is the negated number of
 * the page before it (unique, so it can key the gap).
 */
export function pageNumbers(page: number, pages: number): number[] {
  const out: number[] = [];
  for (let n = 1; n <= pages; n++) {
    const last = out[out.length - 1] ?? 0;
    if (n === 1 || n === pages || Math.abs(n - page) <= WINDOW) out.push(n);
    else if (last > 0) out.push(-last);
  }
  return out;
}

/** Numbered pages as plain links (`?page=N`): every page is reachable by a crawler. */
export async function Pagination(props: {
  locale: string;
  path: string;
  query: PortalQuery;
  page: number;
  pages: number;
}) {
  if (props.pages <= 1) return null;
  const t = await getTranslations({ locale: props.locale, namespace: 'portal' });
  const href = (n: number) => `${props.path}${queryString(props.query, { page: n })}`;
  const fmt = formatter(props.locale);
  const step = 'inline-flex min-w-10 items-center justify-center rounded-md px-3 py-2';
  return (
    <nav aria-label={t('pagination.label')} className="mt-8">
      <ul className="flex flex-wrap items-center gap-1 text-sm">
        {props.page > 1 ? (
          <li>
            <a href={href(props.page - 1)} rel="prev" className={`${step} text-sea hover:bg-shore`}>
              {t('pagination.previous')}
            </a>
          </li>
        ) : null}
        {pageNumbers(props.page, props.pages).map((n) =>
          n < 0 ? (
            <li key={n} aria-hidden="true" className="px-1 text-stone">
              …
            </li>
          ) : (
            <li key={n}>
              {n === props.page ? (
                <span aria-current="page" className={`${step} bg-ink font-semibold text-white`}>
                  {fmt.number(n)}
                </span>
              ) : (
                <a
                  href={href(n)}
                  aria-label={t('pagination.page', { n })}
                  className={`${step} tabular-nums text-sea hover:bg-shore`}
                >
                  {fmt.number(n)}
                </a>
              )}
            </li>
          ),
        )}
        {props.page < props.pages ? (
          <li>
            <a href={href(props.page + 1)} rel="next" className={`${step} text-sea hover:bg-shore`}>
              {t('pagination.next')}
            </a>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
