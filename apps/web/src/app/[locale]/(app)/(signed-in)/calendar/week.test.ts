import { describe, expect, it } from 'vitest';
import { dayKey, weekOf } from './week';

const TZ = 'Europe/Madrid';

describe('calendar week', () => {
  it('[S11-F11] a Canary-Islands agency’s week and day keys follow its zone (an hour behind Madrid)', () => {
    const week = weekOf('2026-07-15', new Date(), 'Atlantic/Canary');
    expect(week.key).toBe('2026-07-13');
    expect(week.start.toISOString()).toBe('2026-07-12T23:00:00.000Z');
    expect(week.end.toISOString()).toBe('2026-07-19T23:00:00.000Z');
    // 23:30 Madrid-summer on the 14th is 22:30 UTC = 23:30 in the Canaries (still the 14th); 00:30 Madrid is the 15th there
    expect(dayKey(new Date('2026-07-14T22:30:00Z'), 'Atlantic/Canary')).toBe('2026-07-14');
    expect(dayKey(new Date('2026-07-14T22:30:00Z'), 'Europe/Madrid')).toBe('2026-07-15');
  });

  it('[S10-06] a week runs Monday to Sunday in the agency’s zone, across a DST change', () => {
    // Sunday 25 October 2026 is the end of summer time in Madrid
    const week = weekOf('2026-10-22', new Date(), TZ);
    expect(week.key).toBe('2026-10-19');
    expect(week.prev).toBe('2026-10-12');
    expect(week.next).toBe('2026-10-26');
    expect(week.days.map((d) => d.key)).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    expect(week.start.toISOString()).toBe('2026-10-18T22:00:00.000Z');
    expect(week.days[6]?.start.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(week.end.toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('[S10-06] an invalid week falls back to the current one; instants map to local days', () => {
    const now = new Date('2026-10-24T23:30:00Z'); // Sunday 01:30 in Madrid
    expect(weekOf('2026-02-30', now, TZ).key).toBe('2026-10-19');
    expect(weekOf(undefined, now, TZ).key).toBe('2026-10-19');
    expect(dayKey(now, TZ)).toBe('2026-10-25');
  });
});
