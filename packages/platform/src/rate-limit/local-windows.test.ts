import { afterEach, describe, expect, it } from 'vitest';
import { restoreClock, useFakeClock } from '../clock';
import { LocalFixedWindows } from './local-windows';

const windows = (max: number) =>
  new LocalFixedWindows<'key' | 'ip'>({
    key: { max, windowMs: 3_600_000 },
    ip: { max, windowMs: 600_000 },
  });
const key = (id: string, limit = 2) => ({ pool: 'key' as const, identity: id, limit });
const ip = (id: string, limit = 2) => ({ pool: 'ip' as const, identity: id, limit });

describe('local fixed windows (S8-F6)', () => {
  afterEach(() => restoreClock());

  it('[S8-F6] a flood of new IP identities does not evict a tracked key window', () => {
    useFakeClock('2026-10-23T10:00:00Z');
    const w = windows(10);
    expect(w.reserve([key('k1')])).toMatchObject({ allowed: true });
    expect(w.reserve([key('k1')])).toMatchObject({ allowed: true });
    for (let i = 0; i < 1_000; i++) expect(w.reserve([ip(`ip${i}`)])).toMatchObject({ allowed: true });
    expect(w.size('ip')).toBe(10);
    expect(w.size('key')).toBe(1);
    expect(w.reserve([key('k1')])).toMatchObject({ allowed: false, retryAfterSeconds: 3_600 });
  });

  it('[S8-F6] a full pool never refuses a new identity; boxed windows survive the flood', () => {
    useFakeClock('2026-10-23T10:00:00Z');
    const w = windows(5);
    for (let i = 0; i < 2; i++) w.hit('ip', 'boxed', 2);
    for (let i = 0; i < 100; i++) w.hit('ip', `flood${i}`, 2);
    expect(w.size('ip')).toBe(5);
    expect(w.peek('ip', 'boxed', 2)).toBe(600);
    // An identity the pool does not track is never refused.
    expect(w.peek('ip', 'newcomer', 2)).toBe(0);
    // Every window at its limit: a new identity goes untracked (allowed), nothing is evicted.
    const full = windows(2);
    for (const id of ['a', 'a', 'b', 'b']) full.hit('ip', id, 2);
    expect(full.hit('ip', 'c', 2)).toBe(false);
    expect(full.reserve([ip('c')])).toMatchObject({ allowed: true });
    expect([full.peek('ip', 'a', 2), full.peek('ip', 'b', 2), full.size('ip')]).toEqual([600, 600, 2]);
  });

  it('[S8-F6] reserve takes one from every check or none; release frees the window it started', () => {
    useFakeClock('2026-10-23T10:00:00Z');
    const w = windows(10);
    const first = w.reserve([key('k1', 1), ip('a', 5), ip('a', 5)]);
    expect(first.allowed).toBe(true);
    // Duplicate checks count once.
    expect(w.peek('ip', 'a', 1)).toBe(600);
    expect(w.peek('ip', 'a', 2)).toBe(0);
    // The key is used up: the IP is not counted either.
    expect(w.reserve([key('k1', 1), ip('a', 5)])).toMatchObject({ allowed: false, check: { pool: 'key' } });
    expect(w.peek('ip', 'a', 2)).toBe(0);
    if (first.allowed) {
      first.release();
      first.release();
    }
    expect([w.size('key'), w.size('ip')]).toEqual([0, 0]);
  });

  it('[S8-F6] expired windows are swept; a full pool evicts its oldest window under its limit', () => {
    const clock = useFakeClock('2026-10-23T10:00:00Z');
    const w = windows(3);
    w.hit('ip', 'boxed', 1);
    w.hit('ip', 'x', 5);
    w.hit('ip', 'y', 5);
    w.hit('ip', 'z', 5);
    // `x` (oldest under its limit) went, `boxed` stayed.
    expect([w.peek('ip', 'boxed', 1), w.peek('ip', 'x', 1), w.peek('ip', 'z', 1)]).toEqual([600, 0, 600]);
    clock.advance(600_000);
    expect(w.hit('ip', 'late', 5)).toBe(true);
    expect(w.size('ip')).toBe(1);
  });
});

describe('local fixed windows (S8-F9)', () => {
  afterEach(() => restoreClock());

  it('[S8-F9] a full pool evicts a window under its limit wherever it sits, past any number of boxed windows', () => {
    useFakeClock('2026-10-23T10:00:00Z');
    const w = windows(1_000);
    for (let i = 0; i < 999; i++) w.hit('ip', `boxed${i}`, 1);
    w.hit('ip', 'open', 5);
    expect(w.size('ip')).toBe(1_000);
    // The only window under its limit is the newest, 999 boxed windows ahead of it: it goes, the newcomer is tracked.
    expect(w.hit('ip', 'newcomer', 5)).toBe(true);
    expect([w.peek('ip', 'open', 1), w.peek('ip', 'newcomer', 1), w.peek('ip', 'boxed0', 1)]).toEqual([0, 600, 600]);
    // A window back under its limit after a release is a candidate again.
    const two = windows(2);
    two.hit('ip', 'a', 1);
    two.hit('ip', 'b', 2);
    const held = two.reserve([ip('b', 2)]);
    expect(two.hit('ip', 'c', 1)).toBe(false);
    if (held.allowed) held.release();
    expect(two.hit('ip', 'c', 1)).toBe(true);
    expect([two.peek('ip', 'a', 1), two.peek('ip', 'b', 1), two.peek('ip', 'c', 1)]).toEqual([600, 0, 600]);
  });

  it('[S8-F9] enforce: false counts past the limit and never refuses; untracked checks are reported', () => {
    useFakeClock('2026-10-23T10:00:00Z');
    const w = windows(1);
    for (let i = 0; i < 4; i++) expect(w.reserve([{ ...ip('a'), enforce: false }])).toMatchObject({ allowed: true });
    // The window kept counting: an enforced check sees it over its limit.
    expect(w.reserve([ip('a')])).toMatchObject({ allowed: false, retryAfterSeconds: 600 });
    // The pool (1) holds a boxed window: a new identity is untracked, and says so.
    expect(w.reserve([ip('b'), key('k')])).toMatchObject({ allowed: true, untracked: 1 });
    expect([w.size('ip'), w.size('key')]).toEqual([1, 1]);
  });

  it('[S8-F9] saturated: only after the pool had to evict or leave one untracked, for one window length', () => {
    const clock = useFakeClock('2026-10-23T10:00:00Z');
    const w = windows(2);
    w.hit('ip', 'a', 5);
    w.hit('ip', 'b', 5);
    // Full but nothing pushed out yet; another pool's pressure is its own.
    expect(w.saturated('ip')).toBe(false);
    w.hit('ip', 'c', 5);
    expect([w.saturated('ip'), w.saturated('key')]).toEqual([true, false]);
    clock.advance(600_000);
    expect(w.saturated('ip')).toBe(false);
  });

  it('[S8-F9] a window takes the current limit: a tier raised mid-window makes a boxed window evictable again', () => {
    useFakeClock('2026-10-23T10:00:00Z');
    const w = windows(2);
    w.hit('ip', 'a', 1);
    w.hit('ip', 'b', 1);
    expect(w.hit('ip', 'c', 1)).toBe(false);
    // `a`'s limit goes up to 5 (count 2 < 5): back in the under-limit list, so the next newcomer evicts it.
    w.hit('ip', 'a', 5);
    expect(w.hit('ip', 'd', 1)).toBe(true);
    expect([w.peek('ip', 'a', 1), w.peek('ip', 'b', 1), w.peek('ip', 'd', 1)]).toEqual([0, 600, 600]);
  });
});
