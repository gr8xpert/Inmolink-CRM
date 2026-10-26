import { portalCrumbs, portalJsonLd, portalMetadataFor, serializeJsonLd } from '@inmolink/core/modules/website-api';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import {
  assertPortalLocale,
  catalogOf,
  parseQuery,
  portalSettings,
  searchPortal,
  zoneOf,
  zoneSlugs,
} from '@/portal/data';
import { legacyRedirectFor } from '@/portal/legacy';
import { JsonLd } from '@/portal/ui/breadcrumbs';
import { LocationIntro } from '@/portal/ui/location-intro';
import { SearchView } from '@/portal/ui/search-view';
import { PortalShell } from '@/portal/ui/shell';
import { searchPath, zonePath } from '@/portal/urls';

/**
 * A zone page (S15-01): a location group — a comarca or a coast (`/zone/costa-blanca-south`) — with the same opening
 * as a location page (type mix, its member places) and the search narrowed to its members.
 */

type Props = {
  params: Promise<{ locale: string; zone: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale, zone: slug } = await params;
  assertPortalLocale(locale);
  const zone = await zoneOf(locale, decodeURIComponent(slug));
  if (!zone) return {};
  const query = parseQuery(await searchParams);
  return portalMetadataFor({
    kind: 'zone',
    locale,
    origin: (await portalSettings()).origin,
    query,
    zone,
    slugs: await zoneSlugs(zone.id),
  });
}

export default async function ZonePage({ params, searchParams }: Props) {
  const { locale, zone: slug } = await params;
  assertPortalLocale(locale);
  setRequestLocale(locale);
  const zone = await zoneOf(locale, decodeURIComponent(slug));
  if (!zone || zone.members.length === 0) {
    const to = await legacyRedirectFor(zonePath(locale, slug));
    if (to) permanentRedirect(to);
    notFound();
  }
  const query = parseQuery(await searchParams);
  const first = (query.page ?? 1) === 1;
  const [t, catalog, settings, result, slugs] = await Promise.all([
    getTranslations({ locale, namespace: 'portal' }),
    catalogOf(locale),
    portalSettings(),
    searchPortal({ locale, locationIds: zone.members.map((m) => m.id), query, facets: first, zoneId: zone.id }),
    zoneSlugs(zone.id),
  ]);
  // A numbered page past the last (an empty search included) is a 404, never an empty copy of the search.
  if (!result.pageUnavailable && result.page > Math.max(1, result.pageCount)) notFound();
  const path = zonePath(locale, zone.slug);
  const page = { kind: 'zone', locale, origin: settings.origin, query, zone, slugs } as const;
  return (
    <PortalShell
      locale={locale}
      alternates={Object.fromEntries(Object.entries(slugs).map(([l, s]) => [l, zonePath(l, s)]))}
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
        heading={t('search.headingPlace', { count: result.total, place: zone.name })}
        crumbs={portalCrumbs(page)}
        settings={settings}
        intro={
          first ? (
            <LocationIntro
              locale={locale}
              path={path}
              intro={t('location.zoneIntro', { zone: zone.name })}
              catalog={catalog}
              typeCounts={result.typeCounts}
              childrenHeading={t('location.members', { zone: zone.name })}
              places={zone.members}
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
