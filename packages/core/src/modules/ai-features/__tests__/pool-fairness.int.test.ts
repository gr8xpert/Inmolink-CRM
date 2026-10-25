import { loadStackEnv } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import {
  closeQueues,
  configureQueue,
  defineJob,
  type PoolHandle,
  queueFor,
  registerPool,
} from '@inmolink/platform/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiFeaturesJobs, whiteLabelGroup, whiteLabelJobs } from '../jobs';

/**
 * S13-F6: the `ai` pool's fair share keeps an agency's bulk white-label work apart from its interactive jobs. A real
 * `ai` pool on this file's queue prefix (redis-queue of the test stack) runs stand-ins of `aiFeatures.sanitizeTexts` and
 * `aiFeatures.generateListingCopy`: the real definitions' name, pool, group, caps and payloads, with a timed `run`
 * instead of the model (no database, no AI provider).
 */

const RUN = newId().slice(0, 8);
const log = createLogger({ service: 'test', level: 'silent' });

/** A sanitize pass of the stand-in: long enough that 50 of them in a row take far longer than the budget. */
const SANITIZE_MS = 250;
const STUDIO_MS = 30;
const POOL_CONCURRENCY = 2;
const BULK = 50;
const INTERACTIVE = 10;
/** The acceptance budget: A's interactive job starts within 5 s (p95) despite A's bulk backlog. */
const P95_BUDGET_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start times (ms since epoch) per stand-in kind, in start order. */
const started = { sanitize: [] as number[], studio: new Map<string, number>() };

const sanitizeStandIn = defineJob({
  ...whiteLabelJobs.sanitizeTexts.spec,
  async run() {
    started.sanitize.push(Date.now());
    await sleep(SANITIZE_MS);
  },
});

const studioStandIn = defineJob({
  ...aiFeaturesJobs.generateListingCopy.spec,
  async run(p) {
    started.studio.set(p.requestId, Date.now());
    await sleep(STUDIO_MS);
  },
});

const studioPayload = (agencyId: string) => ({
  requestId: newId(),
  agencyId,
  userId: newId(),
  listingIds: [newId()],
  tone: 'PROFESSIONAL' as const,
  locales: ['en'],
  replaceReviewed: false,
});

let pool: PoolHandle | undefined;

beforeAll(async () => {
  loadStackEnv('test');
  await configureQueue({ prefix: `test-ai-fair-${RUN}`, logger: log });
  pool = registerPool('ai', [sanitizeStandIn, studioStandIn], {
    concurrency: POOL_CONCURRENCY,
    groupRetryMs: 20,
    groupRetryMaxMs: 200,
  });
});

afterAll(async () => {
  await pool?.close();
  await queueFor('ai')
    .obliterate({ force: true })
    .catch(() => undefined);
  await closeQueues();
});

describe('ai pool fairness (S13-F6)', () => {
  it('[S13-F6] bulk white-label jobs queue in their own fair-share group, interactive jobs keep the agency group', () => {
    const agencyId = newId();
    const sanitizeGroup = whiteLabelJobs.sanitizeTexts.spec.group?.({
      eventId: newId(),
      agencyId,
      targetIds: [newId()],
      retry: 0,
    });
    const studioGroup = aiFeaturesJobs.generateListingCopy.spec.group?.(
      aiFeaturesJobs.generateListingCopy.spec.payload.parse(studioPayload(agencyId)),
    );
    expect(sanitizeGroup).toBe(whiteLabelGroup(agencyId));
    expect(studioGroup).toBe(agencyId);
    expect(sanitizeGroup).not.toBe(studioGroup);
  });

  it('[S13-F6] with 50 queued sanitize jobs for agency A, A’s generateListingCopy starts within one free slot (p95 < 5 s)', async () => {
    const agencyA = newId();
    await sanitizeStandIn.enqueueMany(
      Array.from({ length: BULK }, () => ({
        payload: { eventId: newId(), agencyId: agencyA, targetIds: [newId()] },
      })),
    );
    // The bulk backlog is draining (one sanitize at a time for A) before the interactive requests arrive.
    while (started.sanitize.length === 0) await sleep(10);

    const waits: number[] = [];
    /** Sanitize jobs that started between an interactive request's enqueue and its start. */
    const overtakenBy: number[] = [];
    for (let i = 0; i < INTERACTIVE; i++) {
      const payload = studioPayload(agencyA);
      const sanitizeBefore = started.sanitize.length;
      const enqueuedAt = Date.now();
      await studioStandIn.enqueue(payload);
      const deadline = enqueuedAt + 4 * P95_BUDGET_MS;
      while (!started.studio.has(payload.requestId) && Date.now() < deadline) await sleep(5);
      const startedAt = started.studio.get(payload.requestId);
      expect(startedAt, `interactive request ${i} never started`).toBeDefined();
      waits.push((startedAt as number) - enqueuedAt);
      overtakenBy.push(started.sanitize.filter((t) => t <= (startedAt as number)).length - sanitizeBefore);
      await sleep(SANITIZE_MS / 2);
    }

    waits.sort((a, b) => a - b);
    const p95 = waits[Math.ceil(waits.length * 0.95) - 1] as number;
    expect(p95).toBeLessThan(P95_BUDGET_MS);
    // Within one free slot: at most the one sanitize job that took a slot freeing meanwhile ran first — never the
    // agency's bulk backlog (before S13-F6 every queued sanitize job of A went first: ~50 × 250 ms).
    expect(Math.max(...overtakenBy)).toBeLessThanOrEqual(1);
    // The bulk work is still queued behind: the interactive jobs did not wait for it to drain.
    expect(started.sanitize.length).toBeLessThan(BULK);
  }, 60_000);
});
