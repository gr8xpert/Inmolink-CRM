import { closeDb, configureDb, loadStackEnv, pingDb } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import * as exportsModule from '@inmolink/core/modules/exports';
import * as identity from '@inmolink/core/modules/identity';
import * as imports from '@inmolink/core/modules/imports';
import * as media from '@inmolink/core/modules/media';
import * as mls from '@inmolink/core/modules/mls';
import * as search from '@inmolink/core/modules/search';
import * as websites from '@inmolink/core/modules/websites';
import { cacheConnection, closeCache, configureCache } from '@inmolink/platform/cache';
import { hmacRotationFromEnv, keyringFromEnv } from '@inmolink/platform/crypto';
import { createAccessTokenVerifier, parsePublicKeys } from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, producerConnection } from '@inmolink/platform/queue';
import { closeRateLimit, configureRateLimit, rateLimitConnection, rateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, requestSearchConfig } from '@inmolink/platform/search';
import { drainHttp, gracefulShutdown, httpCheck, redisCheck } from '@inmolink/platform/server';
import { configureStorage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { reportError, startObservability } from '@inmolink/platform/telemetry';
import { buildApp } from './app';
import { loadApiConfig } from './config';

loadStackEnv('dev', { allowExample: false });
const config = loadApiConfig();
const logger = createLogger({ service: 'api', level: config.LOG_LEVEL });
// Before any connection opens, so startup work is traced too. Port 0 = no /metrics endpoint.
const telemetry = startObservability(config, {
  service: 'api',
  metricsPort: config.API_METRICS_PORT || undefined,
  // Internet-facing: a client's traceparent must not force sampling.
  trustRemoteParent: false,
});

try {
  await configureDb(
    {
      APP_ROLE: 'http',
      DATABASE_URL_APP_USER: config.DATABASE_URL_APP_USER,
      DATABASE_URL_APP_STAFF: config.DATABASE_URL_APP_STAFF,
      DATABASE_URL_APP_AUTH: config.DATABASE_URL_APP_AUTH,
    },
    { logger },
  );
  configureStorage(storageConfigFromEnv(config));
  await configureCache({ url: config.REDIS_CACHE_URL, logger });
  await configureQueue({ url: config.REDIS_QUEUE_URL, logger });
  await configureRateLimit({ url: config.REDIS_LIMITS_URL, logger });
  // S11-F13: the HMAC_KEY rotation window — feed tokens hashed under HMAC_KEY_PREVIOUS are still found until it ends.
  hmacRotationFromEnv(config, logger);
  // API keys (S1-05) are issued here: stored as HMACs, `live` keys only in production.
  identity.configureIdentity({
    hmacKey: config.HMAC_KEY,
    // S11-F14: the data-export step-up checks a TOTP code, whose secret is encrypted with this keyring.
    keyring: keyringFromEnv(config),
    apiKeyEnv: identity.apiKeyEnvFor(config.DEPLOY_ENV ?? config.NODE_ENV),
  });
  media.configureMedia({ urlKey: config.MEDIA_URL_KEY });
  // Per-site XML feed tokens (S7-07): stored as HMACs; feed-api checks them with the same key.
  websites.configureSiteFeeds({ tokenKey: config.HMAC_KEY });
  // S10-06: members' ICS feed tokens — HMACs with the same key (purpose `crm.calendar-feed-token`).
  crm.configureCalendarFeeds({ tokenKey: config.HMAC_KEY });
  // S11-01: registered clients' details are encrypted, their e-mails and phones fingerprinted (HMAC_KEY).
  mls.configureMls({ keyring: keyringFromEnv(config), fingerprintKey: config.HMAC_KEY });
  // Feed credentials (S6-01) are encrypted here when a connection is saved; only the worker decrypts them.
  imports.configureImports({ keyring: keyringFromEnv(config) });
  // Portal connections (S9-01): credentials encrypted and feed tokens hashed when a connection is saved.
  exportsModule.configureExports({ keyring: keyringFromEnv(config), tokenKey: config.HMAC_KEY });
  // Search (S5-05, S7-08): `requestSearchConfig` — the search-only key; a deployed app without it fails to boot.
  const searchConfig = requestSearchConfig(config);
  if (searchConfig) configureSearch(searchConfig);
  else logger.warn('no MEILI_SEARCH_KEY: network search answers 503 until it is set');
  search.configureNetworkSearch({
    giveToGetMinShared: config.NETWORK_GIVE_TO_GET_MIN_SHARED,
    giveToGetGraceDays: config.NETWORK_GIVE_TO_GET_GRACE_DAYS,
  });
  // S12-F25: minimum-commission edits per agency per day.
  websites.configureWebsites({ minCommissionEditsPerDay: config.WEBSITE_MIN_COMMISSION_EDITS_PER_DAY });

  const app = await buildApp({
    logger,
    trustProxy: config.TRUST_PROXY,
    edgeRequestIdHeader: config.EDGE_REQUEST_ID_HEADER,
    docsUi: config.NODE_ENV === 'development',
    limiter: rateLimiter(),
    verifier: createAccessTokenVerifier({ publicKeys: parsePublicKeys(config.AUTH_JWT_PUBLIC_KEYS) }),
    checks: {
      db: () => pingDb('app_user'),
      redisCache: redisCheck(cacheConnection),
      // A wrong REDIS_LIMITS_URL credential would otherwise surface only as refused logins.
      redisLimits: redisCheck(rateLimitConnection),
      redisQueue: redisCheck(producerConnection),
      search: httpCheck(new URL('/health', config.MEILI_URL).href),
    },
  });

  gracefulShutdown({
    logger,
    steps: [
      drainHttp(app, config.SHUTDOWN_DRAIN_DELAY_MS),
      { name: 'queue', run: closeQueues },
      { name: 'rate-limit', run: closeRateLimit },
      { name: 'cache', run: closeCache },
      { name: 'db', run: closeDb },
      { name: 'telemetry', run: telemetry.shutdown },
    ],
  });
  await app.listen({ host: config.HOST, port: config.API_PORT });
} catch (err) {
  logger.fatal({ err }, 'api failed to start');
  reportError(err, { phase: 'startup' });
  await telemetry.shutdown();
  process.exit(1);
}
