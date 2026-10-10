import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob, stableJobId } from './index';

const payload = z.object({ id: z.string() });

describe('queue definitions', () => {
  it('[S0-06] stable job IDs never contain ":" and never collide after encoding', () => {
    expect(stableJobId('search.reindex', 'reindex:abc:3')).toBe('search.reindex.reindex%3Aabc%3A3');
    expect(stableJobId('a.b', 'x%3A')).not.toBe(stableJobId('a.b', 'x:'));
    expect(stableJobId('a.b', '123')).not.toMatch(/^\d+$/);
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
});
