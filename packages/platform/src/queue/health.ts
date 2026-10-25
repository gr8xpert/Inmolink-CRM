import { queueFor } from './connection';
import { deadLetterQueue } from './worker';

/** Worker pools (workers.md); each can run on its own node via `WORKER_POOLS` (apps/worker). */
export const POOLS = [
  'outbox',
  'imports',
  'media',
  'indexing',
  'matching',
  'exports',
  'email',
  // S11 review: live socket pushes (chat messages, read receipts, in-app notifications) — no mail, no digests.
  'realtime',
  // S11 review: notification e-mail digests, bursty (a broad network post), in their own queue and slots.
  'digest',
  'ai',
  // S12-01 (ADR 0018): request-path AI usage records and spend-mirror seeds — the only queue feed-api can write.
  'ai-usage',
  'social',
  'pdf',
  'maintenance',
] as const;
export type Pool = (typeof POOLS)[number];

export interface PoolHealth {
  pool: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  dead: number;
}

/**
 * Job counts of each pool's queue and its dead-letter queue (S13-03, the staff console's queue health): a handful of
 * Redis reads per pool, no scan. The `outbox` pool runs the dispatcher (no queue) and is left out. Network I/O: never
 * inside a DB transaction.
 */
export async function queueHealth(pools: readonly string[] = POOLS): Promise<PoolHealth[]> {
  return Promise.all(
    pools
      .filter((p) => p !== 'outbox')
      .map(async (pool) => {
        const [c, d] = await Promise.all([
          queueFor(pool).getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed'),
          queueFor(deadLetterQueue(pool)).getJobCounts('waiting', 'prioritized', 'delayed'),
        ]);
        const n = (v: number | undefined) => v ?? 0;
        return {
          pool,
          waiting: n(c.waiting) + n(c.prioritized),
          active: n(c.active),
          delayed: n(c.delayed),
          failed: n(c.failed),
          dead: n(d.waiting) + n(d.prioritized) + n(d.delayed),
        };
      }),
  );
}
