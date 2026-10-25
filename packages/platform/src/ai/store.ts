import { sql } from 'drizzle-orm';
import { newId } from '../ids';
import type { Logger } from '../logger';
import type { SqlExecutor } from '../sql';
import type { SpendMirror } from './mirror';
import type { Prompt } from './prompts';
import type { AiTier, AiUsage } from './types';

/**
 * Usage accounting (`ai_jobs`, `ai_usage_monthly`; `@inmolink/db` schema/ai.ts — keep column names in sync).
 *
 * The hard cap is a reservation, not a check (S12-01 review): before a provider call the gateway atomically reserves
 * the call's worst-case cost — one conditional UPDATE that succeeds only while `cost + reserved + estimate <= hard` —
 * and after it settles the real cost and releases the reservation, in one transaction. Concurrent calls and batches of
 * one agency therefore cannot pass the cap together. Each step is a short transaction of its own: never the caller's,
 * never around the provider call.
 *
 * Two implementations: `createPgAiStore` (workers, `withSystem`) and `createRequestAiStore` (request processes: a
 * redis mirror of the month's spend + usage recorded through a queued job) — ADR 0008 #6a.
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
  /** `YYYY-MM-01` (UTC) — the usage month the cost counts against (a batch settles into its submit month). */
  month: string;
}

export type ReserveResult = { ok: true; spentMicroUsd: number } | { ok: false; reason: 'HARD_CAP' | 'UNKNOWN' };

export interface AiStore {
  /** False: this store cannot hold batch jobs (the request path) — `ai.batch` refuses before submitting. */
  readonly batches?: boolean;
  /**
   * Reserves `estimateMicroUsd` against the month when `spent + reserved + estimate <= hardMicroUsd`. `UNKNOWN`: the
   * spend could not be read (request path, mirror not seeded yet) — the gateway fails closed.
   */
  reserve(input: {
    agencyId: string;
    month: string;
    estimateMicroUsd: number;
    hardMicroUsd: number;
  }): Promise<ReserveResult>;
  /**
   * Records a finished call and settles it in one transaction: appends the job, adds its cost and tokens to the month
   * and releases `reservedMicroUsd`. A PENDING (batch) job is appended with the reservation kept on its row instead.
   */
  settle(job: AiJobRecord, reservedMicroUsd: number): Promise<void>;
  /** Gives a reservation back when no job will settle it (the provider was never reached). */
  release(agencyId: string, month: string, reservedMicroUsd: number): Promise<void>;
  /** The batch job of this agency (null: none — not this agency's batch). */
  batchJob(agencyId: string, providerBatchId: string): Promise<{ status: AiJobStatus; inputHash: string } | null>;
  /**
   * Settles a PENDING batch job once, into the month and against the reservation stored on its row. False when it was
   * settled already (a second collect costs nothing twice).
   */
  settleBatch(input: {
    agencyId: string;
    providerBatchId: string;
    usage: AiUsage;
    costMicroUsd: number;
    failedItems: number;
  }): Promise<boolean>;
}

/** A short transaction as `app_system` (`withSystem(reason, …)` from `@inmolink/db`), injected at boot. */
export type SystemRunner = <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export function usageMonth(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * TEMPORARY (S12-01 review, until the reservation migration is applied everywhere — remove with it): whether
 * `ai_usage_monthly.reserved_micro_usd` / `ai_jobs.usage_month` exist. Without them the store keeps the 0139 behaviour
 * (check-then-record, no reservation), so lanes testing against the 0139 schema keep working. A `true` is kept for the
 * process; a `false` is re-checked after a minute (the migration may land while it runs).
 */
let reservationSchema: { ok: boolean; at: number } | undefined;
async function hasReservations(tx: SqlExecutor): Promise<boolean> {
  if (reservationSchema && (reservationSchema.ok || Date.now() - reservationSchema.at < 60_000)) {
    return reservationSchema.ok;
  }
  const { rows } = await tx.execute(sql`
    select count(*)::int as n from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_usage_monthly' and column_name = 'reserved_micro_usd'`);
  reservationSchema = { ok: Number(rows[0]?.n) > 0, at: Date.now() };
  return reservationSchema.ok;
}

async function bumpMonth(
  tx: SqlExecutor,
  agencyId: string,
  month: string,
  usage: AiUsage,
  costMicroUsd: number,
  releaseMicroUsd: number,
): Promise<void> {
  await tx.execute(sql`
    insert into ai_usage_monthly (agency_id, month, cost_micro_usd, calls, input_tokens, output_tokens, updated_at)
    values (${agencyId}, ${month}::date, ${costMicroUsd}, 1,
            ${usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens}, ${usage.outputTokens}, now())
    on conflict (agency_id, month) do update set
      cost_micro_usd = ai_usage_monthly.cost_micro_usd + excluded.cost_micro_usd,
      ${(await hasReservations(tx)) ? sql`reserved_micro_usd = greatest(ai_usage_monthly.reserved_micro_usd - ${releaseMicroUsd}, 0),` : sql``}
      calls = ai_usage_monthly.calls + 1,
      input_tokens = ai_usage_monthly.input_tokens + excluded.input_tokens,
      output_tokens = ai_usage_monthly.output_tokens + excluded.output_tokens,
      updated_at = now()`);
}

/**
 * Appends a job row (idempotent by its id) and, unless PENDING, counts it in the month and releases `releaseMicroUsd`.
 * Also the `ai.recordUsage` job's body (request-path usage, and worker records whose first write failed). Returns
 * false when the row existed already (nothing counted twice).
 */
export async function recordUsageRow(tx: SqlExecutor, job: AiJobRecord, releaseMicroUsd: number): Promise<boolean> {
  const pending = job.status === 'PENDING';
  const v2 = await hasReservations(tx);
  const { rows } = await tx.execute(sql`
    insert into ai_jobs (id, agency_id, feature, kind, tier, model, prompt_id, prompt_version, input_hash, status,
      error_code, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd, latency_ms,
      item_count, provider_batch_id, request_id, ${v2 ? sql`usage_month, reserved_micro_usd,` : sql``} completed_at)
    values (${job.id}, ${job.agencyId}, ${job.feature}, ${job.kind}, ${job.tier}, ${job.model}, ${job.promptId},
      ${job.promptVersion}, ${job.inputHash}, ${job.status}, ${job.errorCode}, ${job.usage.inputTokens},
      ${job.usage.outputTokens}, ${job.usage.cacheReadTokens}, ${job.usage.cacheWriteTokens}, ${job.costMicroUsd},
      ${job.latencyMs}, ${job.itemCount}, ${job.providerBatchId}, ${job.requestId},
      ${v2 ? sql`${job.month}::date, ${pending ? releaseMicroUsd : 0},` : sql``} ${pending ? null : sql`now()`})
    on conflict (id) do nothing
    returning id`);
  if (rows.length === 0) return false;
  if (!pending) await bumpMonth(tx, job.agencyId, job.month, job.usage, job.costMicroUsd, releaseMicroUsd);
  return true;
}

export interface PgAiStoreOptions {
  /** Kept in step with every settled cost, so the request path sees worker spend (best effort). */
  mirror?: SpendMirror | null;
  logger?: Logger;
}

export function createPgAiStore(runSystem: SystemRunner, options: PgAiStoreOptions = {}): AiStore {
  const mirror = options.mirror ?? null;
  const toMirror = async (agencyId: string, month: string, delta: number) => {
    if (!mirror || delta === 0) return;
    await mirror
      .adjust(agencyId, month, delta)
      .catch((err: unknown) => options.logger?.warn({ err }, 'ai spend mirror'));
  };
  return {
    async reserve({ agencyId, month, estimateMicroUsd, hardMicroUsd }) {
      const estimate = Math.max(0, Math.ceil(estimateMicroUsd));
      return runSystem('ai.reserveBudget', async (tx) => {
        if (!(await hasReservations(tx))) {
          // 0139 schema (TEMPORARY): check only.
          const { rows } = await tx.execute(sql`
            select cost_micro_usd from ai_usage_monthly where agency_id = ${agencyId} and month = ${month}::date`);
          const spent = rows[0] ? Number(rows[0].cost_micro_usd) : 0;
          return spent + estimate > hardMicroUsd
            ? ({ ok: false, reason: 'HARD_CAP' } as const)
            : ({ ok: true, spentMicroUsd: spent } as const);
        }
        await tx.execute(sql`
          insert into ai_usage_monthly (agency_id, month) values (${agencyId}, ${month}::date)
          on conflict (agency_id, month) do nothing`);
        // The row lock serializes concurrent reservations; the condition is re-checked on the locked row.
        const { rows } = await tx.execute(sql`
          update ai_usage_monthly set reserved_micro_usd = reserved_micro_usd + ${estimate}, updated_at = now()
          where agency_id = ${agencyId} and month = ${month}::date
            and cost_micro_usd + reserved_micro_usd + ${estimate} <= ${hardMicroUsd}
          returning cost_micro_usd`);
        if (rows.length === 0) return { ok: false, reason: 'HARD_CAP' } as const;
        return { ok: true, spentMicroUsd: Number(rows[0]?.cost_micro_usd) } as const;
      });
    },

    async settle(job, reservedMicroUsd) {
      const inserted = await runSystem('ai.recordUsage', (tx) => recordUsageRow(tx, job, reservedMicroUsd));
      if (inserted && job.status !== 'PENDING') await toMirror(job.agencyId, job.month, job.costMicroUsd);
    },

    async release(agencyId, month, reservedMicroUsd) {
      if (reservedMicroUsd <= 0) return;
      await runSystem('ai.releaseBudget', async (tx) => {
        if (!(await hasReservations(tx))) return;
        await tx.execute(sql`
          update ai_usage_monthly set reserved_micro_usd = greatest(reserved_micro_usd - ${reservedMicroUsd}, 0),
            updated_at = now()
          where agency_id = ${agencyId} and month = ${month}::date`);
      });
    },

    async batchJob(agencyId, providerBatchId) {
      return runSystem('ai.batchJob', async (tx) => {
        const { rows } = await tx.execute(sql`
          select status, input_hash from ai_jobs
          where agency_id = ${agencyId} and provider_batch_id = ${providerBatchId} and kind = 'BATCH'`);
        const r = rows[0];
        return r ? { status: String(r.status) as AiJobStatus, inputHash: String(r.input_hash) } : null;
      });
    },

    async settleBatch(input) {
      const month = await runSystem('ai.settleBatch', async (tx) => {
        const v2 = await hasReservations(tx);
        const { rows } = await tx.execute(sql`
          with pending as (
            select id, ${v2 ? sql`reserved_micro_usd` : sql`0::bigint as reserved_micro_usd`},
              ${v2 ? sql`coalesce(usage_month, date_trunc('month', created_at at time zone 'UTC')::date)` : sql`date_trunc('month', created_at at time zone 'UTC')::date`} as month
            from ai_jobs
            where agency_id = ${input.agencyId} and provider_batch_id = ${input.providerBatchId} and status = 'PENDING'
            for update
          )
          update ai_jobs j set status = 'SUCCEEDED', input_tokens = ${input.usage.inputTokens},
            output_tokens = ${input.usage.outputTokens}, cache_read_tokens = ${input.usage.cacheReadTokens},
            cache_write_tokens = ${input.usage.cacheWriteTokens}, cost_micro_usd = ${input.costMicroUsd},
            error_code = ${input.failedItems > 0 ? `ITEMS_FAILED:${input.failedItems}` : null},
            ${v2 ? sql`reserved_micro_usd = 0, usage_month = pending.month,` : sql``} completed_at = now()
          from pending where j.id = pending.id
          returning to_char(pending.month, 'YYYY-MM-DD') as month, pending.reserved_micro_usd as reserved`);
        const row = rows[0];
        if (!row) return null;
        // Into the batch's own month, releasing the reservation made at submit.
        await bumpMonth(tx, input.agencyId, String(row.month), input.usage, input.costMicroUsd, Number(row.reserved));
        return String(row.month);
      });
      if (month === null) return false;
      await toMirror(input.agencyId, month, input.costMicroUsd);
      return true;
    },
  };
}

export interface RequestAiStoreOptions {
  mirror: SpendMirror;
  /** Enqueues the `ai.recordUsage` job (the worker appends the row and counts it in the month). */
  enqueueRecord: (input: { job: AiJobRecord; releaseMicroUsd: number }) => Promise<unknown>;
  /** Enqueues the `ai.refreshSpend` job (seeds the mirror from the database); deduplicated by the job id. */
  enqueueRefresh: (input: { agencyId: string; month: string }) => Promise<unknown>;
  logger?: Logger;
}

/**
 * Request-path usage store (S12-01 review, ADR 0008 #6a) — for processes without `withSystem` (feed-api's NL search,
 * S12-08). Reserves on the redis mirror (atomic Lua; fails closed while the mirror is not seeded), settles by adjusting
 * the mirror to the real cost and enqueueing the usage record for a worker. Batches are worker-only.
 */
export function createRequestAiStore(options: RequestAiStoreOptions): AiStore {
  const workersOnly = (): never => {
    throw new Error('AI batches run in workers (createPgAiStore), not on the request path');
  };
  return {
    batches: false,
    async reserve({ agencyId, month, estimateMicroUsd, hardMicroUsd }) {
      let r: ReserveResult;
      try {
        r = await options.mirror.reserve(agencyId, month, estimateMicroUsd, hardMicroUsd);
      } catch (err) {
        options.logger?.warn({ err }, 'ai spend mirror unreachable');
        r = { ok: false, reason: 'UNKNOWN' };
      }
      if (!r.ok && r.reason === 'UNKNOWN') {
        await options
          .enqueueRefresh({ agencyId, month })
          .catch((err: unknown) => options.logger?.warn({ err }, 'ai spend refresh enqueue failed'));
      }
      return r;
    },
    async settle(job, reservedMicroUsd) {
      if (job.status === 'PENDING') workersOnly();
      await options.mirror.adjust(job.agencyId, job.month, job.costMicroUsd - reservedMicroUsd).catch(() => undefined);
      // The reservation lived in the mirror only: the database has nothing to release.
      await options.enqueueRecord({ job, releaseMicroUsd: 0 });
    },
    async release(agencyId, month, reservedMicroUsd) {
      await options.mirror.adjust(agencyId, month, -reservedMicroUsd).catch(() => undefined);
    },
    batchJob: async () => workersOnly(),
    settleBatch: async () => workersOnly(),
  };
}

/** Seeds the mirror for one agency and month from the database (the `ai.refreshSpend` job's body). */
export async function refreshSpendMirror(
  tx: SqlExecutor,
  mirror: SpendMirror,
  agencyId: string,
  month: string,
): Promise<number> {
  const { rows } = await tx.execute(
    sql`select cost_micro_usd from ai_usage_monthly where agency_id = ${agencyId} and month = ${month}::date`,
  );
  const spent = rows[0] ? Number(rows[0].cost_micro_usd) : 0;
  await mirror.seed(agencyId, month, spent);
  return spent;
}

/** Thumbs up/down on an AI output (PLAN §8 `AiFeedback` → weekly review → prompt/eval updates). */
export interface AiFeedbackInput {
  agencyId: string;
  /** The member giving it — must be the session's user (`app_user_id()`, RLS). */
  userId: string | null;
  feature: string;
  jobId: string | null;
  promptId: string | null;
  promptVersion: number | null;
  rating: 1 | -1;
  comment?: string | null;
}

/** `<area>.<feature>` — the same rule as the gateway's. */
export const AI_FEATURE_RE = /^[a-z][a-z0-9-]{0,40}(\.[a-z0-9-]{1,40}){0,3}$/;

/**
 * Appends a feedback row on the caller's tenant transaction (`withTenant`: a member inserts rows of their agency
 * that name themselves, reads the agency's; nobody updates or deletes). Returns its id.
 */
export async function recordAiFeedback(tx: SqlExecutor, input: AiFeedbackInput): Promise<string> {
  if (input.rating !== 1 && input.rating !== -1) throw new TypeError('rating must be 1 or -1');
  if (!AI_FEATURE_RE.test(input.feature)) throw new TypeError('invalid AI feature');
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
