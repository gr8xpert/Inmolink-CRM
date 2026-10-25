import type { z } from 'zod';

/** Model tiers (PLAN §8, ADR 0008 #2): features ask for a tier, the model ID comes from env. */
export type AiTier = 'FAST' | 'SMART';
export const AI_TIERS: readonly AiTier[] = ['FAST', 'SMART'];

/**
 * The part of `ctx` (PATTERNS §4) the gateway needs — structural, so platform does not depend on core. A core `Ctx`
 * fits as is. `tenant: null` (scripts such as `pnpm i18n:draft`, `pnpm ai:eval`) skips budgets and usage records.
 *
 * The gateway never uses a caller's transaction: budget reads and usage records run on its own short system
 * transactions, and the provider call runs outside any transaction (CLAUDE.md rule 6). Call it from a worker job
 * (ADR 0008 #9), never while holding a transaction open.
 */
export interface AiCtx {
  tenant?: { agencyId: string; plan?: string | null } | null;
  requestId?: string;
}

/** A versioned prompt file: `<promptsDir>/<id>/v<version>.md` (ADR 0008 #5). */
export interface PromptRef {
  id: string;
  version: number;
}

/** What every gateway call names. */
export interface AiCallBase {
  /** `<area>.<feature>`, e.g. `listing-studio.describe` — usage, cache scope and feedback are keyed by it. */
  feature: string;
  prompt: PromptRef;
  /** Overrides the prompt file's tier. */
  tier?: AiTier;
  /**
   * The variable part, sent last (after the stable system prompt, so provider prefix caching applies). A string is
   * sent as is, anything else as JSON. Send no client PII unless the feature needs it (PLAN §8 data minimization).
   */
  input: unknown;
  /** Overrides the prompt file's `maxTokens`. */
  maxTokens?: number;
  /**
   * Extra material for the response cache key (e.g. the listing's facts hash). The key is always the hash of the
   * model, prompt version, input and schema; this only adds to it. `false` skips the cache for this call.
   */
  cacheKey?: string | false;
}

export type AiGenerateRequest = AiCallBase;

export interface AiStructuredRequest<S extends z.ZodType> extends AiCallBase {
  /** The answer must be JSON that this schema accepts; one repair retry on invalid output. */
  schema: S;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type AiBudgetState = 'OK' | 'SOFT_CAP' | 'UNMETERED';

export interface AiResultMeta {
  model: string;
  tier: AiTier;
  /** Served from the response cache: no provider call, no cost. */
  cached: boolean;
  /** Hex SHA-256 of the request (model, prompt version, input, schema, cache key). */
  inputHash: string;
  /** `ai_jobs` row of this call (null when cached, or without a tenant). Feedback (`recordAiFeedback`) points at it. */
  jobId: string | null;
  usage: AiUsage;
  costMicroUsd: number;
  /** `SOFT_CAP`: the agency is past its soft cap this month (still served). `UNMETERED`: no tenant. */
  budget: AiBudgetState;
}

export interface AiTextResult {
  text: string;
  meta: AiResultMeta;
}

export interface AiStructuredResult<T> {
  data: T;
  meta: AiResultMeta;
}

/** One item of a bulk request (translations, per-site content) — `customId` is the caller's key. */
export interface AiBatchItem {
  customId: string;
  input: unknown;
  cacheKey?: string | false;
}

export interface AiBatchRequest extends Omit<AiCallBase, 'input' | 'cacheKey'> {
  items: readonly AiBatchItem[];
}

export type AiBatchItemResult =
  | { customId: string; ok: true; text: string; cached: boolean }
  | { customId: string; ok: false; error: 'REFUSED' | 'FAILED' | 'EXPIRED' };

export interface AiBatchHandle {
  /** Provider batch id, or null when every item came from the cache. */
  batchId: string | null;
  /** Items answered from the cache at submit time (not sent to the provider). */
  cached: AiBatchItemResult[];
  /** Items sent to the provider. */
  submitted: number;
}

export type AiBatchCollect =
  | { status: 'IN_PROGRESS' }
  | { status: 'ENDED'; results: AiBatchItemResult[]; costMicroUsd: number };

export interface AiEmbedRequest {
  feature: string;
  texts: readonly string[];
}

export interface AiEmbedResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}
