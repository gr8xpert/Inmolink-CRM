import { closeDb, configureDb, loadStackEnv, pingDb } from '@inmolink/core';
import { cacheConnection, closeCache, configureCache } from '@inmolink/platform/cache';
import { createAccessTokenVerifier, parsePublicKeys } from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, producerConnection } from '@inmolink/platform/queue';
import { rateLimiter } from '@inmolink/platform/rate-limit';
import { drainHttp, gracefulShutdown, httpCheck, redisCheck } from '@inmolink/platform/server';
import { buildApp } from './app';
import { loadApiConfig } from './config';

loadStackEnv('dev', { allowExample: false });
const config = loadApiConfig();
const logger = createLogger({ service: 'api', level: config.LOG_LEVEL });

try {
  await configureDb({ APP_ROLE: 'http', DATABASE_URL_APP_USER: config.DATABASE_URL_APP_USER }, { logger });
  await configureCache({ url: config.REDIS_CACHE_URL, logger });
  await configureQueue({ url: config.REDIS_QUEUE_URL, logger });

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
      redisQueue: redisCheck(producerConnection),
      search: httpCheck(new URL('/health', config.MEILI_URL).href),
    },
  });

  gracefulShutdown({
    logger,
    steps: [
      drainHttp(app, config.SHUTDOWN_DRAIN_DELAY_MS),
      { name: 'queue', run: closeQueues },
      { name: 'cache', run: closeCache },
      { name: 'db', run: closeDb },
    ],
  });
  await app.listen({ host: config.HOST, port: config.API_PORT });
} catch (err) {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
}
