import { closeDb, configureDb, createOutboxDispatcher, loadStackEnv, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import * as media from '@inmolink/core/modules/media';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { closeEmail, configureEmail } from '@inmolink/platform/email';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, producerConnection } from '@inmolink/platform/queue';
import { gracefulShutdown, redisCheck } from '@inmolink/platform/server';
import { configureStorage, storageConfigFromEnv } from '@inmolink/platform/storage';
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
  // Pool-aware (S3-F4): a media-only container has `app_media` and storage, nothing else.
  const mediaOnly = config.WORKER_POOLS.every((p) => p === 'media');
  await configureDb(
    {
      APP_ROLE: 'worker',
      DATABASE_URL_APP_USER: config.DATABASE_URL_APP_USER,
      DATABASE_URL_APP_SYSTEM: config.DATABASE_URL_APP_SYSTEM,
      DATABASE_URL_APP_MEDIA: config.DATABASE_URL_APP_MEDIA,
    },
    { logger },
  );
  await configureQueue({ url: config.REDIS_QUEUE_URL, logger });
  // A media-only container has no cache (S3-F7): nothing it runs reads or writes cached bodies.
  if (config.REDIS_CACHE_URL) await configureCache({ url: config.REDIS_CACHE_URL, logger });
  if (config.WORKER_POOLS.includes('email')) await configureEmail(emailConfig(config));
  if (config.HMAC_KEY && config.WEB_URL)
    identity.configureIdentity({ hmacKey: config.HMAC_KEY, webUrl: config.WEB_URL });
  configureStorage(storageConfigFromEnv(config as Parameters<typeof storageConfigFromEnv>[0]));
  if (config.MEDIA_URL_KEY) media.configureMedia({ urlKey: config.MEDIA_URL_KEY });
  registerSubscriptions();

  const worker = await startWorker({
    logger,
    pools: config.WORKER_POOLS,
    jobs: POOL_JOBS,
    createDispatcher: () => createOutboxDispatcher({ logger }),
    trustProxy: config.TRUST_PROXY,
    checks: { db: () => pingDb(mediaOnly ? 'app_media' : 'app_system'), redisQueue: redisCheck(producerConnection) },
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
