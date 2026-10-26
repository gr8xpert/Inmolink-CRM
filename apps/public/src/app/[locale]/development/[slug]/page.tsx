import { excerpt } from '@inmolink/core/modules/websites';
import { DEFAULT_UI_LOCALE, formatter } from '@inmolink/i18n';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { assertPortalLocale, developmentByCode, PORTAL_LOCALES, placeOf, portalSettings } from '@/portal/data';
import { legacyRedirectFor } from '@/portal/legacy';
import { breadcrumbJsonLd, type Crumb, developmentJsonLd, languageAlternates, serializeJsonLd } from '@/portal/seo';
import { JsonLd } from '@/portal/ui/breadcrumbs';
import { DevelopmentView } from '@/portal/ui/development';
import { townOf } from '@/portal/ui/results';
import { PortalShell } from '@/portal/ui/shell';
import { agencyPath, codeOfSlug, developmentPath, homePath, profileUrl, searchPath } from '@/portal/urls';

/**
 * A new-build development page (S15-01): `/development/<name>-<code>` — an OPEN development's public page with its
 * available and reserved homes, ISR (5 minutes), JSON-LD (`RealEstateListing` with an `AggregateOffer`, breadcrumbs),
 * canonical and hreflang. Another slug for the same code 301s to the current one. 2–3 statements.
 */

export const revalidate = 300;

export function generateStaticParams(): { slug: string }[] {
  return [];
}

type Props = { params: Promise<{ locale: string; slug: string }> };

async function load(locale: string, slug: string) {
  const code = codeOfSlug(slug);
  return code ? developmentByCode(locale, code) : null;
}

/** The development's name as pages title it (the developer's name; its marketing title when it has none). */
const nameOf = (d: { name: string; title: string }) => d.name || d.title;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  assertPortalLocale(locale);
  const development = await load(locale, slug);
  if (!development) return {};
  const t = await getTranslations({ locale, namespace: 'portal' });
  const { detail } = development;
  const { origin } = await portalSettings();
  const name = nameOf(detail);
  const town = townOf(detail.place);
  const paths = Object.fromEntries(PORTAL_LOCALES.map((l) => [l, developmentPath(l, name, development.code)]));
  const canonical = `${origin}${paths[locale]}`;
  const title = t('development.metaTitle', { name, town });
  const description =
    detail.metaDescription ??
    (detail.price.fromCents === null
      ? detail.description
        ? excerpt(detail.description, 160)
        : title
      : t('development.metaDescription', {
          town,
          units: detail.units.available,
          price: formatter(locale).money(detail.price.fromCents, detail.price.currency),
        }));
  return {
    title,
    description,
    alternates: { canonical, languages: languageAlternates(origin, paths, DEFAULT_UI_LOCALE) },
    openGraph: { type: 'website', url: canonical, title, description, locale },
    twitter: { card: 'summary', title },
  };
}

export default async function DevelopmentPage({ params }: Props) {
  const { locale, slug } = await params;
  assertPortalLocale(locale);
  setRequestLocale(locale);
  const development = await load(locale, slug);
  if (!development) {
    const to = await legacyRedirectFor(`/${locale}/development/${slug}`);
    if (to) permanentRedirect(to);
    notFound();
  }
  const t = await getTranslations({ locale, namespace: 'portal' });
  const { detail } = development;
  const name = nameOf(detail);
  const path = developmentPath(locale, name, development.code);
  // One URL per development and locale: any other slug (a listing's link, a renamed development) moves here.
  if (path !== `/${locale}/development/${slug}`) permanentRedirect(path);
  const settings = await portalSettings();
  const deepest = detail.place.area ?? detail.place.city ?? detail.place.region ?? detail.place.country;
  const place = deepest ? await placeOf(locale, deepest.id) : null;
  const crumbs: Crumb[] = [
    { name: t('breadcrumb.home'), path: homePath(locale) },
    { name: t('breadcrumb.all'), path: searchPath(locale) },
    ...(place
      ? [...place.ancestors, place.place].map((p) => ({ name: p.name, path: searchPath(locale, p.path) }))
      : []),
    { name, path },
  ];
  const ld = developmentJsonLd({
    url: `${settings.origin}${path}`,
    name,
    description: detail.description ? excerpt(detail.description, 500) : null,
    price:
      detail.price.fromCents === null
        ? null
        : {
            low: detail.price.fromCents / 100,
            high: (detail.price.toCents ?? detail.price.fromCents) / 100,
            currency: detail.price.currency,
          },
    available: detail.units.available,
    address: {
      locality: detail.place.city?.name ?? null,
      region: detail.place.region?.name ?? null,
      country: detail.place.country?.name ?? null,
    },
    geo: detail.geo ? { lat: detail.geo.lat, lng: detail.geo.lng } : null,
    agency: development.agency
      ? { name: development.agency.name, url: profileUrl(settings.origin, agencyPath(locale, development.agency)) }
      : null,
    dateModified: development.updatedAt.toISOString(),
  });
  return (
    <PortalShell
      locale={locale}
      alternates={Object.fromEntries(PORTAL_LOCALES.map((l) => [l, developmentPath(l, name, development.code)]))}
    >
      <JsonLd json={serializeJsonLd(ld)} />
      <JsonLd json={serializeJsonLd(breadcrumbJsonLd(settings.origin, crumbs))} />
      <DevelopmentView locale={locale} development={development} title={name} crumbs={crumbs} />
    </PortalShell>
  );
}
