/**
 * A redirect target the portal may answer with: a path on its own origin (`/…`), never a protocol-relative (`//host`)
 * or backslash (`/\host`, which browsers read as `//host`) URL, an absolute URL, or anything with control characters.
 * Null otherwise. (S15-01; its own module since S15-02 so the legacy lookup and the pages share it without a cycle.)
 */
export function localRedirectTarget(target: string | null | undefined): string | null {
  if (!target?.startsWith('/')) return null;
  if (target.startsWith('//') || target.startsWith('/\\')) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  if (/[\u0000-\u001f\u007f\\]/.test(target)) return null;
  return target;
}
