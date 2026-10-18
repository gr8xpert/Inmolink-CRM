import { NetworkSearchBody } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { type CommissionTerms, giveToGetGate, networkCommission, networkFilter } from '../network';

const DAY = 86_400_000;
const created = new Date('2026-09-01T00:00:00Z');
const gate = (over: Partial<Parameters<typeof giveToGetGate>[0]>) =>
  giveToGetGate({
    exempt: false,
    sharedListings: 0,
    createdAt: created,
    now: created,
    minShared: 5,
    graceDays: 30,
    ...over,
  });

describe('give-to-get gate', () => {
  it('[S5-05] agency below the give-to-get threshold after grace is LOCKED (the upsell state)', () => {
    const g = gate({ sharedListings: 4, now: new Date(created.getTime() + 31 * DAY) });
    expect(g).toEqual({
      state: 'LOCKED',
      sharedListings: 4,
      threshold: 5,
      graceEndsAt: new Date(created.getTime() + 30 * DAY).toISOString(),
    });
  });

  it('[S5-05] grace period, the threshold and the staff exemption each open the network', () => {
    expect(gate({ now: new Date(created.getTime() + 29 * DAY) }).state).toBe('GRACE');
    expect(gate({ sharedListings: 5, now: new Date(created.getTime() + 90 * DAY) }).state).toBe('OPEN');
    expect(gate({ exempt: true, now: new Date(created.getTime() + 90 * DAY) }).state).toBe('EXEMPT');
    // From config: no grace, a higher threshold.
    expect(gate({ sharedListings: 5, minShared: 10, graceDays: 0 }).state).toBe('LOCKED');
  });
});

const terms = (over: Partial<CommissionTerms>): CommissionTerms => ({
  priceCents: 50_000_000,
  priceOnRequest: false,
  currency: 'EUR',
  commissionBp: 500,
  commissionFixedCents: null,
  commissionCurrency: 'EUR',
  splitBp: 5000,
  includesVat: false,
  ...over,
});

describe('network commission', () => {
  it('[S5-05] each result shows total %, split and own earnings = price × commission_bp × split_bp', () => {
    // €500,000 × 5 % × 50 % = €12,500
    expect(networkCommission(terms({}))).toEqual({
      type: 'PCT',
      totalBp: 500,
      fixed: null,
      splitBp: 5000,
      includesVat: false,
      viewerEarnings: { amountCents: 1_250_000, currency: 'EUR' },
    });
    // €1,234,567.89 × 3.75 % × 40 % = €18,518.518… → rounded down to the cent
    expect(
      networkCommission(terms({ priceCents: 123_456_789, commissionBp: 375, splitBp: 4000 }))?.viewerEarnings,
    ).toEqual({ amountCents: 1_851_851, currency: 'EUR' });
    // Exact beyond a double's integer range: €90 bn × 100 % × 100 %
    expect(
      networkCommission(terms({ priceCents: 9_000_000_000_000, commissionBp: 10_000, splitBp: 10_000 }))?.viewerEarnings
        ?.amountCents,
    ).toBe(9_000_000_000_000);
  });

  it('[S5-05] a fixed commission earns the fixed amount × split_bp; no price or no split earns nothing shown', () => {
    expect(
      networkCommission(terms({ commissionBp: null, commissionFixedCents: 1_000_001, commissionCurrency: 'GBP' })),
    ).toEqual({
      type: 'FIXED',
      totalBp: null,
      fixed: { amountCents: 1_000_001, currency: 'GBP' },
      splitBp: 5000,
      includesVat: false,
      viewerEarnings: { amountCents: 500_000, currency: 'GBP' },
    });
    expect(networkCommission(terms({ priceOnRequest: true }))?.viewerEarnings).toBeNull();
    expect(networkCommission(terms({ splitBp: null }))).toMatchObject({ splitBp: null, viewerEarnings: null });
    expect(networkCommission(terms({ commissionBp: null }))).toBeNull();
  });
});

describe('network filter', () => {
  const scope = {
    self: 'self',
    preferring: ['p1'],
    preferred: ['mine1'],
  };
  const q = (over: NetworkSearchBody = {}) => NetworkSearchBody.parse(over);

  it("[S5-05] never PRIVATE, never PREFERRED of a non-preferring owner, never the caller's own", () => {
    const f = networkFilter(scope, q());
    expect(f).toMatchObject({
      op: 'and',
      filters: [
        {
          op: 'or',
          filters: [
            {
              op: 'and',
              filters: [
                { op: 'eq', field: 'kind', value: 'LISTING' },
                // PRIVATE listings have no document; RESTRICTED units are not listings
                { op: 'in', field: 'visibility', values: ['PUBLIC', 'SHARED'] },
                {
                  op: 'or',
                  filters: [
                    { op: 'eq', field: 'shareScope', value: 'ALL' },
                    { op: 'in', field: 'ownerAgencyId', values: ['p1'] },
                  ],
                },
              ],
            },
            {
              op: 'and',
              filters: [
                { op: 'eq', field: 'kind', value: 'UNIT' },
                {
                  op: 'or',
                  filters: [
                    { op: 'eq', field: 'visibility', value: 'PUBLIC' },
                    { op: 'eq', field: 'allowedAgencyIds', value: 'self' },
                  ],
                },
              ],
            },
          ],
        },
        { op: 'not', filter: { op: 'eq', field: 'ownerAgencyId', value: 'self' } },
        { op: 'in', field: 'status', values: ['ACTIVE', 'AVAILABLE'] },
      ],
    });
    // Nobody prefers the caller: shared-with-ALL only.
    const none = networkFilter({ ...scope, preferring: [] }, q());
    expect(JSON.stringify(none)).not.toContain('"ownerAgencyId","values"');
  });

  it('[S5-05] preferred agencies only, new-builds only', () => {
    const f = networkFilter(scope, q({ preferredOnly: true, newBuilds: true }));
    expect(f.op === 'and' && f.filters).toEqual(
      expect.arrayContaining([
        { op: 'in', field: 'ownerAgencyId', values: ['mine1'] },
        { op: 'eq', field: 'kind', value: 'UNIT' },
      ]),
    );
  });
});
