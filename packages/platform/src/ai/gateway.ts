import { createHash } from 'node:crypto';
import { metrics } from '@opentelemetry/api';
import { z } from 'zod';
import { type CacheKey, cacheKey } from '../cache/key';
import { type Clock, clock as processClock } from '../clock';
import { AppError, type ErrorCode, isAppError } from '../errors';
import { newId } from '../ids';
import type { Logger } from '../logger';
import { CircuitBreaker } from '../search/breaker';
import { type AiBudget, costMicroUsd, type ModelPrice } from './config';
import { checkImages, IMAGE_TOKENS_ESTIMATE } from './images';
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
import { AI_FEATURE_RE, type AiBatchClaim, type AiJobKind, type AiJobRecord, type AiStore, usageMonth } from './store';
import type {
  AiBatchCollect,
  AiBatchHandle,
  AiBatchItemResult,
  AiBatchRef,
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
 * 1. resolves the prompt file and the tier's model (env), and who pays: a tenant (metered) or an explicit
 *    `ctx.unmetered` reason (platform scripts) — anything else is refused,
 * 2. answers from the response cache when the same request (input hash) was answered before — no provider call,
 *    no cost, and it works while the provider is down,
 * 3. reserves the call's worst-case cost against the agency's month atomically, refusing with `AI_BUDGET_EXCEEDED`
 *    when that would pass the hard cap — before any provider call, also for concurrent calls and batches,
 * 4. refuses with `AI_UNAVAILABLE` while the circuit breaker is open (provider outage) — fast, so features degrade
 *    instead of waiting,
 * 5. calls the provider with a timeout, validates structured output (one repair retry), refuses truncated answers,
 *    and settles the real cost (`ai_jobs`, `ai_usage_monthly`), releasing the reservation.
 *
 * Every failure is an `AppError` with an `AI_*` code; `aiOrFallback` turns them into the feature's fallback.
 *
 * Cache and PII: answers are cached per agency for `AI_CACHE_TTL_SECONDS`. A feature whose input carries client PII
 * passes `cacheKey: false` (or keeps the TTL short); erasing an agency's data also clears its `ai` cache entries.
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
  /** Whole call, the provider's own retries included. */
  timeoutMs: number;
  breaker: { failures: number; openMs: number };
  logger: Logger;
  clock?: Clock;
  /**
   * A usage record that could not be written (the provider has answered and billed): retried through the queue (the
   * `ai.recordUsage` job, wired by `@inmolink/core`). Without it the failure is only logged and counted.
   */
  onRecordFailure?: (input: { job: AiJobRecord; releaseMicroUsd: number }) => Promise<unknown>;
}

export interface AiGateway {
  generate(ctx: AiCtx, request: AiGenerateRequest): Promise<AiTextResult>;
  structured<S extends z.ZodType>(ctx: AiCtx, request: AiStructuredRequest<S>): Promise<AiStructuredResult<z.infer<S>>>;
  /** Submits bulk work to the provider's discounted batch API; items already cached are answered at once. */
  batch(ctx: AiCtx, request: AiBatchRequest): Promise<AiBatchHandle>;
  /**
   * Polls a batch of the caller's agency (verified against its job row and items); once ended, returns every item's
   * result (caching the successes) and settles its cost once.
   */
  collectBatch(ctx: AiCtx, input: AiBatchRef & { request: AiBatchRequest }): Promise<AiBatchCollect>;
  embed(ctx: AiCtx, request: AiEmbedRequest): Promise<AiEmbedResult>;
  /** The breaker's state (health checks, tests). */
  readonly breakerState: 'closed' | 'open' | 'half-open';
}

const CUSTOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** S13-F14: an idempotency key's tag in front of each provider custom id (`k` + 11 hex + `_`). */
const KEY_TAG_LENGTH = 13;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/**
 * S13-F14: how long after a claim its submit may still be in flight beyond the call timeout (clock skew between us and
 * the provider included); a claimed batch without an id is looked up only after this.
 */
const RECONCILE_SLACK_MS = 5 * 60_000;

/** The tag of an agency's idempotency key: provider custom ids start with it, so a lost batch can be found again. */
export function batchKeyTag(agencyId: string, idempotencyKey: string): string {
  return `k${sha256(`${agencyId}:${idempotencyKey}`).slice(0, KEY_TAG_LENGTH - 2)}_`;
}

/**
 * S13-F14: a provider error after which the batch was certainly not accepted (refused before or by the provider) —
 * its claim is dropped. Timeouts, 5xx and network errors are ambiguous: the claim stays and is reconciled.
 */
const notSubmitted = (err: unknown) =>
  isAppError(err) || (err instanceof AiProviderError && (err.kind === 'rejected' || err.kind === 'rate_limited'));
const UNMETERED_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_BATCH_ITEMS = 10_000;
const MAX_EMBED_TEXTS = 256;
const MAX_INPUT_CHARS = 400_000;
/** Characters per token for the budget estimate (conservative for European languages). */
const CHARS_PER_TOKEN = 3;
const MISS = Symbol('ai-cache-miss');

const recordFailures = metrics.getMeter('@inmolink/platform').createCounter('inmolink.ai.usage_record_failures', {
  description: 'AI usage records that could not be written after the provider answered (retried through the queue)',
});

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

/** The schema as JSON Schema (sent to the provider and fingerprinted for the cache key). Refuses a schema it cannot convert. */
function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  let converted: Record<string, unknown>;
  try {
    converted = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'throw' }) as Record<string, unknown>;
  } catch {
    throw new TypeError('ai.structured: the schema must be representable as JSON Schema (no transforms, functions…)');
  }
  const { $schema: _dialect, ...rest } = converted;
  return rest;
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
  /** Null: an unmetered platform call. */
  agencyId: string | null;
  plan: string | null | undefined;
}

interface Reservation {
  budget: AiBudgetState;
  reservedMicroUsd: number;
  month: string;
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
    if (!AI_FEATURE_RE.test(feature)) throw new TypeError(`invalid AI feature "${String(feature).slice(0, 40)}"`);
  }

  /** Who pays: the tenant (metered), or nobody for an explicitly named platform call. */
  function payerOf(ctx: AiCtx): string | null {
    const agencyId = ctx.tenant?.agencyId ?? null;
    if (agencyId !== null) {
      if (ctx.unmetered !== undefined) throw new TypeError('AI: a tenant call is always metered (drop ctx.unmetered)');
      if (!options.store) throw unavailable('NO_USAGE_STORE', false);
      return agencyId;
    }
    if (typeof ctx.unmetered !== 'string' || !UNMETERED_RE.test(ctx.unmetered)) {
      throw new TypeError('AI: a call without a tenant needs ctx.unmetered = "<reason>" (platform scripts only)');
    }
    return null;
  }

  async function resolve(ctx: AiCtx, call: Omit<AiCallBase, 'input' | 'cacheKey'>): Promise<Resolved> {
    assertFeature(call.feature);
    const agencyId = payerOf(ctx);
    if (!options.provider || !options.models) throw unavailable('DISABLED', false);
    const prompt = await options.prompts.load(call.prompt);
    const tier = call.tier ?? prompt.tier;
    return { prompt, tier, model: options.models[tier], agencyId, plan: ctx.tenant?.plan };
  }

  function hashOf(
    r: Resolved,
    kind: string,
    input: unknown,
    extra: { schema?: unknown; key?: string; maxTokens: number; images?: readonly string[] },
  ) {
    return sha256(
      stableJson({
        kind,
        model: r.model,
        prompt: `${r.prompt.id}/v${r.prompt.version}`,
        promptHash: r.prompt.hash,
        input,
        images: extra.images && extra.images.length > 0 ? extra.images : undefined,
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

  function priceOf(model: string, usage: AiUsage, discountBp = 0): number {
    return costMicroUsd(options.pricing[model], usage, discountBp);
  }

  /** Worst-case cost of one request (every attempt at its full `maxTokens`; a repair resends the rejected answer). */
  function estimateOf(
    model: string,
    chars: number,
    images: number,
    maxTokens: number,
    attempts: number,
    discountBp = 0,
  ) {
    const input = Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS_ESTIMATE;
    const usage = {
      inputTokens: attempts * input + (attempts - 1) * maxTokens,
      outputTokens: attempts * maxTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    return priceOf(model, usage, discountBp);
  }

  /** Reserves the estimate against the month; throws AI_BUDGET_EXCEEDED past the hard cap — before any provider call. */
  async function reserve(r: Resolved, feature: string, estimateMicroUsd: number): Promise<Reservation> {
    const month = usageMonth(time.now());
    if (r.agencyId === null || !options.store) return { budget: 'UNMETERED', reservedMicroUsd: 0, month };
    const budget = options.budgetFor(r.plan);
    // At least 1 micro-USD, so a month at its hard cap refuses even a call it cannot price.
    estimateMicroUsd = Math.max(1, Math.ceil(estimateMicroUsd));
    let res: Awaited<ReturnType<AiStore['reserve']>>;
    try {
      res = await options.store.reserve({
        agencyId: r.agencyId,
        month,
        estimateMicroUsd,
        hardMicroUsd: budget.hardMicroUsd,
      });
    } catch (err) {
      log.warn({ err, feature }, 'ai budget reservation failed');
      throw unavailable('USAGE_STORE');
    }
    if (!res.ok) {
      if (res.reason === 'UNKNOWN') throw unavailable('BUDGET_UNKNOWN');
      log.warn({ agencyId: r.agencyId, feature, month }, 'ai hard cap reached');
      throw new AppError('AI_BUDGET_EXCEEDED', { feature, month });
    }
    const soft = res.spentMicroUsd + estimateMicroUsd >= budget.softMicroUsd;
    if (soft) log.info({ agencyId: r.agencyId, feature, month }, 'ai soft cap passed');
    return { budget: soft ? 'SOFT_CAP' : 'OK', reservedMicroUsd: Math.ceil(estimateMicroUsd), month };
  }

  async function release(agencyId: string | null, reservation: Reservation): Promise<void> {
    if (agencyId === null || !options.store || reservation.reservedMicroUsd <= 0) return;
    await options.store
      .release(agencyId, reservation.month, reservation.reservedMicroUsd)
      .catch((err: unknown) => log.warn({ err }, 'ai budget release failed'));
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
      // A rejected request (4xx) or a rate limit says nothing about the provider's health.
      if (mapped.kind === 'unavailable') permit.failure();
      else permit.success(time.nowMs() - started);
      throw mapped;
    }
  }

  /** Settles a job (cost into the month, reservation released). A failed write is counted and retried via the queue. */
  async function record(job: Omit<AiJobRecord, 'id'>, reservedMicroUsd: number): Promise<string> {
    const full: AiJobRecord = { ...job, id: newId() };
    try {
      await options.store?.settle(full, reservedMicroUsd);
    } catch (err) {
      recordFailures.add(1, { feature: job.feature });
      log.error({ err, feature: job.feature, agencyId: job.agencyId }, 'ai usage record failed');
      await options
        // For a PENDING batch job this is the reservation its row keeps until the batch is collected.
        .onRecordFailure?.({ job: full, releaseMicroUsd: reservedMicroUsd })
        .catch((e: unknown) => log.error({ err: e, feature: job.feature }, 'ai usage record retry enqueue failed'));
    }
    return full.id;
  }

  function providerFailure(err: unknown): AppError {
    if (isAppError(err)) return err;
    if (err instanceof AiProviderError && err.kind === 'rejected') {
      return new AppError('AI_REFUSED', { reason: 'REJECTED', status: err.status ?? null });
    }
    if (err instanceof AiProviderError && err.kind === 'rate_limited') return unavailable('RATE_LIMITED');
    return unavailable('PROVIDER_ERROR');
  }

  /**
   * The shared path of `generate` and `structured`: cache → reserve → provider (with `accept` deciding whether to
   * take the answer or ask once more) → settle.
   */
  async function run<T>(
    ctx: AiCtx,
    request: AiCallBase,
    kind: AiJobKind,
    extra: { schema?: Record<string, unknown> },
    accept: (response: ProviderResponse) => { ok: true; value: T } | { ok: false; repair: string },
  ): Promise<{ value: T; meta: AiResultMeta }> {
    const r = await resolve(ctx, request);
    const maxTokens = request.maxTokens ?? r.prompt.maxTokens;
    const user = userText(request.input);
    const images = checkImages(request.images);
    const inputHash = hashOf(r, kind, request.input, {
      schema: extra.schema,
      key: request.cacheKey === false ? undefined : request.cacheKey,
      maxTokens,
      images,
    });
    const attempts = kind === 'STRUCTURED' ? 2 : 1;

    let fresh: AiResultMeta | undefined;
    const load = async (): Promise<{ v: T }> => {
      const estimate = estimateOf(r.model, r.prompt.system.length + user.length, images.length, maxTokens, attempts);
      const reservation = await reserve(r, request.feature, estimate);
      const base: ProviderRequest = {
        model: r.model,
        system: r.prompt.system,
        user,
        maxTokens,
        ...(request.images && request.images.length > 0 ? { images: request.images } : {}),
        ...(extra.schema ? { jsonSchema: extra.schema } : {}),
      };
      let usage: AiUsage = ZERO_USAGE;
      let reached = false;
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
        month: reservation.month,
      };
      const fail = async (code: ErrorCode, error: AppError): Promise<never> => {
        if (r.agencyId) {
          if (!reached) await release(r.agencyId, reservation);
          else {
            const cost = priceOf(r.model, usage);
            await record(
              {
                ...job,
                status: 'FAILED',
                errorCode: code,
                usage,
                costMicroUsd: cost,
                latencyMs: time.nowMs() - started,
              },
              reservation.reservedMicroUsd,
            );
          }
        }
        throw error;
      };

      let req = base;
      for (let attempt = 1; ; attempt++) {
        let response: ProviderResponse;
        try {
          response = await callProvider((signal) => (options.provider as AiProvider).complete(req, { signal }));
        } catch (err) {
          // Breaker open: the provider was not called on this attempt.
          const e = providerFailure(err);
          if (!isAppError(err) || err.code !== 'AI_UNAVAILABLE') reached = true;
          return fail(e.code, e);
        }
        reached = true;
        usage = addUsage(usage, response.usage);
        if (response.refused) return fail('AI_REFUSED', new AppError('AI_REFUSED', { reason: 'REFUSAL' }));
        // Cut at maxTokens: never a usable (or cacheable) answer, and a repair would be cut again.
        if (response.truncated) {
          return fail(
            'AI_OUTPUT_INVALID',
            new AppError('AI_OUTPUT_INVALID', { feature: request.feature, reason: 'TRUNCATED' }),
          );
        }
        const verdict = accept(response);
        if (verdict.ok) {
          const cost = priceOf(r.model, usage);
          const jobId = r.agencyId
            ? await record(
                {
                  ...job,
                  status: 'SUCCEEDED',
                  errorCode: null,
                  usage,
                  costMicroUsd: cost,
                  latencyMs: time.nowMs() - started,
                },
                reservation.reservedMicroUsd,
              )
            : null;
          fresh = {
            model: r.model,
            tier: r.tier,
            cached: false,
            inputHash,
            jobId,
            usage,
            costMicroUsd: cost,
            budget: reservation.budget,
          };
          return { v: verdict.value };
        }
        if (attempt >= attempts) {
          return fail(
            'AI_OUTPUT_INVALID',
            new AppError('AI_OUTPUT_INVALID', { feature: request.feature, reason: 'SCHEMA' }),
          );
        }
        // The rejected answer goes back as the assistant's turn, then a short correction.
        req = { ...base, repair: { previous: response.text, correction: verdict.repair } };
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
    if (request.idempotencyKey !== undefined) {
      const tooLong = request.items.some((i) => i.customId.length > 64 - KEY_TAG_LENGTH);
      if (!IDEMPOTENCY_KEY_RE.test(request.idempotencyKey) || tooLong) {
        throw new AppError('VALIDATION_FAILED', { reason: 'AI_BATCH_IDEMPOTENCY_KEY' });
      }
    }
    const maxTokens = request.maxTokens ?? r.prompt.maxTokens;
    const images = checkImages(request.images);
    const seen = new Set<string>();
    const items = request.items.map((item) => {
      if (!CUSTOM_ID_RE.test(item.customId) || seen.has(item.customId)) {
        throw new AppError('VALIDATION_FAILED', { reason: 'AI_BATCH_CUSTOM_ID' });
      }
      seen.add(item.customId);
      const user = userText(item.input);
      // Same hash as `generate` for the same input, so batch and interactive calls share cached answers.
      const inputHash = hashOf(r, 'GENERATE', item.input, {
        key: item.cacheKey === false ? undefined : item.cacheKey,
        maxTokens,
        images,
      });
      return { item, user, inputHash, maxTokens, key: keyOf(r.agencyId, request.feature, inputHash) };
    });
    // The whole batch's fingerprint (every item, cached or not): stored at submit, checked at collect.
    const batchHash = sha256(stableJson(items.map((p) => [p.item.customId, p.inputHash])));
    return { items, batchHash, images: images.length };
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
      const jsonSchema = jsonSchemaOf(schema);
      const { value, meta } = await run<z.infer<typeof schema>>(
        ctx,
        request,
        'STRUCTURED',
        { schema: jsonSchema },
        (response) => {
          let parsed: unknown;
          try {
            parsed = parseJsonAnswer(response.text);
          } catch {
            return { ok: false, repair: 'That was not valid JSON. Answer again with the JSON only.' };
          }
          const result = schema.safeParse(parsed);
          if (result.success) return { ok: true, value: result.data };
          return {
            ok: false,
            repair: `That JSON did not match the required schema (${issuesSummary(result.error)}). Answer again with the corrected JSON only.`,
          };
        },
      );
      return { data: value, meta };
    },

    async batch(ctx, request) {
      const r = await resolve(ctx, request);
      const { items, batchHash, images } = batchItems(r, request);
      const cached: AiBatchItemResult[] = [];
      const pending: typeof items = [];
      for (const p of items) {
        const hit = p.item.cacheKey === false ? undefined : await peek(p.key);
        if (hit !== undefined) cached.push({ customId: p.item.customId, ok: true, text: hit, cached: true });
        else pending.push(p);
      }
      // S13-F14: under an idempotency key (metered worker calls), a key claimed before is never submitted again.
      const key =
        request.idempotencyKey !== undefined && r.agencyId && options.store && options.store.batches !== false
          ? request.idempotencyKey
          : null;
      const store = options.store as AiStore;
      const fromClaim = (claim: AiBatchClaim): AiBatchHandle => {
        if (claim.inputHash !== batchHash) {
          throw new AppError('VALIDATION_FAILED', { reason: 'AI_BATCH_IDEMPOTENCY_KEY_REUSED' });
        }
        return claim.providerBatchId
          ? { batchId: claim.providerBatchId, cached, submitted: claim.itemCount }
          : { batchId: null, cached, submitted: claim.itemCount, unconfirmed: true };
      };
      if (key) {
        // a retry: the batch claimed before (cached answers are returned again; applying them is idempotent)
        const claim = await store.batchClaim(r.agencyId as string, key);
        if (claim) return fromClaim(claim);
      }
      if (pending.length === 0) return { batchId: null, cached, submitted: 0 };
      if (r.agencyId && options.store?.batches === false) {
        throw new Error('AI batches run in workers (createPgAiStore), not on the request path');
      }
      let estimate = 0;
      for (const p of pending) {
        estimate += estimateOf(
          r.model,
          r.prompt.system.length + p.user.length,
          images,
          p.maxTokens,
          1,
          options.batchDiscountBp,
        );
      }
      const reservation = await reserve(r, request.feature, estimate);
      const job = {
        agencyId: r.agencyId as string,
        feature: request.feature,
        kind: 'BATCH' as const,
        tier: r.tier,
        model: r.model,
        promptId: r.prompt.id,
        promptVersion: r.prompt.version,
        inputHash: batchHash,
        status: 'PENDING' as const,
        errorCode: null,
        usage: ZERO_USAGE,
        costMicroUsd: 0,
        latencyMs: 0,
        itemCount: pending.length,
        requestId: ctx.requestId ?? null,
        month: reservation.month,
      };
      const claimId = newId();
      if (key) {
        const claimed = await store
          .claimBatch(
            { ...job, id: claimId, providerBatchId: null, idempotencyKey: key, createdAt: time.now() },
            reservation.reservedMicroUsd,
          )
          .catch(async (err: unknown) => {
            await release(r.agencyId, reservation);
            throw err;
          });
        if (!claimed.claimed) {
          // a concurrent run claimed it between the read and the insert
          await release(r.agencyId, reservation);
          return fromClaim(claimed.existing);
        }
      }
      const tag = key ? batchKeyTag(r.agencyId as string, key) : '';
      let batchId: string;
      try {
        ({ batchId } = await callProvider(() =>
          (options.provider as AiProvider).submitBatch(
            pending.map((p) => ({
              customId: `${tag}${p.item.customId}`,
              request: {
                model: r.model,
                system: r.prompt.system,
                user: p.user,
                maxTokens: p.maxTokens,
                ...(request.images && request.images.length > 0 ? { images: request.images } : {}),
              },
            })),
          ),
        ));
      } catch (err) {
        if (!key) await release(r.agencyId, reservation);
        else if (notSubmitted(err)) {
          // certainly not accepted: the claim goes (with its reservation) and a retry submits afresh
          await store
            .dropBatchClaim(r.agencyId as string, claimId)
            .catch((e: unknown) => log.warn({ err: e }, 'ai batch claim drop failed'));
        }
        // else: ambiguous (timeout, 5xx) — the claim stays; a retry gets `unconfirmed` and `collectBatch` reconciles
        throw providerFailure(err);
      }
      if (key) {
        // A crash before this line leaves the claim without an id: `collectBatch` finds the batch by the key's tag.
        await store.attachBatch(r.agencyId as string, claimId, batchId);
      } else if (r.agencyId) {
        // PENDING: the reservation stays on the job row until the batch is collected.
        await record({ ...job, providerBatchId: batchId }, reservation.reservedMicroUsd);
      }
      return { batchId, cached, submitted: pending.length };
    },

    /**
     * S13-F14: a claim without a provider batch id (the submit crashed or failed ambiguously). After the window in
     * which that submit could still be in flight, the provider is asked for a batch carrying the key's tag: found →
     * its id is saved and it is collected; a candidate still running → `IN_PROGRESS`; none → the claim and its
     * reservation are dropped (`NOT_SUBMITTED`: the caller submits again under the same key).
     */
    async collectBatch(ctx, { request, ...ref }) {
      const r = await resolve(ctx, request);
      const { items, batchHash } = batchItems(r, request);
      let batchId = ref.batchId ?? null;
      let tag = '';
      if (r.agencyId && options.store) {
        const store = options.store;
        if (ref.idempotencyKey !== undefined) {
          // Only this agency's claim, with the very items it submitted.
          const claim = await store.batchClaim(r.agencyId, ref.idempotencyKey);
          if (!claim || claim.inputHash !== batchHash || (batchId && claim.providerBatchId !== batchId)) {
            throw new AppError('NOT_FOUND', { reason: 'AI_BATCH_UNKNOWN' });
          }
          tag = batchKeyTag(r.agencyId, ref.idempotencyKey);
          batchId = claim.providerBatchId;
          if (!batchId) {
            const windowEnd = claim.createdAt.getTime() + options.timeoutMs + RECONCILE_SLACK_MS;
            if (time.nowMs() < windowEnd) return { status: 'IN_PROGRESS' };
            const prefix = tag;
            let found: Awaited<ReturnType<AiProvider['findBatch']>>;
            try {
              found = await callProvider(() =>
                (options.provider as AiProvider).findBatch({
                  customIdPrefix: prefix,
                  createdAfter: new Date(claim.createdAt.getTime() - RECONCILE_SLACK_MS),
                  createdBefore: new Date(windowEnd),
                }),
              );
            } catch (err) {
              throw providerFailure(err);
            }
            if (found.status === 'UNKNOWN') return { status: 'IN_PROGRESS' };
            if (found.status === 'NONE') {
              await store.dropBatchClaim(r.agencyId, claim.id);
              return { status: 'NOT_SUBMITTED' };
            }
            await store.attachBatch(r.agencyId, claim.id, found.batchId);
            batchId = found.batchId;
          }
        } else {
          if (!batchId) throw new AppError('VALIDATION_FAILED', { reason: 'AI_BATCH_REF' });
          // Only this agency's batch, with the very items it submitted: nothing else is returned or cached.
          const owned = await store.batchJob(r.agencyId, batchId);
          if (!owned || owned.inputHash !== batchHash) {
            throw new AppError('NOT_FOUND', { reason: 'AI_BATCH_UNKNOWN' });
          }
          if (owned.idempotencyKey) tag = batchKeyTag(r.agencyId, owned.idempotencyKey);
        }
      }
      if (!batchId) throw new AppError('VALIDATION_FAILED', { reason: 'AI_BATCH_REF' });
      const providerBatchId = batchId;
      const prepared = new Map(items.map((p) => [p.item.customId, p]));
      let raw: Awaited<ReturnType<AiProvider['batchResults']>>;
      try {
        raw = await callProvider(() => (options.provider as AiProvider).batchResults(providerBatchId));
      } catch (err) {
        throw providerFailure(err);
      }
      if (raw === null) return { status: 'IN_PROGRESS' };
      let usage: AiUsage = ZERO_USAGE;
      let failed = 0;
      const results: AiBatchItemResult[] = [];
      for (const entry of raw) {
        // a keyed batch's provider custom ids carry the key's tag (S13-F14)
        const customId = entry.customId.startsWith(tag) ? entry.customId.slice(tag.length) : '';
        const p = prepared.get(customId);
        if (!p) continue; // not one of the caller's items: ignore
        if (entry.type !== 'succeeded') {
          failed++;
          results.push({ customId, ok: false, error: entry.type === 'expired' ? 'EXPIRED' : 'FAILED' });
          continue;
        }
        usage = addUsage(usage, entry.response.usage);
        if (entry.response.refused || entry.response.truncated) {
          failed++;
          results.push({ customId, ok: false, error: entry.response.refused ? 'REFUSED' : 'TRUNCATED' });
          continue;
        }
        results.push({ customId, ok: true, text: entry.response.text, cached: false });
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
          providerBatchId,
          usage,
          costMicroUsd: cost,
          failedItems: failed,
        });
        if (!first) cost = 0;
      }
      return { status: 'ENDED', results, costMicroUsd: cost };
    },

    async embed(ctx, request) {
      assertFeature(request.feature);
      const agencyId = payerOf(ctx);
      const provider = options.embeddings;
      if (!provider) throw unavailable('EMBEDDINGS_DISABLED', false);
      if (request.texts.length === 0 || request.texts.length > MAX_EMBED_TEXTS) {
        throw new AppError('VALIDATION_FAILED', { reason: 'AI_EMBED_SIZE', max: MAX_EMBED_TEXTS });
      }
      let chars = 0;
      for (const t of request.texts) chars += userText(t).length;
      const r: Resolved = {
        prompt: undefined as unknown as Prompt,
        tier: 'FAST',
        model: provider.model,
        agencyId,
        plan: ctx.tenant?.plan,
      };
      const estimate = priceOf(provider.model, { ...ZERO_USAGE, inputTokens: Math.ceil(chars / CHARS_PER_TOKEN) });
      const reservation = await reserve(r, request.feature, estimate);
      const started = time.nowMs();
      let out: { vectors: number[][]; inputTokens: number };
      try {
        out = await callProvider((signal) => provider.embed(request.texts, { signal }));
      } catch (err) {
        await release(agencyId, reservation);
        throw providerFailure(err);
      }
      if (agencyId) {
        const usage = { ...ZERO_USAGE, inputTokens: out.inputTokens };
        await record(
          {
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
            month: reservation.month,
          },
          reservation.reservedMicroUsd,
        );
      }
      return { vectors: out.vectors, model: provider.model, dimensions: provider.dimensions };
    },
  };
}
