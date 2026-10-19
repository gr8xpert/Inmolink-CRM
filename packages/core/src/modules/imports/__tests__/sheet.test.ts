import { XmlMapping } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { columnKeys, rowNode } from '../sheet/columns';
import { sheetFileId } from '../sheet/connector';
import { mapXmlRecord, xmlMappedSettings } from '../xml-mapped/mapping';

describe('sheet columns', () => {
  it('[S6-05] headers become unique path-safe keys: accents dropped, odd characters replaced, repeats numbered', () => {
    expect(columnKeys(['Ref', 'Baños', 'Precio (€)', '', 'Ref', 'ref', '2024 price', 'a/b', '@id'])).toEqual([
      'Ref',
      'Banos',
      'Precio',
      'col_4',
      'Ref_2',
      'ref_3',
      'c_2024_price',
      'a_b',
      'id',
    ]);
    expect(columnKeys(['x'.repeat(100)])[0]).toHaveLength(56);
  });

  it('[S6-05] a row maps through the XML mapping rules; empty cells are absent and text starting with = + - @ is data', () => {
    const keys = columnKeys(['Ref', 'Type', 'Price', 'Notes', 'City']);
    const mapping = XmlMapping.parse({
      schemaVersion: 1,
      recordElement: 'row',
      fields: {
        ref: { path: 'Ref' },
        propertyType: { path: 'Type' },
        price: { path: 'Price' },
        city: { path: 'City' },
      },
      translations: [{ locale: 'en', description: { path: 'Notes' } }],
    });
    const result = mapXmlRecord(rowNode(keys, ['A1', 'Villa', '', '=1+1', 'Marbella']), mapping, xmlMappedSettings({}));
    expect(result).toMatchObject({ ok: true, ref: 'A1', item: { priceOnRequest: true, priceCents: null } });
    if (result.ok) expect(result.item.translations?.[0]?.description).toBe('=1+1');
    const bad = mapXmlRecord(rowNode(keys, ['A2', 'Villa', 'abc', '', 'Marbella']), mapping, xmlMappedSettings({}));
    expect(bad).toMatchObject({ ok: false, ref: 'A2', problems: [{ code: 'INVALID_PRICE', field: 'price' }] });
  });

  it('[S6-05] a sheet connection address names its file; anything else is not one', () => {
    const id = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(sheetFileId(`upload://${id}`)).toBe(id);
    expect(sheetFileId(`upload://${id}/../x`)).toBeNull();
    expect(sheetFileId('https://example.com/a.csv')).toBeNull();
    expect(sheetFileId('upload://')).toBeNull();
  });
});
