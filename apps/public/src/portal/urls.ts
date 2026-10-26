import { slugOf } from '@inmolink/core/modules/websites';

export { hasFilters, queryString } from './query';

/**
 * The portal's URL shapes (S15-01). Pure: pages, links, canonicals and tests build every portal URL here, so the
 * legacy redirects (S15-02) and the profile pages (S15-03) have one place to read them from.
 *
 * - `/{locale}/properties` — every listing; `/{locale}/properties/{country}/{region}/{city}/{area}` — a location page
 * - `/{locale}/zone/{slug}` — a location group (a comarca, a coast)
 * - `/{locale}/property/{type-in-town}-{code}` — a listing (its public code, lower case)
 * - `/{locale}/development/{name}-{code}` — a new-build development with its units (its public code, lower case)
 * - `/{locale}/agency/{agencyId}/{name}` — the listing agency's profile (built by S15-03; not linked until then,
 *   `AGENCY_PROFILES_LIVE`)
 * Filters ride in the query string (`PortalQuery`), numbered pages as `?page=N`.
 */

export const homePath = (locale: string) => `/${locale}`;
export const searchPath = (locale: string, placePath: readonly string[] = []) =>
  ['', locale, 'properties', ...placePath.map(encodeURIComponent)].join('/');
export const zonePath = (locale: string, slug: string) => `/${locale}/zone/${encodeURIComponent(slug)}`;
export const listingPath = (locale: string, title: string, code: string) =>
  `/${locale}/property/${slugOf(title, 'property')}-${code.toLowerCase()}`;
export const developmentPath = (locale: string, name: string, code: string) =>
  `/${locale}/development/${slugOf(name, 'development')}-${code.toLowerCase()}`;

/**
 * The agency profile pages are live (S15-03 flips this): until then the portal names the listing agency without a
 * link and its JSON-LD carries no profile URL — no link to a page that does not exist yet.
 */
export const AGENCY_PROFILES_LIVE = false;

/** The listing agency's profile page, or null while the profiles are not live (`AGENCY_PROFILES_LIVE`). */
export function agencyPath(locale: string, agency: { id: string; name: string }): string | null {
  return AGENCY_PROFILES_LIVE ? `/${locale}/agency/${agency.id}/${slugOf(agency.name, 'agency')}` : null;
}

/** An absolute profile URL for JSON-LD, or null while there is no profile page. */
export const profileUrl = (origin: string, path: string | null) => (path ? `${origin}${path}` : null);

/**
 * An agency- or agent-supplied URL the portal may link to: absolute `http:` / `https:` only (a `javascript:`, `data:`
 * or relative value is never rendered as a link — defence in depth beside the profile's own input check). Null: no
 * link.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

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
