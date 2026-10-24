import type { Logger } from '@inmolink/platform/logger';
import type { Dispatcher } from '@inmolink/platform/outbox';
import { type JobDef, type PoolHandle, type PoolOptions, registerPool } from '@inmolink/platform/queue';
import { createServer, type FastifyZod, type HealthCheck, healthRoutes } from '@inmolink/platform/server';
import type { Pool } from './config';

/** BullMQ processors, one entry per pool. Transport only — business logic lives in @inmolink/core. */
export const APP_NAME = 'worker';

/** In-flight jobs get this long on shutdown, inside the 30 s process deadline; the rest are retried as stalled. */
export const POOL_SHUTDOWN_MS = 25_000;

export interface WorkerDeps {
  logger: Logger;
  pools: readonly Pool[];
  jobs: Partial<Record<Pool, readonly JobDef[]>>;
  /** The `outbox` pool runs the dispatcher instead of BullMQ jobs. */
  createDispatcher?: () => Dispatcher;
  checks: Record<string, HealthCheck>;
  trustProxy: false | number | string[];
  poolOptions?: PoolOptions;
  /** Options of one pool over `poolOptions` (`POOL_OPTIONS`). */
  poolOverrides?: Partial<Record<Pool, PoolOptions>>;
}

export interface WorkerApp {
  health: FastifyZod;
  handles: readonly PoolHandle[];
  /** Shutdown step: fail readiness, stop claiming, let in-flight jobs and the outbox batch finish. */
  drain(): Promise<void>;
}

export async function startWorker(deps: WorkerDeps): Promise<WorkerApp> {
  const handles: PoolHandle[] = [];
  let dispatcher: Dispatcher | undefined;
  for (const pool of deps.pools) {
    if (pool === 'outbox') {
      if (!deps.createDispatcher) throw new TypeError('the outbox pool needs createDispatcher');
      dispatcher = deps.createDispatcher();
      await dispatcher.start();
      continue;
    }
    const jobs = deps.jobs[pool] ?? [];
    if (jobs.length === 0) {
      deps.logger.info({ pool }, 'pool has no jobs yet; not started');
      continue;
    }
    handles.push(
      registerPool(pool, jobs, { shutdownMs: POOL_SHUTDOWN_MS, ...deps.poolOptions, ...deps.poolOverrides?.[pool] }),
    );
  }
  deps.logger.info({ pools: deps.pools, running: handles.map((h) => h.pool) }, 'worker started');

  const health = await createServer({
    logger: deps.logger,
    trustProxy: deps.trustProxy,
    openapi: { title: 'Inmolink worker health', version: '2.0.0' },
  });
  healthRoutes(health, { checks: deps.checks });

  return {
    health,
    handles,
    async drain() {
      health.lifecycle.draining = true;
      await Promise.all([dispatcher?.stop(), ...handles.map((h) => h.close())]);
      await health.close();
    },
  };
}
