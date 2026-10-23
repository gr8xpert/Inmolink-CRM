/** `https:` only, plus plain `http://localhost` for local development; anything else is refused. */
export function safeBaseUrl(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The key and API URL pair for one host element, or none. They are a pair: both from the element, or both from the
 * script tag. The script's key is never sent to an element's own URL (markup an attacker adds to the page cannot
 * redirect it).
 */
export function connection(
  host: Record<string, string | undefined>,
  scriptData: Record<string, string | undefined> | undefined,
): { apiKey: string; baseUrl: string; turnstileSiteKey?: string; privacyUrl?: string } | undefined {
  const own = host.apiKey || host.baseUrl ? host : scriptData;
  const baseUrl = safeBaseUrl(own?.baseUrl);
  if (!own?.apiKey || !baseUrl) return undefined;
  // The lead form's settings (S8-F8) travel with the pair: a script tag's site key and privacy notice never apply
  // to an element that brings its own key, nor an element's to the script's key.
  const { turnstileSiteKey, privacyUrl } = own;
  return {
    apiKey: own.apiKey,
    baseUrl,
    ...(turnstileSiteKey ? { turnstileSiteKey } : {}),
    ...(privacyUrl ? { privacyUrl } : {}),
  };
}
