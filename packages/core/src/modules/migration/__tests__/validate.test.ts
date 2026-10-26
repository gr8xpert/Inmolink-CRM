import type { MigrationValidationReport } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import type { StaffCtx } from '../../../context';
import type * as crm from '../../crm';
import type * as properties from '../../properties';
import { canStaff } from '../policy';
import { compareContact, compareLead, compareListing, settleReport } from '../validate';

/** Validation reports (S14-03): field comparisons, rates and PASS / FAIL — pure logic. */

const LOC = '01900000-0000-7000-8000-000000000001';
const TYPE = '01900000-0000-7000-8000-000000000002';
const POOL = '01900000-0000-7000-8000-000000000003';

const listing = {
  id: 'L1',
  ref: 'R1',
  status: 'available',
  listing_type: 'sale',
  price: 250_000,
  bedrooms: 3,
  built_m2: '120.5',
  location_id: 'loc',
  property_type_id: 'type',
  feature_ids: ['pool', 'sauna'],
};
const v2Listing: properties.LegacyListingSnapshot = {
  id: '01900000-0000-7000-8000-0000000000a1',
  ref: 'R1',
  status: 'ACTIVE',
  transactionType: 'SALE',
  priceCents: 25_000_000,
  currency: 'EUR',
  bedrooms: 3,
  bathrooms: null,
  builtM2: '120.50',
  plotM2: null,
  locationId: LOC,
  propertyTypeId: TYPE,
  featureIds: [POOL],
};
const maps = {
  locations: new Map([['loc', LOC]]),
  types: new Map([['type', TYPE]]),
  // `sauna` has no map: the load left it out (a warning), so it is not expected either
  features: new Map([['pool', POOL]]),
  reasons: new Set<string>(),
};

const report = (over: Partial<MigrationValidationReport> = {}) =>
  settleReport({
    legacyAgencyId: 'A',
    agencyId: '01900000-0000-7000-8000-0000000000b1',
    counts: [
      {
        entity: 'listing',
        legacyRows: 1000,
        staged: 1000,
        mapped: 990,
        explained: 10,
        unexplained: 0,
        issuesByReason: {},
      },
    ],
    images: { legacy: 5000, staged: 5000, expected: 5000, attached: 4990, pending: 0, unexplained: 10 },
    sample: { size: 50, rows: 50, differing: 0, rate: 0, fields: [], samples: [] },
    urls: { checked: 50, failed: 0, rate: 0, checks: [] },
    failedBatches: [],
    ...over,
  });

describe('validation reports (S14-03)', () => {
  it('[S14-03] a listing that arrived as staged matches; a changed field is named, never its value', () => {
    expect(compareListing(listing, v2Listing, maps)).toEqual({ fields: [], explainedFields: [] });
    const changed = compareListing(listing, { ...v2Listing, priceCents: 1, bedrooms: 4, featureIds: [] }, maps);
    expect(changed.fields).toEqual(['price', 'bedrooms', 'features']);
    expect(JSON.stringify(changed)).not.toContain('25000000');
  });

  it('[S14-03] differences the load reported are explained (a reference taken), missing images are not', () => {
    const renamed = { ...v2Listing, ref: 'INL-XYZ' };
    expect(compareListing(listing, renamed, maps).fields).toEqual(['ref']);
    expect(compareListing(listing, renamed, { ...maps, reasons: new Set(['ref_taken']) })).toEqual({
      fields: [],
      explainedFields: ['ref'],
    });
    const images = { expected: 3, attached: 1, pending: 1 };
    expect(compareListing(listing, v2Listing, { ...maps, images }).fields).toEqual(['images']);
    expect(compareListing(listing, v2Listing, { ...maps, images: { ...images, pending: 2 } }).fields).toEqual([]);
  });

  it('[S14-03] contacts compare names, language and identifiers as the load normalized them', () => {
    const v2: crm.LegacyContactSnapshot = {
      id: '01900000-0000-7000-8000-0000000000c1',
      firstName: 'Ana',
      lastName: null,
      language: 'es',
      source: 'IMPORT',
      mergedIntoId: null,
      deleted: false,
      emails: ['ana@example.com'],
      phones: ['+34600123456'],
    };
    const row = { id: 'C1', first_name: 'Ana', email: ' ANA@example.com ', phone: '600 123 456', language: 'ES' };
    const x = { shared: false, reasons: new Set<string>() };
    expect(compareContact(row, v2, x)).toEqual({ fields: [], explainedFields: [] });
    expect(compareContact({ ...row, first_name: 'Anna' }, v2, x).fields).toEqual(['firstName']);
    // one contact took in two legacy contacts (same e-mail): its own values stand
    expect(compareContact({ ...row, first_name: 'Anna' }, v2, { ...x, shared: true })).toEqual({
      fields: [],
      explainedFields: ['firstName'],
    });
  });

  it('[S14-03] leads compare status, source, contact and listing through the maps', () => {
    const v2: crm.LegacyLeadSnapshot = {
      id: '01900000-0000-7000-8000-0000000000d1',
      contactId: 'contact-v2',
      status: 'IN_PROGRESS',
      source: 'WEBSITE',
      targetKind: 'LISTING',
      targetId: 'listing-v2',
    };
    const x = {
      contacts: new Map([['C1', 'contact-v2']]),
      targets: new Map([['L1', 'listing-v2']]),
      reasons: new Set<string>(),
    };
    const row = { id: 'E1', contact_id: 'C1', property_id: 'L1', status: 'contacted', source: 'web' };
    expect(compareLead(row, v2, x)).toEqual({ fields: [], explainedFields: [] });
    expect(compareLead({ ...row, status: 'won' }, v2, x).fields).toEqual(['status']);
    expect(compareLead(row, { ...v2, targetId: null }, { ...x, reasons: new Set(['orphan']) })).toEqual({
      fields: [],
      explainedFields: ['target'],
    });
  });

  it('[S14-03] PASS under 0.5 % unexplained; FAIL at or above it, on a differing sample, a failed URL or batch', () => {
    const pass = report();
    expect(pass.status).toBe('PASS');
    expect(pass.totals).toEqual({ legacy: 6000, unexplained: 10, rate: 10 / 6000 });
    const overCounts = report({
      counts: [
        {
          entity: 'listing',
          legacyRows: 1000,
          staged: 1000,
          mapped: 960,
          explained: 10,
          unexplained: 30,
          issuesByReason: {},
        },
      ],
    });
    expect(overCounts.totals.rate).toBeCloseTo(40 / 6000);
    expect(overCounts.status).toBe('FAIL');
    expect(report({ sample: { size: 50, rows: 50, differing: 1, rate: 0, fields: [], samples: [] } }).status).toBe(
      'FAIL',
    );
    expect(report({ urls: { checked: 50, failed: 1, rate: 0, checks: [] } }).status).toBe('FAIL');
    expect(report({ failedBatches: [{ entity: 'properties', seq: 3, error: 'code=DB_23505' }] }).status).toBe('FAIL');
  });

  it('[S14-03] every active staff role reads the reports; nobody else', () => {
    const staff = (role: StaffCtx['actor']['role']) =>
      ({ actor: { kind: 'staff', userId: 'u', role } }) as unknown as StaffCtx;
    for (const role of ['SUPER_ADMIN', 'STAFF_SUPPORT', 'STAFF_DATA_OPS'] as const) {
      expect(canStaff(staff(role), 'staff.migration.readValidation')).toBe(true);
    }
    expect(canStaff({ actor: { kind: 'user' } } as unknown as StaffCtx, 'staff.migration.readValidation')).toBe(false);
  });
});
