/**
 * The portal's 404 hook for legacy URLs (S15-01 → S15-02). Every portal path that names nothing (an unknown location,
 * a listing code that is gone, any other path under a locale) asks this first; a known legacy URL answers with its
 * 301 target, so a URL that existed never ends in a 404 (frontend rules, PLAN §14).
 *
 * S15-02 wires it to `migration.resolveLegacyRedirect('portal', url)` (S14-05: one indexed probe, cached) and flushes
 * the hit counts. Until then nothing is known: null. Whatever the resolver answers goes through `localRedirectTarget`:
 * a redirect never leaves the portal's own origin.
 */
export async function legacyRedirectFor(_path: string): Promise<string | null> {
  return localRedirectTarget(null);
}

/**
 * A redirect target the portal may answer with: a path on its own origin (`/…`), never a protocol-relative (`//host`)
 * or backslash (`/\host`, which browsers read as `//host`) URL, an absolute URL, or anything with control characters.
 * Null otherwise.
 */
export function localRedirectTarget(target: string | null | undefined): string | null {
  if (!target?.startsWith('/')) return null;
  if (target.startsWith('//') || target.startsWith('/\\')) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  if (/[\u0000-\u001f\u007f\\]/.test(target)) return null;
  return target;
}
