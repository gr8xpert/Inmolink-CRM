import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { assertPortalLocale, catalogOf, PORTAL_LOCALES, parseQuery, portalSettings, searchPortal } from '@/portal/data';
import { searchMetadata } from '@/portal/meta';
import { breadcrumbJsonLd, type Crumb, serializeJsonLd } from '@/portal/seo';
import { JsonLd } from '@/portal/ui/breadcrumbs';
import { SearchView } from '@/portal/ui/search-view';
import { PortalShell } from '@/portal/ui/shell';
import { homePath, searchPath } from '@/portal/urls';

/** Every listing on the portal (S15-01), filtered and paged by the query string. */

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const pathsOf = () => Object.fromEntries(PORTAL_LOCALES.map((l) => [l, searchPath(l)]));

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale } = await params;
  assertPortalLocale(locale);
  const t = await getTranslations({ locale, namespace: 'portal' });
  const query = parseQuery(await searchParams);
  const page = query.page ?? 1;
  const title = t('search.titleAll');
  return searchMetadata({
    origin: (await portalSettings()).origin,
    locale,
    paths: pathsOf(),
    query,
    title: page > 1 ? `${title}, ${t('search.pageSuffix', { page })}` : title,
    description: t('search.metaDescriptionAll'),
  });
}

export default async function AllPropertiesPage({ params, searchParams }: Props) {
  const { locale } = await params;
  assertPortalLocale(locale);
  setRequestLocale(locale);
  const query = parseQuery(await searchParams);
  const [t, catalog, settings, result] = await Promise.all([
    getTranslations({ locale, namespace: 'portal' }),
    catalogOf(locale),
    portalSettings(),
    searchPortal({ locale, query }),
  ]);
  // A numbered page past the last (an empty search included) is a 404, never an empty copy of the search.
  if (!result.pageUnavailable && result.page > Math.max(1, result.pageCount)) notFound();
  const path = searchPath(locale);
  const crumbs: Crumb[] = [
    { name: t('breadcrumb.home'), path: homePath(locale) },
    { name: t('breadcrumb.all'), path },
  ];
  return (
    <PortalShell locale={locale} alternates={pathsOf()}>
      <JsonLd json={serializeJsonLd(breadcrumbJsonLd(settings.origin, crumbs))} />
      <SearchView
        locale={locale}
        path={path}
        query={query}
        result={result}
        catalog={catalog}
        heading={t('search.headingAll', { count: result.total })}
        crumbs={crumbs}
        settings={settings}
      />
    </PortalShell>
  );
}
