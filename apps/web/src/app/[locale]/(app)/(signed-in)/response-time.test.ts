import { describe, expect, it } from 'vitest';
import { durationParts } from './response-time';

describe('response time display', () => {
  it('[S10-09] reads seconds, minutes, then hours and minutes', () => {
    expect(durationParts(0)).toEqual({ unit: 'seconds', value: 0 });
    expect(durationParts(59.4)).toEqual({ unit: 'seconds', value: 59 });
    expect(durationParts(60)).toEqual({ unit: 'minutes', value: 1 });
    expect(durationParts(3_599)).toEqual({ unit: 'minutes', value: 59 });
    expect(durationParts(3_600)).toEqual({ unit: 'hours', hours: 1, minutes: 0 });
    expect(durationParts(3 * 3_600 + 20 * 60 + 59)).toEqual({ unit: 'hours', hours: 3, minutes: 20 });
  });
});
