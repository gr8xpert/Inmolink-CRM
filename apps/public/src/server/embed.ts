import * as websiteApi from '@inmolink/core/modules/website-api';
import { isAppError } from '@inmolink/platform/errors';
import { clientIpFromForwarded } from '@inmolink/platform/http';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { ipBucket, rateLimiter } from '@inmolink/platform/rate-limit';
import { originOf } from '../embed/csp';
import { gateMarker, gateMarkerValid, minuteOf } from '../embed/gate';
import { publicConfig } from './env';

/**
 * Embed pages' transport (S7-F8): the proxy's gate (per-IP limits, then the site check, then the gate marker), the
 * marker check of the embed routes, and the routes' site lookup. Which sites may be embedded, what they show and where
 * leads go are core's (`website-api/embed.ts`).
 */

/** Requests without a usable client address share one bucket (fails safe, never unlimited). */
export const UNKNOWN_IP = 'unknown';
const UNKNOWN_IP_LOG_INTERVAL_MS = 60_000;
let lastUnknownLog = Number.NEGATIVE_INFINITY;
let unknownSince = 0;
const log = createLogger({ service: 'public', level: process.env.LOG_LEVEL ?? 'info' });

/**
 * The client's address (Turnstile `remoteip`) and its rate-limit bucket (IPv6 by /64). No address (a missing or
 * misconfigured `TRUST_PROXY`) puts every visitor in one bucket: logged at most once a minute with the count, so a bad
 * proxy setting shows instead of quietly throttling everyone together.
 */
export async function clientAddress(forwardedFor: string | null): Promise<{ ip?: string; bucket: string }> {
  const { TRUST_PROXY } = await publicConfig();
  const ip = clientIpFromForwarded(forwardedFor, TRUST_PROXY);
  if (ip) return { ip, bucket: ipBucket(ip) };
  unknownSince += 1;
  const now = Date.now();
  if (now - lastUnknownLog >= UNKNOWN_IP_LOG_INTERVAL_MS) {
    log.warn(
      { requests: unknownSince, hasForwardedFor: forwardedFor !== null },
      'embed: no client address (TRUST_PROXY?)',
    );
    lastUnknownLog = now;
    unknownSince = 0;
  }
  return { bucket: UNKNOWN_IP };
}

/** The gate marker of a site for now (`embed/gate.ts`: keyed MAC of the site id and the minute). */
export async function embedGateMarker(siteId: string): Promise<string> {
  return gateMarker((await publicConfig()).HMAC_KEY, siteId, minuteOf(Date.now()));
}

/** Whether a request carries the proxy's marker for this site, of this or the previous minute. */
export async function passedGate(siteId: string, marker: string | null): Promise<boolean> {
  return gateMarkerValid((await publicConfig()).HMAC_KEY, siteId, marker, Date.now());
}

export type EmbedGateResult =
  | { kind: 'ok'; marker: string }
  | { kind: 'not-found' }
  | { kind: 'limited'; retryAfterSeconds: number };

/**
 * Before an embed route runs: the client's page limit first (so made-up site ids cost one Redis call, not a database
 * read), then whether the site may be embedded (`embedSiteScope`: the site scope only, cached, unknown ids cached as
 * missing), then the marker the route checks.
 */
export async function embedGate(siteId: string, forwardedFor: string | null): Promise<EmbedGateResult> {
  await publicConfig();
  const limit = await websiteApi.checkEmbedLimits(rateLimiter(), { ip: (await clientAddress(forwardedFor)).bucket });
  if (!limit.allowed) return { kind: 'limited', retryAfterSeconds: limit.retryAfterSeconds };
  try {
    await websiteApi.embedSiteScope(siteId);
  } catch (err) {
    if (isAppError(err) && err.code === 'SITE_NOT_FOUND') return { kind: 'not-found' };
    throw err;
  }
  return { kind: 'ok', marker: await embedGateMarker(siteId) };
}

/** The embed site a route renders (checked again here: the URL's site id is never trusted); null when refused. */
export async function embedSiteFor(siteId: string): Promise<websiteApi.EmbedSite | null> {
  await publicConfig();
  try {
    return await websiteApi.embedSite(siteId, newId());
  } catch (err) {
    if (isAppError(err) && err.code === 'SITE_NOT_FOUND') return null;
    throw err;
  }
}

/** The media CDN's origin (preconnect, `img-src`) and the Turnstile site key (null: no form until H3). */
export async function embedPageConfig(): Promise<{ mediaOrigin: string | null; turnstileSiteKey: string | null }> {
  const config = await publicConfig();
  return { mediaOrigin: originOf(config.MEDIA_CDN_URL), turnstileSiteKey: config.TURNSTILE_SITE_KEY ?? null };
}
