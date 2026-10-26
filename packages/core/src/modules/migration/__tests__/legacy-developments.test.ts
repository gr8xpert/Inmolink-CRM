import { describe, expect, it } from 'vitest';
import { transformLegacyDevelopments } from '../legacy-developments';
import { contentLocale, finishReport, newLoadReport, slugify } from '../load';

/** The legacy new-build transform (S4-04): pure, no database. */

const LOC = '00000000-0000-4000-8000-0000000000a1';
const TYPE = '00000000-0000-4000-8000-0000000000b1';
const KNOWN = '00000000-0000-4000-8000-0000000000c1';
const targets = {
  locations: new Map([['10', LOC]]),
  propertyTypes: new Map([['20', TYPE]]),
  units: new Map([['501', KNOWN]]),
};

const dev = (id: number, extra: object = {}) => ({ id, name: `Residencial ${id}`, location_id: 10, ...extra });
const unit = (id: number, development_id: number, extra: object = {}) => ({
  id,
  development_id,
  property_type_id: 20,
  ...extra,
});

describe('legacy developments transform', () => {
  it('[S4-04] maps legacy projects and units onto v2 inputs', () => {
    const report = newLoadReport('L1', 'agency', false);
    const [d] = transformLegacyDevelopments(
      report,
      {
        developments: [
          dev(1, {
            ref: 'MH-1',
            status: 'Under construction',
            completion_date: '2027-06-30T00:00:00Z',
            lat: '36.5101',
            lng: -4.8824,
            commission_percent: 3.5,
            currency: 'eur',
            translations: [
              { locale: 'EN', title: 'Marbella Heights — Phase 1', description: 'Sea views' },
              { locale: 'es_ES', title: null, description: '' },
              { locale: 'en', title: 'ignored: second English text' },
            ],
          }),
        ],
        units: [
          unit(501, 1, { ref: 'B-1', price: '350000.5', built_m2: '95.5', orientation: 'so', status: 'Reservado' }),
          unit(502, 1, { ref: 'B-1', bedrooms: 2, floor: -1 }), // reference taken in the development: derived one
        ],
      },
      targets,
    );
    expect(d).toMatchObject({
      legacyId: '1',
      ref: 'MH-1',
      name: 'Residencial 1',
      status: 'UNDER_CONSTRUCTION',
      completionDate: '2027-06-30',
      locationId: LOC,
      lat: 36.5101,
      lng: -4.8824,
      commissionBp: 350,
      currency: 'EUR',
      texts: [
        {
          locale: 'en',
          title: 'Marbella Heights — Phase 1',
          description: 'Sea views',
          slug: 'marbella-heights-phase-1',
        },
        { locale: 'es-ES', title: 'Residencial 1', description: null, slug: 'residencial-1' },
      ],
    });
    expect(d?.units).toEqual([
      expect.objectContaining({
        legacyId: '501',
        knownId: KNOWN,
        ref: 'B-1',
        propertyTypeId: TYPE,
        priceCents: 35_000_050,
        internalM2: 95.5,
        orientation: 'SW',
        status: 'RESERVED',
      }),
      expect.objectContaining({
        legacyId: '502',
        knownId: null,
        ref: 'L-502',
        bedrooms: 2,
        floor: -1,
        status: 'AVAILABLE',
      }),
    ]);
    expect(report.issues).toEqual([]);
  });

  it('[S4-04] lists every row it cannot load with a reason, and counts the mismatch', () => {
    const report = newLoadReport('L1', 'agency', false);
    report.counts.development = { ...emptyCounts(), legacyRows: 6 };
    const inputs = transformLegacyDevelopments(
      report,
      {
        developments: [
          dev(1),
          dev(1), // duplicate legacy id
          { id: 2, location_id: 10 }, // no name
          dev(3, { location_id: 99 }), // location not mapped
          dev(4, { status: 'demolished' }),
          dev(5, { lat: 36.5 }), // half a coordinate
          null, // a staging line that was not JSON
        ],
        units: [
          unit(601, 1),
          unit(602, 1, { property_type_id: 98 }), // property type not mapped
          unit(603, 3), // its development was not loaded
          unit(604, 777), // its development is not staged
          unit(605, 1, { orientation: 'up' }),
          unit(606, 1, { bedrooms: 'many' }),
        ],
      },
      targets,
    );
    expect(inputs.map((i) => i.legacyId)).toEqual(['1']);
    expect(inputs[0]?.units.map((u) => u.legacyId)).toEqual(['601']);
    const issues = report.issues.map((i) => `${i.entity}:${i.legacyId}:${i.reason}`);
    expect(issues).toEqual(
      expect.arrayContaining([
        'development:1:duplicate',
        'development:2:invalid',
        'development:3:unmapped_location',
        'development:4:invalid',
        'development:5:invalid',
        'development:#7:invalid',
        'unit:602:unmapped_property_type',
        'unit:603:orphan',
        'unit:604:orphan',
        'unit:605:invalid',
        'unit:606:invalid',
      ]),
    );
    expect(issues).toHaveLength(11);
    expect(report.counts.development).toMatchObject({ staged: 7, failed: 6 });
    expect(report.counts.unit).toMatchObject({ staged: 6, failed: 5 });
    // nothing loaded yet: no count matches the inventory
    expect(finishReport(report).matches).toBe(false);
  });

  it('[S4-04] slugs and locales', () => {
    expect(slugify('  Áticos del Mar — Fase II ')).toBe('aticos-del-mar-fase-ii');
    expect(slugify('***')).toBe('');
    expect(contentLocale('EN_gb')).toBe('en-GB');
    expect(contentLocale('english')).toBeNull();
  });
});

function emptyCounts() {
  return { legacyRows: null, staged: 0, created: 0, updated: 0, unchanged: 0, failed: 0, mapped: 0, matches: false };
}
