import { closeDb, configureDb, loadStackEnv, pingDb, withMemberCtx } from '@inmolink/core';
import * as chat from '@inmolink/core/modules/chat';
import { configureCache, pubSubConnections, sessionRevocation, subscribeUserEvents } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createAccessTokenVerifier, parsePublicKeys } from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { closeRateLimit, configureRateLimit, rateLimiter } from '@inmolink/platform/rate-limit';
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
  // S11-03: per-user /chat counters (connects, thread joins) across nodes
  await configureRateLimit({ url: config.REDIS_LIMITS_URL, logger });
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
    // S12-F4: events of members with no socket on this node are skipped before parsing
    userEvents: (handler, isLocal) => subscribeUserEvents(userEvents, handler, logger, { isLocal }),
    // S11-03: a `/chat` join is the member's own request (app_user, RLS): an inactive member or a thread they are not
    // in answers no
    canJoinThread: (auth, threadId) =>
      withMemberCtx({ userId: auth.userId, agencyId: auth.agencyId, requestId: newId() }, (ctx) =>
        chat.canJoinThread(ctx, threadId),
      ).catch(() => false),
    limit: async (rule, identity) => (await rateLimiter().consume(rule, identity)).allowed,
    // S12-F10: deactivations and revoked sessions every node must refuse (redis-cache, written by the worker)
    revocation: sessionRevocation,
    checks: { db: () => pingDb('app_user'), redis: redisCheck(() => pub) },
  });

  gracefulShutdown({
    logger,
    steps: [
      { name: 'sockets+http', run: () => realtime.drain(config.SHUTDOWN_DRAIN_DELAY_MS) },
      { name: 'redis', run: async () => void (await Promise.all([pub.quit(), sub.quit(), userEvents.quit()])) },
      { name: 'rate-limit', run: closeRateLimit },
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
