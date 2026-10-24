import { describe, expect, it } from 'vitest';
import { isRank, RANK_MAX_CHARS, rankBetween, spreadRank, timeRank } from '../rank';

/** Board ranks (S10-03): a key strictly between any two, never ending in 0; time keys sort the newest first. */

describe('board ranks', () => {
  it('[S10-03] a drop gets a key strictly between its neighbours, at the top, the bottom and in any gap', () => {
    for (const [a, b] of [
      ['', null],
      ['', '1'],
      ['', '01'],
      ['4', '5'],
      ['4', '4i'],
      ['4z', '5'],
      ['a', 'b1'],
      ['zz', null],
      ['0001', '0002'],
    ] as const) {
      const k = rankBetween(a, b);
      expect(isRank(k), `${a}|${b} → ${k}`).toBe(true);
      expect(k > a, `${a} < ${k}`).toBe(true);
      if (b !== null) expect(k < b, `${k} < ${b}`).toBe(true);
    }
    expect(() => rankBetween('5', '5')).toThrow();
  });

  it('[S10-03] repeated drops keep a strict order and short keys (no renumbering)', () => {
    // a column of 200 cards built by random drops: the keys stay sorted as the cards were placed
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const column: string[] = [];
    for (let i = 0; i < 200; i++) {
      const at = Math.floor(random() * (column.length + 1));
      const key = rankBetween(column[at - 1] ?? '', column[at] ?? null);
      column.splice(at, 0, key);
    }
    expect([...column].sort()).toEqual(column);
    expect(new Set(column).size).toBe(column.length);
    expect(Math.max(...column.map((k) => k.length))).toBeLessThan(20);
    // the worst case — always the same gap — grows about one digit per five drops, far from the cap
    let lo = '';
    const hi = 'i';
    for (let i = 0; i < 100; i++) lo = rankBetween(lo, hi);
    expect(lo.length).toBeLessThan(RANK_MAX_CHARS / 4);
  });

  it('[S10-03] time keys sort the newest lead first and are valid ranks', () => {
    const id = '01900000-0000-7000-8000-00000000abcd';
    const older = timeRank(new Date('2026-10-01T10:00:00.000Z'), id);
    const newer = timeRank(new Date('2026-10-01T10:00:00.001Z'), id);
    expect(newer < older).toBe(true);
    expect(isRank(older)).toBe(true);
    expect(older).toMatch(/^[0-9a-z]{9}abcdi$/);
    // a drag to the top of a column of time keys stays ahead of the newest
    expect(rankBetween('', newer) < newer).toBe(true);
  });

  it('[S10-03] a rebalanced column gets short, strictly increasing keys with room between each two', () => {
    for (const total of [1, 35, 36, 1_300, 10_000]) {
      const keys = Array.from({ length: total }, (_, i) => spreadRank(i, total));
      expect([...keys].sort()).toEqual(keys);
      expect(new Set(keys).size).toBe(total);
      expect(keys.every(isRank)).toBe(true);
      expect(isRank(rankBetween(keys[0] ?? '', keys[1] ?? null))).toBe(true);
    }
    expect(spreadRank(9_999, 10_000)).toHaveLength(4);
  });
});
