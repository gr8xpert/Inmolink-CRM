import type { PortalQuery } from '@inmolink/contracts';
import type { PortalCatalog, PortalSearchPage } from '@inmolink/core/modules/website-api';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { PortalSettings } from '../data';
import type { Crumb } from '../seo';
import { listingPath, queryString } from '../urls';
import { Breadcrumbs } from './breadcrumbs';
import { Filters } from './filters';
import { MapToggle } from './map-toggle';
import { Pagination, ResultList, SortLinks, titleOf } from './results';

/**
 * A search page's body (S15-01): every listing, a location or a zone. The heading carries the live count; under it the
 * location's opening (page 1), then filters beside the results, sort, map and numbered pages.
 */
export async function SearchView(props: {
  locale: string;
  path: string;
  query: PortalQuery;
  result: PortalSearchPage;
  catalog: PortalCatalog;
  heading: string;
  crumbs: readonly Crumb[];
  intro?: ReactNode;
  settings: PortalSettings;
  /** S15-03: a visible heading over the results (an agency page: its listings); default a screen-reader one. */
  resultsHeading?: string;
  /** S15-03: what an empty first page says (default: no listing matches the filters). */
  emptyText?: string;
}) {
  const t = await getTranslations({ locale: props.locale, namespace: 'portal' });
  const { result } = props;
  const pins = props.settings.map
    ? result.items.flatMap((item) => {
        if (!item.card.geo || !item.code) return [];
        const label = titleOf(t, item.card);
        return [
          { lat: item.card.geo.lat, lng: item.card.geo.lng, label, href: listingPath(props.locale, label, item.code) },
        ];
      })
    : [];
  return (
    <div className="mx-auto max-w-6xl px-4 pt-6">
      <Breadcrumbs label={t('breadcrumb.label')} crumbs={props.crumbs} />
      <header className="mt-4">
        <h1 className="max-w-[22ch] text-[clamp(2rem,5.5vw,3.5rem)] font-extrabold leading-[1.04] tracking-tight text-ink">
          {props.heading}
        </h1>
        {props.intro}
      </header>
      <div className="mt-10 grid gap-8 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside>
          <Filters locale={props.locale} path={props.path} query={props.query} catalog={props.catalog} />
        </aside>
        <section aria-labelledby="results-heading" className="min-w-0">
          <h2
            id="results-heading"
            className={props.resultsHeading ? 'mb-4 text-2xl font-bold tracking-tight text-ink' : 'sr-only'}
          >
            {props.resultsHeading ?? t('search.results')}
          </h2>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-shore pb-4">
            <SortLinks locale={props.locale} path={props.path} query={props.query} />
            {props.settings.map && pins.length > 0 ? (
              <MapToggle
                pins={pins}
                tileUrl={props.settings.map.tileUrl}
                attribution={props.settings.map.attribution}
                text={{
                  show: t('map.show'),
                  hide: t('map.hide'),
                  label: t('map.label'),
                  zoomIn: t('map.zoomIn'),
                  zoomOut: t('map.zoomOut'),
                }}
              />
            ) : null}
          </div>
          {result.degraded && !result.pageUnavailable ? (
            <p className="mb-4 rounded-md bg-shore px-3 py-2 text-sm text-ink">{t('search.degraded')}</p>
          ) : null}
          {result.pageUnavailable ? (
            <p className="rounded-md bg-shore px-4 py-3 text-sm text-ink">
              {t('search.unavailable', { page: result.page })}{' '}
              <a
                href={`${props.path}${queryString(props.query, { page: undefined })}`}
                className="font-semibold text-sea"
              >
                {t('search.firstPage')}
              </a>
            </p>
          ) : result.items.length === 0 ? (
            <p className="rounded-md bg-shore px-4 py-3 text-sm text-ink">{props.emptyText ?? t('search.empty')}</p>
          ) : (
            <ResultList locale={props.locale} items={result.items} />
          )}
          <Pagination
            locale={props.locale}
            path={props.path}
            query={props.query}
            page={result.page}
            pages={result.pageCount}
          />
        </section>
      </div>
    </div>
  );
}
