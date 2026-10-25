import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFakeClock } from '../clock';
import { ConfigError } from '../config';
import { createLogger } from '../logger';
import { costMicroUsd, loadAiSettings } from './config';
import { checkAnswer, EvalCase } from './eval';
import { type AiGatewayOptions, aiOrFallback, createAiGateway, stableJson } from './gateway';
import { ai, configureAi } from './index';
import { parsePrompt, staticPromptSource } from './prompts';
import { AiProviderError } from './provider';
import { FakeProvider, memoryAiCache, memoryAiStore } from './testing';
import type { AiCtx } from './types';

const log = createLogger({ service: 'ai-test', level: 'silent' });
const AGENCY = '0192f3a4-0000-7000-8000-000000000001';
const ctx: AiCtx = { tenant: { agencyId: AGENCY, plan: 'STARTER' }, requestId: 'req-1' };
const MONTH = '2026-10-01';

const PROMPT = parsePrompt(
  { id: 'listing-copy', version: 1 },
  '---\ntier: FAST\nmaxTokens: 500\nschema: Copy\n---\nYou write listing copy.',
);
const PROMPT_V2 = parsePrompt(
  { id: 'listing-copy', version: 2 },
  '---\ntier: SMART\nmaxTokens: 800\n---\nYou write better listing copy.',
);
// Prices are test data (USD per million tokens), never the provider's real ones.
const PRICING = {
  'fast-model': { input: 1, output: 5 },
  'smart-model': { input: 4, output: 20 },
};

function setup(overrides: Partial<AiGatewayOptions> & { spend?: number } = {}) {
  const provider = new FakeProvider(() => 'A bright villa.');
  const store = memoryAiStore(overrides.spend !== undefined ? { [`${AGENCY}:${MONTH}`]: overrides.spend } : {});
  const cache = memoryAiCache();
  const clock = createFakeClock('2026-10-15T10:00:00Z');
  const gateway = createAiGateway({
    provider,
    models: { FAST: 'fast-model', SMART: 'smart-model' },
    pricing: PRICING,
    batchDiscountBp: 5_000,
    prompts: staticPromptSource([PROMPT, PROMPT_V2]),
    cache,
    cacheTtlSeconds: 3_600,
    store,
    budgetFor: (plan) =>
      plan === 'PRO'
        ? { softMicroUsd: 500_000, hardMicroUsd: 1_000_000 }
        : { softMicroUsd: 50_000, hardMicroUsd: 100_000 },
    timeoutMs: 5_000,
    breaker: { failures: 3, openMs: 30_000 },
    logger: log,
    clock,
    ...overrides,
  });
  return { gateway, provider, store, cache, clock };
}

const call = { feature: 'listing-studio.describe', prompt: { id: 'listing-copy', version: 1 }, input: { beds: 3 } };

afterEach(() => configureAi(undefined));

describe('AI gateway — budgets', () => {
  it('[S12-01] hard cap reached → AI_BUDGET_EXCEEDED without calling the provider', async () => {
    const { gateway, provider, store } = setup({ spend: 100_000 });
    await expect(gateway.generate(ctx, call)).rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED' });
    await expect(gateway.structured(ctx, { ...call, schema: z.object({ title: z.string() }) })).rejects.toMatchObject({
      code: 'AI_BUDGET_EXCEEDED',
    });
    await expect(gateway.batch(ctx, { ...call, items: [{ customId: 'a', input: 1 }] })).rejects.toMatchObject({
      code: 'AI_BUDGET_EXCEEDED',
    });
    expect(provider.calls).toHaveLength(0);
    expect(provider.batches.size).toBe(0);
    expect(store.jobs).toHaveLength(0);
  });

  it('[S12-01] the hard cap follows the plan budget; past the soft cap calls are served and flagged', async () => {
    const pro = setup({ spend: 600_000 });
    const res = await pro.gateway.generate({ tenant: { agencyId: AGENCY, plan: 'PRO' } }, call);
    expect(res.meta.budget).toBe('SOFT_CAP');
    expect(pro.provider.calls).toHaveLength(1);
    // The same spend is over the STARTER hard cap.
    const starter = setup({ spend: 600_000 });
    await expect(starter.gateway.generate(ctx, call)).rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED' });
  });

  it('[S12-01] a call is recorded with its tokens and cost and counts against the month', async () => {
    const { gateway, store } = setup();
    const res = await gateway.generate(ctx, call);
    // FakeProvider: 1000 input + 200 output tokens at 1 / 5 USD per Mtok = 1000 + 1000 micro-USD.
    expect(res.meta).toMatchObject({ model: 'fast-model', tier: 'FAST', cached: false, costMicroUsd: 2_000 });
    expect(store.jobs).toEqual([
      expect.objectContaining({
        agencyId: AGENCY,
        feature: 'listing-studio.describe',
        kind: 'GENERATE',
        status: 'SUCCEEDED',
        model: 'fast-model',
        promptId: 'listing-copy',
        promptVersion: 1,
        costMicroUsd: 2_000,
        month: MONTH,
        requestId: 'req-1',
      }),
    ]);
    expect(res.meta.jobId).toBe(store.jobs[0]?.id);
    expect(await store.monthSpend(AGENCY, MONTH)).toBe(2_000);
  });

  it('[S12-01] a tenant call without a usage store is refused (never unmetered)', async () => {
    const { gateway, provider } = setup({ store: null });
    await expect(gateway.generate(ctx, call)).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      details: { reason: 'NO_USAGE_STORE' },
    });
    // Platform scripts (no tenant) are unmetered.
    expect((await gateway.generate({ tenant: null }, call)).meta.budget).toBe('UNMETERED');
    expect(provider.calls).toHaveLength(1);
  });
});

describe('AI gateway — tiers and prompts', () => {
  it('[S12-01] the model comes from the tier (env), the tier from the prompt file unless the call overrides it', async () => {
    const { gateway, provider } = setup();
    await gateway.generate(ctx, call);
    await gateway.generate(ctx, { ...call, prompt: { id: 'listing-copy', version: 2 } });
    await gateway.generate(ctx, { ...call, input: { beds: 4 }, tier: 'SMART' });
    expect(provider.calls.map((c) => c.model)).toEqual(['fast-model', 'smart-model', 'smart-model']);
    expect(provider.calls[0]).toMatchObject({ system: 'You write listing copy.', user: '{"beds":3}', maxTokens: 500 });
  });

  it('[S12-01] prompt files need a front matter with tier and maxTokens', () => {
    expect(() => parsePrompt({ id: 'x', version: 1 }, 'no front matter')).toThrow(/front matter/);
    expect(() => parsePrompt({ id: 'x', version: 1 }, '---\ntier: HUGE\nmaxTokens: 5\n---\nbody')).toThrow(/tier/);
    expect(() => parsePrompt({ id: 'x', version: 1 }, '---\ntier: FAST\n---\nbody')).toThrow(/maxTokens/);
  });

  it('[S12-01] AI switched off (no provider) or not configured fails fast with AI_UNAVAILABLE', async () => {
    const { gateway } = setup({ provider: null });
    await expect(gateway.generate(ctx, call)).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      details: { reason: 'DISABLED' },
    });
    await expect(ai.generate(ctx, call)).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      details: { reason: 'NOT_CONFIGURED' },
    });
  });
});

describe('AI gateway — response cache', () => {
  it('[S12-01] identical request served from cache (no provider call)', async () => {
    const { gateway, provider, store } = setup();
    const first = await gateway.generate(ctx, call);
    // Same input with its keys in another order: same input hash.
    const second = await gateway.generate(ctx, { ...call, input: { beds: 3 } });
    expect(second.text).toBe(first.text);
    expect(second.meta).toMatchObject({ cached: true, costMicroUsd: 0, jobId: null, inputHash: first.meta.inputHash });
    expect(provider.calls).toHaveLength(1);
    expect(store.jobs).toHaveLength(1);
  });

  it('[S12-01] another input, prompt version or cache key is a different request', async () => {
    const { gateway, provider } = setup();
    await gateway.generate(ctx, call);
    await gateway.generate(ctx, { ...call, input: { beds: 4 } });
    await gateway.generate(ctx, { ...call, prompt: { id: 'listing-copy', version: 2 } });
    await gateway.generate(ctx, { ...call, cacheKey: 'facts-v2' });
    await gateway.generate(ctx, { ...call, cacheKey: false });
    expect(provider.calls).toHaveLength(5);
  });

  it('[S12-01] cached answers are scoped per agency', async () => {
    const { gateway, provider } = setup();
    await gateway.generate(ctx, call);
    await gateway.generate({ tenant: { agencyId: '0192f3a4-0000-7000-8000-000000000002' } }, call);
    expect(provider.calls).toHaveLength(2);
  });

  it('[S12-01] a structured answer is cached after it validated', async () => {
    const { gateway, provider } = setup();
    provider.respondWith(() => '{"title":"Villa"}');
    const schema = z.object({ title: z.string() });
    await gateway.structured(ctx, { ...call, schema });
    const again = await gateway.structured(ctx, { ...call, schema });
    expect(again).toMatchObject({ data: { title: 'Villa' }, meta: { cached: true } });
    expect(provider.calls).toHaveLength(1);
  });
});

describe('AI gateway — structured output', () => {
  const schema = z.object({ title: z.string().max(60), bullets: z.array(z.string()).min(1) });

  it('[S12-01] valid JSON is parsed and validated (a code fence is tolerated); the schema is sent to the provider', async () => {
    const { gateway, provider } = setup();
    provider.enqueue('```json\n{"title":"Sea views","bullets":["Pool"]}\n```');
    const res = await gateway.structured(ctx, { ...call, schema });
    expect(res.data).toEqual({ title: 'Sea views', bullets: ['Pool'] });
    expect(provider.calls[0]?.jsonSchema).toMatchObject({ type: 'object', required: ['title', 'bullets'] });
    expect(provider.calls[0]?.jsonSchema).not.toHaveProperty('$schema');
  });

  it('[S12-01] invalid output gets one repair retry', async () => {
    const { gateway, provider, store } = setup();
    provider.enqueue('{"title":"x"}', '{"title":"Sea views","bullets":["Pool"]}');
    const res = await gateway.structured(ctx, { ...call, schema });
    expect(res.data.bullets).toEqual(['Pool']);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.user).toMatch(/did not match the required schema/);
    // One job, both attempts' tokens.
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]).toMatchObject({ kind: 'STRUCTURED', status: 'SUCCEEDED', usage: { inputTokens: 2_000 } });
  });

  it('[S12-01] invalid twice → AI_OUTPUT_INVALID, recorded as a failed job that still costs', async () => {
    const { gateway, provider, store } = setup();
    provider.enqueue('not json', '{"title":1}');
    await expect(gateway.structured(ctx, { ...call, schema })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(provider.calls).toHaveLength(2);
    expect(store.jobs[0]).toMatchObject({ status: 'FAILED', errorCode: 'AI_OUTPUT_INVALID', costMicroUsd: 4_000 });
  });

  it('[S12-01] a safety refusal → AI_REFUSED', async () => {
    const { gateway, provider, store } = setup();
    provider.enqueue({ text: '', refused: true });
    await expect(gateway.generate(ctx, call)).rejects.toMatchObject({ code: 'AI_REFUSED' });
    expect(store.jobs[0]).toMatchObject({ status: 'FAILED', errorCode: 'AI_REFUSED' });
  });
});

describe('AI gateway — provider outage', () => {
  it('[S12-01] provider outage → features degrade gracefully (core flows unaffected)', async () => {
    const { gateway, provider, clock } = setup();
    provider.failWith();
    // A feature step wrapped in aiOrFallback: the core flow gets its fallback, not an error.
    const describe = () =>
      aiOrFallback(
        async () => (await gateway.generate(ctx, { ...call, cacheKey: false })).text,
        (code) => `owner text (${code})`,
      );
    for (let i = 0; i < 3; i++) expect(await describe()).toBe('owner text (AI_UNAVAILABLE)');
    expect(provider.calls).toHaveLength(3);
    // Breaker open (3 failures): calls fail fast without touching the provider.
    expect(gateway.breakerState).toBe('open');
    await expect(gateway.generate(ctx, { ...call, cacheKey: false })).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      details: { reason: 'CIRCUIT_OPEN' },
      retryable: true,
    });
    expect(await describe()).toBe('owner text (AI_UNAVAILABLE)');
    expect(provider.calls).toHaveLength(3);
    // After openMs one probe goes through; the provider is back, the breaker closes.
    provider.respondWith(() => 'Back online.');
    clock.advance(30_000);
    expect(await describe()).toBe('Back online.');
    expect(gateway.breakerState).toBe('closed');
  });

  it('[S12-01] cached answers are still served while the provider is down', async () => {
    const { gateway, provider } = setup();
    const first = await gateway.generate(ctx, call);
    provider.failWith();
    for (let i = 0; i < 3; i++)
      await gateway.generate(ctx, { ...call, input: { beds: 10 + i } }).catch(() => undefined);
    expect(gateway.breakerState).toBe('open');
    expect((await gateway.generate(ctx, call)).text).toBe(first.text);
  });

  it('[S12-01] a rejected request (4xx) does not open the breaker; failures are recorded', async () => {
    const { gateway, provider, store } = setup();
    provider.failWith(new AiProviderError('rejected', 'bad request', 400));
    for (let i = 0; i < 5; i++) {
      await expect(gateway.generate(ctx, { ...call, cacheKey: false })).rejects.toMatchObject({ code: 'AI_REFUSED' });
    }
    expect(gateway.breakerState).toBe('closed');
    expect(store.jobs.every((j) => j.status === 'FAILED')).toBe(true);
  });

  it('[S12-01] aiOrFallback lets other errors through', async () => {
    await expect(
      aiOrFallback(
        () => Promise.reject(new Error('bug')),
        () => 'x',
      ),
    ).rejects.toThrow('bug');
  });
});

describe('AI gateway — batch and embeddings', () => {
  const items = [
    { customId: 'es', input: { locale: 'es' } },
    { customId: 'de', input: { locale: 'de' } },
  ];

  it('[S12-01] ai.batch submits uncached items, settles the discounted cost once and caches the answers', async () => {
    const { gateway, provider, store } = setup();
    // One item is already cached from an interactive call.
    await gateway.generate(ctx, { ...call, input: { locale: 'es' } });
    const handle = await gateway.batch(ctx, { ...call, items });
    expect(handle.cached).toEqual([{ customId: 'es', ok: true, text: 'A bright villa.', cached: true }]);
    expect(handle.submitted).toBe(1);
    const batchId = handle.batchId as string;
    expect(store.jobs.at(-1)).toMatchObject({
      kind: 'BATCH',
      status: 'PENDING',
      providerBatchId: batchId,
      itemCount: 1,
    });

    expect(await gateway.collectBatch(ctx, { batchId, request: { ...call, items } })).toEqual({
      status: 'IN_PROGRESS',
    });
    provider.endBatch(batchId);
    const done = await gateway.collectBatch(ctx, { batchId, request: { ...call, items } });
    // Half price: (1000 + 1000) / 2.
    expect(done).toEqual({
      status: 'ENDED',
      results: [{ customId: 'de', ok: true, text: 'A bright villa.', cached: false }],
      costMicroUsd: 1_000,
    });
    expect(await store.monthSpend(AGENCY, MONTH)).toBe(3_000);
    // A second collect costs nothing twice.
    expect(await gateway.collectBatch(ctx, { batchId, request: { ...call, items } })).toMatchObject({
      costMicroUsd: 0,
    });
    // The batch answer now serves the interactive call from the cache.
    const calls = provider.calls.length;
    expect((await gateway.generate(ctx, { ...call, input: { locale: 'de' } })).meta.cached).toBe(true);
    expect(provider.calls).toHaveLength(calls);
  });

  it('[S12-01] ai.embed fails fast with AI_UNAVAILABLE while no embedding provider is configured', async () => {
    const { gateway } = setup();
    await expect(gateway.embed(ctx, { feature: 'search.semantic', texts: ['villa'] })).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      details: { reason: 'EMBEDDINGS_DISABLED' },
    });
  });

  it('[S12-01] ai.embed goes through budget, breaker and usage like the other calls', async () => {
    const embeddings = {
      name: 'fake',
      model: 'embed-model',
      dimensions: 2,
      embed: async (texts: readonly string[]) => ({ vectors: texts.map(() => [0.1, 0.2]), inputTokens: 10 }),
    };
    const { gateway, store } = setup({ embeddings, pricing: { ...PRICING, 'embed-model': { input: 1, output: 0 } } });
    const out = await gateway.embed(ctx, { feature: 'search.semantic', texts: ['villa', 'piso'] });
    expect(out).toEqual({
      vectors: [
        [0.1, 0.2],
        [0.1, 0.2],
      ],
      model: 'embed-model',
      dimensions: 2,
    });
    expect(store.jobs[0]).toMatchObject({ kind: 'EMBED', costMicroUsd: 10, itemCount: 2 });
    const capped = setup({ embeddings, spend: 100_000 });
    await expect(capped.gateway.embed(ctx, { feature: 'search.semantic', texts: ['x'] })).rejects.toMatchObject({
      code: 'AI_BUDGET_EXCEEDED',
    });
  });
});

describe('AI settings', () => {
  const env = {
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'test-key',
    AI_MODEL_FAST: 'fast-model',
    AI_MODEL_SMART: 'smart-model',
    AI_PRICING: JSON.stringify(PRICING),
  };

  it('[S12-01] model tiers, prices and plan budgets come from env', () => {
    const s = loadAiSettings({ ...env, AI_BUDGETS_BY_PLAN: '{"PRO":{"softUsdCents":100,"hardUsdCents":200}}' });
    expect(s.models).toEqual({ FAST: 'fast-model', SMART: 'smart-model' });
    expect(s.budgetsByPlan.PRO).toEqual({ softMicroUsd: 1_000_000, hardMicroUsd: 2_000_000 });
    expect(loadAiSettings({}).provider).toBe('none');
  });

  it('[S12-01] AI on without a tier model, its price or the key does not boot', () => {
    for (const drop of ['AI_MODEL_FAST', 'ANTHROPIC_API_KEY']) {
      const partial: Record<string, string> = { ...env };
      delete partial[drop];
      expect(() => loadAiSettings(partial)).toThrow(ConfigError);
    }
    expect(() => loadAiSettings({ ...env, AI_PRICING: '{"fast-model":{"input":1,"output":5}}' })).toThrow(ConfigError);
    expect(() => loadAiSettings({ ...env, AI_PRICING: 'nope' })).toThrow(ConfigError);
  });

  it('[S12-01] cost is computed in micro-USD and rounded up', () => {
    const usage = { inputTokens: 3, outputTokens: 1, cacheReadTokens: 10, cacheWriteTokens: 0 };
    expect(costMicroUsd({ input: 1, output: 5, cacheRead: 0.1 }, usage)).toBe(9);
    expect(costMicroUsd({ input: 1, output: 5 }, { ...usage, cacheReadTokens: 0 }, 5_000)).toBe(4);
    expect(costMicroUsd(undefined, usage)).toBe(0);
  });

  it('[S12-01] stable JSON ignores key order', () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});

describe('ai:eval checks', () => {
  const c = EvalCase.parse({
    name: 'placeholders',
    input: { strings: { a: 'Hi {name}', b: '<b>x</b>' } },
    checks: { json: true, sameKeys: 'strings', keepsTokens: { path: 'strings', pattern: '\\{[a-z]+\\}|</?b>' } },
  });

  it('[S12-01] a good answer passes; lost keys and placeholders fail', () => {
    expect(checkAnswer(c, '{"strings":{"a":"Hola {name}","b":"<b>y</b>"}}')).toEqual([]);
    expect(checkAnswer(c, '{"strings":{"a":"Hola"}}')).toEqual(
      expect.arrayContaining(['keys of "strings" differ', 'strings.a lost "{name}"']),
    );
    expect(checkAnswer(c, 'Sure! Here it is')).toEqual(['not JSON']);
  });
});
