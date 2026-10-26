import { rateLimiter } from '@inmolink/platform/rate-limit';
import { clientAddress, UNKNOWN_IP } from './embed';
import { publicConfig } from './env';

/**
 * The portal's per-client page limit (S15-01 review): search, location and zone pages render per request (the query
 * string is the search), so one client may load `PORTAL_PAGE_LIMIT_PER_MINUTE` of them a minute — generous for people,
 * a ceiling for scrapers. Fails open: a limits outage (the rule's default) or an unknown client address (a missing
 * `TRUST_PROXY`: everyone would share one bucket) never refuses a page.
 */
export async function portalPageGate(
  forwardedFor: string | null,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const config = await publicConfig();
  const { bucket } = await clientAddress(forwardedFor);
  if (bucket === UNKNOWN_IP) return { allowed: true, retryAfterSeconds: 0 };
  const result = await rateLimiter().consume(
    { name: 'portal.page', scope: 'ip', limit: config.PORTAL_PAGE_LIMIT_PER_MINUTE, windowSeconds: 60 },
    bucket,
  );
  return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
}
