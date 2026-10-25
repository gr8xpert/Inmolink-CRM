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
  pruneAiJobs,
  recordUsageRow,
  refreshSpendMirror,
  type SpendMirror,
  type SystemRunner,
  syncPromptVersions,
  usageMonth,
} from '@inmolink/platform/ai';
import { cacheConnection } from '@inmolink/platform/cache';
import { clock } from '@inmolink/platform/clock';
import type { Logger } from '@inmolink/platform/logger';
import { defineJob, UnrecoverableError } from '@inmolink/platform/queue';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

/**
 * AI gateway wiring (S12-01, ADR 0008): the worker runtime (`ai` pool, usage in Postgres), the request runtime
 * (feed-api / api: budget on the redis spend mirror, usage through the `ai-usage` queue — ADR 0008 #6a, ADR 0018) and the
 * jobs that serve them (`ai-usage`: request path, untrusted producer; `ai`: worker retries).
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

/**
 * S12-01 (ADR 0018 gap): AI features that call the gateway on a request path. `ai.recordUsage` (the `ai-usage` queue,
 * which feed-api's `feed_ai` Redis user can write) accepts records of these features only. Keep in step with the
 * request-path callers (`website-api.search-ai`: `AI_SEARCH_FEATURE`, S12-08).
 */
export const REQUEST_PATH_AI_FEATURES: readonly string[] = ['website-api.search-ai'];

/**
 * Bounds of one request-path record (S12-01, ADR 0018): a compromised producer can at most inflate a real agency's
 * recorded spend by small, plausible calls — never plant a huge cost, a batch, a foreign month or an unknown agency.
 */
export const REQUEST_PATH_RECORD_LIMITS = {
  costMicroUsd: 1_000_000,
  inputTokens: 200_000,
  outputTokens: 16_000,
  latencyMs: 600_000,
} as const;

const MONTH_RE = /^\d{4}-\d{2}-01$/;

/** The usage month must be this month or the previous one (UTC): records arrive seconds, at most days, late. */
function recentMonth(month: string, now = new Date()): boolean {
  const cur = usageMonth(now);
  const prev = usageMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  return month === cur || month === prev;
}

async function agencyExists(tx: Tx, agencyId: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`select 1 from agencies where agency_id = ${agencyId}`);
  return rows.length > 0;
}

/** A request-path record: what `createRequestAiStore` produces, within `REQUEST_PATH_RECORD_LIMITS`. */
const RequestPathRecord = z.object({
  id: z.string().uuid(),
  agencyId: z.string().uuid(),
  feature: z.string().refine((f) => REQUEST_PATH_AI_FEATURES.includes(f), 'not a request-path AI feature'),
  kind: z.enum(['GENERATE', 'STRUCTURED', 'EMBED']),
  tier: z.enum(['FAST', 'SMART']).nullable(),
  model: z.string().min(1).max(100),
  promptId: z.string().max(64).nullable(),
  promptVersion: z.number().int().min(1).max(9_999).nullable(),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(['SUCCEEDED', 'FAILED']),
  errorCode: z.string().max(100).nullable(),
  usage: z.object({
    inputTokens: z.number().int().min(0).max(REQUEST_PATH_RECORD_LIMITS.inputTokens),
    outputTokens: z.number().int().min(0).max(REQUEST_PATH_RECORD_LIMITS.outputTokens),
    cacheReadTokens: z.number().int().min(0).max(REQUEST_PATH_RECORD_LIMITS.inputTokens),
    cacheWriteTokens: z.number().int().min(0).max(REQUEST_PATH_RECORD_LIMITS.inputTokens),
  }),
  costMicroUsd: z.number().int().min(0).max(REQUEST_PATH_RECORD_LIMITS.costMicroUsd),
  latencyMs: z.number().int().min(0).max(REQUEST_PATH_RECORD_LIMITS.latencyMs),
  itemCount: z.literal(1),
  providerBatchId: z.null(),
  requestId: z.string().max(200).nullable(),
  month: z.string().regex(MONTH_RE),
});

/**
 * S13-F9: `ai_jobs` retention — settled rows are kept this many months (the usage page's year plus the month it
 * compares against; the totals stay in `ai_usage_monthly`), deleted `PRUNE_BATCH` per statement by `ai.pruneJobs`.
 */
export const AI_JOBS_RETENTION = { MONTHS: 13, PRUNE_BATCH: 5_000 } as const;

/** The instant `months` calendar months (UTC) before `nowMs`. */
export function monthsBefore(nowMs: number, months: number): Date {
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/** The daily `ai_jobs` prune (S13-F9): settled rows older than `AI_JOBS_RETENTION.MONTHS`, batch by batch. */
export async function pruneAiJobRows(
  nowMs: number = clock.nowMs(),
  signal?: AbortSignal,
): Promise<{ deleted: number }> {
  const before = monthsBefore(nowMs, AI_JOBS_RETENTION.MONTHS);
  let deleted = 0;
  for (;;) {
    const n = await withSystem('ai.pruneJobs', (tx: Tx) => pruneAiJobs(tx, before, AI_JOBS_RETENTION.PRUNE_BATCH));
    deleted += n;
    if (n < AI_JOBS_RETENTION.PRUNE_BATCH || signal?.aborted) break;
  }
  return { deleted };
}

export const aiJobs = {
  /**
   * Appends a request-path usage record (no `withSystem` there) — queue `ai-usage`, the only one feed-api's `feed_ai`
   * Redis user can reach (ADR 0018). Its producer is untrusted: the payload is validated against
   * `REQUEST_PATH_RECORD_LIMITS` and the request-path feature list (Zod, invalid → dead letter), the month must be
   * recent and the agency must exist (else dead letter, nothing written). Idempotent by the job id. The cost was queued
   * on the spend mirror; it moves into the mirror's base once the row is in.
   */
  recordUsage: defineJob({
    name: 'ai.recordUsage',
    pool: 'ai-usage',
    payload: z.object({ job: RequestPathRecord }),
    jobId: (p) => p.job.id,
    attempts: 10,
    backoff: { type: 'exponential', delay: 2_000 },
    async run(p) {
      const job = p.job as AiJobRecord;
      if (!recentMonth(job.month)) throw new UnrecoverableError('ai.recordUsage: month out of range');
      const inserted = await withSystem('ai.recordUsage', async (tx: Tx) => {
        if (!(await agencyExists(tx, job.agencyId))) return null;
        return recordUsageRow(tx, job, 0);
      });
      if (inserted === null) throw new UnrecoverableError('ai.recordUsage: unknown agency');
      if (inserted) await spendMirror().recorded(job.agencyId, job.month, job.costMicroUsd);
    },
  }),

  /** S13-F9: daily, pool `maintenance` — settled `ai_jobs` rows past their retention (`pruneAiJobRows`). */
  pruneJobs: defineJob({
    name: 'ai.pruneJobs',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 24 * 60 * 60_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const res = await pruneAiJobRows(clock.nowMs(), signal);
      if (res.deleted) log.info(res, 'ai jobs pruned');
      return res;
    },
  }),

  /** Seeds the spend mirror of one agency and month from `ai_usage_monthly` (the request path asked: key missing). */
  refreshSpend: defineJob({
    name: 'ai.refreshSpend',
    pool: 'ai-usage',
    payload: z.object({ agencyId: z.string().uuid(), month: z.string().regex(MONTH_RE) }),
    attempts: 3,
    backoff: { type: 'fixed', delay: 1_000 },
    async run(p) {
      if (!recentMonth(p.month)) throw new UnrecoverableError('ai.refreshSpend: month out of range');
      await withSystem(
        'ai.refreshSpend',
        async (tx: Tx) => {
          // An unknown agency gets no mirror key (nothing to seed for it).
          if (await agencyExists(tx, p.agencyId)) await refreshSpendMirror(tx, spendMirror(), p.agencyId, p.month);
        },
        { routine: true },
      );
    },
  }),

  /**
   * A worker-path usage record whose first write failed (the gateway's `onRecordFailure`) — the `ai` queue, which only
   * workers reach. Any feature, batches included; `releaseMicroUsd` gives back the call's database reservation. The
   * cost reaches the mirror's base once the row is in.
   */
  retryUsageRecord: defineJob({
    name: 'ai.retryUsageRecord',
    pool: 'ai',
    payload: z.object({ job: JobRecord, releaseMicroUsd: z.number().int().min(0) }),
    jobId: (p) => p.job.id,
    attempts: 10,
    backoff: { type: 'exponential', delay: 2_000 },
    async run(p) {
      const job = p.job as AiJobRecord;
      const inserted = await withSystem('ai.recordUsage', (tx: Tx) => recordUsageRow(tx, job, p.releaseMicroUsd));
      if (inserted && job.status !== 'PENDING') await spendMirror().adjust(job.agencyId, job.month, job.costMicroUsd);
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
      onRecordFailure: (input) => aiJobs.retryUsageRecord.enqueue(input),
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
 * (`configureQueue`) and redis-cache configured at boot, and a worker running the `ai-usage` pool. No batches here.
 */
export function configureAiRequestRuntime(options: { logger: Logger }): void {
  configureAi(
    createAiGatewayFromEnv({
      promptsDir: aiPromptsDir(),
      store: createRequestAiStore({
        mirror: spendMirror(),
        // `ai-usage` queue (ADR 0018): the request path's own; its records are validated by the worker.
        enqueueRecord: (input) => aiJobs.recordUsage.enqueue({ job: input.job as z.input<typeof RequestPathRecord> }),
        // Throttled per agency and month: a burst of requests on a cold key asks once.
        enqueueRefresh: (input) => aiJobs.refreshSpend.enqueue(input, { throttleMs: 2_000 }),
        logger: options.logger,
      }),
      logger: options.logger,
    }),
  );
}
