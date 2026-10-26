import type { PortalQuery } from '@inmolink/contracts';
import { DEFAULT_UI_LOCALE } from '@inmolink/i18n';
import type { Metadata } from 'next';
import { languageAlternates } from './seo';
import { hasFilters, queryString } from './urls';

/**
 * A search page's metadata (S15-01): canonical (its numbered page, or the filtered URL spelled one way), hreflang to
 * the same page in each locale, Open Graph. Filtered searches are `noindex, follow` (the location pages and their
 * numbered pages are what crawlers index); numbered pages index as themselves.
 */
export function searchMetadata(input: {
  origin: string;
  locale: string;
  /** This page's path in each locale (no query). */
  paths: Readonly<Record<string, string>>;
  query: PortalQuery;
  title: string;
  description: string;
  image?: string | null;
}): Metadata {
  const filtered = hasFilters(input.query);
  const qs = queryString(input.query);
  const withQuery = Object.fromEntries(Object.entries(input.paths).map(([l, p]) => [l, `${p}${qs}`]));
  const canonical = `${input.origin}${withQuery[input.locale] ?? ''}`;
  return {
    title: input.title,
    description: input.description,
    alternates: {
      canonical,
      languages: languageAlternates(input.origin, withQuery, DEFAULT_UI_LOCALE),
    },
    robots: filtered ? { index: false, follow: true } : { index: true, follow: true },
    openGraph: {
      type: 'website',
      url: canonical,
      title: input.title,
      description: input.description,
      locale: input.locale,
      ...(input.image ? { images: [{ url: input.image }] } : {}),
    },
    twitter: { card: input.image ? 'summary_large_image' : 'summary', title: input.title },
  };
}
