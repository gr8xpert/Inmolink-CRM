import { chatJobs } from '@inmolink/core/modules/chat';
import { notificationsJobs } from '@inmolink/core/modules/notifications';
import { loadStackEnv } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import {
  closeQueues,
  configureQueue,
  defineJob,
  type JobDef,
  type PoolHandle,
  queueFor,
  registerPool,
} from '@inmolink/platform/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POOL_OPTIONS } from '../../apps/worker/src/processors';

/**
 * S11 review (perf-auditor MUST-FIX): a broad network post at 5,000 agencies queues thousands of notification digests.
 * They used to share the `email` pool — its slots and its per-agency fair-share backlogs — with the live pushes, capped
 * at 2 per process: every digest over the cap bounced through delayed (`moveToDelayed` churn on the noeviction
 * redis-queue) and an agency's chat delivery queued behind its digests' backlog.
 *
 * On the real queue (redis-queue only, no database): the real job definitions' pools, fair-share keys and caps, with
 * the worker app's pool options, and stand-in handlers — a digest 40 ms (a claim and an e-mail), a chat delivery 5 ms.
 * One worker process, as production's `workers` role runs every non-media pool. 5,000 digests of 100 agencies are
 * queued, then 100 chat deliveries of the same agencies arrive over ~1 s: their queue age p95 stays under 2 s, and no
 * digest is sent back to delayed (the digest queue's delayed set, sampled every 20 ms, stays empty: they are queued
 * undelayed, so a digest there is an over-cap bounce — at least 250 ms long).
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'delivery-pools-test', level: 'silent' });
const DIGESTS = 5_000;
const AGENCIES = 100;
const CHATS = 100;
const DIGEST_MS = 40;
const CHAT_MS = 5;
const WARM_UP = 10;

/** The pool a definition runs in, suffixed per run (queue names are global on the shared redis-queue). */
const testPool = (pool: string) => `${pool}-${RUN}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The real definition (pool, fair-share group, caps, attempts) with a stand-in handler. */
function standIn<D extends JobDef>(def: D, run: (payload: Record<string, unknown>) => Promise<unknown>): JobDef {
  return defineJob({ ...def.spec, pool: testPool(def.pool), run: (p) => run(p as Record<string, unknown>) });
}

const enqueuedAt = new Map<string, number>();
const chatAges: number[] = [];
let digestsDone = 0;
let warmed = 0;

const digest = standIn(notificationsJobs.sendDigest, async () => {
  await sleep(DIGEST_MS);
  digestsDone++;
});
const chat = standIn(chatJobs.deliverMessage, async (p) => {
  const id = p.eventId as string;
  if (id.startsWith('0')) {
    warmed++;
    return;
  }
  chatAges.push(Date.now() - (enqueuedAt.get(id) as number));
  await sleep(CHAT_MS);
});

const handles: PoolHandle[] = [];
const pools = [...new Set([digest.pool, chat.pool])];

beforeAll(async () => {
  loadStackEnv('test');
  await configureQueue({ prefix: `test-deliv-${RUN}`, logger: log });
});

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  for (const pool of pools) for (const name of [pool, `${pool}.dead`]) await queueFor(name).obliterate({ force: true });
  await closeQueues();
});

const agencies = Array.from({ length: AGENCIES }, () => crypto.randomUUID());
/** A UUID whose first digit marks warm-up deliveries ('0') apart from measured ones ('1'…'f'). */
const eventId = (warmUp: boolean) => {
  const id = crypto.randomUUID();
  return `${warmUp ? '0' : id[0] === '0' ? '1' : id[0]}${id.slice(1)}`;
};
const chatPayload = (warmUp: boolean, agencyId: string) => ({
  eventId: eventId(warmUp),
  agencyId,
  threadId: crypto.randomUUID(),
  messageId: crypto.randomUUID(),
  createdMs: Date.now(),
});

function p95(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] as number;
}

async function waitUntil(done: () => boolean, timeoutMs: number, what: string, each?: () => Promise<void>) {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await each?.();
    await sleep(20);
  }
}

describe('delivery pools under a digest burst (S11 review)', () => {
  it('[S11-review] 5,000 queued digests + 100 chat deliveries: chat queue age p95 < 2 s, no digest bounced to delayed', async () => {
    // Digests and live pushes are separate pools (one BullMQ queue, slots and fair-share backlog each).
    expect(digest.pool).not.toBe(chat.pool);
    for (const pool of pools) {
      const jobs = [digest, chat].filter((d) => d.pool === pool);
      const real = pool.slice(0, -RUN.length - 1) as keyof typeof POOL_OPTIONS;
      handles.push(registerPool(pool, jobs, { ...POOL_OPTIONS[real] }));
    }

    // 1. warm-up: connections up and scripts loaded, nothing measured
    for (let i = 0; i < WARM_UP; i++) await chat.enqueue(chatPayload(true, agencies[0] as string));
    await waitUntil(() => warmed === WARM_UP, 30_000, 'the warm-up');

    // 2. the burst: 50 digests per agency (a broad network post notifying every member)
    await digest.enqueueMany(
      Array.from({ length: DIGESTS }, (_, i) => ({
        payload: { agencyId: agencies[i % AGENCIES] as string, userId: crypto.randomUUID() },
      })),
    );

    // 3. live chat deliveries of the same agencies, 10 every 100 ms, while the digests drain
    let digestBounces = 0;
    const sampleDelayed = async () => {
      digestBounces = Math.max(digestBounces, await queueFor(digest.pool).getDelayedCount());
    };
    for (let i = 0; i < CHATS; i++) {
      const payload = chatPayload(false, agencies[i % AGENCIES] as string);
      enqueuedAt.set(payload.eventId, Date.now());
      await chat.enqueue(payload);
      if (i % 10 === 9) {
        await sampleDelayed();
        await sleep(100);
      }
    }
    await waitUntil(() => chatAges.length === CHATS, 60_000, 'the chat deliveries', sampleDelayed);
    // a while longer: digests keep draining, none bounces
    const until = Date.now() + 2_000;
    await waitUntil(() => Date.now() > until, 5_000, 'the digest drain', sampleDelayed);

    log.info({ p95: p95(chatAges), digestsDone, digestBounces }, 'delivery pools');
    expect(p95(chatAges)).toBeLessThan(2_000);
    expect(digestBounces).toBe(0);
    // the digests were draining meanwhile (their own slots, at the pool's concurrency), not parked
    expect(digestsDone).toBeGreaterThan(0);
  });
});
