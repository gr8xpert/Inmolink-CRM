import { fileURLToPath } from 'node:url';
import {
  closeDb,
  configureDb as configureDbPools,
  type DbConfig,
  loadStackEnv,
  type PoolOptions,
  pingDb,
  type Tx,
  withGlobalRead,
  withSystem,
} from '@inmolink/db';
import {
  configureAi,
  createAiGatewayFromEnv,
  createPgAiStore,
  listPrompts,
  type SystemRunner,
  syncPromptVersions,
} from '@inmolink/platform/ai';
import { configureFlagReader } from '@inmolink/platform/flags';
import type { Logger } from '@inmolink/platform/logger';
import { createDispatcher, type Dispatcher, type SqlExecutor } from '@inmolink/platform/outbox';

/**
 * App lifecycle hooks (S0-08). Apps reach the database only through core, so the boundary rule
 * "apps → core / contracts / platform / ui" (S0-12) holds for boot, readiness and shutdown too.
 */
export { closeDb, type DbConfig, loadStackEnv, pingDb };

/**
 * `configureDb` from `@inmolink/db`, plus the platform adapters that need a database of their own: the
 * feature-flag reload runs on a short `withGlobalRead` (`app_user`), never on a request's transaction
 * (S1-F3). A process without an `app_user` URL (feed-api, web) falls back to reading on the caller's transaction.
 */
export async function configureDb(next: DbConfig, options: PoolOptions = {}): Promise<void> {
  await configureDbPools(next, options);
  configureFlagReader(next.DATABASE_URL_APP_USER ? (fn) => withGlobalRead((tx) => fn(tx)) : undefined);
}

/** The outbox dispatcher for the worker's `outbox` pool, wired to `withSystem` (routine: debug-level audit lines). Polls (ADR 0014). */
export function createOutboxDispatcher(options: { logger: Logger }): Dispatcher {
  return createDispatcher({
    runSystem: <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>) =>
      withSystem(reason, (tx: Tx) => fn(tx), { routine: true }),
    logger: options.logger,
  });
}

/** The versioned prompt files (`prompts/<id>/v<N>.md`, ADR 0008 #5) — same path from `src/` and `dist/`. */
export const AI_PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));

const aiSystemRunner: SystemRunner = (reason, fn) => withSystem(reason, (tx: Tx) => fn(tx), { routine: true });

/**
 * The AI gateway for a worker running the `ai` pool (S12-01): model tiers, prices and budgets from env (`aiEnv`),
 * usage recorded on short `withSystem` transactions, responses cached on redis-cache. Records the prompt files in
 * `prompt_versions` (a changed shipped version stops boot: add a new version instead). Not for request processes:
 * `withSystem` is refused there, and AI runs in jobs (ADR 0008 #9).
 */
export async function configureAiRuntime(options: { logger: Logger }): Promise<void> {
  configureAi(
    createAiGatewayFromEnv({
      promptsDir: AI_PROMPTS_DIR,
      store: createPgAiStore(aiSystemRunner),
      logger: options.logger,
    }),
  );
  const prompts = await listPrompts(AI_PROMPTS_DIR);
  const added = await withSystem('ai.syncPrompts', (tx: Tx) => syncPromptVersions(tx, prompts));
  if (added > 0) options.logger.info({ added }, 'ai prompt versions recorded');
}
