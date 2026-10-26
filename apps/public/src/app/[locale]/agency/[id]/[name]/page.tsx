import { portalCrumbs, portalJsonLd, portalMetadataFor, serializeJsonLd } from '@inmolink/core/modules/website-api';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { agencyOf, assertPortalLocale, catalogOf, parseQuery, portalSettings, searchPortal } from '@/portal/data';
import { legacyRedirectFor } from '@/portal/legacy';
import { AgencyProfileIntro } from '@/portal/ui/agency-profile';
import { JsonLd } from '@/portal/ui/breadcrumbs';
import { SearchView } from '@/portal/ui/search-view';
import { PortalShell } from '@/portal/ui/shell';
import { hasFilters, queryString } from '@/portal/urls';

/**
 * An agency profile page (S15-03, PLAN §7 M14): `/agency/<id>/<name>` — a directory-listed agency's published profile
 * (contacts, register number, languages, its texts), its contact form, and its PUBLIC listings as the search's cards,
 * filtered, sorted and paged like any search (`?page=N`, crawlable). JSON-LD `RealEstateAgent` + `BreadcrumbList`;
 * canonical and hreflang from core's `portalAgencyPaths` (the sitemaps' and legacy redirects' URL too). An unlisted
 * agency has no page (404, after the legacy redirects); an old name slug 301s to the current one. Statements: the
 * profile (cached a minute, 0–1) + the search (1–2).
 */

type Props = {
  params: Promise<{ locale: string; id: string; name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale, id } = await params;
  assertPortalLocale(locale);
  const agency = await agencyOf(locale, id);
  if (!agency) return {};
  const query = parseQuery(await searchParams);
  return portalMetadataFor({ kind: 'agency', locale, origin: (await portalSettings()).origin, query, agency });
}

export default async function AgencyPage({ params, searchParams }: Props) {
  const { locale, id, name } = await params;
  assertPortalLocale(locale);
  setRequestLocale(locale);
  const agency = await agencyOf(locale, id);
  if (!agency) {
    const to = await legacyRedirectFor(`/${locale}/agency/${id}/${name}`);
    if (to) permanentRedirect(to);
    notFound();
  }
  const query = parseQuery(await searchParams);
  const path = agency.paths[locale] as string;
  // One URL per agency and locale: an old name (or another spelling of the id) moves to the current one.
  if (path !== `/${locale}/agency/${id}/${name}`) permanentRedirect(`${path}${queryString(query)}`);
  const [t, catalog, settings, result] = await Promise.all([
    getTranslations({ locale, namespace: 'portal' }),
    catalogOf(locale),
    portalSettings(),
    searchPortal({ locale, agencyId: agency.id, query }),
  ]);
  // A numbered page past the last is a 404, never an empty copy (page 1 stays: the profile is the page).
  if (!result.pageUnavailable && result.page > Math.max(1, result.pageCount)) notFound();
  const first = (query.page ?? 1) === 1;
  const page = { kind: 'agency', locale, origin: settings.origin, query, agency } as const;

  return (
    <PortalShell locale={locale} alternates={agency.paths}>
      {portalJsonLd(page).map((ld) => (
        <JsonLd key={(ld as { '@type': string })['@type']} json={serializeJsonLd(ld)} />
      ))}
      <SearchView
        locale={locale}
        path={path}
        query={query}
        result={result}
        catalog={catalog}
        heading={agency.name}
        crumbs={portalCrumbs(page)}
        settings={settings}
        intro={<AgencyProfileIntro locale={locale} agency={agency} path={path} settings={settings} full={first} />}
        resultsHeading={t('agency.listings', { count: result.total, agency: agency.name })}
        emptyText={hasFilters(query) ? undefined : t('agency.empty', { agency: agency.name })}
      />
    </PortalShell>
  );
}
