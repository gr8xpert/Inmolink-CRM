import { describe, expect, it } from 'vitest';
import { CommissionSplitBp, CreateDevelopmentBody, UpdateDevelopmentBody } from './developments';

const base = { ref: 'D1', name: 'Marbella Heights', locationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' };

describe('development commission split (S17-F5)', () => {
  it('[S17-F5] a split outside 0–10000 or not an integer is rejected', () => {
    for (const bad of [-1, 10_001, 50.5, Number.NaN, '5000', null]) {
      expect(CommissionSplitBp.safeParse(bad).success, String(bad)).toBe(false);
      expect(UpdateDevelopmentBody.safeParse({ version: 1, commissionSplitBp: bad }).success, String(bad)).toBe(false);
      expect(CreateDevelopmentBody.safeParse({ ...base, commissionSplitBp: bad }).success, String(bad)).toBe(false);
    }
    for (const good of [0, 1, 5000, 10_000]) {
      expect(UpdateDevelopmentBody.parse({ version: 1, commissionSplitBp: good }).commissionSplitBp).toBe(good);
    }
    // Left out: the database default (5000) applies.
    expect(CreateDevelopmentBody.parse(base).commissionSplitBp).toBeUndefined();
  });
});
