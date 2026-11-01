import { closeDb, withSystem } from '@inmolink/db';
import { legacyUrlRedirects } from '@inmolink/db/schema/migration';
import { setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache, counts } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as migration from '../index';
import * as repo from '../repo';

/**
 * S16-F3 (S15 review): the legacy redirect hit counters are drained from redis-cache in two steps — taken (renamed),
 * written, then settled — so a failed write loses nothing: the next flush retries the same counters from Redis.
 * The real repo write, with one injected failure (the database itself is never mocked: every other call goes through).
 */
vi.mock('../repo', async (original) => {
  const actual = await original<typeof import('../repo')>();
  return { ...actual, addRedirectHits: vi.fn(actual.addRedirectHits) };
});

const RUN = newId().slice(-8).toLowerCase();
const L = newId();
const HOST = `hits-${RUN}.example`;
const row = (path: string): migration.RedirectRow => ({
  source: 'portal',
  host: HOST,
  locale: 'es',
  pathKey: `/es/${RUN}/${path}`,
  targetPath: `/es/${path}`,
  entity: 'listing',
  targetId: L,
  status: 301,
});
const hitsOf = async (pathKey: string) => {
  const [r] = await withSystem('migration.test', (tx) =>
    tx
      .select({ hits: legacyUrlRedirects.hits })
      .from(legacyUrlRedirects)
      .where(eq(legacyUrlRedirects.pathKey, pathKey)),
  );
  return r?.hits;
};

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:redirect-hits-2step:${RUN}` });
  migration.resetRedirectCache();
});
afterAll(async () => {
  await withSystem('migration.test', (tx) => tx.delete(legacyUrlRedirects).where(eq(legacyUrlRedirects.targetId, L)));
  await closeCache();
  await closeDb();
});

describe('legacy redirect hit flush (S16-F3)', () => {
  it('[S16-F3] a failed hit flush is retried from Redis: nothing lost, nothing counted twice', async () => {
    const r = row('two-step');
    await migration.saveRedirects([r]);
    migration.resetRedirectCache();
    // The public pages: 3 hits pushed to the shared counters.
    for (let i = 0; i < 3; i++) await migration.resolveLegacyRedirect('portal', HOST, r.pathKey);
    expect(await migration.pushRedirectHits()).toBe(1);

    // The worker's flush fails at the write: the taken counters stay on redis-cache.
    vi.mocked(repo.addRedirectHits).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(migration.flushRedirectHits()).rejects.toThrow('database unavailable');
    expect(await hitsOf(r.pathKey)).toBe(0);

    // Hits pushed meanwhile land in the next set, not in the taken one.
    await migration.resolveLegacyRedirect('portal', HOST, r.pathKey);
    expect(await migration.pushRedirectHits()).toBe(1);

    // The retry writes the taken counters (3), then the newer set (1): 4 in all, once each.
    expect(await migration.flushRedirectHits()).toBe(1);
    expect(await hitsOf(r.pathKey)).toBe(3);
    expect(await migration.flushRedirectHits()).toBe(1);
    expect(await hitsOf(r.pathKey)).toBe(4);
    expect(await migration.flushRedirectHits()).toBe(0);
    expect(await hitsOf(r.pathKey)).toBe(4);
    expect(repo.addRedirectHits).toHaveBeenCalledTimes(3);
  });

  it('[S16-F3] overlapping flushes never write the same counters twice (the taken set is leased)', async () => {
    const r = row('overlap');
    await migration.saveRedirects([r]);
    migration.resetRedirectCache();
    for (let i = 0; i < 2; i++) await migration.resolveLegacyRedirect('portal', HOST, r.pathKey);
    await migration.pushRedirectHits();
    // The first flush stalls inside its write (a slow database); a second one (its retry, a stalled re-run) starts.
    let resume: () => void = () => {};
    const stalled = new Promise<void>((res) => {
      resume = res;
    });
    const real = vi.mocked(repo.addRedirectHits).getMockImplementation();
    vi.mocked(repo.addRedirectHits).mockImplementationOnce(async (...args) => {
      await stalled;
      return real?.(...args);
    });
    const first = migration.flushRedirectHits();
    await vi.waitFor(() => expect(repo.addRedirectHits).toHaveBeenCalled());
    // Leased to the first: the second writes only its own (empty) buffer.
    expect(await migration.flushRedirectHits()).toBe(0);
    resume();
    expect(await first).toBe(1);
    expect(await hitsOf(r.pathKey)).toBe(2);
    expect(await migration.flushRedirectHits()).toBe(0);
    expect(await hitsOf(r.pathKey)).toBe(2);
  });

  it('[S16-F3] an aborted flush (its job timed out) rolls back before committing; the next flush writes the hits', async () => {
    const r = row('aborted');
    await migration.saveRedirects([r]);
    migration.resetRedirectCache();
    await migration.resolveLegacyRedirect('portal', HOST, r.pathKey);
    await migration.pushRedirectHits();
    const timeout = new AbortController();
    const real = vi.mocked(repo.addRedirectHits).getMockImplementation();
    vi.mocked(repo.addRedirectHits).mockImplementationOnce(async (...args) => {
      await real?.(...args);
      timeout.abort(new Error('job timed out')); // the deadline passes while the statement ran
    });
    await expect(migration.flushRedirectHits({ signal: timeout.signal })).rejects.toThrow('job timed out');
    expect(await hitsOf(r.pathKey)).toBe(0);
    expect(await migration.flushRedirectHits()).toBe(1);
    expect(await hitsOf(r.pathKey)).toBe(1);
  });

  it('[S16-F3] a batch every write refuses is dropped (logged) after the attempt limit; later hits flow again', async () => {
    const r = row('poison');
    await migration.saveRedirects([r]);
    migration.resetRedirectCache();
    await migration.resolveLegacyRedirect('portal', HOST, r.pathKey);
    await migration.pushRedirectHits();
    for (let i = 0; i < migration.REDIRECT_HITS_MAX_ATTEMPTS; i++) {
      vi.mocked(repo.addRedirectHits).mockRejectedValueOnce(new Error('refused'));
      await expect(migration.flushRedirectHits()).rejects.toThrow('refused');
    }
    const errors: string[] = [];
    const log = { error: (_o: unknown, msg: string) => errors.push(msg), warn: () => {} } as never;
    expect(await migration.flushRedirectHits({ log })).toBe(0);
    expect(errors).toEqual(['legacy redirect hits: a batch failed every write; dropped']);
    expect(await hitsOf(r.pathKey)).toBe(0);
    await migration.resolveLegacyRedirect('portal', HOST, r.pathKey);
    await migration.pushRedirectHits();
    expect(await migration.flushRedirectHits()).toBe(1);
    expect(await hitsOf(r.pathKey)).toBe(1);
  });

  it('[S16-F3] counts.take leases the taken set: busy while held, settled only by its holder, released for a retry', async () => {
    const set = `t-two-step-${RUN}`;
    const lease = { leaseMs: 60_000 };
    await counts.add(set, new Map([['a', 2]]));
    const t1 = await counts.take(set, lease);
    expect(t1?.counts).toEqual(new Map([['a', 2]]));
    expect(t1?.attempts).toBe(1);
    await counts.add(set, new Map([['b', 1]]));
    // Held: another drain gets nothing (and the newer counters wait in the set).
    expect(await counts.take(set, lease)).toBeNull();
    expect(await counts.settle(set, 'not-the-holder')).toBe(false);
    // Released (its write failed): taken again at once, the same counters, a second attempt.
    expect(await counts.release(set, t1?.lease as string)).toBe(true);
    const t2 = await counts.take(set, lease);
    expect(t2?.counts).toEqual(new Map([['a', 2]]));
    expect(t2?.attempts).toBe(2);
    // The first holder's late settle never deletes the second holder's set.
    expect(await counts.settle(set, t1?.lease as string)).toBe(false);
    expect(await counts.settle(set, t2?.lease as string)).toBe(true);
    const t3 = await counts.take(set, lease);
    expect(t3?.counts).toEqual(new Map([['b', 1]]));
    expect(await counts.settle(set, t3?.lease as string)).toBe(true);
    expect(await counts.take(set, lease)).toEqual({ counts: new Map(), lease: '', attempts: 0 });
  });
});
