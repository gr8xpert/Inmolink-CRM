import { closeDb, configureDb, loadStackEnv, pingDb } from '@inmolink/core';
import { cacheConnection, closeCache, configureCache } from '@inmolink/platform/cache';
import { createLogger } from '@inmolink/platform/logger';
import { rateLimiter } from '@inmolink/platform/rate-limit';
import { drainHttp, gracefulShutdown, httpCheck, redisCheck } from '@inmolink/platform/server';
import { buildApp } from './app';
import { loadFeedApiConfig } from './config';

loadStackEnv('dev', { allowExample: false });
const config = loadFeedApiConfig();
const logger = createLogger({ service: 'feed-api', level: config.LOG_LEVEL });

try {
  await configureDb({ APP_ROLE: 'http', DATABASE_URL_APP_PUBLIC: config.DATABASE_URL_APP_PUBLIC }, { logger });
  await configureCache({ url: config.REDIS_CACHE_URL, logger });

  const app = await buildApp({
    logger,
    trustProxy: config.TRUST_PROXY,
    edgeRequestIdHeader: config.EDGE_REQUEST_ID_HEADER,
    docsUi: config.NODE_ENV === 'development',
    limiter: rateLimiter(),
    checks: {
      db: () => pingDb('app_public'),
      redisCache: redisCheck(cacheConnection),
      search: httpCheck(new URL('/health', config.MEILI_URL).href),
    },
  });

  gracefulShutdown({
    logger,
    steps: [
      drainHttp(app, config.SHUTDOWN_DRAIN_DELAY_MS),
      { name: 'cache', run: closeCache },
      { name: 'db', run: closeDb },
    ],
  });
  await app.listen({ host: config.HOST, port: config.FEED_API_PORT });
} catch (err) {
  logger.fatal({ err }, 'feed-api failed to start');
  process.exit(1);
}
