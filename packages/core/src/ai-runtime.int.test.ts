import { closeDb, type Tx, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { type AiJobRecord, createSpendMirror, loadAiSettings, usageMonth } from '@inmolink/platform/ai';
import { cacheConnection, closeCache, configureCache, whenReady } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import type { JobContext } from '@inmolink/platform/queue';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiJobs, REQUEST_PATH_AI_FEATURES, REQUEST_PATH_RECORD_LIMITS } from './ai-runtime';
import { createFounder, type Founder } from './testing/factories';

/**
 * S12-01 (ADR 0018): the `ai-usage` queue's jobs treat their producer (feed-api's `feed_ai` Redis user) as untrusted —
 * request-path features only, bounded amounts, recent months, existing agencies.
 */
const month = usageMonth(new Date());
let a: Founder;
const jobCtx = {} as JobContext;

// The request-path record shape the job accepts (its payload schema is narrower than AiJobRecord).
type RequestRecord = Parameters<typeof aiJobs.recordUsage.spec.run>[0]['job'];
const record = (over: Partial<AiJobRecord> = {}): RequestRecord =>
  ({
    id: newId(),
    agencyId: a.agencyId,
    feature: REQUEST_PATH_AI_FEATURES[0] as string,
    kind: 'STRUCTURED',
    tier: 'FAST',
    model: 'fast-model',
    promptId: 'search-parse',
    promptVersion: 1,
    inputHash: '0'.repeat(64),
    status: 'SUCCEEDED',
    errorCode: null,
    usage: { inputTokens: 300, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costMicroUsd: 700,
    latencyMs: 400,
    itemCount: 1,
    providerBatchId: null,
    requestId: 'req-ai-usage',
    month,
    ...over,
  }) as RequestRecord;

const rowsOf = (id: string) =>
  withSystem('test.ai-usage', async (tx: Tx) => {
    const { rows } = await tx.execute(sql`select id from ai_jobs where id = ${id}`);
    return rows.length;
  });

const payloadOk = (job: RequestRecord) => aiJobs.recordUsage.spec.payload.safeParse({ job }).success;

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({});
  await whenReady(cacheConnection());
  a = await createFounder();
});

afterAll(async () => {
  const keys = await cacheConnection().keys(`inl:ai:spend:${a.agencyId}:*`);
  if (keys.length > 0) await cacheConnection().del(...keys);
  await closeCache();
  await closeDb();
});

describe('ai-usage queue — untrusted producer (ADR 0018)', () => {
  it('[S12-01] ai.recordUsage and ai.refreshSpend run on the ai-usage queue; worker retries stay on ai', () => {
    expect(aiJobs.recordUsage.pool).toBe('ai-usage');
    expect(aiJobs.refreshSpend.pool).toBe('ai-usage');
    expect(aiJobs.retryUsageRecord.pool).toBe('ai');
  });

  it('[S12-01] the payload must be a single request-path call within bounds', () => {
    expect(payloadOk(record())).toBe(true);
    expect(payloadOk(record({ feature: 'listing-studio.describe' }))).toBe(false);
    expect(payloadOk(record({ costMicroUsd: REQUEST_PATH_RECORD_LIMITS.costMicroUsd + 1 }))).toBe(false);
    expect(payloadOk(record({ usage: { ...record().usage, outputTokens: 1_000_000 } }))).toBe(false);
    expect(payloadOk(record({ kind: 'BATCH', providerBatchId: 'b1', itemCount: 500 }))).toBe(false);
    expect(payloadOk(record({ status: 'PENDING' }))).toBe(false);
  });

  it('[S12-01] an unknown agency or an old month is dead-lettered without writing anything', async () => {
    const unknown = record({ agencyId: newId() });
    await expect(aiJobs.recordUsage.spec.run({ job: unknown }, jobCtx)).rejects.toThrow(/unknown agency/);
    expect(await rowsOf(unknown.id)).toBe(0);
    const old = record({ month: '2020-01-01' });
    await expect(aiJobs.recordUsage.spec.run({ job: old }, jobCtx)).rejects.toThrow(/month out of range/);
    expect(await rowsOf(old.id)).toBe(0);
  });

  it('[S12-01] a valid record is appended once and its queued cost moves into the mirror base', async () => {
    const mirror = createSpendMirror({ redis: cacheConnection(), ttlSeconds: loadAiSettings().spendMirrorTtlSeconds });
    await mirror.seed(a.agencyId, month, 5_000);
    const job = record();
    await mirror.settle(a.agencyId, month, 0, job.costMicroUsd); // the request path queued it
    await aiJobs.recordUsage.spec.run({ job }, jobCtx);
    await aiJobs.recordUsage.spec.run({ job }, jobCtx);
    expect(await rowsOf(job.id)).toBe(1);
    const redis = cacheConnection();
    const key = `inl:ai:spend:${a.agencyId}:${month}`;
    expect(Number(await redis.get(key))).toBe(5_700);
    expect(Number(await redis.get(`${key}:queued`))).toBe(0);
  });

  it('[S12-01] ai.refreshSpend seeds only existing agencies, recent months', async () => {
    const ghost = newId();
    await aiJobs.refreshSpend.spec.run({ agencyId: ghost, month }, jobCtx);
    expect(await cacheConnection().exists(`inl:ai:spend:${ghost}:${month}`)).toBe(0);
    await expect(aiJobs.refreshSpend.spec.run({ agencyId: a.agencyId, month: '2020-01-01' }, jobCtx)).rejects.toThrow(
      /month out of range/,
    );
  });
});
