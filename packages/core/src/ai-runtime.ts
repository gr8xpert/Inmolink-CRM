import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Tx, withSystem } from '@inmolink/db';
import {
  type AiJobRecord,
  configureAi,
  createAiGatewayFromEnv,
  createPgAiStore,
  createRequestAiStore,
  createSpendMirror,
  listPrompts,
  loadAiSettings,
  recordUsageRow,
  refreshSpendMirror,
  type SpendMirror,
  type SystemRunner,
  syncPromptVersions,
} from '@inmolink/platform/ai';
import { cacheConnection } from '@inmolink/platform/cache';
import type { Logger } from '@inmolink/platform/logger';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';

/**
 * AI gateway wiring (S12-01, ADR 0008): the worker runtime (`ai` pool, usage in Postgres), the request runtime
 * (feed-api / api: budget on the redis spend mirror, usage through the queue — ADR 0008 #6a) and the two `ai` pool
 * jobs that serve them.
 */

/**
 * The versioned prompt files (`prompts/<id>/v<N>.md`, ADR 0008 #5) — same path from `src/` and `dist/`. Resolved on
 * call, not as a `new URL(<literal>, import.meta.url)`: bundlers (Turbopack in the Next apps) treat that literal as an
 * asset import and fail the build.
 */
export function aiPromptsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
}

const aiSystemRunner: SystemRunner = (reason, fn) => withSystem(reason, (tx: Tx) => fn(tx), { routine: true });

let mirror: SpendMirror | undefined;

/** The month-spend mirror on redis-cache (TTL from `AI_SPEND_MIRROR_TTL_SECONDS`). */
function spendMirror(): SpendMirror {
  mirror ??= createSpendMirror({ redis: cacheConnection(), ttlSeconds: loadAiSettings().spendMirrorTtlSeconds });
  return mirror;
}

const Usage = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
});

const JobRecord = z.object({
  id: z.string().uuid(),
  agencyId: z.string().uuid(),
  feature: z.string().min(1).max(200),
  kind: z.enum(['GENERATE', 'STRUCTURED', 'BATCH', 'EMBED']),
  tier: z.enum(['FAST', 'SMART']).nullable(),
  model: z.string().min(1).max(100),
  promptId: z.string().max(64).nullable(),
  promptVersion: z.number().int().nullable(),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(['SUCCEEDED', 'FAILED', 'PENDING']),
  errorCode: z.string().max(100).nullable(),
  usage: Usage,
  costMicroUsd: z.number().int().min(0),
  latencyMs: z.number().int().min(0),
  itemCount: z.number().int().min(1),
  providerBatchId: z.string().max(200).nullable(),
  requestId: z.string().max(200).nullable(),
  month: z.string().regex(/^\d{4}-\d{2}-01$/),
});

export const aiJobs = {
  /**
   * Appends a usage record the gateway could not write itself: every request-path call (no `withSystem` there), and a
   * worker call whose write failed. Idempotent by the job id (a second run counts nothing). `mirrored`: the call's cost
   * is already on the spend mirror (request path); otherwise it is added once the row is in.
   */
  recordUsage: defineJob({
    name: 'ai.recordUsage',
    pool: 'ai',
    payload: z.object({ job: JobRecord, releaseMicroUsd: z.number().int().min(0), mirrored: z.boolean() }),
    jobId: (p) => p.job.id,
    attempts: 10,
    backoff: { type: 'exponential', delay: 2_000 },
    async run(p) {
      const job = p.job as AiJobRecord;
      const inserted = await withSystem('ai.recordUsage', (tx: Tx) => recordUsageRow(tx, job, p.releaseMicroUsd));
      if (!inserted || job.status === 'PENDING') return;
      // Request path: the cost was queued on the mirror — it leaves `queued` now that the row is in (S12-01 security
      // review). Worker retry: the cost reaches the mirror's base only now.
      if (p.mirrored) await spendMirror().recorded(job.agencyId, job.month, job.costMicroUsd);
      else await spendMirror().adjust(job.agencyId, job.month, job.costMicroUsd);
    },
  }),

  /** Seeds the spend mirror of one agency and month from `ai_usage_monthly` (the request path asked: key missing). */
  refreshSpend: defineJob({
    name: 'ai.refreshSpend',
    pool: 'ai',
    payload: z.object({ agencyId: z.string().uuid(), month: z.string().regex(/^\d{4}-\d{2}-01$/) }),
    attempts: 3,
    backoff: { type: 'fixed', delay: 1_000 },
    async run(p) {
      await withSystem('ai.refreshSpend', (tx: Tx) => refreshSpendMirror(tx, spendMirror(), p.agencyId, p.month), {
        routine: true,
      });
    },
  }),
};

/**
 * The AI gateway for a worker running the `ai` pool (S12-01): model tiers, prices and budgets from env (`aiEnv`),
 * budget reservations and usage on short `withSystem` transactions (kept in step with the spend mirror), responses
 * cached on redis-cache, failed usage writes retried through `ai.recordUsage`. Records the prompt files in
 * `prompt_versions` (a changed shipped version stops boot: add a new version instead).
 */
export async function configureAiRuntime(options: { logger: Logger }): Promise<void> {
  configureAi(
    createAiGatewayFromEnv({
      promptsDir: aiPromptsDir(),
      store: createPgAiStore(aiSystemRunner, { mirror: spendMirror(), logger: options.logger }),
      logger: options.logger,
      onRecordFailure: (input) => aiJobs.recordUsage.enqueue({ ...input, mirrored: false }),
    }),
  );
  const prompts = await listPrompts(aiPromptsDir());
  const added = await withSystem('ai.syncPrompts', (tx: Tx) => syncPromptVersions(tx, prompts));
  if (added > 0) options.logger.info({ added }, 'ai prompt versions recorded');
}

/**
 * The AI gateway for a request process (S12-01 review, ADR 0008 #6a — feed-api's NL search, S12-08): no `withSystem`.
 * The hard cap is a reservation on the redis spend mirror (fails closed with `AI_UNAVAILABLE` `BUDGET_UNKNOWN` until
 * the `ai.refreshSpend` job has seeded it), and usage is recorded by the `ai.recordUsage` job. Needs the queue
 * (`configureQueue`) and redis-cache configured at boot, and a worker running the `ai` pool. No batches here.
 */
export function configureAiRequestRuntime(options: { logger: Logger }): void {
  configureAi(
    createAiGatewayFromEnv({
      promptsDir: aiPromptsDir(),
      store: createRequestAiStore({
        mirror: spendMirror(),
        enqueueRecord: (input) => aiJobs.recordUsage.enqueue({ ...input, mirrored: true }),
        // Throttled per agency and month: a burst of requests on a cold key asks once.
        enqueueRefresh: (input) => aiJobs.refreshSpend.enqueue(input, { throttleMs: 2_000 }),
        logger: options.logger,
      }),
      logger: options.logger,
    }),
  );
}
