import { describe, expect, it } from 'vitest';
import {
  explainMatch,
  explanationText,
  type MatchListingFacts,
  type MatchProfileCriteria,
  NEUTRAL_SEMANTIC,
  passesHardFilters,
  scoreMatch,
} from '../explain';
import {
  EVENT_KEY_TIERS,
  listingEventKeyTiers,
  listingMatchKeys,
  profileMatchKeys,
  profileProbeKeys,
} from '../match-keys';

/** Match explanations (R2-02b): fixtures for each satisfied / unsatisfied criterion, the tolerances and the scores. */

const COUNTRY = '00000000-0000-7000-8000-000000000001';
const CITY = '00000000-0000-7000-8000-000000000002';
const AREA = '00000000-0000-7000-8000-000000000003';
const OTHER_CITY = '00000000-0000-7000-8000-000000000004';
const VILLA = '00000000-0000-7000-8000-000000000010';
const F = [0, 1, 2, 3, 4].map((i) => `00000000-0000-7000-8000-00000000002${i}`);

const profile = (extra: Partial<MatchProfileCriteria> = {}): MatchProfileCriteria => ({
  transactionType: 'SALE',
  propertyTypeIds: [VILLA],
  locationIds: [CITY],
  featureIds: [F[0] as string, F[1] as string],
  priceMinCents: null,
  priceMaxCents: 50_000_000,
  bedsMin: 3,
  bathsMin: null,
  areaMinM2: 100,
  areaMaxM2: null,
  ...extra,
});

const listing = (extra: Partial<MatchListingFacts> = {}): MatchListingFacts => ({
  transactionType: 'SALE',
  propertyTypeId: VILLA,
  locationIds: [COUNTRY, CITY, AREA],
  featureIds: [F[0] as string, F[1] as string, F[2] as string],
  priceCents: 48_000_000,
  beds: 4,
  baths: 2,
  areaM2: 180,
  ...extra,
});

describe('match explanations (R2-02b)', () => {
  it('[R2-02b] all criteria met: every one satisfied, within budget', () => {
    const e = explainMatch(profile(), listing());
    expect(e.satisfied).toEqual(['transaction', 'propertyType', 'location', 'price', 'bedrooms', 'area', 'mustHaves']);
    expect(e.unsatisfied).toEqual([]);
    expect(e.priceDeltaPct).toBe(-4);
    expect(e.mustHaves).toEqual({ met: 2, total: 2 });
    expect(passesHardFilters(e)).toBe(true);
    const text = explanationText(e, 'en');
    expect(text.summary).toBe('7/7 criteria met');
    expect(text.lines).toContain('Within budget');
    expect(text.lines).toContain('2/2 must-haves');
  });

  it('[R2-02b] over budget: 6% over is a near miss (unsatisfied, still a match); 12% over is refused', () => {
    const e = explainMatch(profile(), listing({ priceCents: 53_000_000 }));
    expect(e.unsatisfied).toEqual(['price']);
    expect(e.priceDeltaPct).toBe(6);
    expect(passesHardFilters(e)).toBe(true);
    expect(explanationText(e, 'en').lines).toContain('6% over budget');
    expect(explanationText(e, 'es').lines).toContain('6 % por encima del presupuesto');
    expect(explanationText(e, 'es').summary).toBe('6/7 criterios cumplidos');
    // exactly 10% over still passes; beyond does not
    expect(passesHardFilters(explainMatch(profile(), listing({ priceCents: 55_000_000 })))).toBe(true);
    const far = explainMatch(profile(), listing({ priceCents: 56_000_000 }));
    expect(far.unsatisfied).toEqual(['price']);
    expect(passesHardFilters(far)).toBe(false);
    // the minimum is strict; price on request with a budget is unsatisfied and refused
    expect(passesHardFilters(explainMatch(profile({ priceMinCents: 49_000_000 }), listing()))).toBe(false);
    const onRequest = explainMatch(profile(), listing({ priceCents: null }));
    expect(onRequest).toMatchObject({ unsatisfied: ['price'], priceOnRequest: true, priceDeltaPct: null });
    expect(passesHardFilters(onRequest)).toBe(false);
    expect(explanationText(onRequest, 'en').lines).toContain('Price on request');
  });

  it('[R2-02b] a missing must-have: 4/5 passes (a quarter may miss), 1/2 does not', () => {
    const five = profile({ featureIds: F });
    const e = explainMatch(five, listing({ featureIds: F.slice(0, 4) }));
    expect(e.unsatisfied).toEqual(['mustHaves']);
    expect(e.mustHaves).toEqual({ met: 4, total: 5 });
    expect(passesHardFilters(e)).toBe(true);
    expect(explanationText(e, 'en').lines).toContain('4/5 must-haves');
    expect(explanationText(e, 'es').lines).toContain('4/5 imprescindibles');
    expect(passesHardFilters(explainMatch(five, listing({ featureIds: F.slice(0, 3) })))).toBe(false);
    expect(passesHardFilters(explainMatch(profile(), listing({ featureIds: [F[0] as string] })))).toBe(false);
  });

  it('[R2-02b] wrong area, too few bedrooms, too small: unsatisfied and refused', () => {
    const away = explainMatch(profile(), listing({ locationIds: [COUNTRY, OTHER_CITY] }));
    expect(away.unsatisfied).toEqual(['location']);
    expect(passesHardFilters(away)).toBe(false);
    expect(explanationText(away, 'en').lines).toContain('Outside the wanted areas');
    const small = explainMatch(profile(), listing({ beds: 2, areaM2: null }));
    expect(small.unsatisfied).toEqual(['bedrooms', 'area']);
    expect(passesHardFilters(small)).toBe(false);
    // a profile without criteria is satisfied by anything (no criteria listed)
    const open = profile({
      transactionType: null,
      propertyTypeIds: [],
      locationIds: [],
      featureIds: [],
      priceMaxCents: null,
      bedsMin: null,
      areaMinM2: null,
    });
    expect(explainMatch(open, listing())).toMatchObject({ criteria: [], satisfied: [], unsatisfied: [] });
  });

  it('[R2-02b] the total: hard fit and the semantic score (neutral without vectors), near misses score lower', () => {
    const all = explainMatch(profile(), listing());
    expect(scoreMatch(all, null)).toEqual({ hard: 1, semantic: null, boost: 0, total: 0.7 + 0.3 * NEUTRAL_SEMANTIC });
    expect(scoreMatch(all, 0.9).total).toBeCloseTo(0.97);
    expect(scoreMatch(all, -0.2).semantic).toBe(0);
    const over = scoreMatch(explainMatch(profile(), listing({ priceCents: 53_000_000 })), null);
    expect(over.hard).toBeLessThan(1);
    expect(over.hard).toBeGreaterThan(0.9);
  });

  it('[R2-02b] keys: a listing shares a key with a profile that may see it, and only then', () => {
    const p = { agencyId: 'A', transactionType: 'SALE', locationIds: [CITY] };
    const own = listingMatchKeys({
      ownerAgencyId: 'A',
      transactionType: 'SALE',
      locationIds: [COUNTRY, CITY],
      network: false,
    });
    const net = listingMatchKeys({
      ownerAgencyId: 'B',
      transactionType: 'SALE',
      locationIds: [COUNTRY, CITY],
      network: true,
    });
    const notShared = listingMatchKeys({
      ownerAgencyId: 'B',
      transactionType: 'SALE',
      locationIds: [CITY],
      network: false,
    });
    const rent = listingMatchKeys({
      ownerAgencyId: 'A',
      transactionType: 'RENT_LONG_TERM',
      locationIds: [CITY],
      network: true,
    });
    const hit = (a: string[], b: string[]) => a.some((k) => b.includes(k));
    expect(hit(profileMatchKeys(p), own)).toBe(true);
    expect(hit(profileMatchKeys(p), net)).toBe(true);
    expect(hit(profileMatchKeys(p), notShared)).toBe(false);
    expect(hit(profileMatchKeys(p), rent)).toBe(false);
    // the network is closed to the profile's agency: its probe keeps only its own keys
    expect(hit(profileProbeKeys(p, false), net)).toBe(false);
    expect(hit(profileProbeKeys(p, false), own)).toBe(true);
    // anywhere, any transaction
    expect(hit(profileMatchKeys({ agencyId: 'C', transactionType: null, locationIds: [] }), rent)).toBe(true);
    // a changed listing probes only its places below the country, never `*`: broad profiles are swept instead
    const event = listingEventKeyTiers({
      ownerAgencyId: 'B',
      transactionType: 'SALE',
      locationIds: [COUNTRY, CITY],
      network: true,
    }).flat();
    expect(hit(profileMatchKeys(p), event)).toBe(true);
    expect(hit(profileMatchKeys({ agencyId: 'C', transactionType: null, locationIds: [] }), event)).toBe(false);
    expect(hit(profileMatchKeys({ agencyId: 'C', transactionType: 'SALE', locationIds: [COUNTRY] }), event)).toBe(
      false,
    );
  });

  it('[R2-02f] a changed listing probes its places a tier at a time, the most specific first', () => {
    const l = { ownerAgencyId: 'B', transactionType: 'SALE', locationIds: ['C', 'R', 'T', 'A'], network: true };
    const tiers = listingEventKeyTiers(l);
    expect(tiers).toHaveLength(EVENT_KEY_TIERS);
    expect(tiers[0]).toEqual(['a:B:*:A', 'a:B:SALE:A', 'n:*:A', 'n:SALE:A']);
    expect(tiers[1]).toEqual(['a:B:*:T', 'a:B:SALE:T', 'n:*:T', 'n:SALE:T']);
    expect(tiers[2]).toEqual(['a:B:*:R', 'a:B:SALE:R', 'n:*:R', 'n:SALE:R']);
    // never the country, never `*`
    expect(tiers.flat().some((k) => k.endsWith(':C') || k.endsWith(':*'))).toBe(false);
    // off the network: own keys only; no area: the city leads and the last tier is empty
    expect(listingEventKeyTiers({ ...l, locationIds: ['C', 'R', 'T'], network: false })).toEqual([
      ['a:B:*:T', 'a:B:SALE:T'],
      ['a:B:*:R', 'a:B:SALE:R'],
      [],
    ]);
    expect(listingEventKeyTiers({ ...l, locationIds: ['C'] })).toEqual([[], [], []]);
  });
});
