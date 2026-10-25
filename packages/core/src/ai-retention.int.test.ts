import { closeDb, type Tx, withSystem } from '@inmolink/db';
import { setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { pruneAiJobs } from '@inmolink/platform/ai';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_JOBS_RETENTION, aiJobs, monthsBefore, pruneAiJobRows } from './ai-runtime';
import { createFounder, type Founder } from './testing/factories';
import { captureSql, describePlan, explainNodes, indexScans, seqScans } from './testing/query-plan';

/**
 * `ai_jobs` retention (S13-F9) on the real test database: settled rows older than 13 months go, recent rows and a
 * PENDING batch (its budget reservation) stay, and the month totals in `ai_usage_monthly` are untouched. The delete
 * reads `ai_jobs_prune_idx`, never the whole table.
 */

let f: Founder;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('ai.retention.test', fn);
const DAY = 86_400_000;

beforeAll(async () => {
  await setupTestDb('worker');
  f = await createFounder();
}, 120_000);
afterAll(closeDb);

async function job(status: 'SUCCEEDED' | 'FAILED' | 'PENDING', createdAt: Date): Promise<string> {
  const id = newId();
  await system((tx) =>
    tx.execute(sql`
      insert into ai_jobs (id, agency_id, feature, kind, model, input_hash, status, provider_batch_id, created_at)
      values (${id}, ${f.agencyId}, 'test.retention', ${status === 'PENDING' ? 'BATCH' : 'GENERATE'}, 'test-model',
              ${'0'.repeat(64)}, ${status}, ${status === 'PENDING' ? `batch_${id}` : null},
              ${createdAt.toISOString()}::timestamptz)`),
  );
  return id;
}

const present = async (ids: string[]) =>
  (
    await system((tx) =>
      tx.execute<{ id: string }>(sql`select id from ai_jobs where id = any(${`{${ids.join(',')}}`}::uuid[])`),
    )
  ).rows
    .map((r) => r.id)
    .sort();

describe('ai_jobs retention', () => {
  it('[S13-F9] ai_jobs: settled rows past 13 months are deleted; recent rows and PENDING batches stay', async () => {
    const now = Date.now();
    const cutoff = monthsBefore(now, AI_JOBS_RETENTION.MONTHS).getTime();
    const oldOk = await job('SUCCEEDED', new Date(cutoff - DAY));
    const oldFailed = await job('FAILED', new Date(cutoff - 30 * DAY));
    const oldPending = await job('PENDING', new Date(cutoff - 30 * DAY));
    const justInside = await job('SUCCEEDED', new Date(cutoff + DAY));
    const recent = await job('SUCCEEDED', new Date(now - 30 * DAY));
    await system((tx) =>
      tx.execute(sql`insert into ai_usage_monthly (agency_id, month, cost_micro_usd, calls)
        values (${f.agencyId}, date_trunc('month', now() - interval '14 months')::date, 1234, 2)`),
    );

    const res = await pruneAiJobRows(now);
    expect(res.deleted).toBeGreaterThanOrEqual(2);
    expect(await present([oldOk, oldFailed, oldPending, justInside, recent])).toEqual(
      [oldPending, justInside, recent].sort(),
    );
    const totals = await system((tx) =>
      tx.execute<{ cost: string }>(sql`select cost_micro_usd::text as cost from ai_usage_monthly
        where agency_id = ${f.agencyId} and month = date_trunc('month', now() - interval '14 months')::date`),
    );
    expect(totals.rows[0]?.cost).toBe('1234');
    // idempotent: a second run finds nothing of these
    await pruneAiJobRows(now);
    expect(await present([oldPending, justInside, recent])).toHaveLength(3);
  });

  it('[S13-F9] ai_jobs: the prune runs daily in the maintenance pool', () => {
    expect(aiJobs.pruneJobs.pool).toBe('maintenance');
    expect(aiJobs.pruneJobs.spec.every).toBe(24 * 60 * 60_000);
    expect(AI_JOBS_RETENTION.PRUNE_BATCH).toBeLessThanOrEqual(5_000);
  });

  it('[S13-F9] ai_jobs: the delete EXPLAINs as an index scan of ai_jobs_prune_idx (20k rows)', async () => {
    const [statement] = await captureSql((tx) =>
      pruneAiJobs(tx, monthsBefore(Date.now(), 13), AI_JOBS_RETENTION.PRUNE_BATCH),
    );
    const nodes = await withAdminRollback(['ai_jobs'], async (q) => {
      await q('set local session_replication_role = replica');
      // a year of usage (20k rows), a few hundred past the retention
      await q(
        `insert into ai_jobs (id, agency_id, feature, kind, model, input_hash, status, created_at)
         select gen_random_uuid(), gen_random_uuid(), 'test.plan', 'GENERATE', 'm', repeat('0', 64),
                case when g % 50 = 0 then 'FAILED' else 'SUCCEEDED' end,
                case when g <= 200 then now() - interval '14 months' - (g || ' hours')::interval
                     else now() - ((g % 360) || ' days')::interval end
           from generate_series(1, 20000) g`,
      );
      await q('analyze ai_jobs');
      await q('set local role app_system');
      return explainNodes(q, statement as NonNullable<typeof statement>);
    });
    expect(seqScans(nodes, 'ai_jobs'), describePlan(nodes)).toBe(false);
    expect(indexScans(nodes, 'ai_jobs_prune_idx'), describePlan(nodes)).not.toHaveLength(0);
  });
});
