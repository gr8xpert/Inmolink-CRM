import { closeDb, configureDb, loadStackEnv, pingDb } from '@inmolink/core';
import { configureCache, pubSubConnections } from '@inmolink/platform/cache';
import { createAccessTokenVerifier, parsePublicKeys } from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { gracefulShutdown, redisCheck } from '@inmolink/platform/server';
import { buildApp } from './app';
import { loadRealtimeConfig } from './config';

loadStackEnv('dev', { allowExample: false });
const config = loadRealtimeConfig();
const logger = createLogger({ service: 'realtime', level: config.LOG_LEVEL });

try {
  await configureDb({ APP_ROLE: 'http', DATABASE_URL_APP_USER: config.DATABASE_URL_APP_USER }, { logger });
  await configureCache({ url: config.REDIS_CACHE_URL, logger });
  const { pub, sub } = pubSubConnections();

  const realtime = await buildApp({
    logger,
    trustProxy: config.TRUST_PROXY,
    edgeRequestIdHeader: config.EDGE_REQUEST_ID_HEADER,
    adapter: { pub, sub },
    verifier: createAccessTokenVerifier({ publicKeys: parsePublicKeys(config.AUTH_JWT_PUBLIC_KEYS) }),
    allowedOrigins: [new URL(config.WEB_URL).origin],
    checks: { db: () => pingDb('app_user'), redis: redisCheck(() => pub) },
  });

  gracefulShutdown({
    logger,
    steps: [
      { name: 'sockets+http', run: () => realtime.drain(config.SHUTDOWN_DRAIN_DELAY_MS) },
      { name: 'redis', run: async () => void (await Promise.all([pub.quit(), sub.quit()])) },
      { name: 'db', run: closeDb },
    ],
  });
  await realtime.app.listen({ host: config.HOST, port: config.REALTIME_PORT });
} catch (err) {
  logger.fatal({ err }, 'realtime failed to start');
  process.exit(1);
}
