/**
 * Per-site XML feed documents (S7-07, PLAN §9.5): one site's inventory as **Kyero v3** (`kyero.xml`, the format
 * Spanish portals and web designers import) and as **Inmolink generic XML v1** (`inmolink.xml`, every field a site
 * shows). Pure: items in, `XmlWriter` calls out — every value goes through the escaping writer, never into markup.
 *
 * An item is the site's own white-labelled detail (`serializeDetailsFor`, the same as `/v2/listings/{ref}`): the
 * reference the site shows, the presenting agency, sanitized network text and the site agency's overrides. Nothing
 * here can add the owner's identity, the commission or a honeytoken: the details carry none (strict contracts), and
 * honeytokens exist only on deep search pages of flagged callers.
 *
 * Schemas: `tests/fixtures/kyero/kyero-v3.xsd` and `tests/fixtures/website-feed/inmolink-feed-v1.xsd` (validated in
 * the tests). Kyero takes priced sales and monthly (long-term) or weekly (holiday) rentals only: other items — price on
 * request, nightly rentals, no town — are left out of `kyero.xml` and counted (`kyeroCount`).
 */
import type { WebsiteDetail, WebsiteImage, WebsiteMedia } from '@inmolink/contracts';
import type { XmlWriter } from '@inmolink/platform/xml';

/** One listing or unit of the site, in each of its languages. */
export interface FeedItem {
  /** The detail in the feed's base locale (types, places and features are named in it). */
  base: WebsiteDetail;
  /** Own text per site locale (locale → detail), only where the listing has text in that language. */
  texts: ReadonlyMap<string, WebsiteDetail>;
  /** The document's last change. */
  updatedAt: Date;
}

/** Languages Kyero v3 takes in `<desc>` and `<url>` (the schema fixture lists the same). */
export const KYERO_LANGUAGES: ReadonlySet<string> = new Set([
  'en',
  'es',
  'de',
  'fr',
  'nl',
  'it',
  'pt',
  'ru',
  'sv',
  'no',
  'da',
  'fi',
  'pl',
]);

/** Kyero's date: `YYYY-MM-DD HH:MM:SS` (UTC). */
export const kyeroDate = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

const images = (media: readonly WebsiteMedia[]): WebsiteImage[] =>
  media.filter((m): m is WebsiteImage => m.kind === 'IMAGE' || m.kind === 'FLOOR_PLAN');

const imageUrl = (img: WebsiteImage) => img.urls.large ?? img.urls.medium ?? img.urls.og ?? img.urls.small ?? null;

/** Kyero's `price_freq` for an item, or null: Kyero has no place for it. */
function kyeroFrequency(d: WebsiteDetail): 'sale' | 'month' | 'week' | null {
  if (d.kind === 'UNIT') return 'sale';
  if (d.transactionType === 'SALE') return 'sale';
  if (d.transactionType === 'RENT_LONG_TERM' && (d.price.period ?? 'MONTH') === 'MONTH') return 'month';
  if (d.transactionType === 'RENT_SHORT_TERM' && d.price.period === 'WEEK') return 'week';
  return null;
}

/** CEE label → Kyero's energy value (A–G, `exempt`, `in_progress`). */
function kyeroEnergy(rating: string | null): string | null {
  if (rating === null) return null;
  if (rating === 'EXEMPT') return 'exempt';
  if (rating === 'PENDING') return 'in_progress';
  return rating;
}

const POOL = /\b(pool|piscina|swimming)\b/i;

export function writeKyeroStart(w: XmlWriter): void {
  w.open('root').newline();
  w.open('kyero').leaf('feed_version', 3).close().newline();
}

export function writeKyeroEnd(w: XmlWriter): void {
  w.close().newline();
}

/**
 * Why Kyero cannot take an item, or null when it can. The names are the portal issue codes of `@inmolink/contracts`
 * (`PortalIssueCode`) on purpose: the validator reports a blocker as it is, with no mapping to drift.
 */
export type KyeroBlocker = 'PRICE_ON_REQUEST' | 'PRICE_MISSING' | 'PRICE_PERIOD' | 'TOWN_MISSING';

const kyeroAmount = (d: WebsiteDetail) =>
  d.price.onRequest || d.price.amountCents === null ? 0 : Math.round(d.price.amountCents / 100);
const kyeroTown = (d: WebsiteDetail) => d.place.city?.name ?? d.place.area?.name ?? null;

export function kyeroBlocker(d: WebsiteDetail): KyeroBlocker | null {
  if (d.price.onRequest) return 'PRICE_ON_REQUEST';
  if (kyeroAmount(d) <= 0) return 'PRICE_MISSING';
  if (kyeroFrequency(d) === null) return 'PRICE_PERIOD';
  if (kyeroTown(d) === null) return 'TOWN_MISSING';
  return null;
}

/** Images a feed lists, in order (pictures and floor plans with a usable URL). */
export function feedPictureUrls(d: WebsiteDetail): string[] {
  return d.kind === 'LISTING' ? images(d.media).flatMap((m) => imageUrl(m) ?? []) : [];
}

/** One `<property>`; false (nothing written) when Kyero cannot take the item. `maxImages`: a portal's photo cap. */
export function writeKyeroProperty(w: XmlWriter, item: FeedItem, opts: { maxImages?: number } = {}): boolean {
  const d = item.base;
  if (kyeroBlocker(d) !== null) return false;
  const freq = kyeroFrequency(d) as 'sale' | 'month' | 'week';
  const amount = kyeroAmount(d);
  const town = kyeroTown(d) as string;
  const province = d.place.region?.name ?? town;
  const listing = d.kind === 'LISTING' ? d : null;
  w.open('property');
  w.leaf('id', d.ref);
  w.leaf('date', kyeroDate(item.updatedAt));
  w.leaf('ref', d.ref);
  w.leaf('price', amount);
  w.leaf('currency', d.price.currency);
  w.leaf('price_freq', freq);
  w.leaf('part_ownership', 0);
  w.leaf('leasehold', 0);
  w.leaf('new_build', d.kind === 'UNIT' ? 1 : 0);
  w.leaf('type', d.propertyType.name);
  w.leaf('town', town);
  w.leaf('province', province);
  if (d.place.city && d.place.area) w.leaf('location_detail', d.place.area.name);
  if (d.geo) {
    w.open('location').leaf('latitude', d.geo.lat).leaf('longitude', d.geo.lng).close();
  }
  w.leaf('beds', d.bedrooms);
  w.leaf('baths', d.bathrooms);
  w.leaf('pool', listing?.features.some((f) => POOL.test(f.name) || POOL.test(f.slug)) ? 1 : 0);
  const built = listing ? listing.builtM2 : d.kind === 'UNIT' ? d.internalM2 : null;
  if (built !== null || d.plotM2 !== null) {
    w.open('surface_area');
    if (built !== null) w.leaf('built', Math.round(built));
    if (d.plotM2 !== null) w.leaf('plot', Math.round(d.plotM2));
    w.close();
  }
  const consumption = kyeroEnergy(listing?.energyRating ?? null);
  const emissions = kyeroEnergy(listing?.energyEmissionsRating ?? null);
  if (consumption !== null || emissions !== null) {
    w.open('energy_rating').leaf('consumption', consumption).leaf('emissions', emissions).close();
  }
  const descs = [...item.texts].filter(([locale, t]) => KYERO_LANGUAGES.has(locale) && t.description);
  if (descs.length > 0) {
    w.open('desc');
    for (const [locale, t] of descs) w.leaf(locale, t.description);
    w.close();
  }
  if (listing && listing.features.length > 0) {
    w.open('features');
    for (const f of listing.features) w.leaf('feature', f.name);
    w.close();
  }
  const pictures = feedPictureUrls(d).slice(0, opts.maxImages ?? Number.POSITIVE_INFINITY);
  if (pictures.length > 0) {
    w.open('images');
    pictures.forEach((url, i) => {
      w.open('image', { id: i + 1 })
        .leaf('url', url)
        .close();
    });
    w.close();
  }
  w.close().newline();
  return true;
}

// ── Generic XML v1 ──────────────────────────────────────────────────────────────────────────────────────────────

/** The generic feed's header: the presenting agency (white-label) and the run. */
export function writeGenericStart(
  w: XmlWriter,
  head: {
    /** Null: no timestamp (portal feeds: the same data gives the same bytes, so a content hash can skip an upload). */
    generatedAt: Date | null;
    siteName: string;
    locales: readonly string[];
    agency: { name: string; email: string | null; phone: string | null; website: string | null };
  },
): void {
  w.open('inmolink_feed', { version: 1, generated: head.generatedAt?.toISOString() }).newline();
  w.open('site').leaf('name', head.siteName).leaf('languages', head.locales.join(' ')).close().newline();
  w.open('agency')
    .leaf('name', head.agency.name)
    .leaf('email', head.agency.email)
    .leaf('phone', head.agency.phone)
    .leaf('website', head.agency.website)
    .close()
    .newline();
  w.open('items').newline();
}

export function writeGenericEnd(w: XmlWriter): void {
  w.close().newline().close().newline();
}

const taxon = (w: XmlWriter, name: string, t: { id: string; slug: string; name: string } | null) => {
  if (t) w.leaf(name, t.name, { id: t.id, slug: t.slug });
};

/** One `<item>`: every field the site's detail carries. */
export function writeGenericItem(w: XmlWriter, item: FeedItem): void {
  const d = item.base;
  // The site's reference only: the internal id is the same on every site and would link a network listing to its owner.
  w.open('item', { kind: d.kind, ref: d.ref });
  w.leaf('updated', item.updatedAt.toISOString());
  w.leaf('status', d.status);
  if (d.kind === 'LISTING') w.leaf('transaction', d.transactionType);
  // Cents, like the API (`amountCents`); a price on request has no amount.
  if (d.price.onRequest) w.leaf('price_on_request', true, { currency: d.price.currency });
  else w.leaf('price', d.price.amountCents, { currency: d.price.currency, period: d.price.period });
  taxon(w, 'type', d.propertyType);
  w.open('place');
  taxon(w, 'country', d.place.country);
  taxon(w, 'region', d.place.region);
  taxon(w, 'city', d.place.city);
  taxon(w, 'area', d.place.area);
  w.close();
  if (d.geo) w.leaf('geo', '', { lat: d.geo.lat, lng: d.geo.lng, precision: d.geo.precision });
  w.leaf('bedrooms', d.bedrooms);
  w.leaf('bathrooms', d.bathrooms);
  if (d.kind === 'LISTING') {
    w.leaf('built_m2', d.builtM2);
    w.leaf('plot_m2', d.plotM2);
    w.leaf('terrace_m2', d.terraceM2);
    w.leaf('year_built', d.yearBuilt);
    w.leaf('energy_rating', d.energyRating);
    w.leaf('energy_emissions_rating', d.energyEmissionsRating);
    w.leaf('development_ref', d.developmentRef);
  } else {
    w.leaf('internal_m2', d.internalM2);
    w.leaf('terrace_m2', d.terraceM2);
    w.leaf('plot_m2', d.plotM2);
    w.leaf('floor', d.floor);
    w.leaf('orientation', d.orientation);
    w.leaf('development', d.development.name, {
      ref: d.development.ref,
      status: d.development.status,
      completion: d.development.completionDate,
    });
  }
  if (item.texts.size > 0) {
    w.open('texts');
    for (const [locale, t] of item.texts) {
      w.open('text', { lang: locale });
      w.leaf('title', t.title);
      w.leaf('slug', t.slug);
      w.leaf('description', t.description);
      w.leaf('meta_title', t.metaTitle);
      w.leaf('meta_description', t.metaDescription);
      if (t.kind === 'UNIT') w.leaf('payment_terms', t.paymentTerms);
      w.close();
    }
    w.close();
  }
  if (d.kind === 'LISTING' && d.features.length > 0) {
    w.open('features');
    for (const f of d.features) taxon(w, 'feature', f);
    w.close();
  }
  const pictures = d.kind === 'LISTING' ? images(d.media) : [];
  if (pictures.length > 0) {
    w.open('images');
    for (const img of pictures) {
      w.open('image', { kind: img.kind, cover: img.cover, width: img.width, height: img.height });
      w.leaf('alt', img.alt);
      for (const [size, url] of Object.entries(img.urls)) w.leaf('url', url, { size });
      w.close();
    }
    w.close();
  }
  w.close().newline();
}
