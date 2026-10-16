import { describe, expect, it } from 'vitest';
import { continuationTrigger } from '../document-jobs';

describe('document purge continuation', () => {
  it('[S3-F10] every continuation gets a new trigger (job id), however long the run, within the 64-char cap', () => {
    const seen = new Set<string>();
    let t = 'x'.repeat(64);
    for (let i = 0; i < 5_000; i++) {
      t = continuationTrigger(t);
      expect(t).toMatch(/^[A-Za-z0-9-]{1,64}$/);
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
    expect(continuationTrigger('evt1')).toBe('evt1-c1');
    expect(continuationTrigger('evt1-c1')).toBe('evt1-c2');
  });
});
