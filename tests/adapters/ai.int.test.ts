import { closeDb, type Tx, withSystem, withTenant } from '@inmolink/db';
import { adminQuery, loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import {
  type AiGatewayOptions,
  aiOrFallback,
  createAiGateway,
  createPgAiStore,
  parsePrompt,
  recordAiFeedback,
  staticPromptSource,
  syncPromptVersions,
  usageMonth,
} from '@inmolink/platform/ai';
import { FakeProvider } from '@inmolink/platform/ai/testing';
import { Cache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The AI gateway against the real usage tables (Postgres) and response cache (redis-cache); a fake provider. */
const log = createLogger({ service: 'ai-int-test', level: 'silent' });
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const prefix = `t:ai:${run}`;
const agencyA = newId();
const agencyB = newId();
const month = usageMonth(new Date());
const PROMPT_ID = `itest-${run}`;
const prompt = parsePrompt({ id: PROMPT_ID, version: 1 }, '---\ntier: FAST\nmaxTokens: 300\n---\nYou write test copy.');
let redis: Redis;
let cache: Cache;

const store = createPgAiStore((reason, fn) => withSystem(reason, (tx: Tx) => fn(tx)));

function gateway(provider: FakeProvider, over: Partial<AiGatewayOptions> = {}) {
  return createAiGateway({
    provider,
    models: { FAST: 'fast-model', SMART: 'smart-model' },
    pricing: { 'fast-model': { input: 1, output: 5 }, 'smart-model': { input: 4, output: 20 } },
    batchDiscountBp: 5_000,
    prompts: staticPromptSource([prompt]),
    cache,
    cacheTtlSeconds: 600,
    store,
    budgetFor: () => ({ softMicroUsd: 50_000, hardMicroUsd: 100_000 }),
    timeoutMs: 5_000,
    breaker: { failures: 3, openMs: 30_000 },
    logger: log,
    ...over,
  });
}

const call = (input: unknown) => ({ feature: 'itest.describe', prompt: { id: PROMPT_ID, version: 1 }, input });
const ctxOf = (agencyId: string) => ({ tenant: { agencyId, plan: null }, requestId: `req-${run}` });

const jobsOf = (agencyId: string) =>
  withSystem('test.ai.jobs', async (tx: Tx) => {
    const { rows } = await tx.execute(
      sql`select kind, status, error_code, cost_micro_usd, input_tokens, output_tokens, provider_batch_id
            from ai_jobs where agency_id = ${agencyId} order by created_at, id`,
    );
    return rows;
  });

const spendOf = (agencyId: string) => store.monthSpend(agencyId, month);

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  redis = new Redis(process.env.REDIS_CACHE_URL as string, { protocol: 2, maxRetriesPerRequest: 1 });
  cache = new Cache({ redis, prefix, logger: log });
  for (const id of [agencyA, agencyB]) {
    await adminQuery(`insert into agencies (agency_id, kind, name) values ($1, 'AGENCY', $2)`, [id, `AI test ${run}`]);
  }
});

afterAll(async () => {
  await withSystem('test.ai.cleanup', (tx: Tx) =>
    tx.execute(sql`delete from prompt_versions where prompt_id like ${`itest-${run}%`}`),
  );
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
  await closeDb();
});

describe('AI gateway — usage store and cache (Postgres + redis)', () => {
  it('[S12-01] a call is recorded in ai_jobs and counted in ai_usage_monthly', async () => {
    const provider = new FakeProvider(() => 'Bright villa.');
    const res = await gateway(provider).generate(ctxOf(agencyA), call({ beds: 3 }));
    expect(res.meta).toMatchObject({ cached: false, costMicroUsd: 2_000 });
    expect(await jobsOf(agencyA)).toEqual([
      expect.objectContaining({ kind: 'GENERATE', status: 'SUCCEEDED', input_tokens: 1_000, output_tokens: 200 }),
    ]);
    expect(await spendOf(agencyA)).toBe(2_000);
    // Members read their agency's usage, never another's (RLS; the generated isolation suite covers the rest).
    const seen = await withTenant({ agencyId: agencyB }, (tx: Tx) =>
      tx.execute(sql`select count(*)::int as n from ai_jobs where agency_id = ${agencyA}`),
    );
    expect(seen.rows[0]?.n).toBe(0);
  });

  it('[S12-01] identical request served from cache (no provider call)', async () => {
    const provider = new FakeProvider(() => 'Sea views.');
    const g = gateway(provider);
    const first = await g.generate(ctxOf(agencyA), call({ beds: 4, pool: true }));
    // Another process instance, same redis-cache: still a hit.
    const second = await gateway(provider).generate(ctxOf(agencyA), call({ pool: true, beds: 4 }));
    expect(second).toMatchObject({ text: first.text, meta: { cached: true, costMicroUsd: 0 } });
    expect(provider.calls).toHaveLength(1);
    // Another agency asking the same thing is its own request (cache keys name the agency).
    await g.generate(ctxOf(agencyB), call({ beds: 4, pool: true }));
    expect(provider.calls).toHaveLength(2);
  });

  it('[S12-01] hard cap reached → AI_BUDGET_EXCEEDED without calling the provider', async () => {
    await withSystem('test.ai.spend', (tx: Tx) =>
      tx.execute(sql`
        insert into ai_usage_monthly (agency_id, month, cost_micro_usd, calls)
        values (${agencyB}, ${month}::date, 100000, 1)
        on conflict (agency_id, month) do update set cost_micro_usd = 100000`),
    );
    const provider = new FakeProvider();
    const before = (await jobsOf(agencyB)).length;
    await expect(gateway(provider).generate(ctxOf(agencyB), call({ beds: 9 }))).rejects.toMatchObject({
      code: 'AI_BUDGET_EXCEEDED',
    });
    expect(provider.calls).toHaveLength(0);
    expect(await jobsOf(agencyB)).toHaveLength(before);
    // The other agency is not affected.
    await gateway(provider).generate(ctxOf(agencyA), call({ beds: 9 }));
    expect(provider.calls).toHaveLength(1);
  });

  it('[S12-01] provider outage → features degrade gracefully (core flows unaffected)', async () => {
    const provider = new FakeProvider().failWith();
    const g = gateway(provider);
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await aiOrFallback(
          async () => (await g.generate(ctxOf(agencyA), call({ outage: i }))).text,
          (code) => `fallback:${code}`,
        ),
      );
    }
    expect(results).toEqual(Array(5).fill('fallback:AI_UNAVAILABLE'));
    // Three provider attempts opened the breaker; the last two never reached it.
    expect(provider.calls).toHaveLength(3);
    expect(g.breakerState).toBe('open');
    const failed = (await jobsOf(agencyA)).filter((j) => j.status === 'FAILED');
    expect(failed).toHaveLength(3);
    expect(failed[0]).toMatchObject({ error_code: 'AI_UNAVAILABLE' });
    expect(Number(failed[0]?.cost_micro_usd)).toBe(0);
  });

  it('[S12-01] a collected batch is settled once (discounted cost added to the month once)', async () => {
    const provider = new FakeProvider(() => 'Traducido.');
    const g = gateway(provider);
    const request = { ...call(null), items: [{ customId: 'es', input: { t: `es-${run}` } }] };
    const handle = await g.batch(ctxOf(agencyA), request);
    const batchId = handle.batchId as string;
    provider.endBatch(batchId);
    const spend = await spendOf(agencyA);
    expect(await g.collectBatch(ctxOf(agencyA), { batchId, request })).toMatchObject({ costMicroUsd: 1_000 });
    expect(await g.collectBatch(ctxOf(agencyA), { batchId, request })).toMatchObject({ costMicroUsd: 0 });
    expect(await spendOf(agencyA)).toBe(spend + 1_000);
    expect((await jobsOf(agencyA)).filter((j) => j.provider_batch_id === batchId)).toEqual([
      expect.objectContaining({ kind: 'BATCH', status: 'SUCCEEDED', cost_micro_usd: '1000' }),
    ]);
  });

  it('[S12-01] members append feedback on an output; prompt versions are registered once and frozen', async () => {
    const provider = new FakeProvider(() => 'Rated copy.');
    const res = await gateway(provider).generate(ctxOf(agencyA), call({ rated: run }));
    const id = await withTenant({ agencyId: agencyA }, (tx: Tx) =>
      recordAiFeedback(tx, {
        agencyId: agencyA,
        userId: null,
        feature: 'itest.describe',
        jobId: res.meta.jobId,
        promptId: PROMPT_ID,
        promptVersion: 1,
        rating: -1,
        comment: 'Too long',
      }),
    );
    const own = await withTenant({ agencyId: agencyA }, (tx: Tx) =>
      tx.execute(sql`select rating, ai_job_id from ai_feedback where id = ${id}`),
    );
    expect(own.rows[0]).toEqual({ rating: -1, ai_job_id: res.meta.jobId });

    expect(await withSystem('test.ai.sync', (tx: Tx) => syncPromptVersions(tx, [prompt]))).toBe(1);
    expect(await withSystem('test.ai.sync', (tx: Tx) => syncPromptVersions(tx, [prompt]))).toBe(0);
    const edited = parsePrompt({ id: PROMPT_ID, version: 1 }, '---\ntier: FAST\nmaxTokens: 300\n---\nEdited in place.');
    await expect(withSystem('test.ai.sync', (tx: Tx) => syncPromptVersions(tx, [edited]))).rejects.toThrow(
      /changed after it shipped/,
    );
  });
});
