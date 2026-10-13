import { closeDb, configureDb, loadStackEnv, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { cacheConnection, closeCache, configureCache } from '@inmolink/platform/cache';
import { createLogger } from '@inmolink/platform/logger';
import { closeRateLimit, configureRateLimit, rateLimitConnection, rateLimiter } from '@inmolink/platform/rate-limit';
import { drainHttp, gracefulShutdown, httpCheck, redisCheck } from '@inmolink/platform/server';
import { reportError, startObservability } from '@inmolink/platform/telemetry';
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
  await configureDb({ APP_ROLE: 'http', DATABASE_URL_APP_PUBLIC: config.DATABASE_URL_APP_PUBLIC }, { logger });
  await configureCache({ url: config.REDIS_CACHE_URL, logger });
  await configureRateLimit({ url: config.REDIS_LIMITS_URL, logger });
  // Website API keys (S1-05): HMAC-checked; only keys of this environment (`live` in production) work.
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
    checks: {
      db: () => pingDb('app_public'),
      redisCache: redisCheck(cacheConnection),
      // A wrong REDIS_LIMITS_URL credential would otherwise surface only as refused logins.
      redisLimits: redisCheck(rateLimitConnection),
      search: httpCheck(new URL('/health', config.MEILI_URL).href),
    },
  });

  gracefulShutdown({
    logger,
    steps: [
      drainHttp(app, config.SHUTDOWN_DRAIN_DELAY_MS),
      { name: 'rate-limit', run: closeRateLimit },
      { name: 'cache', run: closeCache },
      { name: 'db', run: closeDb },
      { name: 'telemetry', run: telemetry.shutdown },
    ],
  });
  await app.listen({ host: config.HOST, port: config.FEED_API_PORT });
} catch (err) {
  logger.fatal({ err }, 'feed-api failed to start');
  reportError(err, { phase: 'startup' });
  await telemetry.shutdown();
  process.exit(1);
}
