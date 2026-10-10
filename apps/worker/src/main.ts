import { closeDb, configureDb, createOutboxDispatcher, loadStackEnv, pingDb } from '@inmolink/core';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, producerConnection } from '@inmolink/platform/queue';
import { gracefulShutdown, redisCheck } from '@inmolink/platform/server';
import { startWorker } from './app';
import { loadWorkerConfig } from './config';
import { POOL_JOBS } from './processors';

loadStackEnv('dev', { allowExample: false });
const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL });

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
      { name: 'db', run: closeDb },
    ],
  });
  await worker.health.listen({ host: config.HOST, port: config.WORKER_HEALTH_PORT });
} catch (err) {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
}
