import { closeDb, countQueries, withPublicRead } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { cache, cacheConnection, cacheKey, closeCache, configureCache } from '@inmolink/platform/cache';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as agencies from '../../agencies';
import * as search from '../../search';
import * as websiteApi from '../index';

/**
 * S16-F1: the portal's owner set is scanned at most once a minute across every process (one shared claim) and read
 * from redis-cache in one MGET — on the test database's scale data (~550k search documents).
 */

const RUN = newId().slice(-8).toLowerCase();
const PREFIX = `t:doc-owners:${RUN}`;

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: PREFIX });
}, 120_000);

afterAll(async () => {
  await closeCache();
  await closeDb();
});

const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] as number;

describe('portal owner scope shared and cheap (S16-F1)', () => {
  it('[S16-F1] one scan per minute across all instances: concurrent callers and the worker share one claim', async () => {
    // Eight "instances" find the set missing at once, and the worker's run comes in too: exactly one scans.
    let winner: search.DocOwners | null = null;
    let workerOwners = -1;
    const n = await countQueries(async () => {
      const [shared, worker] = await Promise.all([
        Promise.all(Array.from({ length: 8 }, () => search.sharedDocOwners())),
        search.refreshDocOwners(),
      ]);
      const scanned = shared.filter((s) => s !== null).length + ('owners' in worker ? 1 : 0);
      expect(scanned).toBe(1);
      // The ones that lost the claim answer without the set (the portal then names the listed agencies).
      expect(shared.filter((s) => s === null).length).toBe('owners' in worker ? 8 : 7);
      winner = shared.find((s) => s !== null) ?? null;
      if ('owners' in worker) workerOwners = worker.owners;
    });
    // The scan, plus the transaction around it: one statement of work.
    expect(n).toBeLessThanOrEqual(3);
    // The claim holds for the rest of the minute: the worker's next runs in it skip, callers read the stored set.
    const ttl = await cacheConnection().pttl(`${PREFIX}:claim:v1:search:doc-owners-scan:g`);
    expect(ttl).toBeGreaterThan(search.DOC_OWNERS_CLAIM_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(search.DOC_OWNERS_CLAIM_MS);
    expect(search.DOC_OWNERS_REFRESH_MS).toBeGreaterThanOrEqual(search.DOC_OWNERS_CLAIM_MS);
    expect(await search.refreshDocOwners()).toEqual({ skipped: true });
    expect(await countQueries(() => search.sharedDocOwners())).toBe(0);
    // The stored set is the scan's (other suites add owners meanwhile: compared with the scan, not a new one).
    const again = await search.sharedDocOwners();
    expect(again?.owners.length).toBeGreaterThan(0);
    if (winner) expect(again).toEqual(winner);
    else expect(again?.owners.length).toBe(workerOwners);
  });

  it('[S16-F1] the owner-scope read is ≤ 5 ms on the scale data (one GET and the listed agencies), no scan', async () => {
    const stored = await search.sharedDocOwners();
    expect(stored?.owners.length ?? 0).toBeGreaterThan(0);
    // What the portal's refresh does (portal.ts `loadOwnerScope`): never the skip scan.
    const read = async () => {
      const shared = await search.sharedDocOwners();
      const listed = await withPublicRead((tx) => agencies.listedAgencyIds(tx));
      const listedSet = new Set(listed);
      return websiteApi.ownerScopeOf(listed, shared?.owners.filter((o) => !listedSet.has(o)) ?? null);
    };
    const wall: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      expect(await countQueries(read)).toBeLessThanOrEqual(3); // begin, the listed agencies, commit
      wall.push(performance.now() - t0);
    }
    // The read's own cost, apart from round trips (this machine shares its CPUs with the whole test stack): the
    // statement's execution on the server, and decoding the stored set plus the filter in the process.
    const exec: number[] = [];
    for (let i = 0; i < 9; i++) {
      const plan = await withPublicRead((tx) =>
        tx.execute(sql`explain (analyze, format json) select agency_id from agency_directory where listed`),
      );
      const [first] = (plan.rows[0] as { 'QUERY PLAN': { 'Execution Time': number }[] })['QUERY PLAN'];
      exec.push(first?.['Execution Time'] ?? Number.POSITIVE_INFINITY);
    }
    const raw = (await cacheConnection().get(`${PREFIX}:v2:search:doc-owners:g`)) ?? '';
    const listed = new Set(await withPublicRead((tx) => agencies.listedAgencyIds(tx)));
    const decode: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      (JSON.parse(raw) as { v: { owners: string[] } }).v.owners.filter((o) => !listed.has(o));
      decode.push(performance.now() - t0);
    }
    const base: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      await withPublicRead((tx) => tx.execute(sql`select 1`));
      await cacheConnection().ping();
      base.push(performance.now() - t0);
    }
    const cost = median(exec) + median(decode);
    console.info(
      `[S16-F1] owner-scope read over ${stored?.owners.length} owners (${raw.length} B): statement ${median(exec).toFixed(2)} ms + decode ${median(decode).toFixed(2)} ms = ${cost.toFixed(2)} ms; wall ${median(wall).toFixed(2)} ms vs round-trip baseline ${median(base).toFixed(2)} ms`,
    );
    expect(cost).toBeLessThanOrEqual(5);
  });

  it('[S16-F1] a stale set is never used: older than the max age (a stalled worker), or marked by a new PUBLIC owner', async () => {
    const ownersKey = `${PREFIX}:v2:search:doc-owners:g`;
    const fresh = await search.sharedDocOwners();
    expect(fresh).not.toBeNull();
    // A stalled worker: the stored set outlives its age only in Redis; read past it, it is missing (the claim from
    // the first test is still held, so this caller does not scan: null → the portal names the listed agencies).
    const fake = useFakeClock((fresh?.at ?? 0) + search.DOC_OWNERS_MAX_AGE_MS + 1);
    try {
      expect(await search.sharedDocOwners()).toBeNull();
      fake.set((fresh?.at ?? 0) + search.DOC_OWNERS_MAX_AGE_MS - 1);
      expect(await search.sharedDocOwners()).not.toBeNull();
    } finally {
      restoreClock();
    }
    // A build wrote documents of an owner the set lists: nothing to mark, no statement.
    const [first, ...rest] = fresh?.owners ?? [];
    search.resetDocOwnersCopy();
    expect(await countQueries(async () => expect(await search.noteDocOwner(first as string)).toBe(false))).toBe(0);
    // An agency without PUBLIC documents: one probe, no mark.
    expect(await search.noteDocOwner(newId())).toBe(false);
    expect(await search.sharedDocOwners()).not.toBeNull();
    // An owner the set lacks (its first PUBLIC listing, simulated by storing the set without it): the set is marked
    // stale and reads as missing until a scan that starts after the mark.
    const raw = JSON.parse((await cacheConnection().get(ownersKey)) ?? '{}') as { v: search.DocOwners };
    raw.v.owners = rest;
    await cacheConnection().set(ownersKey, JSON.stringify(raw), 'EX', 90);
    search.resetDocOwnersCopy();
    expect(await search.noteDocOwner(first as string)).toBe(true);
    expect(await search.sharedDocOwners()).toBeNull();
    // The next scan (here: the claim given up, as after a failed scan) includes the owner and is used again.
    await cache.release(cacheKey({ v: 1, module: 'search', entity: 'doc-owners-scan', scope: 'global' }));
    const rescanned = await search.refreshDocOwners();
    expect('owners' in rescanned).toBe(true);
    const after = await search.sharedDocOwners();
    expect(after?.owners).toContain(first);
  });

  it('[S16-F1] a released claim lets the next caller in at once; a held one keeps every other caller out', async () => {
    const key = cacheKey({ v: 1, module: 'search', entity: 'claim-test', scope: 'global', id: RUN });
    expect(await cache.claim(key, 60_000)).toBe(true);
    expect(await cache.claim(key, 60_000)).toBe(false);
    await cache.release(key);
    expect(await cache.claim(key, 60_000)).toBe(true);
  });

  it('[S16-F1] without the shared set only a show list is used (never unlisted stock)', () => {
    expect(websiteApi.ownerScopeOf(['a', 'b'], null)).toEqual({ show: ['a', 'b'] });
    expect(websiteApi.ownerScopeOf(['a', 'b'], [])).toEqual({ hide: [] });
  });
});
