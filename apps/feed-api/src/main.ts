import { closeDb, configureAiRequestRuntime, configureDb, loadStackEnv, pingDb } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import * as exportsModule from '@inmolink/core/modules/exports';
import * as identity from '@inmolink/core/modules/identity';
import * as migration from '@inmolink/core/modules/migration';
import * as search from '@inmolink/core/modules/search';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { loadAiSettings } from '@inmolink/platform/ai';
import { cacheConnection, closeCache, configureCache } from '@inmolink/platform/cache';
import { hmacRotationFromEnv } from '@inmolink/platform/crypto';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue } from '@inmolink/platform/queue';
import { closeRateLimit, configureRateLimit, rateLimitConnection, rateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, requestSearchConfig, searchEngine } from '@inmolink/platform/search';
import { drainHttp, gracefulShutdown, httpCheck, redisCheck } from '@inmolink/platform/server';
import { configureStorage, storageConfigForBuckets } from '@inmolink/platform/storage';
import { reportError, startObservability } from '@inmolink/platform/telemetry';
import { createTurnstileVerifier } from '@inmolink/platform/turnstile';
import { buildApp } from './app';
import { loadFeedApiConfig } from './config';

loadStackEnv('dev', { allowExample: false });
const config = loadFeedApiConfig();
const logger = createLogger({ service: 'feed-api', level: config.LOG_LEVEL });
// Before any connection opens, so startup work is traced too. Port 0 = no /metrics endpoint.
const telemetry = startObservability(config, {
  service: 'feed-api',
  metricsPort: config.FEED_API_METRICS_PORT || undefined,
});

try {
  await configureDb(
    {
      APP_ROLE: 'http',
      DATABASE_URL_APP_PUBLIC: config.DATABASE_URL_APP_PUBLIC,
      DATABASE_URL_APP_INTAKE: config.DATABASE_URL_APP_INTAKE,
    },
    { logger },
  );
  await configureCache({ url: config.REDIS_CACHE_URL, logger });
  await configureRateLimit({ url: config.REDIS_LIMITS_URL, logger });
  // S11-F13: the HMAC_KEY rotation window — feed tokens hashed under HMAC_KEY_PREVIOUS are still found until it ends.
  hmacRotationFromEnv(config, logger);
  // Website API keys (S1-05): HMAC-checked; only keys of this environment (`live` in production) work.
  identity.configureIdentity({
    hmacKey: config.HMAC_KEY,
    apiKeyEnv: identity.apiKeyEnvFor(config.DEPLOY_ENV ?? config.NODE_ENV),
  });
  // Website API v2 (S7-03): image URLs under the media CDN; network listings follow the give-to-get standing.
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: config.MEDIA_CDN_URL,
    cursorKey: config.HMAC_KEY,
    // S7-04: quotas and paging limits are the defaults (website-api config.ts); honeytokens can be turned off.
    limits: { honeytokens: config.WEBSITE_HONEYTOKENS === 'true' },
    // S7-05: website forms through publishable keys need Turnstile; without a secret they are refused (H3).
    turnstile: config.TURNSTILE_SECRET_KEY
      ? createTurnstileVerifier({ secretKey: config.TURNSTILE_SECRET_KEY, logger })
      : null,
    // S13-F21: the website API cut-off of a site whose plan lost it applies only while plans are enforced.
    enforcePlans: config.BILLING_ENFORCE_PLANS === 'true',
  });
  // S12-08: AI search — the request-safe AI gateway (budget from the cached month spend, usage recorded by queued
  // jobs: no `withSystem` here), after the cache and the queue. Without AI (`AI_PROVIDER=none`, the default) or a
  // queue, no gateway: every AI search answers with a keyword search.
  // The gateway here serves AI search only: a late model call ends within 3 s and is never retried (S12-08 review),
  // unless the destination sets these itself.
  process.env.AI_TIMEOUT_MS ??= '3000';
  process.env.AI_MAX_RETRIES ??= '0';
  const aiSettings = loadAiSettings();
  const aiOn = aiSettings.provider !== 'none';
  if (aiOn && config.REDIS_QUEUE_URL) {
    await configureQueue({ url: config.REDIS_QUEUE_URL, logger });
    configureAiRequestRuntime({ logger });
  } else if (aiOn) logger.warn('AI_PROVIDER is set but REDIS_QUEUE_URL is not: AI search answers with keyword search');
  websiteApi.configureAiSearch({
    timeoutMs: config.SEARCH_AI_TIMEOUT_MS,
    cacheTtlSeconds: config.SEARCH_AI_CACHE_TTL_SECONDS,
    maxLateCalls: config.SEARCH_AI_MAX_LATE_CALLS,
    limits: {
      perKeyPerMinute: config.SEARCH_AI_MISSES_PER_KEY_PER_MINUTE,
      perBrowserPerMinute: config.SEARCH_AI_MISSES_PER_BROWSER_PER_MINUTE,
      perSitePerDay: config.SEARCH_AI_MISSES_PER_SITE_PER_DAY,
      perAgencyPerMonth: websiteApi.aiSearchMonthlyCalls(aiSettings, config.SEARCH_AI_BUDGET_SHARE_BP),
    },
  });
  // S7-06: Cache-Tags of site answers (keyed hashes; the worker purges the same tags).
  websiteApi.configureEdgeCache({ tagKey: config.HMAC_KEY });
  // S7-07: per-site XML feeds — tokens hashed with HMAC_KEY, files read from the feeds bucket only.
  websites.configureSiteFeeds({ tokenKey: config.HMAC_KEY });
  // S10-06: members' ICS feed tokens — HMACs with the same key (purpose `crm.calendar-feed-token`).
  crm.configureCalendarFeeds({ tokenKey: config.HMAC_KEY });
  // S9-03: portal feeds — the same token key (purpose `exports.feed-token`); no encryption keys here.
  exportsModule.configureExports({ tokenKey: config.HMAC_KEY });
  configureStorage(storageConfigForBuckets(config, { feeds: config.S3_BUCKET_FEEDS ?? config.S3_BUCKET_EXPORTS }));
  if (!config.TURNSTILE_SECRET_KEY)
    logger.warn('no TURNSTILE_SECRET_KEY: website forms through publishable keys are refused');
  // Search (S5-05, S7-08): `requestSearchConfig` — the search-only key; a deployed app without it fails to boot.
  const searchConfig = requestSearchConfig(config);
  if (searchConfig) configureSearch(searchConfig);
  else logger.warn('no MEILI_SEARCH_KEY: website search answers 500 until it is set');
  search.configureNetworkSearch({
    giveToGetMinShared: config.NETWORK_GIVE_TO_GET_MIN_SHARED,
    giveToGetGraceDays: config.NETWORK_GIVE_TO_GET_GRACE_DAYS,
  });
  // Website search timing from config (S6-F3).
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

  const app = await buildApp({
    logger,
    trustProxy: config.TRUST_PROXY,
    edgeRequestIdHeader: config.EDGE_REQUEST_ID_HEADER,
    docsUi: config.NODE_ENV === 'development',
    limiter: rateLimiter(),
    // S7-06: public first pages and details for the CDN, only once its cache rules are live (runbook cdn.md).
    edgeCache: config.WEBSITE_EDGE_CACHE === 'true',
    // S9-03: portal crawlers fetch many feeds from one address (the per-token limit protects each feed).
    portalFeedIpPerMinute: config.PORTAL_FEED_IP_PER_MINUTE,
    checks: {
      db: () => pingDb('app_public'),
      dbIntake: () => pingDb('app_intake'),
      redisCache: redisCheck(cacheConnection),
      // A wrong REDIS_LIMITS_URL credential would otherwise surface only as refused logins.
      redisLimits: redisCheck(rateLimitConnection),
      // S7-F7: the limit scripts themselves run as the `limits` ACL user — an ACL missing a command (NOPERM) or a
      // full Redis (OOM) fails readiness here, while requests keep failing open (S7-04).
      rateLimitScripts: () => rateLimiter().selfTest(),
      search: httpCheck(new URL('/health', config.MEILI_URL).href),
      // S7-08: a website search engine is configured (not ready without one: every search would be a 500).
      searchConfigured: async () => {
        searchEngine();
      },
    },
  });

  gracefulShutdown({
    logger,
    steps: [
      drainHttp(app, config.SHUTDOWN_DRAIN_DELAY_MS),
      { name: 'rate-limit', run: closeRateLimit },
      { name: 'queue', run: closeQueues }, // S12-08: AI usage records (a no-op without AI)
      { name: 'cache', run: closeCache },
      { name: 'db', run: closeDb },
      { name: 'telemetry', run: telemetry.shutdown },
    ],
  });
  // S12-08: AI search's taxonomy vocabulary, loaded before traffic (no request pays the cold load).
  await websiteApi.warmAiSearch();
  // S8-02: the v1 shim's legacy taxonomy maps, loaded before traffic (a failure is retried at first use).
  await migration
    .reloadLegacyTaxonomy()
    .catch((err: unknown) => logger.warn({ err }, 'legacy taxonomy maps not loaded'));
  await app.listen({ host: config.HOST, port: config.FEED_API_PORT });
} catch (err) {
  logger.fatal({ err }, 'feed-api failed to start');
  reportError(err, { phase: 'startup' });
  await telemetry.shutdown();
  process.exit(1);
}
