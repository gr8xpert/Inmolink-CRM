/**
 * The portal's 404 hook for legacy URLs (S15-01 → S15-02). Every portal page that names nothing (an unknown location,
 * a listing code that is gone, any other path under a locale) asks this first; a known legacy URL answers with its
 * redirect target, so a URL that existed never ends in a 404 (frontend rules, PLAN §14).
 *
 * S15-02: answered by `migration.resolveLegacyRedirect('portal', …)` (S14-05: one indexed probe, cached; hits counted
 * and handed to the worker) through `server/legacy-redirects`. Paths outside the portal's page shapes (the old site's
 * `/property-details/<ref>/<slug>`, `/agent/<id>/<name>`, `/?page_id=…`) are answered by the proxy with a true 301
 * before any page renders; a page can only answer 308 (Next's `permanentRedirect`), the same for GET crawlers. Fails
 * open: a resolver error is a plain 404. Whatever the resolver answers goes through `localRedirectTarget`: a redirect
 * never leaves the portal's own origin.
 */
export async function legacyRedirectFor(path: string): Promise<string | null> {
  try {
    return (await (await import('@/server/legacy-redirects')).legacyRedirect(path))?.targetPath ?? null;
  } catch {
    return null;
  }
}

export { localRedirectTarget } from './redirect-target';
