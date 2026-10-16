import { describe, expect, it } from 'vitest';
import { parseCsv, priceListFromCsv, priceToCents, unitsFromCsv } from './csv';

const TYPE = '01900000-0000-7000-8000-000000000001';
const typeId = (v: string) => (v.toLowerCase() === 'apartment' || v === TYPE ? TYPE : null);

describe('development CSVs', () => {
  it('[S4-03] parses comma and semicolon files with quotes and CRLF', () => {
    expect(parseCsv('ref,type\r\n"A-1, east",Apartment\r\n')).toEqual([
      ['ref', 'type'],
      ['A-1, east', 'Apartment'],
    ]);
    expect(parseCsv('﻿ref;price\nA-1;"250.000"')).toEqual([
      ['ref', 'price'],
      ['A-1', '250.000'],
    ]);
  });

  it('[S4-03] reads prices in the usual spellings, empty as on request', () => {
    expect(priceToCents('850000')).toBe(85_000_000);
    expect(priceToCents('850.000')).toBe(85_000_000);
    expect(priceToCents('850,000')).toBe(85_000_000);
    expect(priceToCents('1.250.000,50 €')).toBe(125_000_050);
    expect(priceToCents('1,250,000.50')).toBe(125_000_050);
    expect(priceToCents('99.5')).toBe(9_950);
    expect(priceToCents('')).toBeNull();
    expect(priceToCents('call us')).toBeUndefined();
  });

  it('[S4-03] turns a unit CSV into units, the type by name', () => {
    const csv =
      'Ref;Type;Bedrooms;Internal m2;Floor;Orientation;Price;Status\nA-1;Apartment;2;85,5;0;sw;250000;\nA-2;apartment;3;;1;;;reserved';
    expect(unitsFromCsv(csv, typeId)).toEqual({
      units: [
        {
          ref: 'A-1',
          propertyTypeId: TYPE,
          bedrooms: 2,
          internalM2: 85.5,
          floor: 0,
          orientation: 'SW',
          priceCents: 25_000_000,
        },
        {
          ref: 'A-2',
          propertyTypeId: TYPE,
          bedrooms: 3,
          internalM2: null,
          floor: 1,
          priceCents: null,
          status: 'RESERVED',
        },
      ],
      problems: [],
    });
  });

  it('[S4-03] names every bad line and column, and sends nothing then', () => {
    const csv = 'ref,type,bedrooms,status\nA-1,Villa,2,\nA-1,Apartment,two,GONE\n,Apartment,,';
    const { units, problems } = unitsFromCsv(csv, typeId);
    expect(units).toEqual([]);
    expect(problems).toEqual([
      { line: 2, column: 'type', reason: 'unknownType' },
      { line: 3, column: 'ref', reason: 'duplicate' },
      { line: 3, column: 'bedrooms', reason: 'invalid' },
      { line: 3, column: 'status', reason: 'invalid' },
      { line: 4, column: 'ref', reason: 'required' },
    ]);
    expect(unitsFromCsv('name,price\nx,1', typeId).problems).toEqual([{ line: 1, column: 'file', reason: 'noHeader' }]);
  });

  it('[S4-03] reads a price list: ref, price (empty: on request) and an optional status', () => {
    expect(priceListFromCsv('ref;price;status\nA-1;260.000;\nA-2;;SOLD')).toEqual({
      entries: [
        { ref: 'A-1', priceCents: 26_000_000 },
        { ref: 'A-2', priceCents: null, status: 'SOLD' },
      ],
      problems: [],
    });
    expect(priceListFromCsv('ref,price\nA-1,abc\nA-1,1').problems).toEqual([
      { line: 2, column: 'price', reason: 'invalid' },
      { line: 3, column: 'ref', reason: 'duplicate' },
    ]);
  });
});
