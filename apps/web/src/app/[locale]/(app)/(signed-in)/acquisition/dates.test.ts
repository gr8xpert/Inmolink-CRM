import { describe, expect, it } from 'vitest';
import { dayKey, groupByDay, localInputValue } from './dates';

const TZ = 'Europe/Madrid';

describe('acquisition dates', () => {
  it('[S10-07] the by-date view groups follow-ups by the agency’s day, not UTC’s', () => {
    // 23:30 UTC on the 24th is already the 25th in Madrid (UTC+2 in October)
    const items = [
      { id: 'a', at: new Date('2026-10-24T08:00:00Z') },
      { id: 'b', at: new Date('2026-10-24T22:30:00Z') },
      { id: 'c', at: new Date('2026-10-24T23:30:00Z') },
    ];
    expect(dayKey(new Date('2026-10-24T23:30:00Z'), TZ)).toBe('2026-10-25');
    expect(groupByDay(items, (i) => i.at, TZ).map((g) => [g.day, g.items.map((i) => i.id)])).toEqual([
      ['2026-10-24', ['a']],
      ['2026-10-25', ['b', 'c']],
    ]);
  });

  it('[S10-07] a follow-up shows in the edit form at the agency’s wall clock', () => {
    expect(localInputValue(new Date('2026-10-24T07:30:00Z'), TZ)).toBe('2026-10-24T09:30');
    expect(localInputValue(new Date('2026-12-24T07:30:00Z'), TZ)).toBe('2026-12-24T08:30');
  });
});
