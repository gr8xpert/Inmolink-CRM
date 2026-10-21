/**
 * Honeytoken listings (S7-04, PLAN §9.2 §12): fake listing cards only a full-inventory scrape reaches.
 *
 * - **Who:** only a caller that has tripped a scraping rule (`checkWebsiteLimits` → `suspicious`): a `/v2/listings`
 *   cursor chain at depth ≥ `deepPage`, or a publishable-key browser flagged for paging volume. Volume alone never
 *   flags a secret key (one server pages for all of a site's visitors). Never in `/v2/sitemap` (it feeds the site's
 *   public sitemap: search engines and buyers would follow it), the change feed, developments, totals or facets.
 * - **Where and what:** on such a caller's search pages at depth ≥ `honeytokenMinPage`, one real listing card is
 *   **replaced** by its own clone (the page keeps its size: nothing to spot by counting): the same place, type, title
 *   and cover the site already shows (white-labelled by construction), a new id, a shifted price, size and map point,
 *   and a reference in the cloned card's style — `<prefix>-<code>` for a network card, the agency's own pattern (its
 *   trailing digits replaced) for an own card.
 * - **Nothing stores them:** no table, read model, index, count, feed or sitemap holds one. Codes and digits are
 *   derived from the site and the real card (HMAC, `HMAC_KEY`) and carry a check part, so `isHoneytokenRef` recognises
 *   one from the reference alone; a detail request answers 404 like a listing just withdrawn and raises
 *   `WebsiteHoneytokenHit` (a code-style hit is first confirmed to be no real public code). Found republished
 *   elsewhere, `honeytokenSiteOf` tells which site's inventory leaked.
 */
import type { WebsiteCard, WebsiteListingCard } from '@inmolink/contracts';
import { hmacSha256 } from '@inmolink/platform/crypto';
import * as websites from '../websites';
import { countHoneytokenServed } from './alerts';

type Key = string | Uint8Array;
type Site = { siteId: string; referencePrefix: string | null };

const PURPOSE = 'website-api.honeytoken';
/** Public codes' alphabet (Crockford base32, `PublicCode`). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
/** Own-style references: the trailing digits replaced; the last `OWN_CHECK_DIGITS` are a check (1 in 10⁴). */
const OWN_MIN_DIGITS = 6;
const OWN_CHECK_DIGITS = 4;

const bytes = (key: Key, data: string) => Buffer.from(hmacSha256(key, PURPOSE, data), 'base64url');

function crockford(buf: Buffer, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += CROCKFORD[(buf[i] as number) & 31];
  return out;
}

function decimal(buf: Buffer, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += String((buf[i] as number) % 10);
  return out;
}

/** The check half of a code: its first four characters, keyed to the site. */
const checkOf = (key: Key, siteId: string, head: string) => crockford(bytes(key, `check|${siteId}|${head}`), 4);
/** The check digits of an own-style reference: everything before them, keyed to the site. */
const ownCheckOf = (key: Key, siteId: string, head: string) =>
  decimal(bytes(key, `own-check|${siteId}|${head}`), OWN_CHECK_DIGITS);

/** The honeytoken code a site derives from one of its real cards (the same card always gives the same code). */
export function honeytokenCode(key: Key, siteId: string, seed: string): string {
  const head = crockford(bytes(key, `seed|${siteId}|${seed}`), 4);
  return head + checkOf(key, siteId, head);
}

/** Whether `code` is one of this site's honeytoken codes (1 in 2²⁰ for any other code — confirm against real codes). */
export function isHoneytokenCode(key: Key, siteId: string, code: string): boolean {
  return CODE_RE.test(code) && code.slice(4) === checkOf(key, siteId, code.slice(0, 4));
}

/** The trailing digit run of an own reference long enough to carry a check, else null. */
function ownParts(ref: string): { head: string; digits: number } | null {
  const run = /(\d+)$/.exec(ref)?.[1];
  return run && run.length >= OWN_MIN_DIGITS
    ? { head: ref.slice(0, ref.length - run.length), digits: run.length }
    : null;
}

/** The reference a honeytoken cloned from `real` gets: the real card's style, or `<prefix>-<code>`. */
export function honeytokenRef(key: Key, site: Site, realRef: string): string {
  const prefix = websites.networkRefPrefix(site);
  const network = `${prefix}-${honeytokenCode(key, site.siteId, realRef)}`;
  if (realRef.toUpperCase().startsWith(`${prefix}-`) && CODE_RE.test(realRef.slice(prefix.length + 1))) return network;
  const own = ownParts(realRef);
  if (!own) return network;
  const seeded = own.head + decimal(bytes(key, `own-seed|${site.siteId}|${realRef}`), own.digits - OWN_CHECK_DIGITS);
  const ref = seeded + ownCheckOf(key, site.siteId, seeded);
  return ref === realRef ? network : ref;
}

/**
 * Whether a reference the site was asked for names one of its honeytokens: `code` (`<prefix>-<code>`, to be confirmed
 * as no real public code) or `own` (own-style, 1 in 10⁴ for any other such reference); null: not one.
 */
export function honeytokenKind(
  key: Key,
  site: Site,
  ref: string,
): { style: 'code'; code: string } | { style: 'own' } | null {
  const dash = ref.lastIndexOf('-');
  if (dash > 0 && ref.slice(0, dash).toUpperCase() === websites.networkRefPrefix(site)) {
    const code = ref.slice(dash + 1).toUpperCase();
    if (isHoneytokenCode(key, site.siteId, code)) return { style: 'code', code };
  }
  const own = ownParts(ref);
  if (own) {
    const seeded = ref.slice(0, ref.length - OWN_CHECK_DIGITS);
    if (ref.slice(-OWN_CHECK_DIGITS) === ownCheckOf(key, site.siteId, seeded)) return { style: 'own' };
  }
  return null;
}

export function isHoneytokenRef(key: Key, site: Site, ref: string): boolean {
  return honeytokenKind(key, site, ref) !== null;
}

/** Which of these sites a republished honeytoken code came from (staff tooling; also check it is no real code). */
export function honeytokenSiteOf(key: Key, siteIds: readonly string[], code: string): string | null {
  return siteIds.find((id) => isHoneytokenCode(key, id, code)) ?? null;
}

/** A deterministic factor in [1 − spread, 1 + spread] from `buf[i]`, never within 2 % of 1 (no near-duplicate). */
function shift(buf: Buffer, i: number, spread: number): number {
  const u = (buf[i] as number) / 255; // 0..1
  const magnitude = 0.02 + u * (spread - 0.02);
  return ((buf[i + 1] as number) & 1) === 0 ? 1 + magnitude : 1 - magnitude;
}

/** A UUID (RFC 9562 version 8, like `siteScopedId`) for a honeytoken. */
function uuidOf(buf: Buffer): string {
  const h = Buffer.from(buf.subarray(0, 16));
  h[6] = ((h[6] as number) & 0x0f) | 0x80;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The honeytoken a site makes from one of its real listing cards. */
export function honeytokenCard(key: Key, site: Site, real: WebsiteListingCard): WebsiteListingCard {
  const ref = honeytokenRef(key, site, real.ref);
  const b = bytes(key, `card|${site.siteId}|${ref}`);
  const price = real.price.amountCents;
  // Prices to the nearest 1,000 of the currency, like an agent's; 3–9 % away from the real one.
  const shifted =
    price === null ? null : Math.max(100_000, Math.round((price * shift(b, 16, 0.09)) / 100_000) * 100_000);
  const area = (m2: number | null, i: number) => (m2 === null ? null : Math.max(1, Math.round(m2 * shift(b, i, 0.08))));
  return {
    ...real,
    id: uuidOf(b),
    ref,
    price: { ...real.price, amountCents: shifted === price && price !== null ? price + 500_000 : shifted },
    builtM2: area(real.builtM2, 18),
    plotM2: area(real.plotM2, 20),
    // A different point nearby (about 20 m to 1 km away), same precision.
    geo: real.geo
      ? {
          ...real.geo,
          lat: Number((real.geo.lat + (shift(b, 22, 0.009) - 1)).toFixed(6)),
          lng: Number((real.geo.lng + (shift(b, 24, 0.009) - 1)).toFixed(6)),
        }
      : null,
    developmentId: null,
    developmentRef: null,
  };
}

/**
 * A search page with one listing card replaced by its honeytoken clone (the page keeps its size), or the page as it is:
 * only listing cards outside developments are cloned. The card and its position follow from the page's cursor, so the
 * same page always looks the same.
 */
export function withHoneytoken(key: Key, site: Site, cursor: string, items: WebsiteCard[]): WebsiteCard[] {
  const candidates = items
    .map((c, i) => ({ c, i }))
    .filter(
      (x): x is { c: WebsiteListingCard; i: number } =>
        x.c.kind === 'LISTING' && x.c.developmentId === null && x.c.developmentRef === null,
    );
  if (candidates.length === 0) return items;
  const b = bytes(key, `page|${site.siteId}|${cursor}`);
  const pick = candidates[(b[0] as number) % candidates.length] as { c: WebsiteListingCard; i: number };
  const token = honeytokenCard(key, site, pick.c);
  if (items.some((c) => c.ref === token.ref || c.id === token.id)) return items;
  countHoneytokenServed();
  return items.map((c, i) => (i === pick.i ? token : c));
}
