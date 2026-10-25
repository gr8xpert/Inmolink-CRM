import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/**
 * AI gateway tables (S12-01, PLAN §4 "AI", §8, ADR 0008). Owned by `@inmolink/platform/ai`, which reaches them with
 * raw SQL (`src/ai/store.ts`) — keep column names in sync. Money is integer micro-USD (1 USD = 1 000 000): one FAST
 * call costs a fraction of a cent.
 */

/**
 * One row per gateway call that reached the provider (or a batch submitted to it): who, which feature, model,
 * tokens, cost, latency, outcome. Written by the gateway as `app_system`; agencies read their own (usage page).
 */
export const aiJobs = pgTable(
  'ai_jobs',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** `<area>.<feature>`, e.g. `listing-studio.describe`. */
    feature: text('feature').notNull(),
    /** GENERATE | STRUCTURED | BATCH | EMBED */
    kind: text('kind').notNull(),
    /** FAST | SMART (null for embeddings). */
    tier: text('tier'),
    model: text('model').notNull(),
    promptId: text('prompt_id'),
    promptVersion: integer('prompt_version'),
    /** Hex SHA-256 of the request (the response-cache key). */
    inputHash: char('input_hash', { length: 64 }).notNull(),
    /** SUCCEEDED | FAILED | PENDING (a batch not collected yet) */
    status: text('status').notNull(),
    errorCode: text('error_code'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    /** Items in a batch (1 otherwise). */
    itemCount: integer('item_count').notNull().default(1),
    providerBatchId: text('provider_batch_id'),
    requestId: text('request_id'),
    /** S12-01 review: the usage month the cost counts against (a batch settles into its submit month). */
    usageMonth: date('usage_month'),
    /** S12-01 review: a PENDING batch's budget reservation, released when it is collected. */
    reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    // the agency's usage list (staff console / dashboard): where agency_id = ? order by created_at desc, id desc
    index('ai_jobs_agency_created_idx').on(t.agencyId, t.createdAt, t.id),
    // settling a collected batch: where agency_id = ? and provider_batch_id = ? and status = 'PENDING'
    uniqueIndex('ai_jobs_batch_uq').on(t.agencyId, t.providerBatchId).where(sql`${t.providerBatchId} is not null`),
    check('ai_jobs_kind_ck', sql`${t.kind} in ('GENERATE', 'STRUCTURED', 'BATCH', 'EMBED')`),
    check('ai_jobs_status_ck', sql`${t.status} in ('SUCCEEDED', 'FAILED', 'PENDING')`),
    check('ai_jobs_tier_ck', sql`${t.tier} is null or ${t.tier} in ('FAST', 'SMART')`),
    check('ai_jobs_cost_ck', sql`${t.costMicroUsd} >= 0`),
    check('ai_jobs_reserved_ck', sql`${t.reservedMicroUsd} >= 0`),
  ],
);

/**
 * Spend per agency and UTC month — the budget check reads one row before every provider call (hard cap →
 * `AI_BUDGET_EXCEEDED`). Written by the gateway as `app_system`; agencies read their own.
 */
export const aiUsageMonthly = pgTable(
  'ai_usage_monthly',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** First day of the month (UTC). */
    month: date('month').notNull(),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    /** S12-01 review: open reservations (worst-case cost of calls and batches in flight); the hard cap counts them. */
    reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull().default(0),
    calls: integer('calls').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // budget check: where agency_id = ? and month = ?
    primaryKey({ columns: [t.agencyId, t.month] }),
    // S13-03, the staff console's AI spend per tenant: where month = ? order by cost_micro_usd desc limit 100
    index('ai_usage_monthly_month_idx').on(t.month),
    check('ai_usage_monthly_month_ck', sql`extract(day from ${t.month}) = 1`),
    check('ai_usage_monthly_reserved_ck', sql`${t.reservedMicroUsd} >= 0`),
  ],
);

/**
 * Prompt registry (PLAN §8): every shipped prompt file version and its content hash. Platform data, the same for
 * every agency (global, `app_system` writes it via `syncPromptVersions`).
 */
export const promptVersions = pgTable(
  'prompt_versions',
  {
    promptId: text('prompt_id').notNull(),
    version: integer('version').notNull(),
    contentHash: char('content_hash', { length: 64 }).notNull(),
    tier: text('tier').notNull(),
    maxTokens: integer('max_tokens').notNull(),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.promptId, t.version] }),
    check('prompt_versions_tier_ck', sql`${t.tier} in ('FAST', 'SMART')`),
  ],
);

/**
 * Thumbs up/down on an AI output (PLAN §8 `AiFeedback` → weekly review → prompt/eval updates). Members append rows
 * that name themselves (`user_id = app_user_id()`) and read their agency's; nobody edits or deletes them (immutable).
 */
export const aiFeedback = pgTable(
  'ai_feedback',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    userId: uuid('user_id'),
    feature: text('feature').notNull(),
    /** The `ai_jobs` row the output came from (null for cached answers). */
    aiJobId: uuid('ai_job_id'),
    promptId: text('prompt_id'),
    promptVersion: integer('prompt_version'),
    /** 1 = thumbs up, -1 = thumbs down. */
    rating: smallint('rating').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // weekly review per feature and prompt version: where feature = ? and created_at >= ? (worker, all agencies)
    index('ai_feedback_feature_created_idx').on(t.feature, t.createdAt),
    // the agency's own feedback list: where agency_id = ? order by created_at desc
    index('ai_feedback_agency_created_idx').on(t.agencyId, t.createdAt, t.id),
    // S12-01 review: the feedback on one output (weekly review joins jobs): where ai_job_id = ?
    index('ai_feedback_job_idx').on(t.aiJobId),
    check('ai_feedback_rating_ck', sql`${t.rating} in (-1, 1)`),
    check('ai_feedback_comment_ck', sql`${t.comment} is null or char_length(${t.comment}) <= 2000`),
  ],
);
