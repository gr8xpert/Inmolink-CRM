/**
 * The portal pages' CDN headers (S15-01, S15 review): one place for `next.config.ts` (its `headers()` rules) and the
 * proxy (`proxy.ts`), so the two cannot disagree. Plain constants: the proxy bundle stays free of the config's imports.
 *
 * Next (16.4) keeps a `Cache-Control` a `headers()` rule set: a page's own (`s-maxage=<revalidate>,
 * stale-while-revalidate=<expireTime − revalidate>`) is only written when none is set yet (`sendRenderResult`). The
 * proxy's headers are applied after the rules, so its `no-store` (a 429, a page with an enquiry notice) wins.
 */

/**
 * Search, location, zone, agency and home pages: rendered per request, no visitor data — the CDN keeps them 45 s and
 * serves a stale copy 15 s while it refetches, so a withdrawn listing or an agency change leaves them within a minute.
 * An origin outage is bridged for 10 minutes at most (S15 review: not a day — a suspended agency's stock would stay).
 */
export const PORTAL_PAGE_CACHE = 'public, max-age=0, s-maxage=45, stale-while-revalidate=15, stale-if-error=600';

/**
 * S15 review: listing and development pages (ISR, `revalidate = 300` in process). Next would send `s-maxage=300` and
 * about a year of `stale-while-revalidate` (its default `expireTime`), and the page cache's tag invalidation (S15-F7)
 * never reaches the CDN — a withdrawn listing or a suspended agency's contacts could be served from the edge long
 * after. The edge keeps them a minute (+30 s stale); the in-process page cache keeps the renders cheap.
 */
export const PORTAL_ISR_PAGE_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=30, stale-if-error=600';

/** S15-03 review: a page with the enquiry form's answer (`?enquiry=`) is the visitor's own. */
export const ENQUIRY_NOTICE_CACHE = 'private, no-store';
