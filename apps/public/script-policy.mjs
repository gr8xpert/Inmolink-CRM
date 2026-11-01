// S16-F8 (security-R1.md M-3): the portal pages' script policy. Plain ESM: `cache-handler.mjs` (loaded by Next at
// runtime, uncompiled), the proxy and the server's fallback (`src/server/script-fallback.ts`) share it.
//
// No `'unsafe-inline'`, no `eval` outside development, no `'strict-dynamic'`: inline scripts run only with the page's
// nonce or hash; script files only from this origin (Next's chunks) and Cloudflare Turnstile (the enquiry form loads
// `api.js` on first use, which loads its own resources from the same host — Cloudflare's documented CSP).
//
// - Pages rendered per request (home, search, location, zone, agency, 404s): the proxy sends the policy with a fresh
//   nonce, the CDN keeps header and HTML together (a cached copy reuses its nonce; without `'strict-dynamic'` that
//   nonce can only run the copy's own inline scripts).
// - ISR pages (listing, development; ADR 0019 (A) page cache): rendered once, served many times — and Next renders
//   them without the request's nonce (a static render). The page cache (`cache-handler.mjs`) hashes the inline scripts
//   Next wrote into the HTML it stores (`stored-page-policy.mjs`) and keeps that `script-src` in the entry's headers:
//   every answer from the entry, the first included, carries the hashes of exactly its own scripts.
// - Any HTML answer that still has no `script-src` (an error page, a render Next did not store): the server adds
//   `FALLBACK_PAGE_CSP` (no inline script at all) just before the headers go out.

// S17-F1: Turnstile's origin (enquiry forms), the page base directives and the nonce are platform's, shared with the
// dashboard.
import { newNonce, PAGE_BASE_CSP, TURNSTILE_ORIGIN } from '@inmolink/platform/web-security';

export { newNonce, PAGE_BASE_CSP, TURNSTILE_ORIGIN };

/** Where browsers send violation reports (`app/api/csp-report`). */
export const CSP_REPORT_PATH = '/api/csp-report';
export const CSP_REPORT_DIRECTIVE = `report-uri ${CSP_REPORT_PATH}`;

/** 16 random bytes, base64 (`newNonce`): exactly what a nonce of ours looks like. */
export const NONCE_SHAPE = /^[A-Za-z0-9+/]{22}==$/;

/** The `script-src` directive for a render's nonce. */
export function portalScriptSrc(nonce, dev = false) {
  if (!NONCE_SHAPE.test(nonce)) throw new TypeError('portal script policy: malformed nonce');
  return `script-src 'self' 'nonce-${nonce}' ${TURNSTILE_ORIGIN}${dev ? " 'unsafe-eval'" : ''}`;
}

/** A CSP hash source (`sha256-<base64 of 32 bytes>`). */
export const SHA256_SOURCE = /^sha256-[A-Za-z0-9+/]{43}=$/;

/** The `script-src` directive of a stored page: the hashes of its own inline scripts (`stored-page-policy.mjs`). */
export function hashedScriptSrc(hashes, dev = false) {
  const sources = hashes.filter((h) => SHA256_SOURCE.test(h)).map((h) => ` '${h}'`);
  return `script-src 'self' ${TURNSTILE_ORIGIN}${sources.join('')}${dev ? " 'unsafe-eval'" : ''}`;
}

/** An HTML answer without any `script-src` of its own: no inline script runs (the page shows, unhydrated). */
export const FALLBACK_PAGE_CSP = `${PAGE_BASE_CSP}; script-src 'self' ${TURNSTILE_ORIGIN}; ${CSP_REPORT_DIRECTIVE}`;
