import { excerpt } from '@inmolink/core/modules/websites';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { agencyOf, assertPortalLocale, catalogOf, parseQuery, portalSettings, searchPortal } from '@/portal/data';
import { legacyRedirectFor } from '@/portal/legacy';
import { searchMetadata } from '@/portal/meta';
import { agencyJsonLd, breadcrumbJsonLd, type Crumb, serializeJsonLd } from '@/portal/seo';
import { AgencyProfileIntro, agencySubline, profileSummary } from '@/portal/ui/agency-profile';
import { JsonLd } from '@/portal/ui/breadcrumbs';
import { SearchView } from '@/portal/ui/search-view';
import { PortalShell } from '@/portal/ui/shell';
import { hasFilters, homePath, queryString, safeHttpUrl } from '@/portal/urls';

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
  const t = await getTranslations({ locale, namespace: 'portal' });
  const query = parseQuery(await searchParams);
  const page = query.page ?? 1;
  const title = t('agency.metaTitle', { agency: agency.name });
  const subline = await agencySubline(locale, agency);
  const summary = profileSummary(agency);
  return searchMetadata({
    origin: (await portalSettings()).origin,
    locale,
    paths: agency.paths,
    query,
    title: page > 1 ? `${title}, ${t('search.pageSuffix', { page })}` : title,
    description: summary ? excerpt(summary, 160) : t('agency.metaDescription', { agency: agency.name, kind: subline }),
  });
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
  const crumbs: Crumb[] = [
    { name: t('breadcrumb.home'), path: homePath(locale) },
    { name: agency.name, path },
  ];
  const website = safeHttpUrl(agency.website);
  const ld = agencyJsonLd({
    url: `${settings.origin}${path}`,
    name: agency.name,
    description: agency.tagline ?? (agency.description ? excerpt(agency.description, 500) : null),
    email: agency.email,
    telephone: agency.phone,
    website,
    city: agency.city,
    languages: agency.languages,
    registerNumber: agency.registerNumber,
  });
  return (
    <PortalShell locale={locale} alternates={agency.paths}>
      <JsonLd json={serializeJsonLd(ld)} />
      <JsonLd json={serializeJsonLd(breadcrumbJsonLd(settings.origin, crumbs))} />
      <SearchView
        locale={locale}
        path={path}
        query={query}
        result={result}
        catalog={catalog}
        heading={agency.name}
        crumbs={crumbs}
        settings={settings}
        intro={<AgencyProfileIntro locale={locale} agency={agency} path={path} settings={settings} full={first} />}
        resultsHeading={t('agency.listings', { count: result.total, agency: agency.name })}
        emptyText={hasFilters(query) ? undefined : t('agency.empty', { agency: agency.name })}
      />
    </PortalShell>
  );
}
