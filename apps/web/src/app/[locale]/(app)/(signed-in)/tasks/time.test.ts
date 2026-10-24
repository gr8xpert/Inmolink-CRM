import { describe, expect, it } from 'vitest';
import { dayBounds, parseLocalDateTime } from './time';

const MADRID = 'Europe/Madrid';

describe('tasks page time zone', () => {
  it('[S10-05] a day is the agency’s calendar day (summer and winter, and the 23-hour day)', () => {
    const summer = dayBounds(new Date('2026-07-10T22:30:00Z'), MADRID); // 00:30 on the 11th in Madrid
    expect(summer.start.toISOString()).toBe('2026-07-10T22:00:00.000Z');
    expect(summer.end.toISOString()).toBe('2026-07-11T22:00:00.000Z');
    const winter = dayBounds(new Date('2026-01-10T12:00:00Z'), MADRID);
    expect(winter.start.toISOString()).toBe('2026-01-09T23:00:00.000Z');
    const springForward = dayBounds(new Date('2026-03-29T12:00:00Z'), MADRID);
    expect(springForward.end.getTime() - springForward.start.getTime()).toBe(23 * 3_600_000);
  });

  it('[S10-05] a datetime-local value is read in the zone', () => {
    expect(parseLocalDateTime('2026-10-24T09:30', MADRID)?.toISOString()).toBe('2026-10-24T07:30:00.000Z');
    expect(parseLocalDateTime('2026-12-24T09:30', MADRID)?.toISOString()).toBe('2026-12-24T08:30:00.000Z');
    expect(parseLocalDateTime('tomorrow', MADRID)).toBeNull();
  });
});
