import { streamXmlRecords, type XmlElement } from '@inmolink/platform/xml';
import { describe, expect, it } from 'vitest';
import { kyeroPropertyToUnit, looksLikeXml } from '../kyero-units';

/** The Kyero file → unit mapping (R2-07a), pure: no database. */

async function one(xml: string): Promise<XmlElement> {
  async function* src() {
    yield xml;
  }
  for await (const el of streamXmlRecords(src(), { recordElement: 'property' })) return el;
  throw new Error('no property');
}

describe('kyeroPropertyToUnit', () => {
  it('[R2-07] maps id, type, price, beds, baths and areas; a 0 price or plot is none', async () => {
    const el = await one(
      '<property><id>A-1</id><type>Apartment</type><price>325000</price><beds>3</beds><baths>2</baths>' +
        '<surface_area><built>112,5</built><plot>0</plot></surface_area></property>',
    );
    expect(kyeroPropertyToUnit(el, 1, 'EUR')).toEqual({
      ok: true,
      read: {
        position: 1,
        ref: 'A-1',
        typeText: 'Apartment',
        unit: { ref: 'A-1', bedrooms: 3, bathrooms: 2, internalM2: 112.5, plotM2: null, priceCents: 32_500_000 },
      },
    });
    const free = await one('<property><ref>B-2</ref><type>Villa</type><price>0</price></property>');
    expect(kyeroPropertyToUnit(free, 2, 'EUR')).toMatchObject({
      ok: true,
      read: { ref: 'B-2', unit: { priceCents: null, bedrooms: null, internalM2: null } },
    });
  });

  it('[R2-07] names each problem: rental, bad numbers, long id, other currency', async () => {
    const el = await one(
      `<property><id>${'X'.repeat(41)}</id><type>Villa</type><price_freq>week</price_freq><price>1.2.3</price>` +
        '<currency>GBP</currency><beds>two</beds><baths>-1</baths><surface_area><built>big</built></surface_area></property>',
    );
    const r = kyeroPropertyToUnit(el, 7, 'EUR');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => [p.field, p.reason])).toEqual([
      ['id', 'invalid'],
      ['price_freq', 'notSale'],
      ['price', 'invalid'],
      ['beds', 'invalid'],
      ['baths', 'invalid'],
      ['surface_area.built', 'invalid'],
    ]);
    expect(r.problems.every((p) => p.position === 7 && p.ref?.length === 40)).toBe(true);
    const gbp = await one(
      '<property><id>C</id><type>Villa</type><price>100</price><currency>gbp</currency></property>',
    );
    expect(kyeroPropertyToUnit(gbp, 1, 'EUR')).toMatchObject({ ok: false, problems: [{ reason: 'currency' }] });
  });
});

describe('looksLikeXml', () => {
  it('[R2-07] accepts XML with or without a BOM, refuses other files', () => {
    const enc = new TextEncoder();
    expect(looksLikeXml(enc.encode('<?xml version="1.0"?><root/>'))).toBe(true);
    expect(looksLikeXml(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('\n  <root/>')]))).toBe(true);
    expect(looksLikeXml(enc.encode('%PDF-1.7'))).toBe(false);
    expect(looksLikeXml(new Uint8Array([0x3c, 0x00, 0x61]))).toBe(false); // NUL bytes: binary
    expect(looksLikeXml(enc.encode('ref;type\nA;Villa'))).toBe(false);
  });
});
