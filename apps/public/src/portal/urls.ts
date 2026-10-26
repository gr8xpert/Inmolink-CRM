import { agencyPath as coreAgencyPath } from '@inmolink/core/modules/website-api';

// S15-02: the page shapes live in core (the sitemaps job builds the same URLs); re-exported for the pages.
export {
  developmentPath,
  homePath,
  listingPath,
  safeHttpUrl,
  searchPath,
  zonePath,
} from '@inmolink/core/modules/website-api';
export { hasFilters, queryString } from './query';

/**
 * The portal's URL shapes (S15-01). Pure: pages, links, canonicals and tests build every portal URL here (the page
 * shapes from core, S15-02), so the legacy redirects and the profile pages (S15-03) have one place to read them from.
 *
 * - `/{locale}/properties` — every listing; `/{locale}/properties/{country}/{region}/{city}/{area}` — a location page
 * - `/{locale}/zone/{slug}` — a location group (a comarca, a coast)
 * - `/{locale}/property/{type-in-town}-{code}` — a listing (its public code, lower case)
 * - `/{locale}/development/{name}-{code}` — a new-build development with its units (its public code, lower case)
 * - `/{locale}/agency/{agencyId}/{name}` — a listed agency's profile with its PUBLIC listings (S15-03)
 * Filters ride in the query string (`PortalQuery`), numbered pages as `?page=N`.
 */

/**
 * A listed agency's profile page (S15-03; core's `agencyPath`, the one its canonical, the sitemaps and the legacy
 * redirects use). Only agencies the portal names have one: an unlisted agency is never named at all.
 */
export function agencyPath(locale: string, agency: { id: string; name: string }): string {
  return coreAgencyPath(locale, agency.id, agency.name);
}

/** An absolute profile URL for JSON-LD. */
export const profileUrl = (origin: string, path: string) => `${origin}${path}`;

/** `rel` for links to sites the portal does not vouch for. */
export const EXTERNAL_REL = 'nofollow noopener noreferrer';

/** A listing slug's public code (its last 8 characters after a `-`, upper case), or null. */
export function codeOfSlug(slug: string): string | null {
  const m = /-([0-9a-hjkmnp-tv-z]{8})$/i.exec(slug);
  return m ? (m[1] as string).toUpperCase() : null;
}

/**
 * A mail link to a published address, or null: a plain `local@domain` address only (no spaces, quotes, angle brackets
 * or extra `?`/`&` headers), its local part percent-encoded.
 */
export function mailtoHref(email: string | null | undefined, subject: string): string | null {
  if (!email) return null;
  const m =
    /^([^\s@"'<>()[\]\\,;:?&]{1,64})@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i.exec(
      email.trim(),
    );
  if (!m) return null;
  return `mailto:${encodeURIComponent(m[1] as string)}@${m[2]}?subject=${encodeURIComponent(subject)}`;
}
