import { CreatePortalConnectionBody } from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as exportsModule from '@inmolink/core/modules/exports';
import {
  configurePortalFeedJobs,
  configurePortalFeeds,
  exportsJobs,
  nightlyWindow,
  seedNightlyLanes,
} from '@inmolink/core/modules/exports/worker';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, type PoolHandle, queueFor, registerPool } from '@inmolink/platform/queue';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The nightly portal feed run on the real queue (S9-03 review): BullMQ and Redis with this file's own key prefix, the
 * real `exports.generatePortalFeeds` and `websiteApi.generateSiteFeed` jobs in one `exports` pool. The night runs as
 * `nightlyLanes` chains (in the perf project: it measures waits, and it marks every other agency's connections done for
 * tonight, which no parallel file may race): at no point are more nightly jobs queued than lanes, none is ever bounced to delayed by a
 * cap, every due agency is covered, and a site feed job queued meanwhile starts within a bounded wait.
 *
 * S9 review: nightly passes, event passes and site feeds share one cap group (per process and pool-wide). The lanes take
 * `LANES` of its slots and leave one (`nightlyLanes` < `maxConcurrentRuns`): the site feed runs in it, and each lane's
 * successor takes its predecessor's slot (handed back before the enqueue), so still none is bounced.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'portal-nightly-test', level: 'silent' });
const AGENCIES = 12;
const LANES = 2;
/** A site feed job queued during the night starts within this (the pool has free slots: lanes < concurrency). */
const SITE_WAIT_BUDGET_MS = 3_000;

let founders: Founder[] = [];
let handle: PoolHandle | undefined;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('exports.nightly.test', fn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  loadStackEnv('test');
  await setupTestDb('worker');
  await configureQueue({ prefix: `test-portal-nightly-${RUN}`, logger: log });
  await configureCache({ prefix: `t:portal-nightly:${RUN}` });
  configureStorage(createMemoryStore());
  exportsModule.configureExports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
  });
  configurePortalFeeds({ mediaBaseUrl: 'https://media.example' });
  await system((tx) => exportsModule.syncPortalChannels(tx));
  founders = [];
  for (let i = 0; i < AGENCIES; i++) founders.push(await createFounder());
  for (const f of founders) {
    await setAgencyStatus(f.agencyId, 'VERIFIED');
    await withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId(), locale: 'en' }, (ctx) =>
      exportsModule.createConnection(ctx, CreatePortalConnectionBody.parse({ channelCode: 'kyero', name: 'Night' })),
    );
  }
}, 180_000);

afterAll(async () => {
  configurePortalFeedJobs({});
  await handle?.close();
  for (const name of ['exports', 'exports.dead']) await queueFor(name).obliterate({ force: true });
  await closeQueues();
  await closeCache();
  await closeDb();
});

describe('[S9-03] nightly lanes on the real queue', () => {
  it('[S9-03] the night runs as lanes: never more nightly jobs than lanes, none bounced, all covered, site feeds start promptly', async () => {
    const now = new Date();
    // One process here: its share of the heavy jobs is the whole pool-wide cap (lanes + one for the other heavy jobs).
    configurePortalFeedJobs({
      nightlyHourUtc: now.getUTCHours(),
      nightlyLanes: LANES,
      maxConcurrentRuns: LANES + 1,
      runsPerProcess: LANES + 1,
    });
    const window = nightlyWindow(now, now.getUTCHours());
    const mine = founders.map((f) => f.agencyId);
    // Only this file's agencies are due tonight (the shared database holds other files' connections).
    await system((tx) =>
      tx.execute(sql`update agency_portal_connections
                        set nightly_at = case when agency_id in ${mine} then null else now() end`),
    );
    handle = registerPool(
      'exports',
      [
        exportsJobs.generatePortalFeeds,
        exportsJobs.generateNightlyPortalFeeds,
        websiteApi.websiteApiJobs.generateSiteFeed,
      ],
      {
        concurrency: LANES + 2,
      },
    );
    const queue = queueFor('exports');

    // The sweep seeds one chain per lane — not one job per agency.
    expect(await seedNightlyLanes(now)).toBe(LANES);
    // A site feed job of another tenant, queued while the night runs (its site has no feed: a quick no-op run).
    const site = await websiteApi.websiteApiJobs.generateSiteFeed.enqueue({ siteId: newId(), agencyId: newId() });

    let maxNightly = 0;
    let bounced = 0;
    /** Heavy jobs (the shared cap group) running at once, sampled. */
    let maxHeavy = 0;
    const heavy = new Set([
      'exports.generateNightlyPortalFeeds',
      'exports.generatePortalFeeds',
      'websiteApi.generateSiteFeed',
    ]);
    const due = async () =>
      (
        await system((tx) =>
          tx.execute<{ n: number }>(sql`select count(*)::int as n from agency_portal_connections
                                         where agency_id in ${mine} and (nightly_at is null or nightly_at < ${window.start})`),
        )
      ).rows[0]?.n ?? AGENCIES;
    const until = Date.now() + 120_000;
    for (;;) {
      const jobs = await queue.getJobs(['waiting', 'prioritized', 'delayed', 'active']);
      const nightly = jobs.filter((j) => j.name === 'exports.generateNightlyPortalFeeds');
      maxNightly = Math.max(maxNightly, nightly.length);
      maxHeavy = Math.max(maxHeavy, (await queue.getJobs(['active'])).filter((j) => heavy.has(j.name)).length);
      const delayed = await queue.getJobs(['delayed']);
      bounced = Math.max(bounced, delayed.filter((j) => j.name === 'exports.generateNightlyPortalFeeds').length);
      if ((await due()) === 0 && nightly.length === 0) break;
      if (Date.now() > until) throw new Error('the nightly lanes did not finish');
      await sleep(25);
    }

    // Never more nightly jobs than lanes (each with at most its successor, queued as it finishes), never one parked in
    // delayed by a cap: no churn.
    expect(maxNightly).toBeLessThanOrEqual(2 * LANES);
    expect(bounced).toBe(0);
    // The shared cap held: never more heavy jobs active than the pool-wide cap.
    expect(maxHeavy).toBeLessThanOrEqual(LANES + 1);
    // Every due agency was covered tonight, once (one NIGHTLY run each).
    const nightlyRuns = await system((tx) =>
      tx.execute<{ agency_id: string; n: number }>(sql`select agency_id, count(*)::int as n from portal_feed_runs
                                                        where agency_id in ${mine} and trigger = 'NIGHTLY'
                                                        group by agency_id`),
    );
    expect(nightlyRuns.rows).toHaveLength(AGENCIES);
    expect(nightlyRuns.rows.every((r) => r.n === 1)).toBe(true);
    // The site feed job started promptly.
    const job = await queue.getJob(site.id);
    expect(job?.processedOn).toBeDefined();
    const waited = (job?.processedOn ?? Number.POSITIVE_INFINITY) - (job?.timestamp ?? 0);
    expect(waited).toBeLessThan(SITE_WAIT_BUDGET_MS);
  }, 180_000);
});
