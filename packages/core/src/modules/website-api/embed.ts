/**
 * iFrame embed pages (S7-F8, PLAN §9.5): search, results and detail of a site's inventory served by `apps/public` under
 * `/embed/<site>/<lang>/…`, for the site's own domains to frame. The pages read exactly what the website API serves
 * (`searchListings`, `listingDetail`: the site's inventory policy, give-to-get, white-label serializer, overrides,
 * public read models only — no new joins) and post leads through the S7-05 intake (`submitLead`: Turnstile, the
 * presenting agency).
 *
 * Who may be embedded (`embedSite`) — anything else is the same `SITE_NOT_FOUND` (404), so ids cannot be probed:
 * - a site that exists (a deleted agency's sites are gone with it; tenants never delete sites);
 * - in mode `IFRAME` (the agency's opt-in: no other site is served here, so a WordPress site's inventory does not
 *   become a keyless public page by accident);
 * - of an agency VERIFIED now (`scope.verified`: suspended or unverified agencies are refused, like their API keys);
 * - with at least one valid domain — the pages may be framed by those only (`frame-ancestors`).
 *
 * The site id comes from the URL, so identity is the site record alone: nothing on the request can make a site show
 * another agency's inventory (the inventory, presenter and leads all follow the site's agency).
 *
 * Limits (no API key to count against): page views per client IP (`embed.page*`) and lead posts per site × client IP
 * (the website forms' per-browser figures, `leadsPerBrowser` / `leadsPerBrowserDay`), one Redis round trip.
 */
import type { WebsiteDetail, WebsiteListingPage, WebsiteListingsQuery } from '@inmolink/contracts';
import { LocalLru } from '@inmolink/platform/cache';
import { AppError, isAppError } from '@inmolink/platform/errors';
import type { RateLimitCheck, RateLimiter } from '@inmolink/platform/rate-limit';
import * as websites from '../websites';
import { type EmbedBranding, embedBranding, embedFrameAncestors } from './embed-branding';
import { type LeadInput, submitLead } from './leads';
import { type ApiSite, apiSiteOf, listingDetail, searchListings } from './service';
import { configured, websiteLimits } from './settings';

/** A site as its embed pages serve it. */
export interface EmbedSite {
  api: ApiSite;
  siteId: string;
  /** `frame-ancestors` sources: `https://<domain>` per stored domain. Never empty. */
  frameAncestors: string[];
  branding: EmbedBranding;
  locales: string[];
  defaultLocale: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Site ids found unknown, kept `EMBED_MISS_TTL_MS` per process (review: a flood of requests for one unknown id would
 * otherwise reach the database every time — `siteScope` never caches a miss). Ids are random UUIDv7, so a site
 * created after its id was looked up in vain is not a case to serve within the minute.
 */
export const EMBED_MISS_TTL_MS = 60_000;
const missing = new LocalLru<true>(10_000);

/** Tests: forget the unknown-id cache. */
export function resetEmbedMisses(): void {
  missing.clear();
}

/** A site that may be embedded, as the proxy's gate checks it: the site scope only (cached), no inventory. */
export interface EmbedScope {
  scope: websites.SiteScope;
  /** `frame-ancestors` sources: `https://<domain>` per stored domain. Never empty. */
  frameAncestors: string[];
}

/**
 * The site an embed URL names, if it may be embedded (module comment); `SITE_NOT_FOUND` otherwise. Cached reads only on
 * a warm path (`websites.SITE_CACHE`; unknown ids `EMBED_MISS_TTL_MS`): no statement; 2 on a miss.
 */
export async function embedSiteScope(siteId: string): Promise<EmbedScope> {
  if (!UUID.test(siteId) || missing.get(siteId)) throw new AppError('SITE_NOT_FOUND');
  let scope: websites.SiteScope;
  try {
    scope = await websites.siteScope(siteId);
  } catch (err) {
    if (isAppError(err) && err.code === 'SITE_NOT_FOUND') missing.set(siteId, true, EMBED_MISS_TTL_MS);
    throw err;
  }
  const frameAncestors = embedFrameAncestors(scope.domains);
  if (scope.mode !== 'IFRAME' || !scope.verified || frameAncestors.length === 0) {
    throw new AppError('SITE_NOT_FOUND');
  }
  return { scope, frameAncestors };
}

/** The site an embed page renders (`embedSiteScope` + its inventory as the website API serves it). */
export async function embedSite(siteId: string, requestId: string): Promise<EmbedSite> {
  const { scope, frameAncestors } = await embedSiteScope(siteId);
  return {
    api: await apiSiteOf(scope, null, requestId),
    siteId: scope.siteId,
    frameAncestors,
    // No logo yet: the agency logo lives in the private bucket (no public URL to frame). `embedBranding` takes one
    // (https only) once a public variant exists; the browser loads it, never the server.
    branding: embedBranding(scope.presenter),
    locales: scope.locales,
    defaultLocale: scope.defaultLocale,
  };
}

/** The embed search / results page: one page of the site's inventory (as `/v2/listings`). */
export function embedSearch(site: EmbedSite, q: WebsiteListingsQuery): Promise<WebsiteListingPage> {
  return searchListings(site.api, q);
}

/** The embed detail page: a reference as the site shows it (as `/v2/listings/{ref}`). */
export function embedDetail(site: EmbedSite, ref: string, lang: string): Promise<WebsiteDetail> {
  return listingDetail(site.api, ref, lang);
}

/** Page views per client IP (all embeds): a visitor browses a few pages a minute; a scraper is cut off. */
export const EMBED_PAGE_LIMITS = { perMinute: 60, perDay: 2_000 } as const;

const DAY_SECONDS = 86_400;

/**
 * Embed request limits (module comment): page views per client IP — checked before the site is even looked up, so a
 * flood of made-up ids is cut off by IP — and, with `write`, the lead posts per site × IP on top. One Redis round trip;
 * the limiter fails open if Redis is down (like the website API).
 */
export async function checkEmbedLimits(
  limiter: RateLimiter,
  facts: { ip: string; write?: { siteId: string } },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const l = websiteLimits();
  const checks: RateLimitCheck[] = [
    {
      rule: { name: 'embed.page', scope: 'ip', limit: EMBED_PAGE_LIMITS.perMinute, windowSeconds: 60 },
      identity: facts.ip,
    },
    {
      rule: {
        name: 'embed.page.day',
        scope: 'ip',
        limit: EMBED_PAGE_LIMITS.perDay,
        windowSeconds: DAY_SECONDS,
        fixedWindow: true,
      },
      identity: facts.ip,
    },
  ];
  if (facts.write) {
    const browser = `${facts.write.siteId}|${facts.ip}`;
    checks.push(
      {
        rule: { name: 'embed.leads', scope: 'ip', limit: l.leadsPerBrowser, windowSeconds: l.leadWindowSeconds },
        identity: browser,
      },
      {
        rule: {
          name: 'embed.leads.day',
          scope: 'ip',
          limit: l.leadsPerBrowserDay,
          windowSeconds: DAY_SECONDS,
          fixedWindow: true,
        },
        identity: browser,
      },
    );
  }
  const results = await limiter.consumeMany(checks, { slot: facts.ip });
  const denied = results.filter((r) => !r.allowed);
  return { allowed: denied.length === 0, retryAfterSeconds: Math.max(0, ...denied.map((r) => r.retryAfterSeconds)) };
}

/**
 * A lead from an embed page's form, through the S7-05 intake as a browser form (`submitLead` with a publishable
 * caller): the visitor's Turnstile token must be solved for `website-lead` on the public pages host (`embedOrigin`);
 * the lead is the site's agency's — the presenting agency — also for a network listing.
 */
export function submitEmbedLead(
  site: EmbedSite,
  input: LeadInput,
  facts: { ip?: string; idempotencyKey: string },
): ReturnType<typeof submitLead> {
  const origin = configured().embedOrigin;
  return submitLead(site.api, input, {
    keyKind: 'PUBLISHABLE',
    keyTier: 'STANDARD',
    ...(origin ? { origin } : {}),
    ...(facts.ip ? { ip: facts.ip } : {}),
    idempotencyKey: facts.idempotencyKey,
  });
}
