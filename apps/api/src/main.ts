import { closeDb, configureDb, loadStackEnv, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { cacheConnection, closeCache, configureCache } from '@inmolink/platform/cache';
import { createAccessTokenVerifier, parsePublicKeys } from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, producerConnection } from '@inmolink/platform/queue';
import { closeRateLimit, configureRateLimit, rateLimitConnection, rateLimiter } from '@inmolink/platform/rate-limit';
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
    },
    { logger },
  );
  configureStorage(storageConfigFromEnv(config));
  await configureCache({ url: config.REDIS_CACHE_URL, logger });
  await configureQueue({ url: config.REDIS_QUEUE_URL, logger });
  await configureRateLimit({ url: config.REDIS_LIMITS_URL, logger });
  // API keys (S1-05) are issued here: stored as HMACs, `live` keys only in production.
  identity.configureIdentity({
    hmacKey: config.HMAC_KEY,
    apiKeyEnv: identity.apiKeyEnvFor(config.DEPLOY_ENV ?? config.NODE_ENV),
  });

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
