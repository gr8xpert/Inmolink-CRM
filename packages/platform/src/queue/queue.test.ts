import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob, stableJobId } from './index';
import { groupRetryDelay } from './worker';

const payload = z.object({ id: z.string() });

describe('queue definitions', () => {
  it('[S0-06] stable job IDs never contain ":" and never collide after encoding', () => {
    expect(stableJobId('search.reindex', 'reindex:abc:3')).toBe('search.reindex.reindex%3Aabc%3A3');
    expect(stableJobId('a.b', 'x%3A')).not.toBe(stableJobId('a.b', 'x:'));
    expect(stableJobId('a.b', '123')).not.toMatch(/^\d+$/);
  });

  it('[S1-F4] recurring jobs run at most once a minute and must accept an empty payload', () => {
    const run = async () => {};
    const empty = z.object({}).strict();
    expect(defineJob({ name: 'ops.prune', pool: 'maintenance', payload: empty, every: 60_000, run }).spec.every).toBe(
      60_000,
    );
    expect(() => defineJob({ name: 'ops.prune', pool: 'maintenance', payload: empty, every: 1_000, run })).toThrow(
      /every must be/,
    );
    expect(() => defineJob({ name: 'ops.prune', pool: 'maintenance', payload, every: 60_000, run })).toThrow(
      /must accept \{\}/,
    );
  });

  it('[S0-06] defineJob validates name, pool and group settings', () => {
    const run = async () => {};
    expect(() => defineJob({ name: 'Bad Name', pool: 'indexing', payload, run })).toThrow(/invalid name/);
    expect(() => defineJob({ name: 'search.reindex', pool: 'Indexing!', payload, run })).toThrow(/invalid pool/);
    expect(() => defineJob({ name: 'search.reindex', pool: 'indexing', payload, concurrencyPerGroup: 1, run })).toThrow(
      /needs group/,
    );
    const def = defineJob({ name: 'search.reindex', pool: 'indexing', payload, run });
    expect(def).toMatchObject({ name: 'search.reindex', pool: 'indexing', attempts: 5, timeoutMs: 600_000 });
  });

  it('[S9-review] a capGroup needs a valid name and a cap to share', () => {
    const run = async () => {};
    expect(() =>
      defineJob({ name: 'a.b', pool: 'exports', payload, capGroup: 'Bad Group', perProcessConcurrency: 2, run }),
    ).toThrow(/invalid capGroup/);
    expect(() => defineJob({ name: 'a.b', pool: 'exports', payload, capGroup: 'exports.feeds', run })).toThrow(
      /capGroup needs perProcessConcurrency or globalConcurrency/,
    );
    const def = defineJob({
      name: 'a.b',
      pool: 'exports',
      payload,
      capGroup: 'exports.feeds',
      perProcessConcurrency: 2,
      run,
    });
    expect(def.spec.capGroup).toBe('exports.feeds');
  });
});

describe('fair share over-cap backoff', () => {
  it('[S1-F3] over-cap retries back off geometrically up to the cap, with jitter below one more step', () => {
    expect(groupRetryDelay(1, 250, 5_000, 0)).toBe(250);
    expect(groupRetryDelay(2, 250, 5_000, 0)).toBe(500);
    expect(groupRetryDelay(5, 250, 5_000, 0)).toBe(4_000);
    expect(groupRetryDelay(6, 250, 5_000, 0)).toBe(5_000);
    expect(groupRetryDelay(40, 250, 5_000, 0)).toBe(5_000); // no overflow past the cap
    const jittered = groupRetryDelay(3, 250, 5_000, 0.999);
    expect(jittered).toBeGreaterThanOrEqual(1_000);
    expect(jittered).toBeLessThan(2_000);
  });
});
