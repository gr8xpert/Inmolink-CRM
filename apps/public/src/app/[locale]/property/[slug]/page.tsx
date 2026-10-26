import { excerpt } from '@inmolink/core/modules/websites';
import { DEFAULT_UI_LOCALE } from '@inmolink/i18n';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { assertPortalLocale, listingByCode, placeOf, portalSettings } from '@/portal/data';
import { legacyRedirectFor } from '@/portal/legacy';
import { breadcrumbJsonLd, type Crumb, languageAlternates, listingJsonLd, serializeJsonLd } from '@/portal/seo';
import { JsonLd } from '@/portal/ui/breadcrumbs';
import { ListingView } from '@/portal/ui/listing';
import { priceOf, titleOf, townOf } from '@/portal/ui/results';
import { PortalShell } from '@/portal/ui/shell';
import { agencyPath, codeOfSlug, homePath, profileUrl, searchPath } from '@/portal/urls';

/**
 * A listing page (S15-01, PATTERNS §19): `/property/<type-in-town>-<code>` — the listing a public code names, ISR
 * (5 minutes; CDN-cacheable), JSON-LD `RealEstateListing` + `BreadcrumbList`, canonical and hreflang. A slug that is
 * not the listing's current one 301s to it; an unknown code asks the legacy redirects (S15-02) before its 404.
 * 1–2 statements.
 */

export const revalidate = 300;

/** Rendered on first request, then kept (ISR): none at build time (no database at build). */
export function generateStaticParams(): { slug: string }[] {
  return [];
}

type Props = { params: Promise<{ locale: string; slug: string }> };

async function load(locale: string, slug: string) {
  const code = codeOfSlug(slug);
  return code ? listingByCode(locale, code) : null;
}

/** Media CDN variant for Open Graph (1200 px), else the largest one. */
const ogImage = (urls: Partial<Record<string, string>>) => urls.og ?? urls.large ?? urls.medium ?? null;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  assertPortalLocale(locale);
  const listing = await load(locale, slug);
  if (!listing) return {};
  const t = await getTranslations({ locale, namespace: 'portal' });
  const { detail } = listing;
  const { origin } = await portalSettings();
  const title = titleOf(t, detail);
  const metaTitle = t('listing.metaTitle', {
    type: detail.propertyType.name,
    town: townOf(detail.place),
    price: priceOf(t, locale, detail.price),
  });
  // Every locale's URL from core (S15-02): the same the sitemaps list, each named in its own locale.
  const { paths } = listing;
  const description = detail.metaDescription ?? (detail.description ? excerpt(detail.description, 160) : title);
  const image = detail.cover ? ogImage(detail.cover.urls) : null;
  const canonical = `${origin}${paths[locale]}`;
  return {
    title: metaTitle,
    description,
    alternates: { canonical, languages: languageAlternates(origin, paths, DEFAULT_UI_LOCALE) },
    openGraph: {
      type: 'website',
      url: canonical,
      title,
      description,
      locale,
      ...(image ? { images: [{ url: image, alt: title }] } : {}),
    },
    twitter: { card: image ? 'summary_large_image' : 'summary', title },
  };
}

export default async function ListingPage({ params }: Props) {
  const { locale, slug } = await params;
  assertPortalLocale(locale);
  setRequestLocale(locale);
  const listing = await load(locale, slug);
  if (!listing) {
    const to = await legacyRedirectFor(`/${locale}/property/${slug}`);
    if (to) permanentRedirect(to);
    notFound();
  }
  const t = await getTranslations({ locale, namespace: 'portal' });
  const { detail } = listing;
  const title = titleOf(t, detail);
  const path = listing.paths[locale] as string;
  // One URL per listing and locale: an old slug (type or town renamed) moves to the current one.
  if (path !== `/${locale}/property/${slug}`) permanentRedirect(path);
  const settings = await portalSettings();
  const deepest = detail.place.area ?? detail.place.city ?? detail.place.region ?? detail.place.country;
  const place = deepest ? await placeOf(locale, deepest.id) : null;
  const crumbs: Crumb[] = [
    { name: t('breadcrumb.home'), path: homePath(locale) },
    { name: t('breadcrumb.all'), path: searchPath(locale) },
    ...(place
      ? [...place.ancestors, place.place].map((p) => ({ name: p.name, path: searchPath(locale, p.path) }))
      : []),
    { name: title, path },
  ];
  const alternates = listing.paths;
  const images = [detail.cover, ...detail.media]
    .flatMap((m) => (m && m.kind === 'IMAGE' ? [ogImage(m.urls)] : []))
    .filter((u): u is string => u !== null);
  const ld = listingJsonLd({
    url: `${settings.origin}${path}`,
    name: title,
    description: detail.description ? excerpt(detail.description, 500) : null,
    images: [...new Set(images)].slice(0, 5),
    price:
      detail.price.onRequest || detail.price.amountCents === null
        ? null
        : { amount: detail.price.amountCents / 100, currency: detail.price.currency },
    bedrooms: detail.bedrooms,
    bathrooms: detail.bathrooms,
    builtM2: detail.builtM2,
    address: {
      locality: detail.place.city?.name ?? null,
      region: detail.place.region?.name ?? null,
      country: detail.place.country?.name ?? null,
    },
    geo: detail.geo ? { lat: detail.geo.lat, lng: detail.geo.lng } : null,
    agency: listing.agency
      ? { name: listing.agency.name, url: profileUrl(settings.origin, agencyPath(locale, listing.agency)) }
      : null,
    dateModified: listing.updatedAt.toISOString(),
  });
  return (
    <PortalShell locale={locale} alternates={alternates}>
      <JsonLd json={serializeJsonLd(ld)} />
      <JsonLd json={serializeJsonLd(breadcrumbJsonLd(settings.origin, crumbs))} />
      <ListingView locale={locale} listing={listing} title={title} crumbs={crumbs} settings={settings} />
    </PortalShell>
  );
}
