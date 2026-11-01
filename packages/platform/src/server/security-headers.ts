/**
 * Response security headers of every Fastify app (api, feed-api, realtime, worker health) — S16-03, PLAN §12.
 *
 * These apps answer JSON, XML, iCal, zip downloads and redirects — never a page a browser should run. So every response
 * (route answers, errors, 404s, 429s, health checks) gets a CSP that allows nothing, may not be framed or sniffed into
 * another type, sends no Referer, and is HTTPS-only once a browser has seen it over TLS (HSTS is ignored on plain HTTP,
 * so local stacks are unaffected). The dev-only Swagger UI (`/docs`, `docsUi`) keeps its own scripts: no CSP there.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'cross-origin-opener-policy': 'same-origin',
};

/** The headers for a request path: all of them, except the CSP under the dev-only `/docs` when it is served. */
export function securityHeadersFor(path: string, docsUi: boolean): Record<string, string> {
  if (docsUi && (path === '/docs' || path.startsWith('/docs/'))) {
    const { 'content-security-policy': _csp, ...rest } = API_SECURITY_HEADERS;
    return rest;
  }
  return { ...API_SECURITY_HEADERS };
}
