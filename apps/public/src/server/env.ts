import { configureDb, loadStackEnv } from '@inmolink/core';
import * as presentations from '@inmolink/core/modules/presentations';
import * as search from '@inmolink/core/modules/search';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { configureCache } from '@inmolink/platform/cache';
import {
  type Config,
  ConfigError,
  coreEnv,
  cryptoEnv,
  databaseEnv,
  httpEnv,
  loadConfig,
  mediaCdnEnv,
  networkEnv,
  planEnv,
  rateLimitEnv,
  redisEnv,
  searchEnv,
  siteFeedStorageEnv,
  turnstileEnv,
  websiteSearchEnv,
} from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { configureRateLimit } from '@inmolink/platform/rate-limit';
import { configureSearch, requestSearchConfig } from '@inmolink/platform/search';
import { configureStorage, storageConfigForBuckets } from '@inmolink/platform/storage';
import { createTurnstileVerifier } from '@inmolink/platform/turnstile';
import { z } from 'zod';

/**
 * Server-side setup of the public pages (S7-F8 iFrame embeds): like feed-api — `app_public` for the reads (website API
 * read path), `app_intake` for the embed lead form (S7-05 intake), redis-cache (site scopes), the rate-limit Redis
 * (per-IP embed limits), the search-only key and Turnstile. No `app_user`, no queue. Loaded once, lazily, on the
 * first request that needs it — never at build time.
 */
export const publicEnv = {
  ...coreEnv,
  TRUST_PROXY: httpEnv.TRUST_PROXY,
  DATABASE_URL_APP_PUBLIC: databaseEnv.DATABASE_URL_APP_PUBLIC,
  /** Embed lead forms (S7-F8 → S7-05 intake). Unset: forms are refused. */
  DATABASE_URL_APP_INTAKE: databaseEnv.DATABASE_URL_APP_INTAKE,
  REDIS_CACHE_URL: redisEnv.REDIS_CACHE_URL,
  /** S13-F21: plans enforced: an embedded site past its plan cut-off answers 402. */
  BILLING_ENFORCE_PLANS: planEnv.BILLING_ENFORCE_PLANS,
  ...rateLimitEnv,
  MEILI_URL: searchEnv.MEILI_URL,
  MEILI_SEARCH_KEY: searchEnv.MEILI_SEARCH_KEY,
  /** Development and test only (refused for APP_ROLE=http in production). */
  MEILI_MASTER_KEY: searchEnv.MEILI_MASTER_KEY.optional(),
  ...websiteSearchEnv,
  ...mediaCdnEnv,
  /** Cloudflare Turnstile (H3): the site key renders the embed form's widget, the secret checks it. */
  ...turnstileEnv,
  NETWORK_GIVE_TO_GET_MIN_SHARED: networkEnv.NETWORK_GIVE_TO_GET_MIN_SHARED,
  NETWORK_GIVE_TO_GET_GRACE_DAYS: networkEnv.NETWORK_GIVE_TO_GET_GRACE_DAYS,
  HMAC_KEY: cryptoEnv.HMAC_KEY,
  /**
   * This app's public origin (`https://sites.inmolink.es`): embed forms solve Turnstile on its host. Required in
   * production; the local default elsewhere.
   */
  PUBLIC_URL: z
    .url()
    .optional()
    .transform((v) => v?.replace(/\/+$/, '')),
  /**
   * S15-01: the portal's public origin (`https://inmolink.es`) — canonical, hreflang and Open Graph URLs. Unset: the
   * pages' own `PUBLIC_URL` (one host serving both).
   */
  PORTAL_URL: z
    .url()
    .optional()
    .transform((v) => v?.replace(/\/+$/, '')),
  /**
   * S15-01: the map tiles the portal's maps load (`https://…/{z}/{x}/{y}.png`, a provider whose terms allow it) and
   * the attribution it requires. Unset: no map is offered.
   */
  PORTAL_MAP_TILE_URL: z
    .string()
    .regex(/^https:\/\/[^\s"'<>]+\{z\}[^\s"'<>]*\{x\}[^\s"'<>]*\{y\}[^\s"'<>]*$/)
    .optional(),
  PORTAL_MAP_ATTRIBUTION: z.string().max(200).optional(),
  /** S15-01: portal search, location and zone pages one client address may load per minute (fails open). */
  PORTAL_PAGE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(240),
  /**
   * S15-02: the portal's sitemaps are read from the feeds bucket (`portal-sitemaps/…`, written by the worker), like
   * feed-api's site feeds — production gives a read-only token for that bucket. Required in production; unset
   * elsewhere: `/sitemap.xml` answers 404.
   */
  S3_ENDPOINT: siteFeedStorageEnv.S3_ENDPOINT.optional(),
  S3_REGION: siteFeedStorageEnv.S3_REGION.optional(),
  S3_ACCESS_KEY_ID: siteFeedStorageEnv.S3_ACCESS_KEY_ID.optional(),
  S3_SECRET_ACCESS_KEY: siteFeedStorageEnv.S3_SECRET_ACCESS_KEY.optional(),
  /** The feeds bucket only (no fallback to another bucket: the token reads this one, S15-02 review). */
  S3_BUCKET_FEEDS: siteFeedStorageEnv.S3_BUCKET_FEEDS,
  /**
   * S15-02, tests only: Turnstile's siteverify endpoint (the e2e stack's stub). Refused in production: there, tokens are
   * always checked by Cloudflare.
   */
  TURNSTILE_VERIFY_URL: z.url().optional(),
};
export type PublicConfig = Config<typeof publicEnv>;

/** `PUBLIC_URL` outside production when unset (`next dev` / `next start` port). */
export const LOCAL_PUBLIC_URL = 'http://localhost:3101';

/** S15-02: the portal's origin (`PORTAL_URL`, else `PUBLIC_URL`): redirects and the enquiry form's origin check. */
export const portalOriginOf = (config: Pick<PublicConfig, 'PORTAL_URL' | 'PUBLIC_URL'>): string =>
  new URL(config.PORTAL_URL ?? config.PUBLIC_URL ?? LOCAL_PUBLIC_URL).origin;

let ready: Promise<PublicConfig> | undefined;

export function loadPublicConfig(env: Record<string, string | undefined> = process.env): PublicConfig {
  if (env === process.env) loadStackEnv('dev', { allowExample: false });
  const config = loadConfig(publicEnv, { ...env, APP_ROLE: 'http' });
  if (config.NODE_ENV === 'production' && config.TRUST_PROXY === false) {
    // Next has no socket address: without a trusted proxy hop, X-Forwarded-For is client-controlled.
    throw new ConfigError([{ key: 'TRUST_PROXY', message: 'must name the proxy in front of public in production' }]);
  }
  if (config.NODE_ENV === 'production' && !config.PUBLIC_URL?.startsWith('https://')) {
    // Turnstile tokens are checked against this host: a wrong or missing one refuses every embed enquiry.
    throw new ConfigError([
      { key: 'PUBLIC_URL', message: 'must be the https origin of the public pages in production' },
    ]);
  }
  if (config.NODE_ENV === 'production' && config.TURNSTILE_VERIFY_URL) {
    throw new ConfigError([{ key: 'TURNSTILE_VERIFY_URL', message: 'tests only: not allowed in production' }]);
  }
  if (config.NODE_ENV === 'production' && !storageOf(config)) {
    // The sitemaps live in object storage: without it crawlers find no sitemap.
    throw new ConfigError([{ key: 'S3_ENDPOINT', message: 'the feeds bucket (S3_*) is required in production' }]);
  }
  return config;
}

/** The feeds bucket's storage settings, or null when not configured. */
function storageOf(config: PublicConfig) {
  const bucket = config.S3_BUCKET_FEEDS;
  if (!config.S3_ENDPOINT || !config.S3_REGION || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY || !bucket) {
    return null;
  }
  return storageConfigForBuckets(
    {
      S3_ENDPOINT: config.S3_ENDPOINT,
      S3_REGION: config.S3_REGION,
      S3_ACCESS_KEY_ID: config.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: config.S3_SECRET_ACCESS_KEY,
    },
    { feeds: bucket },
  );
}

async function setup(): Promise<PublicConfig> {
  const config = loadPublicConfig();
  const logger = createLogger({ service: 'public', level: config.LOG_LEVEL });
  await configureDb(
    {
      APP_ROLE: 'http',
      DATABASE_URL_APP_PUBLIC: config.DATABASE_URL_APP_PUBLIC,
      ...(config.DATABASE_URL_APP_INTAKE ? { DATABASE_URL_APP_INTAKE: config.DATABASE_URL_APP_INTAKE } : {}),
    },
    { logger },
  );
  await configureCache({ url: config.REDIS_CACHE_URL, logger });
  await configureRateLimit({ url: config.REDIS_LIMITS_URL, logger });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: config.MEDIA_CDN_URL,
    cursorKey: config.HMAC_KEY,
    turnstile: config.TURNSTILE_SECRET_KEY
      ? createTurnstileVerifier({
          secretKey: config.TURNSTILE_SECRET_KEY,
          logger,
          ...(config.TURNSTILE_VERIFY_URL ? { endpoint: config.TURNSTILE_VERIFY_URL } : {}),
        })
      : null,
    embedOrigin: config.PUBLIC_URL ?? LOCAL_PUBLIC_URL,
    // S15-02: portal enquiry forms solve Turnstile on the portal's host.
    portalOrigin: portalOriginOf(config),
    // S13-F21: the website API cut-off of a site whose plan lost it applies only while plans are enforced.
    enforcePlans: config.BILLING_ENFORCE_PLANS === 'true',
  });
  // S12-04: selection pages find their selection by the token's HMAC (HMAC_KEY), like the API that made the link.
  presentations.configurePresentations({
    tokenKey: config.HMAC_KEY,
    publicBaseUrl: config.PUBLIC_URL ?? LOCAL_PUBLIC_URL,
  });
  // S7-06 edge tags on embed pages: a listing or site change purges them like the website API's answers.
  websiteApi.configureEdgeCache({ tagKey: config.HMAC_KEY });
  // S15-02: the portal's sitemaps (read only).
  const store = storageOf(config);
  if (store) configureStorage(store);
  else logger.warn('no S3_* storage: the portal sitemaps answer 404 until it is set');
  const searchConfig = requestSearchConfig(config);
  if (searchConfig) configureSearch(searchConfig);
  else logger.warn('no MEILI_SEARCH_KEY: embed search pages fail until it is set');
  search.configureNetworkSearch({
    giveToGetMinShared: config.NETWORK_GIVE_TO_GET_MIN_SHARED,
    giveToGetGraceDays: config.NETWORK_GIVE_TO_GET_GRACE_DAYS,
  });
  search.configureWebsiteSearch({
    engineTimeoutMs: config.SEARCH_ENGINE_TIMEOUT_MS,
    slowMs: config.SEARCH_SLOW_MS,
    breakerFailures: config.SEARCH_BREAKER_FAILURES,
    breakerFailureRatio: config.SEARCH_BREAKER_FAILURE_RATIO,
    breakerMinCalls: config.SEARCH_BREAKER_MIN_CALLS,
    breakerWindowMs: config.SEARCH_BREAKER_WINDOW_MS,
    breakerOpenMs: config.SEARCH_BREAKER_OPEN_MS,
    hedgeMaxInFlight: config.SEARCH_HEDGE_MAX_IN_FLIGHT,
    networkFreeText: config.SEARCH_NETWORK_FREE_TEXT === 'true',
  });
  return config;
}

export function publicConfig(): Promise<PublicConfig> {
  ready ??= setup().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}
