import { closeDb, configureDb, loadStackEnv, pingDb } from '@inmolink/core';
import { configureCache, pubSubConnections, subscribeUserEvents } from '@inmolink/platform/cache';
import { createAccessTokenVerifier, parsePublicKeys } from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { gracefulShutdown, redisCheck } from '@inmolink/platform/server';
import { reportError, startObservability } from '@inmolink/platform/telemetry';
import { buildApp } from './app';
import { loadRealtimeConfig } from './config';

loadStackEnv('dev', { allowExample: false });
const config = loadRealtimeConfig();
const logger = createLogger({ service: 'realtime', level: config.LOG_LEVEL });
// Before any connection opens, so startup work is traced too. Port 0 = no /metrics endpoint.
const telemetry = startObservability(config, {
  service: 'realtime',
  metricsPort: config.REALTIME_METRICS_PORT || undefined,
});

try {
  await configureDb({ APP_ROLE: 'http', DATABASE_URL_APP_USER: config.DATABASE_URL_APP_USER }, { logger });
  await configureCache({ url: config.REDIS_CACHE_URL, logger });
  const { pub, sub } = pubSubConnections();
  // S11-04: workers' per-user events (new notifications) on their own subscriber connection
  const userEvents = pub.duplicate();

  const realtime = await buildApp({
    logger,
    trustProxy: config.TRUST_PROXY,
    edgeRequestIdHeader: config.EDGE_REQUEST_ID_HEADER,
    adapter: { pub, sub },
    verifier: createAccessTokenVerifier({ publicKeys: parsePublicKeys(config.AUTH_JWT_PUBLIC_KEYS) }),
    allowedOrigins: [new URL(config.WEB_URL).origin],
    userEvents: (handler) => subscribeUserEvents(userEvents, handler, logger),
    checks: { db: () => pingDb('app_user'), redis: redisCheck(() => pub) },
  });

  gracefulShutdown({
    logger,
    steps: [
      { name: 'sockets+http', run: () => realtime.drain(config.SHUTDOWN_DRAIN_DELAY_MS) },
      { name: 'redis', run: async () => void (await Promise.all([pub.quit(), sub.quit(), userEvents.quit()])) },
      { name: 'db', run: closeDb },
      { name: 'telemetry', run: telemetry.shutdown },
    ],
  });
  await realtime.app.listen({ host: config.HOST, port: config.REALTIME_PORT });
} catch (err) {
  logger.fatal({ err }, 'realtime failed to start');
  reportError(err, { phase: 'startup' });
  await telemetry.shutdown();
  process.exit(1);
}
