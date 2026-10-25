import { z } from 'zod';
import { ConfigError, loadConfig } from '../config';
import type { AiTier } from './types';

/**
 * AI gateway settings (S12-01, ADR 0008). Model IDs, prices and budgets are configuration, never code (CLAUDE.md
 * Never list): a model upgrade is an env change plus a `pnpm ai:eval` run.
 *
 * Money is integer micro-USD (1 USD = 1 000 000) inside the gateway: one FAST call costs a fraction of a cent.
 */
const MODEL_ID = /^[a-z0-9][a-z0-9.:@_-]{1,99}$/;

const ModelPrice = z
  .object({
    /** USD per million input tokens (uncached). */
    input: z.number().min(0).max(10_000),
    /** USD per million output tokens. */
    output: z.number().min(0).max(10_000),
    /** USD per million cache-read input tokens (default: the input price). */
    cacheRead: z.number().min(0).max(10_000).optional(),
    /** USD per million cache-write input tokens (default: the input price). */
    cacheWrite: z.number().min(0).max(10_000).optional(),
  })
  .strict();
export type ModelPrice = z.infer<typeof ModelPrice>;

const Pricing = z.record(z.string().regex(MODEL_ID), ModelPrice);

const Budget = z.object({ softUsdCents: z.number().int().min(0), hardUsdCents: z.number().int().min(0) }).strict();
const BudgetsByPlan = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), Budget);

const json = <T extends z.ZodType>(schema: T) =>
  z.string().transform((text, ctx) => {
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data as z.infer<T>;
      ctx.addIssue({ code: 'custom', message: 'does not match the expected shape' });
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be JSON' });
    }
    return z.NEVER;
  });

export const aiEnv = {
  /** `anthropic` | `none` (AI switched off: every call fails fast with AI_UNAVAILABLE and features degrade). */
  AI_PROVIDER: z.enum(['anthropic', 'none']).default('none'),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  /** Bulk and simple work (translations, drafts, captions, NL search) — ADR 0008 #3. */
  AI_MODEL_FAST: z.string().regex(MODEL_ID).optional(),
  /** Complex reasoning and hard documents. */
  AI_MODEL_SMART: z.string().regex(MODEL_ID).optional(),
  /** `{"<model id>": {"input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25}}` — USD per million tokens. */
  AI_PRICING: json(Pricing).optional(),
  /** Discount of the provider's batch API in basis points of the normal price (5000 = half price). */
  AI_BATCH_DISCOUNT_BP: z.coerce.number().int().min(0).max(10_000).default(5_000),
  /** Whole call, retries included. */
  AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Response cache lifetime (input-hash cache); 0 switches it off. */
  AI_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(90 * 86_400)
    .default(7 * 86_400),
  /** Default monthly budget per agency, in USD cents (PLAN §8: soft and hard caps). */
  AI_BUDGET_SOFT_USD_CENTS: z.coerce.number().int().min(0).default(2_000),
  AI_BUDGET_HARD_USD_CENTS: z.coerce.number().int().min(0).default(5_000),
  /** Per plan key: `{"PRO": {"softUsdCents": 5000, "hardUsdCents": 10000}}`. Plans not listed use the default. */
  AI_BUDGETS_BY_PLAN: json(BudgetsByPlan).optional(),
  /** Lifetime of the request path's month-spend mirror on redis-cache (S12-01 review); reseeded from the database. */
  AI_SPEND_MIRROR_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  AI_BREAKER_FAILURES: z.coerce.number().int().min(1).max(1_000).default(5),
  AI_BREAKER_OPEN_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  /** Embedding provider (ADR 0008 #7). `none` until a multilingual embedding provider is chosen (S12-01 decision). */
  AI_EMBED_PROVIDER: z.enum(['none']).default('none'),
  AI_EMBED_MODEL: z.string().regex(MODEL_ID).optional(),
};

export interface AiBudget {
  softMicroUsd: number;
  hardMicroUsd: number;
}

export interface AiSettings {
  provider: 'anthropic' | 'none';
  apiKey: string | undefined;
  models: Record<AiTier, string> | null;
  pricing: Record<string, ModelPrice>;
  batchDiscountBp: number;
  timeoutMs: number;
  maxRetries: number;
  cacheTtlSeconds: number;
  defaultBudget: AiBudget;
  budgetsByPlan: Record<string, AiBudget>;
  breaker: { failures: number; openMs: number };
  spendMirrorTtlSeconds: number;
  embed: { provider: 'none'; model: string | undefined };
}

const centsToMicro = (cents: number): number => cents * 10_000;

/** Loads and cross-checks the AI settings. Throws `ConfigError` (names, never values) like `loadConfig`. */
export function loadAiSettings(env: NodeJS.ProcessEnv = process.env): AiSettings {
  const c = loadConfig(aiEnv, env);
  const problems: { key: string; message: string }[] = [];
  let models: Record<AiTier, string> | null = null;
  const pricing = c.AI_PRICING ?? {};
  if (c.AI_PROVIDER !== 'none') {
    if (!c.ANTHROPIC_API_KEY)
      problems.push({ key: 'ANTHROPIC_API_KEY', message: 'is required when AI_PROVIDER=anthropic' });
    if (!c.AI_MODEL_FAST) problems.push({ key: 'AI_MODEL_FAST', message: 'is required when AI is on' });
    if (!c.AI_MODEL_SMART) problems.push({ key: 'AI_MODEL_SMART', message: 'is required when AI is on' });
    if (c.AI_MODEL_FAST && c.AI_MODEL_SMART) {
      models = { FAST: c.AI_MODEL_FAST, SMART: c.AI_MODEL_SMART };
      // Budgets need a price for every model the gateway can call: no price, no AI.
      for (const model of new Set(Object.values(models))) {
        if (!pricing[model]) problems.push({ key: 'AI_PRICING', message: `has no price for a configured tier model` });
      }
    }
  }
  if (c.AI_BUDGET_SOFT_USD_CENTS > c.AI_BUDGET_HARD_USD_CENTS) {
    problems.push({ key: 'AI_BUDGET_SOFT_USD_CENTS', message: 'must not exceed AI_BUDGET_HARD_USD_CENTS' });
  }
  const budgetsByPlan: Record<string, AiBudget> = {};
  for (const [plan, b] of Object.entries(c.AI_BUDGETS_BY_PLAN ?? {})) {
    if (b.softUsdCents > b.hardUsdCents)
      problems.push({ key: 'AI_BUDGETS_BY_PLAN', message: 'soft cap above hard cap' });
    budgetsByPlan[plan] = { softMicroUsd: centsToMicro(b.softUsdCents), hardMicroUsd: centsToMicro(b.hardUsdCents) };
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    provider: c.AI_PROVIDER,
    apiKey: c.ANTHROPIC_API_KEY,
    models,
    pricing,
    batchDiscountBp: c.AI_BATCH_DISCOUNT_BP,
    timeoutMs: c.AI_TIMEOUT_MS,
    maxRetries: c.AI_MAX_RETRIES,
    cacheTtlSeconds: c.AI_CACHE_TTL_SECONDS,
    defaultBudget: {
      softMicroUsd: centsToMicro(c.AI_BUDGET_SOFT_USD_CENTS),
      hardMicroUsd: centsToMicro(c.AI_BUDGET_HARD_USD_CENTS),
    },
    budgetsByPlan,
    breaker: { failures: c.AI_BREAKER_FAILURES, openMs: c.AI_BREAKER_OPEN_MS },
    spendMirrorTtlSeconds: c.AI_SPEND_MIRROR_TTL_SECONDS,
    embed: { provider: c.AI_EMBED_PROVIDER, model: c.AI_EMBED_MODEL },
  };
}

/**
 * Cost of a call in micro-USD (rounded up: budgets never under-count). Prices are USD per million tokens, so a
 * token costs exactly `price` micro-USD.
 */
export function costMicroUsd(
  price: ModelPrice | undefined,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  discountBp = 0,
): number {
  if (!price) return 0;
  const full =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * (price.cacheRead ?? price.input) +
    usage.cacheWriteTokens * (price.cacheWrite ?? price.input);
  return Math.ceil((full * (10_000 - discountBp)) / 10_000);
}
