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
  turnstileEnv,
  websiteSearchEnv,
} from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { configureRateLimit } from '@inmolink/platform/rate-limit';
import { configureSearch, requestSearchConfig } from '@inmolink/platform/search';
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
};
export type PublicConfig = Config<typeof publicEnv>;

/** `PUBLIC_URL` outside production when unset (`next dev` / `next start` port). */
export const LOCAL_PUBLIC_URL = 'http://localhost:3101';

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
  return config;
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
      ? createTurnstileVerifier({ secretKey: config.TURNSTILE_SECRET_KEY, logger })
      : null,
    embedOrigin: config.PUBLIC_URL ?? LOCAL_PUBLIC_URL,
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
