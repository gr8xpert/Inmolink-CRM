import {
  portalCrumbs,
  portalJsonLd,
  portalMetadataFor,
  portalPageTag,
  portalPageTags,
  portalPageTitle,
  serializeJsonLd,
} from '@inmolink/core/modules/website-api';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { tagPage } from '@/portal/cache-tags';
import { assertPortalLocale, listingByCode, placeOf, portalSettings } from '@/portal/data';
import { legacyRedirectFor } from '@/portal/legacy';
import { JsonLd } from '@/portal/ui/breadcrumbs';
import { ListingView } from '@/portal/ui/listing';
import { PortalShell } from '@/portal/ui/shell';
import { codeOfSlug } from '@/portal/urls';

/**
 * A listing page (S15-01, PATTERNS §19): `/property/<type-in-town>-<code>` — the listing a public code names, ISR
 * (5 minutes; CDN-cacheable), JSON-LD `RealEstateListing` + `BreadcrumbList`, canonical and hreflang (built in core,
 * S15-F7). The ISR copy carries its listing's and agency's cache tags: a price change, a withdrawal or an agency change
 * drops it on every instance (`website-api/portal-cache.ts`). A slug that is
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

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  assertPortalLocale(locale);
  const listing = await load(locale, slug);
  if (!listing) return {};
  const { origin } = await portalSettings();
  return portalMetadataFor({ kind: 'listing', locale, origin, listing });
}

export default async function ListingPage({ params }: Props) {
  const { locale, slug } = await params;
  assertPortalLocale(locale);
  setRequestLocale(locale);
  const listing = await load(locale, slug);
  if (!listing) {
    // S15-F7: the cached 404 (or redirect) carries the code, so a restored listing comes back within a minute.
    const code = codeOfSlug(slug);
    if (code) await tagPage([portalPageTag.code(code)]);
    const to = await legacyRedirectFor(`/${locale}/property/${slug}`);
    if (to) permanentRedirect(to);
    notFound();
  }
  const path = listing.paths[locale] as string;
  // One URL per listing and locale: an old slug (type or town renamed) moves to the current one.
  if (path !== `/${locale}/property/${slug}`) permanentRedirect(path);
  const settings = await portalSettings();
  const { detail } = listing;
  const deepest = detail.place.area ?? detail.place.city ?? detail.place.region ?? detail.place.country;
  const place = deepest ? await placeOf(locale, deepest.id) : null;
  // S15-F7: title, breadcrumbs, JSON-LD and the ISR copy's cache tags from core (PATTERNS §19).
  const page = { kind: 'listing', locale, origin: settings.origin, listing, place } as const;
  await tagPage(portalPageTags(page));
  return (
    <PortalShell locale={locale} alternates={listing.paths}>
      {portalJsonLd(page).map((ld) => (
        <JsonLd key={(ld as { '@type': string })['@type']} json={serializeJsonLd(ld)} />
      ))}
      <ListingView
        locale={locale}
        listing={listing}
        title={portalPageTitle(page)}
        crumbs={portalCrumbs(page)}
        settings={settings}
      />
    </PortalShell>
  );
}
