import { closeDb, configureDb, createOutboxDispatcher, loadStackEnv, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { closeEmail, configureEmail } from '@inmolink/platform/email';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, producerConnection } from '@inmolink/platform/queue';
import { gracefulShutdown, redisCheck } from '@inmolink/platform/server';
import { reportError, startObservability } from '@inmolink/platform/telemetry';
import { startWorker } from './app';
import { emailConfig, loadWorkerConfig } from './config';
import { POOL_JOBS } from './processors';
import { registerSubscriptions } from './subscriptions';

loadStackEnv('dev', { allowExample: false });
const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL });
// Before any connection opens, so startup work is traced too. Port 0 = no /metrics endpoint.
const telemetry = startObservability(config, {
  service: 'worker',
  metricsPort: config.WORKER_METRICS_PORT || undefined,
});

try {
  await configureDb(
    {
      APP_ROLE: 'worker',
      DATABASE_URL_APP_USER: config.DATABASE_URL_APP_USER,
      DATABASE_URL_APP_SYSTEM: config.DATABASE_URL_APP_SYSTEM,
      DATABASE_URL_LISTEN: config.DATABASE_URL_LISTEN,
    },
    { logger },
  );
  await configureQueue({ url: config.REDIS_QUEUE_URL, logger });
  await configureCache({ url: config.REDIS_CACHE_URL, logger });
  await configureEmail(emailConfig(config));
  identity.configureIdentity({ hmacKey: config.HMAC_KEY, webUrl: config.WEB_URL });
  registerSubscriptions();

  const worker = await startWorker({
    logger,
    pools: config.WORKER_POOLS,
    jobs: POOL_JOBS,
    createDispatcher: () => createOutboxDispatcher({ logger, useListen: config.DATABASE_URL_LISTEN !== undefined }),
    trustProxy: config.TRUST_PROXY,
    checks: { db: () => pingDb('app_system'), redisQueue: redisCheck(producerConnection) },
  });

  gracefulShutdown({
    logger,
    steps: [
      { name: 'pools', run: worker.drain },
      { name: 'queue', run: closeQueues },
      { name: 'cache', run: closeCache },
      { name: 'email', run: closeEmail },
      { name: 'db', run: closeDb },
      { name: 'telemetry', run: telemetry.shutdown },
    ],
  });
  await worker.health.listen({ host: config.HOST, port: config.WORKER_HEALTH_PORT });
} catch (err) {
  logger.fatal({ err }, 'worker failed to start');
  reportError(err, { phase: 'startup' });
  await telemetry.shutdown();
  process.exit(1);
}
