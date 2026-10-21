import { FeedListing, MAPPER_SAMPLE, XmlMapping, type XmlRecordNode } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { getConnector } from '../connectors';
import { mapXmlRecord, valuesAt, xmlMappedSettings } from '../xml-mapped/mapping';
import { analyzeSample, assertXmlBytes } from '../xml-mapped/sample';
import { suggestPaths } from '../xml-mapped/suggest';
import '../xml-mapped/connector';
import { FIXTURE_MAPPING, fixtureBytes } from './xml-mapped-fixture';

/** The generic XML connector and the mapper's sample reading (S6-04). Pure; the run is in xml-mapped.int.test.ts. */

const enc = (s: string) => new TextEncoder().encode(s);
const mapping = XmlMapping.parse(FIXTURE_MAPPING);

describe('generic XML sample', () => {
  it('[S6-04] detects the repeating record node, its paths with sample values and a first mapping guess', async () => {
    const sample = await analyzeSample(fixtureBytes());
    expect(sample.recordElement).toBe('object');
    expect(sample.candidates[0]).toEqual({ name: 'object', count: 4 });
    expect(sample.recordCount).toBe(4);
    const byPath = new Map(sample.paths.map((p) => [p.path, p]));
    expect(byPath.get('@code')?.samples).toEqual(['CD-1001', 'CD-1002', 'CD-1003']);
    expect(byPath.get('price/@currency')?.count).toBe(4);
    expect(byPath.get('tags/tag')?.repeated).toBe(true);
    expect(byPath.get('photos/photo/@url')?.count).toBe(2);
    expect(sample.suggested).toMatchObject({ ref: '@code', price: 'price', propertyType: 'category' });
    expect(sample.suggested.features).toBe('tags/tag');
  });

  it('[S6-04] another record element can be asked for', async () => {
    const sample = await analyzeSample(fixtureBytes(), { recordElement: 'tags' });
    expect(sample.recordElement).toBe('tags');
    expect(sample.recordCount).toBe(3);
  });

  it('[S6-04] an upload must look like XML by its first bytes, not by its name or declared type', () => {
    expect(() => assertXmlBytes(enc('<?xml version="1.0"?><a/>'))).not.toThrow();
    expect(() => assertXmlBytes(enc('\n  <feed><x/></feed>'))).not.toThrow();
    expect(() => assertXmlBytes(Uint8Array.from([0xef, 0xbb, 0xbf, 0x3c, 0x61, 0x2f, 0x3e]))).not.toThrow();
    expect(() => assertXmlBytes(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x3c, 0x61]))).toThrow(
      /FEED_SAMPLE_INVALID|NOT_XML/,
    );
    expect(() => assertXmlBytes(enc('%PDF-1.7'))).toThrow();
    expect(() => assertXmlBytes(enc('{"a":1}'))).toThrow();
    expect(() => assertXmlBytes(enc('<a>\u0000</a>'.padEnd(10, ' ')))).toThrow();
    expect(() => assertXmlBytes(new Uint8Array())).toThrow();
  });

  it('[S6-04] refuses a DOCTYPE and entity tricks, and a document without records', async () => {
    await expect(
      analyzeSample(
        enc('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a><b>&x;</b></a>'),
      ),
    ).rejects.toMatchObject({ code: 'FEED_SAMPLE_INVALID', details: { reason: 'DOCTYPE_NOT_ALLOWED' } });
    await expect(analyzeSample(enc('<a><b/></a>'))).rejects.toMatchObject({ code: 'FEED_SAMPLE_INVALID' });
    await expect(analyzeSample(enc('<a><b>x</a>'))).rejects.toMatchObject({ code: 'FEED_SAMPLE_INVALID' });
  });

  it('[S6-04] a sample cut at the size limit still gives the records before the cut', async () => {
    const records = Array.from({ length: 5 }, (_, i) => `<item id="${i}"><n>${i}</n></item>`).join('');
    const cut = enc(`<feed>${records}<item id="9"><n>part`);
    await expect(analyzeSample(cut)).rejects.toMatchObject({ code: 'FEED_SAMPLE_INVALID' });
    const sample = await analyzeSample(cut, { truncated: true });
    expect(sample.recordCount).toBe(5);
    expect(sample.truncated).toBe(true);
  });

  it('[S6-04] keeps at most the sample record limit', async () => {
    const records = Array.from({ length: 80 }, (_, i) => `<item id="${i}"><n>${i}</n></item>`).join('');
    const sample = await analyzeSample(enc(`<feed>${records}</feed>`));
    expect(sample.recordCount).toBe(MAPPER_SAMPLE.maxRecords);
  });
});

describe('mapper suggestions (S7-F2: guessed in core, not in the web app)', () => {
  const path = (p: string, count: number, repeated = false) => ({ path: p, count, repeated, samples: [] });

  it('[S7-F2] the sample suggests the first translation’s title and description paths', async () => {
    const records = Array.from(
      { length: 4 },
      (_, i) =>
        `<item id="${i}"><type>Villa</type><info><titulo>Casa ${i}</titulo>${i < 1 ? '<descripcion>Vistas</descripcion>' : ''}</info></item>`,
    ).join('');
    const sample = await analyzeSample(enc(`<feed>${records}</feed>`));
    expect(sample.suggested).toMatchObject({
      ref: '@id',
      propertyType: 'type',
      title: 'info/titulo',
      // a description in only some records is still the best guess for a text
      description: 'info/descripcion',
    });
  });

  it('[S7-F2] text guesses take the shallowest non-repeated path and never a path a field claimed first', () => {
    const suggested = suggestPaths([
      path('name', 10),
      path('details/title', 10),
      path('title', 9),
      path('texts/text', 10, true),
      path('body', 3),
    ]);
    expect(suggested.title).toBe('name'); // shallowest, most records first; `title` at depth 1 has fewer records
    expect(suggested.description).toBe('body'); // the repeated `texts/text` is a list, not a text
    expect(suggestPaths([path('ref', 5), path('foo', 5)]).title).toBeUndefined();
    // a path whose name only a text field knows goes to that field alone
    expect(suggestPaths([path('text', 4)])).toEqual({ description: 'text' });
  });
});

describe('generic XML mapping', () => {
  it('[S6-04] is registered as the xml-mapped connector and needs a profile', () => {
    expect(getConnector('xml-mapped')?.requiresMapping).toBe(true);
  });

  it('[S6-04] a profile maps a non-Kyero feed to valid listings (paths, attributes, value maps, comma numbers)', async () => {
    const sample = await analyzeSample(fixtureBytes());
    const out = sample.records.map((r) => mapXmlRecord(r, mapping, xmlMappedSettings({})));
    const first = out[0];
    expect(first?.ok).toBe(true);
    if (!first?.ok) return;
    const listing = FeedListing.parse(first.item);
    expect(listing).toMatchObject({
      ref: 'CD-1001',
      transactionType: 'SALE',
      priceCents: 125_000_000,
      currency: 'EUR',
      builtM2: 180.5,
      plotM2: 800,
      bedrooms: 4,
      coordinates: { lat: 36.51, lng: -4.88 },
      propertyType: 'E2E Villa',
      location: { country: 'E2E Listland', city: 'Seaside' },
      features: ['E2E Pool', 'Sea view'],
      images: ['https://images.example.com/cd-1001/1.jpg', 'https://images.example.com/cd-1001/2.jpg'],
    });
    expect(listing.translations.map((t) => t.locale)).toEqual(['en', 'es']);
    expect(listing.translations[0]?.description).toBe('Bright villa, four bedrooms.');
    // the rental: mapped from "alquiler", per month; a plot of 0 is no plot
    const rental = out[1];
    expect(rental?.ok && rental.item).toMatchObject({
      transactionType: 'RENT_LONG_TERM',
      pricePeriod: 'MONTH',
      priceCents: 240_000,
      plotM2: null,
    });
  });

  it('[S6-04] a record that cannot be read is refused with the field named, not guessed', async () => {
    const sample = await analyzeSample(fixtureBytes());
    const bad = mapXmlRecord(sample.records[2] as never, mapping, xmlMappedSettings({}));
    expect(bad).toMatchObject({ ok: false, ref: 'CD-1003', problems: [{ code: 'INVALID_PRICE', field: 'price' }] });
    const noRef = mapXmlRecord(
      { name: 'object', attributes: {}, text: '', children: [] },
      mapping,
      xmlMappedSettings({}),
    );
    expect(noRef).toMatchObject({ ok: false, problems: [{ code: 'MISSING_FIELD', field: 'ref' }] });
    const unknownDeal = mapXmlRecord(
      {
        name: 'object',
        attributes: { code: 'X' },
        text: '',
        children: [{ name: 'deal', attributes: {}, text: 'traspaso', children: [] }],
      },
      mapping,
      xmlMappedSettings({}),
    );
    expect(unknownDeal.ok).toBe(false);
    if (!unknownDeal.ok) expect(unknownDeal.problems.map((p) => p.field)).toContain('transactionType');
  });

  it('[S6-04] reads paths, repeated elements and attributes of a record', () => {
    const rec: XmlRecordNode = {
      name: 'r',
      attributes: { id: '7' },
      text: '',
      children: [
        {
          name: 'a',
          attributes: { k: 'v' },
          text: ' x ',
          children: [{ name: 'b', attributes: {}, text: 'deep', children: [] }],
        },
        { name: 'a', attributes: {}, text: 'y', children: [] },
      ],
    };
    expect(valuesAt(rec, '@id')).toEqual(['7']);
    expect(valuesAt(rec, 'a')).toEqual(['x', 'y']);
    expect(valuesAt(rec, 'a/@k')).toEqual(['v']);
    expect(valuesAt(rec, 'a/b')).toEqual(['deep']);
    expect(valuesAt(rec, 'nope/b')).toEqual([]);
  });

  it('[S6-04] the mapping schema refuses unknown fields, both a path and a constant, and bad paths', () => {
    const base = { ...FIXTURE_MAPPING };
    expect(XmlMapping.safeParse({ ...base, fields: { ...FIXTURE_MAPPING.fields, nope: { path: 'x' } } }).success).toBe(
      false,
    );
    expect(
      XmlMapping.safeParse({ ...base, fields: { ...FIXTURE_MAPPING.fields, ref: { path: 'a', constant: 'b' } } })
        .success,
    ).toBe(false);
    expect(
      XmlMapping.safeParse({ ...base, fields: { ...FIXTURE_MAPPING.fields, ref: { path: '../etc' } } }).success,
    ).toBe(false);
    expect(XmlMapping.safeParse({ ...base, fields: { ...FIXTURE_MAPPING.fields, ref: { path: 'a/*' } } }).success).toBe(
      false,
    );
    expect(XmlMapping.safeParse({ ...base, fields: { propertyType: { path: 'a' } } }).success).toBe(false);
    expect(XmlMapping.safeParse(base).success).toBe(true);
  });
});

describe('generic XML hardening', () => {
  it('[S6-04] a price like 250.000 under a decimal point is refused, not read as 250.00', () => {
    const rec = (price: string): XmlRecordNode => ({
      name: 'object',
      attributes: { code: 'P1' },
      text: '',
      children: [
        { name: 'category', attributes: {}, text: 'Villa', children: [] },
        { name: 'price', attributes: {}, text: price, children: [] },
        {
          name: 'place',
          attributes: {},
          text: '',
          children: [{ name: 'nation', attributes: {}, text: 'Spain', children: [] }],
        },
      ],
    });
    const point = XmlMapping.parse({ ...FIXTURE_MAPPING, decimalSeparator: 'point' });
    expect(mapXmlRecord(rec('250.000'), point, xmlMappedSettings({}))).toMatchObject({
      ok: false,
      problems: [{ code: 'INVALID_PRICE' }],
    });
    expect(mapXmlRecord(rec('250000.50'), point, xmlMappedSettings({}))).toMatchObject({
      ok: true,
      item: { priceCents: 25_000_050 },
    });
    expect(mapXmlRecord(rec('250.000'), mapping, xmlMappedSettings({}))).toMatchObject({
      ok: true,
      item: { priceCents: 25_000_000 },
    });
  });

  it('[S6-04] a UTF-16 upload gets the same first-bytes check as a UTF-8 one', () => {
    const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(() => assertXmlBytes(utf16('<?xml version="1.0"?><a><b/></a>'))).not.toThrow();
    expect(() => assertXmlBytes(utf16('MZ binary or script, not a document'))).toThrow();
    expect(() => assertXmlBytes(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x7f, 0x45, 0x4c, 0x46]))).toThrow();
  });

  it('[S6-04] records posted back to the API are bounded in depth before they are validated', async () => {
    const { MapperPreviewBody } = await import('@inmolink/contracts');
    let deep: XmlRecordNode = { name: 'x', attributes: {}, text: '', children: [] };
    for (let i = 0; i < 20_000; i++) deep = { name: 'x', attributes: {}, text: '', children: [deep] };
    const t0 = Date.now();
    const parsed = MapperPreviewBody.safeParse({ mapping: FIXTURE_MAPPING, records: [deep] });
    expect(parsed.success).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('mapper field lists', () => {
  it('[S6-04] the field list the mapper shows is the one the mapping schema accepts', async () => {
    const { XML_MAPPED_FIELDS } = await import('@inmolink/contracts/values');
    expect([...XML_MAPPED_FIELDS].sort()).toEqual(Object.keys(XmlMapping.shape.fields.shape).sort());
  });
});
