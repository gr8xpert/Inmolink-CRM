import { sql } from 'drizzle-orm';
import { newId } from '../ids';
import type { SqlExecutor } from '../sql';
import type { Prompt } from './prompts';
import type { AiTier, AiUsage } from './types';

/**
 * Usage accounting (`ai_jobs`, `ai_usage_monthly`; `@inmolink/db` schema/ai.ts — keep column names in sync). The
 * gateway reads the month's spend before a provider call (hard cap) and records each call after it, each on a short
 * transaction of its own: never the caller's, never around the provider call.
 */
export type AiJobKind = 'GENERATE' | 'STRUCTURED' | 'BATCH' | 'EMBED';
export type AiJobStatus = 'SUCCEEDED' | 'FAILED' | 'PENDING';

export interface AiJobRecord {
  id: string;
  agencyId: string;
  feature: string;
  kind: AiJobKind;
  tier: AiTier | null;
  model: string;
  promptId: string | null;
  promptVersion: number | null;
  inputHash: string;
  status: AiJobStatus;
  errorCode: string | null;
  usage: AiUsage;
  costMicroUsd: number;
  latencyMs: number;
  itemCount: number;
  providerBatchId: string | null;
  requestId: string | null;
  /** `YYYY-MM-01` (UTC) — the usage month the cost counts against. */
  month: string;
}

export interface AiStore {
  /** The agency's spend this month in micro-USD (0 without a row). */
  monthSpend(agencyId: string, month: string): Promise<number>;
  /** Appends the job and adds its cost and tokens to the month (one transaction). */
  record(job: AiJobRecord): Promise<void>;
  /**
   * Settles a PENDING batch job once: sets its usage and cost and adds them to the month. False when it was settled
   * already (a second collect of the same batch costs nothing twice).
   */
  settleBatch(input: {
    agencyId: string;
    providerBatchId: string;
    usage: AiUsage;
    costMicroUsd: number;
    failedItems: number;
    month: string;
  }): Promise<boolean>;
}

/** A short transaction as `app_system` (`withSystem(reason, …)` from `@inmolink/db`), injected at boot. */
export type SystemRunner = <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export function usageMonth(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

async function bumpMonth(
  tx: SqlExecutor,
  agencyId: string,
  month: string,
  usage: AiUsage,
  costMicroUsd: number,
  calls: number,
): Promise<void> {
  await tx.execute(sql`
    insert into ai_usage_monthly (agency_id, month, cost_micro_usd, calls, input_tokens, output_tokens, updated_at)
    values (${agencyId}, ${month}::date, ${costMicroUsd}, ${calls},
            ${usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens}, ${usage.outputTokens}, now())
    on conflict (agency_id, month) do update set
      cost_micro_usd = ai_usage_monthly.cost_micro_usd + excluded.cost_micro_usd,
      calls = ai_usage_monthly.calls + excluded.calls,
      input_tokens = ai_usage_monthly.input_tokens + excluded.input_tokens,
      output_tokens = ai_usage_monthly.output_tokens + excluded.output_tokens,
      updated_at = now()`);
}

export function createPgAiStore(runSystem: SystemRunner): AiStore {
  return {
    async monthSpend(agencyId, month) {
      return runSystem('ai.budgetCheck', async (tx) => {
        const { rows } = await tx.execute(
          sql`select cost_micro_usd from ai_usage_monthly where agency_id = ${agencyId} and month = ${month}::date`,
        );
        return rows[0] ? Number(rows[0].cost_micro_usd) : 0;
      });
    },

    async record(job) {
      await runSystem('ai.recordUsage', async (tx) => {
        await tx.execute(sql`
          insert into ai_jobs (id, agency_id, feature, kind, tier, model, prompt_id, prompt_version, input_hash, status,
            error_code, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd, latency_ms,
            item_count, provider_batch_id, request_id, completed_at)
          values (${job.id}, ${job.agencyId}, ${job.feature}, ${job.kind}, ${job.tier}, ${job.model}, ${job.promptId},
            ${job.promptVersion}, ${job.inputHash}, ${job.status}, ${job.errorCode}, ${job.usage.inputTokens},
            ${job.usage.outputTokens}, ${job.usage.cacheReadTokens}, ${job.usage.cacheWriteTokens}, ${job.costMicroUsd},
            ${job.latencyMs}, ${job.itemCount}, ${job.providerBatchId}, ${job.requestId},
            ${job.status === 'PENDING' ? null : sql`now()`})`);
        if (job.status !== 'PENDING') await bumpMonth(tx, job.agencyId, job.month, job.usage, job.costMicroUsd, 1);
      });
    },

    async settleBatch(input) {
      return runSystem('ai.settleBatch', async (tx) => {
        const { rows } = await tx.execute(sql`
          update ai_jobs set status = 'SUCCEEDED', input_tokens = ${input.usage.inputTokens},
            output_tokens = ${input.usage.outputTokens}, cache_read_tokens = ${input.usage.cacheReadTokens},
            cache_write_tokens = ${input.usage.cacheWriteTokens}, cost_micro_usd = ${input.costMicroUsd},
            error_code = ${input.failedItems > 0 ? `ITEMS_FAILED:${input.failedItems}` : null}, completed_at = now()
          where agency_id = ${input.agencyId} and provider_batch_id = ${input.providerBatchId} and status = 'PENDING'
          returning id`);
        if (rows.length === 0) return false;
        await bumpMonth(tx, input.agencyId, input.month, input.usage, input.costMicroUsd, 1);
        return true;
      });
    },
  };
}

/** Thumbs up/down on an AI output (PLAN §8 `AiFeedback` → weekly review → prompt/eval updates). */
export interface AiFeedbackInput {
  agencyId: string;
  userId: string | null;
  feature: string;
  jobId: string | null;
  promptId: string | null;
  promptVersion: number | null;
  rating: 1 | -1;
  comment?: string | null;
}

/**
 * Appends a feedback row on the caller's tenant transaction (`withTenant`, `app_user` may insert its own agency's
 * rows and read them; no update or delete). Returns its id.
 */
export async function recordAiFeedback(tx: SqlExecutor, input: AiFeedbackInput): Promise<string> {
  if (input.rating !== 1 && input.rating !== -1) throw new TypeError('rating must be 1 or -1');
  const comment = input.comment?.trim().slice(0, 2_000) || null;
  const id = newId();
  await tx.execute(sql`
    insert into ai_feedback (id, agency_id, user_id, feature, ai_job_id, prompt_id, prompt_version, rating, comment)
    values (${id}, ${input.agencyId}, ${input.userId}, ${input.feature}, ${input.jobId}, ${input.promptId},
      ${input.promptVersion}, ${input.rating}, ${comment})`);
  return id;
}

/**
 * Records every prompt file version in `prompt_versions` (a global registry, `app_system` only). A version whose file
 * changed after it was recorded is refused: ship a new version instead (`.claude/rules/ai.md`). Returns the versions
 * it added.
 */
export async function syncPromptVersions(tx: SqlExecutor, prompts: readonly Prompt[]): Promise<number> {
  let added = 0;
  for (const p of prompts) {
    const { rows } = await tx.execute(sql`
      insert into prompt_versions (prompt_id, version, content_hash, tier, max_tokens, description)
      values (${p.id}, ${p.version}, ${p.hash}, ${p.tier}, ${p.maxTokens}, ${p.description})
      on conflict (prompt_id, version) do nothing
      returning prompt_id`);
    if (rows.length > 0) {
      added++;
      continue;
    }
    const existing = await tx.execute(
      sql`select content_hash from prompt_versions where prompt_id = ${p.id} and version = ${p.version}`,
    );
    if (existing.rows[0]?.content_hash !== p.hash) {
      throw new Error(`prompt ${p.id}/v${p.version} changed after it shipped: add v${p.version + 1} instead`);
    }
  }
  return added;
}
