import type { z } from 'zod';
import { cache as processCache } from '../cache';
import { AppError } from '../errors';
import { createLogger, type Logger } from '../logger';
import { createAnthropicProvider } from './anthropic';
import { type AiSettings, loadAiSettings } from './config';
import { embeddingProviderFor } from './embeddings';
import { type AiCache, type AiGateway, createAiGateway } from './gateway';
import { filePromptSource } from './prompts';
import type { AiStore } from './store';
import type { AiBatchRequest, AiCtx, AiEmbedRequest, AiGenerateRequest, AiStructuredRequest } from './types';

/**
 * `@inmolink/platform/ai` — the AI gateway (S12-01, PLAN §8, ADR 0008, PATTERNS §17). Features call `ai.generate`,
 * `ai.structured`, `ai.batch` / `ai.collectBatch` and `ai.embed`; nothing else imports a provider SDK.
 *
 * A process opts in at boot with `configureAi(createAiGatewayFromEnv(...))` (the worker, through `@inmolink/core`'s
 * `configureAiRuntime`). Unconfigured, every call fails fast with `AI_UNAVAILABLE` (reason `NOT_CONFIGURED`), which
 * features treat like an outage: they degrade (`aiOrFallback`).
 */
export { createAnthropicProvider, mapProviderError } from './anthropic';
export { type AiBudget, type AiSettings, aiEnv, costMicroUsd, loadAiSettings, type ModelPrice } from './config';
export { embeddingProviderFor } from './embeddings';
export { checkAnswer, EvalCase, type EvalCaseFile, type EvalOutcome, loadEvalCases, runEval } from './eval';
export {
  AI_DEGRADE_CODES,
  type AiCache,
  type AiGateway,
  type AiGatewayOptions,
  aiOrFallback,
  createAiGateway,
  stableJson,
} from './gateway';
export {
  filePromptSource,
  listPrompts,
  type Prompt,
  type PromptSource,
  parsePrompt,
  staticPromptSource,
} from './prompts';
export {
  type AiProvider,
  AiProviderError,
  type EmbeddingProvider,
  type ProviderBatchItem,
  type ProviderBatchResult,
  type ProviderRequest,
  type ProviderResponse,
} from './provider';
export {
  type AiFeedbackInput,
  type AiJobRecord,
  type AiStore,
  createPgAiStore,
  recordAiFeedback,
  type SystemRunner,
  syncPromptVersions,
  usageMonth,
} from './store';
export * from './types';

/** Builds the gateway from `aiEnv` (model tiers, prices, budgets, breaker) — never from hard-coded values. */
export function createAiGatewayFromEnv(options: {
  /** Where the prompt files live (`packages/core/prompts`). */
  promptsDir: string;
  /** Usage store (`createPgAiStore(withSystem)` in workers). Null refuses tenant calls. */
  store: AiStore | null;
  /** Default: the process cache on redis-cache. Null: no response cache. */
  cache?: AiCache | null;
  logger?: Logger;
  settings?: AiSettings;
}): AiGateway {
  const s = options.settings ?? loadAiSettings();
  const provider =
    s.provider === 'anthropic' && s.apiKey
      ? createAnthropicProvider({ apiKey: s.apiKey, maxRetries: s.maxRetries, timeoutMs: s.timeoutMs })
      : null;
  return createAiGateway({
    provider,
    embeddings: embeddingProviderFor(s.embed),
    models: s.models,
    pricing: s.pricing,
    batchDiscountBp: s.batchDiscountBp,
    prompts: filePromptSource(options.promptsDir),
    cache: options.cache === undefined ? processCache : options.cache,
    cacheTtlSeconds: s.cacheTtlSeconds,
    store: options.store,
    budgetFor: (plan) => (plan ? s.budgetsByPlan[plan] : undefined) ?? s.defaultBudget,
    timeoutMs: s.timeoutMs,
    breaker: s.breaker,
    logger: options.logger ?? createLogger({ service: 'ai', level: process.env.LOG_LEVEL }),
  });
}

let current: AiGateway | undefined;

/** Installs the process gateway (boot) — `undefined` removes it (tests). */
export function configureAi(gateway: AiGateway | undefined): void {
  current = gateway;
}

function gateway(): AiGateway {
  if (!current) throw new AppError('AI_UNAVAILABLE', { reason: 'NOT_CONFIGURED' });
  return current;
}

/** The process gateway (PATTERNS §17). */
export const ai = {
  generate: async (ctx: AiCtx, request: AiGenerateRequest) => gateway().generate(ctx, request),
  structured: async <S extends z.ZodType>(ctx: AiCtx, request: AiStructuredRequest<S>) =>
    gateway().structured(ctx, request),
  batch: async (ctx: AiCtx, request: AiBatchRequest) => gateway().batch(ctx, request),
  collectBatch: async (ctx: AiCtx, input: { batchId: string; request: AiBatchRequest }) =>
    gateway().collectBatch(ctx, input),
  embed: async (ctx: AiCtx, request: AiEmbedRequest) => gateway().embed(ctx, request),
};
