import type { FeedListingInput } from '@inmolink/contracts';
import { MEDIA_PER_LISTING_MAX } from '@inmolink/contracts';
import { formatDefaults } from './config';
import type { FeedItemProblem, MapResult } from './connectors';
import { htmlToPlainText } from './html';
import { clip, decimal } from './values';

/**
 * The finishing steps every XML format connector shares (S6-07): the checks and the shaping that turn values a
 * mapper has read into the loader's `FeedListing`. Pure. A mapper reads its format's elements; this file holds
 * what is the same for all of them (coordinates, features, images, translations, price on request).
 */

export const problem = (code: string, field: string, message?: string): FeedItemProblem => ({
  code,
  field,
  ...(message ? { message } : {}),
});

export interface FormatSettings {
  /** Country for feeds that do not send one. */
  defaultCountry: string;
  /** Locale of text the feed does not tag with a language. */
  defaultLocale: string;
  /** Currency of a price the feed sends without one. */
  defaultCurrency: string;
}

/** The connection's settings over its format's defaults (`FORMAT_DEFAULTS` in config.ts, S7-F2). */
export function formatSettings(settings: Record<string, unknown>, connector: string): FormatSettings {
  const d = formatDefaults(connector, settings);
  return { defaultCountry: d.country, defaultLocale: d.locale, defaultCurrency: d.currency };
}

/** Latitude and longitude texts to a point; 0,0, out of range or unreadable is no point. */
export function point(lat: string | undefined, lng: string | undefined): { lat: number; lng: number } | null {
  const la = decimal(lat);
  const ln = decimal(lng);
  return la !== null && ln !== null && !(la === 0 && ln === 0) && Math.abs(la) <= 90 && Math.abs(ln) <= 180
    ? { lat: la, lng: ln }
    : null;
}

/** Distinct (case-insensitive), trimmed, non-empty, in feed order. */
export function uniqueTexts(texts: Iterable<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of texts) {
    const t = raw?.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

/** http(s) image addresses only, in feed order, capped at the per-listing media limit. */
export function httpImages(urls: Iterable<string | undefined>): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const url = raw?.trim();
    if (url && /^https?:\/\/\S+$/i.test(url) && out.length < MEDIA_PER_LISTING_MAX) out.push(url);
  }
  return out;
}

/** A two-letter language code from a `lang` value (`es`, `ES`, `es-ES`); null otherwise (`all`, `spa`). */
export function localeOf(value: string | undefined): string | null {
  const m = /^([A-Za-z]{2})(?:[-_][A-Za-z]{2,4})?$/.exec(value?.trim() ?? '');
  return m ? (m[1] as string).toLowerCase() : null;
}

/** First text per locale, in feed order. */
export class PerLocale {
  readonly map = new Map<string, string>();
  add(locale: string | null, text: string | undefined) {
    const t = text?.trim();
    if (locale && t && !this.map.has(locale)) this.map.set(locale, t);
  }
}

/** One translation per locale that has a title or a description; a listing without text gets one in the default locale. */
export function buildTranslations(
  titles: Map<string, string>,
  descriptions: Map<string, string>,
  generated: string,
  defaultLocale: string,
): NonNullable<FeedListingInput['translations']> {
  const locales = new Set([...titles.keys(), ...descriptions.keys()]);
  if (locales.size === 0) locales.add(defaultLocale);
  return [...locales].map((locale) => {
    const description = descriptions.get(locale);
    const text = description ? htmlToPlainText(description) : '';
    const title = titles.get(locale) ? htmlToPlainText(titles.get(locale) as string, 200) : '';
    return { locale, title: title || generated, description: text || null };
  });
}

export const generatedTitle = (ref: string, ...parts: (string | undefined)[]) =>
  clip(parts.filter(Boolean).join(', ') || ref, 200);

/** Price text to cents (refused: a problem); zero and missing are price on request. */
export function priceFields(
  priceText: string | undefined,
  toCents: (text: string) => number | null,
  problems: FeedItemProblem[],
  field: string,
): { priceCents: number | null; priceOnRequest: boolean } {
  let priceCents: number | null = null;
  if (priceText !== undefined) {
    priceCents = toCents(priceText);
    if (priceCents === null) problems.push(problem('INVALID_PRICE', field, 'a decimal number'));
  }
  const priceOnRequest = priceCents === null || priceCents === 0;
  return { priceCents: priceCents === 0 ? null : priceCents, priceOnRequest };
}

/** Refuses an item with problems (keeping its ref), else wraps the listing. */
export function finishListing(
  ref: string,
  problems: FeedItemProblem[],
  item: FeedListingInput,
): MapResult<FeedListingInput> {
  return problems.length > 0 ? { ok: false, ref, problems } : { ok: true, ref, item };
}

/** An ISO 4217 code from a feed value (any case); the format's default when absent or not a code. */
export function currencyOf(value: string | undefined, fallback: string): string {
  const c = value?.trim().toUpperCase() ?? '';
  return /^[A-Z]{3}$/.test(c) ? c : fallback;
}
