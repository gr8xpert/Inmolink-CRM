import { describe, expect, it } from 'vitest';
import type { StaffCtx } from '../../../context';
import { ANOMALY } from '../config';
import { massWithdrawal, typicalVolume, volumeSpike } from '../guard';
import { canStaff } from '../policy';

describe('import anomaly guard', () => {
  it('[S6-08] typical volume: the median of the last successful runs, none before there are enough', () => {
    expect(typicalVolume([])).toBeNull();
    expect(typicalVolume([100, 100])).toBeNull(); // fewer than MIN_BASELINE_RUNS
    expect(typicalVolume([100, 300, 200])).toBe(200);
    expect(typicalVolume([100, 300, 200, 400])).toBe(250);
    // only the newest BASELINE_RUNS count: an old outlier ages out
    expect(typicalVolume([10, 10, 10, 10, 10, 10_000])).toBe(10);
    expect(ANOMALY.BASELINE_RUNS).toBe(5);
  });

  it('[S6-08] more than 5× the typical volume is a spike; small feeds and missing baselines never are', () => {
    expect(volumeSpike(500, 100, 5)).toBeNull();
    expect(volumeSpike(501, 100, 5)).toEqual({ items: 501, typical: 100, factor: 5 });
    expect(volumeSpike(1_000_000, null, 5)).toBeNull();
    expect(volumeSpike(500, ANOMALY.MIN_BASELINE_ITEMS - 1, 5)).toBeNull();
  });

  it('[S6-08] more than 30% of the live listings vanishing at once is a mass withdrawal (40% pauses, 30% does not)', () => {
    expect(massWithdrawal(100, 40, 0.3)).toEqual({ missing: 40, live: 100, ratio: 0.3 });
    expect(massWithdrawal(100, 30, 0.3)).toBeNull();
    expect(massWithdrawal(ANOMALY.MIN_LIVE_FOR_DROP - 1, 9, 0.3)).toBeNull();
  });

  it('[S6-08] staff: every role reads import health; data ops and super admins resume a paused feed', () => {
    const staff = (role: string) =>
      ({ tx: {}, actor: { kind: 'staff', userId: 'u', role }, locale: 'en', requestId: 'r' }) as unknown as StaffCtx;
    for (const role of ['SUPER_ADMIN', 'STAFF_SUPPORT', 'STAFF_DATA_OPS']) {
      expect(canStaff(staff(role), 'staff.imports.read')).toBe(true);
    }
    expect(canStaff(staff('SUPER_ADMIN'), 'staff.imports.resume')).toBe(true);
    expect(canStaff(staff('STAFF_DATA_OPS'), 'staff.imports.resume')).toBe(true);
    expect(canStaff(staff('STAFF_SUPPORT'), 'staff.imports.resume')).toBe(false);
  });
});
