import { CreateListingBody, PutListingTranslationBody, UpdateListingBody } from '@inmolink/contracts';
import { type Ctx, withMemberCtx } from '@inmolink/core';
import * as media from '@inmolink/core/modules/media';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, type Founder } from '@inmolink/core/test';
import { withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { type PoolHandle, queueFor, registerPool } from '@inmolink/platform/queue';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runId, setupQueueTest, teardownQueueTest, waitFor } from '../queue/helpers';

/**
 * Search indexer acceptance (S5-03) through the worker's real path: outbox events → the search subscriptions →
 * `read_model_queue` rows and the agency's throttled `search.buildReadModels` runs (S5-F4) on a real `indexing` pool
 * (BullMQ, Redis) → read models and the index
 * queue in one transaction → throttled and scheduled `search.syncIndex` jobs → Meilisearch. Only the dispatcher's
 * claim is stood in for: the shared test database holds other suites' events, so this file delivers its own
 * agency's events every 250 ms (the dispatcher's poll, ADR 0014; its pickup is measured in S0-06 / S2-F3).
 * In the `perf` project: it runs alone, so the timing is not shared with parallel suites.
 */

const RUN = runId();
const UID = `t_indexer_${RUN}`;
const POOL = 'indexing';
const LISTINGS = 40;
const FRESH_BUDGET_MS = 10_000;
const real = () =>
  createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.search-indexer', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const inList = (xs: readonly string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );

let m: Founder;
let ids: { location: string; type: string };
let pool: PoolHandle;
const targets: string[] = [];
let delivering = true;
let delivery: Promise<void> = Promise.resolve();

const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const update = (id: string, patch: Omit<UpdateListingBody, 'version'>) =>
  as(async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ ...patch, version: (await properties.getListing(ctx, id)).version }),
    ),
  );
const retitle = (id: string, title: string) =>
  as(async (ctx) =>
    properties.saveListingTranslation(
      ctx,
      id,
      'en',
      PutListingTranslationBody.parse({
        version: (await properties.getListing(ctx, id)).version,
        title,
        description: `${title} text`,
      }),
    ),
  );
/** A SHARED, ACTIVE listing with an English title. */
async function listing(title: string): Promise<string> {
  const { id } = await as((ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.type, locationId: ids.location, priceCents: 45_000_000 }),
    ),
  );
  targets.push(id);
  await retitle(id, title);
  await update(id, { status: 'ACTIVE', visibility: 'SHARED' });
  return id;
}

/** The dispatcher's part for this file's agency: its pending events to the search subscriptions, then acked. */
async function deliverOnce(): Promise<void> {
  const events = await rows<{ id: string; type: string; version: number; payload: unknown }>(
    sql`select id, type, version, payload from outbox_events
         where agency_id = ${m.agencyId} and processed_at is null order by id limit 500`,
  );
  for (const e of events) {
    const meta = {
      eventId: e.id,
      agencyId: m.agencyId,
      type: e.type,
      version: e.version,
      createdAt: new Date(),
      attempt: 1,
    };
    for (const s of defaultSubscribers.get(e.type, e.version)) {
      if (s.name.startsWith('search.')) await s.handler(e.payload as never, meta);
    }
  }
  if (events.length > 0) {
    await rows(sql`update outbox_events set processed_at = now() where id in (${inList(events.map((e) => e.id))})`);
  }
}

/** The index holds exactly what the read models say for these targets (and nothing for those without). */
async function converged(of: readonly string[]): Promise<boolean> {
  const { docs } = await system((tx) => search.indexDocsFor(tx, of));
  const indexed = await real().fetch(UID, of, ['id', 'sourceHash']);
  const want = new Map(docs.map((d) => [d.id, d.sourceHash]));
  return indexed.length === want.size && indexed.every((d) => want.get(String(d.id)) === d.sourceHash);
}

const queued = async (of: readonly string[]) =>
  (
    await rows<{ n: number }>(sql`select count(*)::int as n from search_index_queue where target_id in (${inList(of)})`)
  )[0]?.n ?? 0;

beforeAll(async () => {
  await setupQueueTest(`test-${RUN}`);
  loadStackEnv('test');
  configureSearch(real());
  search.configureSearchIndex({ uid: UID, scope: targets });
  await search.ensureListingsIndex(real(), search.listingsIndex(UID));
  media.configureMedia({ urlKey: `perf-indexer-key-${RUN}-0123456789abcdef` });
  m = await createFounder();
  await setAgencyStatus(m.agencyId, 'VERIFIED');
  await rows(sql`update agency_settings set enabled_locales = '{en,es}' where agency_id = ${m.agencyId}`);
  ids = await system(async (tx) => {
    const tr = (name: string) => [{ locale: 'en', name, slug: `${name.toLowerCase()}-${RUN}` }];
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `ix-${RUN}`,
      translations: tr('Indexland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `ix-g-${RUN}`,
      sort: 0,
      translations: tr('Homes'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `ix-t-${RUN}`,
      sort: 0,
      translations: tr('Villa'),
    });
    return { location, type };
  });
  search.registerSearchSubscriptions();
  pool = registerPool(POOL, [search.searchJobs.buildReadModels, search.searchJobs.syncIndex], {
    concurrency: 10,
  });
  await pool.scheduled;
  delivery = (async () => {
    while (delivering) {
      await deliverOnce();
      await sleep(250);
    }
  })();
}, 180_000);

afterAll(async () => {
  delivering = false;
  await delivery;
  search.unregisterSearchSubscriptions();
  await pool?.close();
  await real().dropIndex(UID);
  if (targets.length > 0) {
    await rows(sql`delete from search_index_queue where target_id in (${inList(targets)})`);
    await rows(sql`delete from read_model_queue where target_id in (${inList(targets)})`);
    await rows(sql`delete from listing_read_models where target_id in (${inList(targets)})`);
  }
  if (m) await rows(sql`delete from properties where agency_id = ${m.agencyId}`);
  await teardownQueueTest([POOL]);
}, 120_000);

it('[S5-03] a listing edit is searchable in < 10 s p95', async () => {
  for (let i = 0; i < LISTINGS; i++) await listing(`Villa ${RUN} ${i}`);
  await waitFor(() => converged(targets), 120_000, 500);

  // An edit every 250 ms (a steady stream: the sync's throttle must not be pushed back by it); each one is timed
  // from its commit until the index answers the new title.
  const latencies = await Promise.all(
    targets.map(async (id, i) => {
      await sleep(i * 250);
      const title = `Fresh ${RUN} n${i}`;
      await retitle(id, title);
      const committed = performance.now();
      await waitFor(async () => (await real().fetch(UID, [id], ['title_en']))[0]?.title_en === title, 60_000, 100);
      return performance.now() - committed;
    }),
  );
  latencies.sort((x, y) => x - y);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1] as number;
  const p50 = latencies[Math.ceil(latencies.length * 0.5) - 1] as number;
  console.info(
    `[S5-03] edit → searchable: p50 ${Math.round(p50)} ms, p95 ${Math.round(p95)} ms, max ${Math.round(latencies.at(-1) as number)} ms (${latencies.length} edits, budget p95 ${FRESH_BUDGET_MS} ms)`,
  );
  // Searchable by text too, not only fetchable.
  const last = await real().search(search.listingsIndex(UID), {
    text: `Fresh ${RUN} n${LISTINGS - 1}`,
    searchOn: ['title_en'],
    filter: { op: 'eq', field: 'ownerAgencyId', value: m.agencyId },
    limit: 1,
  });
  expect(last.ids).toEqual([targets[LISTINGS - 1]]);
  expect(p95).toBeLessThan(FRESH_BUDGET_MS);
});

it('[S5-03] search stopped, then restarted, converges with zero lost updates', async () => {
  await waitFor(async () => (await queued(targets)) === 0, 60_000, 200);
  // The engine goes away: every push fails until it is back.
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'down', timeoutMs: 500 }));
  const dead = async () =>
    (await queueFor(`${POOL}.dead`).getJobs(['wait'])).filter((j) => j.name === 'search.syncIndex').length;
  const deadBefore = await dead();

  // While it is down: edits, removals and new listings.
  const removed = targets.slice(0, 5);
  for (const [i, id] of targets.slice(5, 30).entries()) {
    await retitle(id, `Outage ${RUN} n${i}`);
    await update(id, { priceCents: 50_000_000 + i });
  }
  for (const id of removed) await update(id, { visibility: 'PRIVATE' });
  for (let i = 0; i < 5; i++) await listing(`New ${RUN} ${i}`);
  await waitFor(async () => (await queued(targets)) >= 35, 60_000, 200);

  // Down long enough that the syncs the edits asked for used every attempt and were dead-lettered: what survives
  // is the queue in Postgres, which nothing expires.
  await waitFor(async () => (await dead()) > deadBefore, 120_000, 500);
  expect(await queued(targets)).toBeGreaterThanOrEqual(35);
  expect(await converged(targets)).toBe(false);

  // Back up. Nothing else is edited or triggered: the scheduled sync (every minute) — or a retry still pending —
  // must converge on its own.
  const restarted = performance.now();
  configureSearch(real());
  await waitFor(async () => (await queued(targets)) === 0 && (await converged(targets)), 150_000, 1_000);
  console.info(`[S5-03] converged ${Math.round((performance.now() - restarted) / 1_000)} s after search came back`);

  const removedDocs = await real().fetch(UID, removed, ['id']);
  expect(removedDocs).toEqual([]);
  const titles = await real().fetch(UID, targets.slice(5, 30), ['title_en', 'priceCents']);
  expect(titles.map((d) => d.title_en).sort()).toEqual(
    Array.from({ length: 25 }, (_, i) => `Outage ${RUN} n${i}`).sort(),
  );
  expect(await search.checkIndexDrift()).toMatchObject({ drift: false, mismatched: [] });
});
