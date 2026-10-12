import { closeDb, configureDb, type DbConfig, loadStackEnv, pingDb, type Tx, withSystem } from '@inmolink/db';
import type { Logger } from '@inmolink/platform/logger';
import { createDispatcher, type Dispatcher, type SqlExecutor } from '@inmolink/platform/outbox';

/**
 * App lifecycle hooks (S0-08). Apps reach the database only through core, so the boundary rule
 * "apps → core / contracts / platform / ui" (S0-12) holds for boot, readiness and shutdown too.
 */
export { closeDb, configureDb, type DbConfig, loadStackEnv, pingDb };

/** The outbox dispatcher for the worker's `outbox` pool, wired to `withSystem` (routine: debug-level audit lines). Polls (ADR 0014). */
export function createOutboxDispatcher(options: { logger: Logger }): Dispatcher {
  return createDispatcher({
    runSystem: <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>) =>
      withSystem(reason, (tx: Tx) => fn(tx), { routine: true }),
    logger: options.logger,
  });
}
