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
import { assertPortalLocale, developmentByCode, placeOf, portalSettings } from '@/portal/data';
import { legacyRedirectFor } from '@/portal/legacy';
import { JsonLd } from '@/portal/ui/breadcrumbs';
import { DevelopmentView } from '@/portal/ui/development';
import { PortalShell } from '@/portal/ui/shell';
import { codeOfSlug } from '@/portal/urls';

/**
 * A new-build development page (S15-01): `/development/<name>-<code>` — an OPEN development's public page with its
 * available and reserved homes, ISR (5 minutes), JSON-LD (`RealEstateListing` with an `AggregateOffer`, breadcrumbs),
 * canonical and hreflang (built in core, S15-F7; the ISR copy carries the development's and agency's cache tags).
 * Another slug for the same code 301s to the current one. 2–3 statements.
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

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  assertPortalLocale(locale);
  const development = await load(locale, slug);
  if (!development) return {};
  const { origin } = await portalSettings();
  return portalMetadataFor({ kind: 'development', locale, origin, development });
}

export default async function DevelopmentPage({ params }: Props) {
  const { locale, slug } = await params;
  assertPortalLocale(locale);
  setRequestLocale(locale);
  const development = await load(locale, slug);
  if (!development) {
    // S15-F7: the cached 404 (or redirect) carries the code, so a restored development comes back within a minute.
    const code = codeOfSlug(slug);
    if (code) await tagPage([portalPageTag.code(code)]);
    const to = await legacyRedirectFor(`/${locale}/development/${slug}`);
    if (to) permanentRedirect(to);
    notFound();
  }
  const path = development.paths[locale] as string;
  // One URL per development and locale: any other slug (a listing's link, a renamed development) moves here.
  if (path !== `/${locale}/development/${slug}`) permanentRedirect(path);
  const settings = await portalSettings();
  const { detail } = development;
  const deepest = detail.place.area ?? detail.place.city ?? detail.place.region ?? detail.place.country;
  const place = deepest ? await placeOf(locale, deepest.id) : null;
  // S15-F7: title, breadcrumbs, JSON-LD and the ISR copy's cache tags from core (PATTERNS §19).
  const page = { kind: 'development', locale, origin: settings.origin, development, place } as const;
  await tagPage(portalPageTags(page));
  return (
    <PortalShell locale={locale} alternates={development.paths}>
      {portalJsonLd(page).map((ld) => (
        <JsonLd key={(ld as { '@type': string })['@type']} json={serializeJsonLd(ld)} />
      ))}
      <DevelopmentView
        locale={locale}
        development={development}
        title={portalPageTitle(page)}
        crumbs={portalCrumbs(page)}
      />
    </PortalShell>
  );
}
