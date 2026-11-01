// S17-F1: the browser-security primitives the dashboard (apps/web) and the public site (apps/public) share — one
// definition each. Plain ESM, exported unbuilt: `apps/public/next.config.ts` (loaded by `next typegen` before the
// packages are built) and the portal's uncompiled `script-policy.mjs` / `cache-handler.mjs` import it as is. Pure, and
// safe in a proxy (Web Crypto, `btoa`).

/** Cloudflare Turnstile (login, sign-up, enquiry forms): its script, challenge frame and calls. */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** The directives every page answer carries besides its scripts': no framing, no plugins, no `<base>`, own forms. */
export const PAGE_BASE_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

/** A CSP nonce: 16 random bytes, base64. */
export function newNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
