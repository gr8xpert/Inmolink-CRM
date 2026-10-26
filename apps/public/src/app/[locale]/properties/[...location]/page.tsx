import { portalCrumbs, portalJsonLd, portalMetadataFor, serializeJsonLd } from '@inmolink/core/modules/website-api';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import {
  assertPortalLocale,
  catalogOf,
  locationOf,
  locationPaths,
  parseQuery,
  portalSettings,
  searchPortal,
} from '@/portal/data';
import { legacyRedirectFor } from '@/portal/legacy';
import { JsonLd } from '@/portal/ui/breadcrumbs';
import { LocationIntro } from '@/portal/ui/location-intro';
import { SearchView } from '@/portal/ui/search-view';
import { PortalShell } from '@/portal/ui/shell';
import { searchPath } from '@/portal/urls';

/**
 * A location page (S15-01): country, region, city or area by its slugs (`/properties/spain/alicante/torrevieja`) —
 * the live count, the property-type mix, the places below, then the search narrowed to the location. Dynamic (filters
 * and pages ride in the query string); CDN-cached by `Cache-Control` (next.config). ≤ 2 statements warm.
 */

type Props = {
  params: Promise<{ locale: string; location: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const slugsOf = (location: readonly string[]) => location.map((s) => decodeURIComponent(s)).join('/');

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale, location } = await params;
  assertPortalLocale(locale);
  const loc = await locationOf(locale, slugsOf(location));
  if (!loc) return {};
  const query = parseQuery(await searchParams);
  return portalMetadataFor({
    kind: 'location',
    locale,
    origin: (await portalSettings()).origin,
    query,
    location: loc,
    slugs: await locationPaths(loc.place.id),
  });
}

export default async function LocationPage({ params, searchParams }: Props) {
  const { locale, location } = await params;
  assertPortalLocale(locale);
  setRequestLocale(locale);
  const loc = await locationOf(locale, slugsOf(location));
  if (!loc) {
    const to = await legacyRedirectFor(searchPath(locale, location));
    if (to) permanentRedirect(to);
    notFound();
  }
  const query = parseQuery(await searchParams);
  const first = (query.page ?? 1) === 1;
  const [t, catalog, settings, result, alternates] = await Promise.all([
    getTranslations({ locale, namespace: 'portal' }),
    catalogOf(locale),
    portalSettings(),
    searchPortal({ locale, locationIds: [loc.place.id], query, facets: first }),
    locationPaths(loc.place.id),
  ]);
  // A numbered page past the last (an empty search included) is a 404, never an empty copy of the search.
  if (!result.pageUnavailable && result.page > Math.max(1, result.pageCount)) notFound();
  const path = searchPath(locale, loc.place.path);
  const page = { kind: 'location', locale, origin: settings.origin, query, location: loc, slugs: alternates } as const;
  return (
    <PortalShell
      locale={locale}
      alternates={Object.fromEntries(Object.entries(alternates).map(([l, p]) => [l, searchPath(l, p)]))}
    >
      {portalJsonLd(page).map((ld) => (
        <JsonLd key={(ld as { '@type': string })['@type']} json={serializeJsonLd(ld)} />
      ))}
      <SearchView
        locale={locale}
        path={path}
        query={query}
        result={result}
        catalog={catalog}
        heading={t('search.headingPlace', { count: result.total, place: loc.place.name })}
        crumbs={portalCrumbs(page)}
        settings={settings}
        intro={
          first ? (
            <LocationIntro
              locale={locale}
              path={path}
              intro={t('location.intro', { place: loc.place.name })}
              catalog={catalog}
              typeCounts={result.typeCounts}
              childrenHeading={t('location.children', { place: loc.place.name })}
              places={loc.children}
              childHref={(c) => searchPath(locale, c.path)}
              locationCounts={result.locationCounts}
              counted={!result.degraded}
            />
          ) : null
        }
      />
    </PortalShell>
  );
}
