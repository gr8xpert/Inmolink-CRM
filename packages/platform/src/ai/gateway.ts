import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type CacheKey, cacheKey } from '../cache/key';
import { type Clock, clock as processClock } from '../clock';
import { AppError, type ErrorCode, isAppError } from '../errors';
import { newId } from '../ids';
import type { Logger } from '../logger';
import { CircuitBreaker } from '../search/breaker';
import { type AiBudget, costMicroUsd, type ModelPrice } from './config';
import type { Prompt, PromptSource } from './prompts';
import {
  type AiProvider,
  AiProviderError,
  addUsage,
  type EmbeddingProvider,
  type ProviderRequest,
  type ProviderResponse,
  ZERO_USAGE,
} from './provider';
import { type AiJobKind, type AiJobRecord, type AiStore, usageMonth } from './store';
import type {
  AiBatchCollect,
  AiBatchHandle,
  AiBatchItemResult,
  AiBatchRequest,
  AiBudgetState,
  AiCallBase,
  AiCtx,
  AiEmbedRequest,
  AiEmbedResult,
  AiGenerateRequest,
  AiResultMeta,
  AiStructuredRequest,
  AiStructuredResult,
  AiTextResult,
  AiTier,
  AiUsage,
} from './types';

/**
 * The AI gateway (S12-01, PLAN §8, ADR 0008): one entry point for every model call. Per call it
 *
 * 1. resolves the prompt file and the tier's model (env),
 * 2. answers from the response cache when the same request (input hash) was answered before — no provider call,
 *    no cost, and it works while the provider is down,
 * 3. refuses with `AI_BUDGET_EXCEEDED` when the agency's month is at its hard cap — before any provider call,
 * 4. refuses with `AI_UNAVAILABLE` while the circuit breaker is open (provider outage) — fast, so features degrade
 *    instead of waiting,
 * 5. calls the provider with a timeout, validates structured output (one repair retry), and records the job and its
 *    cost (`ai_jobs`, `ai_usage_monthly`).
 *
 * Every failure is an `AppError` with an `AI_*` code; `aiOrFallback` turns them into the feature's fallback.
 */

/** What the gateway needs from the cache adapter (`cache` from `@inmolink/platform/cache` fits). */
export interface AiCache {
  get<T>(key: CacheKey, options: { ttlSeconds: number }, loader: () => Promise<T>): Promise<T>;
  set(key: CacheKey, value: unknown, options: { ttlSeconds: number }): Promise<void>;
}

export interface AiGatewayOptions {
  provider: AiProvider | null;
  embeddings?: EmbeddingProvider | null;
  /** Model per tier (env `AI_MODEL_FAST` / `AI_MODEL_SMART`); null switches generation off. */
  models: Record<AiTier, string> | null;
  pricing: Record<string, ModelPrice>;
  batchDiscountBp: number;
  prompts: PromptSource;
  /** Null: no response cache. */
  cache: AiCache | null;
  cacheTtlSeconds: number;
  /** Null: tenant calls are refused (`AI_UNAVAILABLE`, reason `NO_USAGE_STORE`) — no call goes unmetered. */
  store: AiStore | null;
  budgetFor: (plan: string | null | undefined) => AiBudget;
  timeoutMs: number;
  breaker: { failures: number; openMs: number };
  logger: Logger;
  clock?: Clock;
}

export interface AiGateway {
  generate(ctx: AiCtx, request: AiGenerateRequest): Promise<AiTextResult>;
  structured<S extends z.ZodType>(ctx: AiCtx, request: AiStructuredRequest<S>): Promise<AiStructuredResult<z.infer<S>>>;
  /** Submits bulk work to the provider's discounted batch API; items already cached are answered at once. */
  batch(ctx: AiCtx, request: AiBatchRequest): Promise<AiBatchHandle>;
  /** Polls a batch; once ended, returns every item's result (caching the successes) and settles its cost once. */
  collectBatch(ctx: AiCtx, input: { batchId: string; request: AiBatchRequest }): Promise<AiBatchCollect>;
  embed(ctx: AiCtx, request: AiEmbedRequest): Promise<AiEmbedResult>;
  /** The breaker's state (health checks, tests). */
  readonly breakerState: 'closed' | 'open' | 'half-open';
}

const FEATURE_RE = /^[a-z][a-z0-9-]{0,40}(\.[a-z0-9-]{1,40}){0,3}$/;
const CUSTOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BATCH_ITEMS = 10_000;
const MAX_EMBED_TEXTS = 256;
const MAX_INPUT_CHARS = 400_000;
const MISS = Symbol('ai-cache-miss');

/** JSON with sorted keys, so equal inputs hash equally whatever their key order. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function userText(input: unknown): string {
  const text = typeof input === 'string' ? input : stableJson(input);
  if (text.length > MAX_INPUT_CHARS) throw new AppError('VALIDATION_FAILED', { reason: 'AI_INPUT_TOO_LARGE' });
  return text;
}

/** The model's JSON answer, tolerating a Markdown code fence around it. */
function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function issuesSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

const unavailable = (reason: string, retryable = true) => new AppError('AI_UNAVAILABLE', { reason }, retryable);

/** Codes a feature degrades on (keeps the owner text, shows "try later", skips the AI step). */
export const AI_DEGRADE_CODES: readonly ErrorCode[] = [
  'AI_BUDGET_EXCEEDED',
  'AI_UNAVAILABLE',
  'AI_OUTPUT_INVALID',
  'AI_REFUSED',
];

/**
 * Runs an AI step and returns `fallback(code)` when the gateway says no (budget, outage, invalid output, refusal):
 * the core flow carries on without AI (ADR 0008 #9). Other errors propagate.
 */
export async function aiOrFallback<T, F>(
  run: () => Promise<T>,
  fallback: (code: ErrorCode) => F | Promise<F>,
): Promise<T | F> {
  try {
    return await run();
  } catch (err) {
    if (isAppError(err) && AI_DEGRADE_CODES.includes(err.code)) return fallback(err.code);
    throw err;
  }
}

interface Resolved {
  prompt: Prompt;
  tier: AiTier;
  model: string;
  agencyId: string | null;
  plan: string | null | undefined;
}

export function createAiGateway(options: AiGatewayOptions): AiGateway {
  const time = options.clock ?? processClock;
  const log = options.logger;
  const breaker = new CircuitBreaker({
    failureThreshold: options.breaker.failures,
    openMs: options.breaker.openMs,
    // A slow answer is not a failure here (AI runs in jobs); only errors and timeouts count.
    slowMs: Number.MAX_SAFE_INTEGER,
    now: () => time.nowMs(),
    onChange: (to, from) => log.warn({ to, from }, 'ai circuit breaker state changed'),
  });

  function assertFeature(feature: string): void {
    if (!FEATURE_RE.test(feature)) throw new TypeError(`invalid AI feature "${String(feature).slice(0, 40)}"`);
  }

  function agencyOf(ctx: AiCtx): string | null {
    const agencyId = ctx.tenant?.agencyId ?? null;
    if (agencyId !== null && !options.store) throw unavailable('NO_USAGE_STORE', false);
    return agencyId;
  }

  async function resolve(ctx: AiCtx, call: Omit<AiCallBase, 'input' | 'cacheKey'>): Promise<Resolved> {
    assertFeature(call.feature);
    const agencyId = agencyOf(ctx);
    if (!options.provider || !options.models) throw unavailable('DISABLED', false);
    const prompt = await options.prompts.load(call.prompt);
    const tier = call.tier ?? prompt.tier;
    return { prompt, tier, model: options.models[tier], agencyId, plan: ctx.tenant?.plan };
  }

  function hashOf(
    r: Resolved,
    kind: string,
    input: unknown,
    extra: { schema?: unknown; key?: string; maxTokens: number },
  ) {
    return sha256(
      stableJson({
        kind,
        model: r.model,
        prompt: `${r.prompt.id}/v${r.prompt.version}`,
        promptHash: r.prompt.hash,
        input,
        schema: extra.schema,
        key: extra.key,
        maxTokens: extra.maxTokens,
      }),
    );
  }

  function keyOf(agencyId: string | null, feature: string, inputHash: string): CacheKey {
    return cacheKey({
      v: 1,
      module: 'ai',
      entity: 'response',
      scope: agencyId ? { agencyId } : 'global',
      id: `${feature}:${inputHash}`,
    });
  }

  /** Throws AI_BUDGET_EXCEEDED at the hard cap — before any provider call. */
  async function checkBudget(
    agencyId: string | null,
    plan: string | null | undefined,
    feature: string,
  ): Promise<AiBudgetState> {
    if (agencyId === null || !options.store) return 'UNMETERED';
    const budget = options.budgetFor(plan);
    const month = usageMonth(time.now());
    const spent = await options.store.monthSpend(agencyId, month);
    if (spent >= budget.hardMicroUsd) {
      log.warn({ agencyId, feature, month }, 'ai hard cap reached');
      throw new AppError('AI_BUDGET_EXCEEDED', { feature, month });
    }
    if (spent >= budget.softMicroUsd) {
      log.info({ agencyId, feature, month }, 'ai soft cap passed');
      return 'SOFT_CAP';
    }
    return 'OK';
  }

  /** One provider call through the breaker and the timeout. */
  async function callProvider<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const permit = breaker.acquire();
    if (!permit) throw unavailable('CIRCUIT_OPEN');
    const started = time.nowMs();
    try {
      const out = await fn(AbortSignal.timeout(options.timeoutMs));
      permit.success(time.nowMs() - started);
      return out;
    } catch (err) {
      const mapped = err instanceof AiProviderError ? err : new AiProviderError('unavailable', 'provider call failed');
      // A rejected request (4xx) says nothing about the provider's health.
      if (mapped.kind === 'rejected') permit.success(time.nowMs() - started);
      else permit.failure();
      throw mapped;
    }
  }

  async function record(job: Omit<AiJobRecord, 'id' | 'month'>): Promise<string> {
    const id = newId();
    try {
      await options.store?.record({ ...job, id, month: usageMonth(time.now()) });
    } catch (err) {
      // The provider has answered (and billed): the feature keeps its result; the ops alert is this log line.
      log.error({ err, feature: job.feature, agencyId: job.agencyId }, 'ai usage record failed');
    }
    return id;
  }

  function priceOf(model: string, usage: AiUsage, discountBp = 0): number {
    return costMicroUsd(options.pricing[model], usage, discountBp);
  }

  function providerFailure(err: unknown): AppError {
    if (isAppError(err)) return err;
    if (err instanceof AiProviderError && err.kind === 'rejected') {
      return new AppError('AI_REFUSED', { reason: 'REJECTED', status: err.status ?? null });
    }
    return unavailable('PROVIDER_ERROR');
  }

  /**
   * The shared path of `generate` and `structured`: cache → budget → provider (with `attempt` deciding whether to
   * accept the answer or ask once more) → record.
   */
  async function run<T>(
    ctx: AiCtx,
    request: AiCallBase,
    kind: AiJobKind,
    extra: { schema?: unknown },
    accept: (response: ProviderResponse, attempt: number) => { ok: true; value: T } | { ok: false; repair: string },
    jsonSchema?: Record<string, unknown>,
  ): Promise<{ value: T; meta: AiResultMeta }> {
    const r = await resolve(ctx, request);
    const maxTokens = request.maxTokens ?? r.prompt.maxTokens;
    const user = userText(request.input);
    const inputHash = hashOf(r, kind, request.input, {
      schema: extra.schema,
      key: request.cacheKey === false ? undefined : request.cacheKey,
      maxTokens,
    });

    let fresh: AiResultMeta | undefined;
    const load = async (): Promise<{ v: T }> => {
      const budget = await checkBudget(r.agencyId, r.plan, request.feature);
      const base: ProviderRequest = { model: r.model, system: r.prompt.system, user, maxTokens, jsonSchema };
      let usage: AiUsage = ZERO_USAGE;
      const started = time.nowMs();
      const job = {
        agencyId: r.agencyId as string,
        feature: request.feature,
        kind,
        tier: r.tier,
        model: r.model,
        promptId: r.prompt.id,
        promptVersion: r.prompt.version,
        inputHash,
        itemCount: 1,
        providerBatchId: null,
        requestId: ctx.requestId ?? null,
      };
      const fail = async (code: ErrorCode, error: AppError): Promise<never> => {
        if (r.agencyId) {
          await record({
            ...job,
            status: 'FAILED',
            errorCode: code,
            usage,
            costMicroUsd: priceOf(r.model, usage),
            latencyMs: time.nowMs() - started,
          });
        }
        throw error;
      };

      let req = base;
      for (let attempt = 1; ; attempt++) {
        let response: ProviderResponse;
        try {
          response = await callProvider((signal) => (options.provider as AiProvider).complete(req, { signal }));
        } catch (err) {
          // Breaker open: the provider was not called — nothing to record.
          if (isAppError(err)) throw err;
          const e = providerFailure(err);
          return fail(e.code, e);
        }
        usage = addUsage(usage, response.usage);
        if (response.refused) return fail('AI_REFUSED', new AppError('AI_REFUSED', { reason: 'REFUSAL' }));
        const verdict = accept(response, attempt);
        if (verdict.ok) {
          const cost = priceOf(r.model, usage);
          const jobId = r.agencyId
            ? await record({
                ...job,
                status: 'SUCCEEDED',
                errorCode: null,
                usage,
                costMicroUsd: cost,
                latencyMs: time.nowMs() - started,
              })
            : null;
          fresh = { model: r.model, tier: r.tier, cached: false, inputHash, jobId, usage, costMicroUsd: cost, budget };
          return { v: verdict.value };
        }
        if (attempt >= 2) {
          return fail('AI_OUTPUT_INVALID', new AppError('AI_OUTPUT_INVALID', { feature: request.feature }));
        }
        req = { ...base, user: `${user}\n\n${verdict.repair}` };
      }
    };

    const useCache = options.cache !== null && options.cacheTtlSeconds > 0 && request.cacheKey !== false;
    const stored = useCache
      ? await (options.cache as AiCache).get(
          keyOf(r.agencyId, request.feature, inputHash),
          { ttlSeconds: options.cacheTtlSeconds },
          load,
        )
      : await load();
    const meta: AiResultMeta = fresh ?? {
      model: r.model,
      tier: r.tier,
      cached: true,
      inputHash,
      jobId: null,
      usage: ZERO_USAGE,
      costMicroUsd: 0,
      budget: r.agencyId ? 'OK' : 'UNMETERED',
    };
    return { value: stored.v, meta };
  }

  async function peek(key: CacheKey): Promise<string | undefined> {
    if (!options.cache || options.cacheTtlSeconds <= 0) return undefined;
    try {
      const hit = await options.cache.get<{ v: string }>(key, { ttlSeconds: options.cacheTtlSeconds }, async () => {
        throw MISS;
      });
      return hit.v;
    } catch (err) {
      if (err === MISS) return undefined;
      log.warn({ err }, 'ai cache peek failed');
      return undefined;
    }
  }

  function batchItems(r: Resolved, request: AiBatchRequest) {
    if (request.items.length === 0 || request.items.length > MAX_BATCH_ITEMS) {
      throw new AppError('VALIDATION_FAILED', { reason: 'AI_BATCH_SIZE', max: MAX_BATCH_ITEMS });
    }
    const maxTokens = request.maxTokens ?? r.prompt.maxTokens;
    const seen = new Set<string>();
    return request.items.map((item) => {
      if (!CUSTOM_ID_RE.test(item.customId) || seen.has(item.customId)) {
        throw new AppError('VALIDATION_FAILED', { reason: 'AI_BATCH_CUSTOM_ID' });
      }
      seen.add(item.customId);
      // Same hash as `generate` for the same input, so batch and interactive calls share cached answers.
      const inputHash = hashOf(r, 'GENERATE', item.input, {
        key: item.cacheKey === false ? undefined : item.cacheKey,
        maxTokens,
      });
      return { item, inputHash, maxTokens, key: keyOf(r.agencyId, request.feature, inputHash) };
    });
  }

  return {
    get breakerState() {
      return breaker.state;
    },

    async generate(ctx, request) {
      const { value, meta } = await run<string>(ctx, request, 'GENERATE', {}, (response) => ({
        ok: true,
        value: response.text,
      }));
      return { text: value, meta };
    },

    async structured(ctx, request) {
      const schema = request.schema;
      let jsonSchema: Record<string, unknown> | undefined;
      try {
        const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' });
        jsonSchema = rest as Record<string, unknown>;
      } catch {
        jsonSchema = undefined;
      }
      const { value, meta } = await run<z.infer<typeof schema>>(
        ctx,
        request,
        'STRUCTURED',
        { schema: jsonSchema ?? String(schema.description ?? 'schema') },
        (response) => {
          let parsed: unknown;
          try {
            parsed = parseJsonAnswer(response.text);
          } catch {
            return { ok: false, repair: 'Your previous answer was not valid JSON. Answer again with JSON only.' };
          }
          const result = schema.safeParse(parsed);
          if (result.success) return { ok: true, value: result.data };
          return {
            ok: false,
            repair: `Your previous answer did not match the required schema (${issuesSummary(result.error)}). Answer again with JSON only.`,
          };
        },
        jsonSchema,
      );
      return { data: value, meta };
    },

    async batch(ctx, request) {
      const r = await resolve(ctx, request);
      const prepared = batchItems(r, request);
      const cached: AiBatchItemResult[] = [];
      const pending: typeof prepared = [];
      for (const p of prepared) {
        const hit = p.item.cacheKey === false ? undefined : await peek(p.key);
        if (hit !== undefined) cached.push({ customId: p.item.customId, ok: true, text: hit, cached: true });
        else pending.push(p);
      }
      if (pending.length === 0) return { batchId: null, cached, submitted: 0 };
      await checkBudget(r.agencyId, r.plan, request.feature);
      let batchId: string;
      try {
        ({ batchId } = await callProvider(() =>
          (options.provider as AiProvider).submitBatch(
            pending.map((p) => ({
              customId: p.item.customId,
              request: {
                model: r.model,
                system: r.prompt.system,
                user: userText(p.item.input),
                maxTokens: p.maxTokens,
              },
            })),
          ),
        ));
      } catch (err) {
        throw providerFailure(err);
      }
      if (r.agencyId) {
        await record({
          agencyId: r.agencyId,
          feature: request.feature,
          kind: 'BATCH',
          tier: r.tier,
          model: r.model,
          promptId: r.prompt.id,
          promptVersion: r.prompt.version,
          inputHash: sha256(stableJson(pending.map((p) => p.inputHash))),
          status: 'PENDING',
          errorCode: null,
          usage: ZERO_USAGE,
          costMicroUsd: 0,
          latencyMs: 0,
          itemCount: pending.length,
          providerBatchId: batchId,
          requestId: ctx.requestId ?? null,
        });
      }
      return { batchId, cached, submitted: pending.length };
    },

    async collectBatch(ctx, { batchId, request }) {
      const r = await resolve(ctx, request);
      const prepared = new Map(batchItems(r, request).map((p) => [p.item.customId, p]));
      let raw: Awaited<ReturnType<AiProvider['batchResults']>>;
      try {
        raw = await callProvider(() => (options.provider as AiProvider).batchResults(batchId));
      } catch (err) {
        throw providerFailure(err);
      }
      if (raw === null) return { status: 'IN_PROGRESS' };
      let usage: AiUsage = ZERO_USAGE;
      let failed = 0;
      const results: AiBatchItemResult[] = [];
      for (const entry of raw) {
        const p = prepared.get(entry.customId);
        if (!p) continue; // not one of the caller's items: ignore
        if (entry.type !== 'succeeded') {
          failed++;
          results.push({ customId: entry.customId, ok: false, error: entry.type === 'expired' ? 'EXPIRED' : 'FAILED' });
          continue;
        }
        usage = addUsage(usage, entry.response.usage);
        if (entry.response.refused) {
          failed++;
          results.push({ customId: entry.customId, ok: false, error: 'REFUSED' });
          continue;
        }
        results.push({ customId: entry.customId, ok: true, text: entry.response.text, cached: false });
        if (options.cache && options.cacheTtlSeconds > 0 && p.item.cacheKey !== false) {
          await options.cache
            .set(p.key, { v: entry.response.text }, { ttlSeconds: options.cacheTtlSeconds })
            .catch((err: unknown) => log.warn({ err }, 'ai cache write failed'));
        }
      }
      let cost = priceOf(r.model, usage, options.batchDiscountBp);
      if (r.agencyId && options.store) {
        const first = await options.store.settleBatch({
          agencyId: r.agencyId,
          providerBatchId: batchId,
          usage,
          costMicroUsd: cost,
          failedItems: failed,
          month: usageMonth(time.now()),
        });
        if (!first) cost = 0;
      }
      return { status: 'ENDED', results, costMicroUsd: cost };
    },

    async embed(ctx, request) {
      assertFeature(request.feature);
      const agencyId = agencyOf(ctx);
      const provider = options.embeddings;
      if (!provider) throw unavailable('EMBEDDINGS_DISABLED', false);
      if (request.texts.length === 0 || request.texts.length > MAX_EMBED_TEXTS) {
        throw new AppError('VALIDATION_FAILED', { reason: 'AI_EMBED_SIZE', max: MAX_EMBED_TEXTS });
      }
      for (const t of request.texts) userText(t);
      await checkBudget(agencyId, ctx.tenant?.plan, request.feature);
      const started = time.nowMs();
      let out: { vectors: number[][]; inputTokens: number };
      try {
        out = await callProvider((signal) => provider.embed(request.texts, { signal }));
      } catch (err) {
        throw providerFailure(err);
      }
      if (agencyId) {
        const usage = { ...ZERO_USAGE, inputTokens: out.inputTokens };
        await record({
          agencyId,
          feature: request.feature,
          kind: 'EMBED',
          tier: null,
          model: provider.model,
          promptId: null,
          promptVersion: null,
          inputHash: sha256(stableJson(request.texts)),
          status: 'SUCCEEDED',
          errorCode: null,
          usage,
          costMicroUsd: priceOf(provider.model, usage),
          latencyMs: time.nowMs() - started,
          itemCount: request.texts.length,
          providerBatchId: null,
          requestId: ctx.requestId ?? null,
        });
      }
      return { vectors: out.vectors, model: provider.model, dimensions: provider.dimensions };
    },
  };
}
