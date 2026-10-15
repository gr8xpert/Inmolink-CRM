import { MEDIA_MAX_BYTES } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import {
  batches,
  mapLimit,
  moveItem,
  partition,
  putHeaders,
  putOutcome,
  refusalOf,
  retryDelayMs,
  uploadTypeOf,
} from './media-upload';

/** Media manager upload planning (S3-06). */

const h = (key: string, sha: string) => ({ key, sha256: sha.repeat(64).slice(0, 64) });

describe('media upload planning', () => {
  it('[S3-06] duplicates are skipped instantly: files already on the listing or chosen twice send no request', () => {
    const files = [h('a.jpg', 'a'), h('b.jpg', 'b'), h('a-copy.jpg', 'a'), h('c.jpg', 'c')];
    const attached = new Set([h('x', 'c').sha256]);
    const plan = partition(files, attached);
    expect(plan.send.map((f) => f.key)).toEqual(['a.jpg', 'b.jpg']);
    expect(plan.duplicates.map((f) => f.key)).toEqual(['a-copy.jpg']);
    expect(plan.skipped.map((f) => f.key)).toEqual(['c.jpg']);
  });

  it('[S3-06] 50 photos upload in one check batch; larger drops in batches of 100, order kept', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => i);
    expect(batches(fifty)).toEqual([fifty]);
    const many = Array.from({ length: 250 }, (_, i) => i);
    const out = batches(many);
    expect(out.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(out.flat()).toEqual(many);
  });

  it('[S3-06] a failed PUT is retried with backoff; 412 (stored already) counts as done', () => {
    expect(putOutcome(200)).toBe('done');
    expect(putOutcome(412)).toBe('done');
    expect(putOutcome(0)).toBe('retry');
    expect(putOutcome(503)).toBe('retry');
    expect(putOutcome(429)).toBe('retry');
    expect(putOutcome(403)).toBe('fail');
    expect([2, 3, 4, 10].map(retryDelayMs)).toEqual([500, 1_000, 2_000, 8_000]);
  });

  it('[S3-06] accepted types come from the browser type or, for HEIC, the extension; size is capped', () => {
    expect(uploadTypeOf({ name: 'a.jpg', type: 'image/jpeg' })).toBe('image/jpeg');
    expect(uploadTypeOf({ name: 'IMG_1.HEIC', type: '' })).toBe('image/heic');
    expect(uploadTypeOf({ name: 'b.heif', type: 'image/heif' })).toBe('image/heic');
    expect(uploadTypeOf({ name: 'doc.pdf', type: 'application/pdf' })).toBeNull();
    expect(uploadTypeOf({ name: 'evil.jpg', type: 'text/html' })).toBeNull();
    expect(refusalOf({ name: 'a.png', type: 'image/png', size: MEDIA_MAX_BYTES + 1 })).toBe('size');
    expect(refusalOf({ name: 'a.gif', type: 'image/gif', size: 10 })).toBe('type');
    expect(refusalOf({ name: 'a.webp', type: 'image/webp', size: 10 })).toBeNull();
  });

  it('[S3-06] order persists: a drag moves one file and keeps the others in order', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
  });

  it('[S3-06] uploads run in parallel up to the limit, results in input order; the browser sets the length', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
    expect(putHeaders({ 'content-length': '5', 'content-type': 'image/jpeg', 'if-none-match': '*' })).toEqual({
      'content-type': 'image/jpeg',
      'if-none-match': '*',
    });
  });
});
