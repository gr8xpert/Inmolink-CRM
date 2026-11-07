import { WINDOW_CARDS_MAX } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { listingIdsOf } from './ids';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('window cards entry point (R2-06)', () => {
  it('[R2-06] takes the comma-separated listing ids the table hands over', () => {
    expect(listingIdsOf(`${id(1)},${id(2)}`)).toEqual([id(1), id(2)]);
  });

  it('[R2-06] anything invalid, duplicated or over the batch limit is nothing', () => {
    expect(listingIdsOf(undefined)).toEqual([]);
    expect(listingIdsOf('nope')).toEqual([]);
    expect(listingIdsOf(`${id(1)},${id(1)}`)).toEqual([]);
    expect(listingIdsOf(Array.from({ length: WINDOW_CARDS_MAX + 1 }, (_, i) => id(i)).join(','))).toEqual([]);
    expect(listingIdsOf(Array.from({ length: WINDOW_CARDS_MAX }, (_, i) => id(i)).join(',')).length).toBe(
      WINDOW_CARDS_MAX,
    );
  });
});
