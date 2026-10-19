import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FeedListing, type FeedListingInput } from '@inmolink/contracts';
import { streamXmlRecords, type XmlElement } from '@inmolink/platform/xml';
import { describe, expect, it } from 'vitest';
import { credentialHeaders, credentialUrl, getConnector } from '../connectors';
import { htmlToPlainText } from '../html';
import { elementPaths, KYERO_V3_FIELDS, renderCoverageReport, ruleFor, unaccountedPaths } from '../kyero/coverage';
import { kyeroSettings, mapKyeroProperty } from '../kyero/mapping';
import { priceToCents } from '../values';
import '../kyero/connector';

/** The Kyero v3 connector (S6-03): mapping, field coverage, text cleaning. Pure; the run is in kyero.int.test.ts. */

const FIXTURE = fileURLToPath(new URL('../../../../../../tests/fixtures/kyero/feed.xml', import.meta.url));

async function records(): Promise<XmlElement[]> {
  const out: XmlElement[] = [];
  for await (const r of streamXmlRecords(createReadStream(FIXTURE), { recordElement: ['kyero', 'property'] }))
    out.push(r);
  return out;
}

const settings = kyeroSettings({});
async function mapped() {
  const props = (await records()).filter((r) => r.name === 'property');
  return props.map((p) => mapKyeroProperty(p, settings));
}
describe('Kyero v3 connector', () => {
  it('[S6-03] is registered under the key kyero', () => {
    expect(getConnector('kyero')?.key).toBe('kyero');
  });

  it('[S6-03] the field map accounts for every element and attribute of the fixture feed (100% coverage)', async () => {
    const all = await records();
    expect(all.filter((r) => r.name === 'property').length).toBe(9);
    const unaccounted: string[] = [];
    const seen = new Set<string>();
    for (const r of all) {
      const prefix = r.name === 'kyero' ? 'kyero/' : '';
      for (const p of elementPaths(r)) {
        const path = `${prefix}${p}`;
        seen.add(ruleFor(path)?.path ?? path);
        if (!ruleFor(path)) unaccounted.push(path);
      }
    }
    expect(unaccounted).toEqual([]);
    expect(
      unaccountedPaths({
        name: 'property',
        attributes: {},
        text: '',
        children: [{ name: 'brand_new', attributes: {}, text: '', children: [] }],
      }),
    ).toEqual(['brand_new']);
    // The fixture exercises every row of the table (a row nothing covers is a row the tests never see).
    expect(KYERO_V3_FIELDS.map((f) => f.path).filter((p) => !seen.has(p))).toEqual([]);
  });

  it('[S6-03] the coverage report lists every v3 element with its target or the reason it is ignored', () => {
    const report = renderCoverageReport();
    for (const f of KYERO_V3_FIELDS) expect(report).toContain(`\`${f.path}\``);
    expect(KYERO_V3_FIELDS.every((f) => f.note.length > 0)).toBe(true);
    expect(KYERO_V3_FIELDS.filter((f) => f.maps === null).every((f) => f.note.length > 10)).toBe(true);
    expect(report).toContain('| `desc/*` | `translations[].description` |');
  });

  it('[S6-03] a full property maps: sale, price in cents, areas, coordinates, ratings, features, images, translations', async () => {
    const villa = okItemOrNull((await mapped())[0]) as FeedListingInput;
    expect(villa).toMatchObject({
      ref: 'K-1001',
      transactionType: 'SALE',
      pricePeriod: null,
      priceCents: 125_000_000,
      priceOnRequest: false,
      currency: 'EUR',
      bedrooms: 5,
      bathrooms: 4,
      builtM2: 420,
      plotM2: 1500,
      energyRating: 'C',
      energyEmissionsRating: 'B',
      coordinates: { lat: 36.5071, lng: -4.9573 },
      locationPrecision: 'APPROX',
      propertyType: 'Villa',
      location: { country: 'Spain', region: 'Málaga', city: 'Marbella', area: 'Nueva Andalucía' },
    });
    expect(villa.features).toEqual(['Pool', 'Air conditioning', 'Sea views', 'Garden', 'Garage']);
    expect(villa.images).toHaveLength(4);
    expect(villa.images?.[0]).toBe('https://img.example.test/k1001/1.jpg');
    expect(FeedListing.safeParse(villa).success).toBe(true);
  });

  it('[S6-03] translations come from the desc languages (en, es, de, ...), titles from the data, descriptions as plain text', async () => {
    const items = (await mapped()).map(okItemOrNull);
    const villa = items[0] as FeedListingInput;
    expect(villa.translations?.map((t) => t.locale)).toEqual(['en', 'es', 'de']);
    expect(villa.translations?.every((t) => t.title === 'Villa, Marbella')).toBe(true);
    expect(villa.translations?.[0]?.description).toBe(
      'Magnificent villa with panoramic sea views in the heart of the golf valley.\n\n- Private pool\n- Double garage\n\nFully air-conditioned. Viewings by appointment.',
    );
    expect(villa.translations?.[1]?.description).toBe(
      'Magnífica villa con vistas panorámicas al mar en el corazón del valle del golf.\n\nPiscina privada y garaje doble.',
    );
    expect(villa.translations?.[2]?.description).toBe(
      'Prächtige Villa mit Meerblick im Golftal.\nPrivatpool und Doppelgarage.',
    );
    const apt = items[1] as FeedListingInput;
    expect(apt.translations?.map((t) => t.locale)).toEqual(['en', 'es', 'fr', 'nl']);
    // A feed title wins in its language; the other languages get the generated one.
    expect(apt.translations?.map((t) => t.title)).toEqual([
      'Bright flat by the beach',
      'Apartment, Estepona',
      'Apartment, Estepona',
      'Apartment, Estepona',
    ]);
    // A property without descriptions still gets one title translation (default locale).
    expect((items[3] as FeedListingInput).translations).toEqual([
      { locale: 'en', title: 'Townhouse, Fuengirola', description: null },
    ]);
  });

  it('[S6-03] rentals map to a transaction type and period; price 0 or no price is price on request; 0,0 and 0 m² are no value', async () => {
    const [, apt, penthouse, townhouse] = (await mapped()).map(okItemOrNull);
    expect(apt).toMatchObject({
      transactionType: 'RENT_LONG_TERM',
      pricePeriod: 'MONTH',
      priceCents: 180_050,
      energyRating: 'PENDING',
      energyEmissionsRating: 'EXEMPT',
    });
    expect(penthouse).toMatchObject({
      transactionType: 'RENT_SHORT_TERM',
      pricePeriod: 'WEEK',
      priceCents: 210_000,
      coordinates: null,
      plotM2: null,
      builtM2: 210,
    });
    expect(townhouse).toMatchObject({ priceCents: null, priceOnRequest: true, images: [] });
    // No country element: the default country; a connection setting changes it.
    expect(townhouse?.location?.country).toBe('Spain');
    const raw = (await records()).filter((r) => r.name === 'property')[3] as XmlElement;
    const pt = mapKyeroProperty(raw, kyeroSettings({ defaultCountry: 'Portugal', defaultLocale: 'pt' }));
    expect(pt.ok && pt.item.location?.country).toBe('Portugal');
    expect(pt.ok && pt.item.translations?.[0]?.locale).toBe('pt');
  });

  it('[S6-03] taxonomy values stay the feed text for the loader; features are de-duplicated, non-http images dropped', async () => {
    const cortijo = okItemOrNull((await mapped())[4] as never) as FeedListingInput;
    expect(cortijo).toMatchObject({
      propertyType: 'Villa',
      location: { country: 'Spain', region: 'Málaga', city: 'Mijas', area: 'Calahonda Alta' },
      features: ['Padel court', 'Garden'],
      images: ['https://img.example.test/k1005/1.jpg'],
    });
  });

  it('[S6-03] HTML in descriptions becomes plain text: tags, scripts and attributes are gone, entities decoded once', async () => {
    const cortijo = okItemOrNull((await mapped())[4] as never) as FeedListingInput;
    const text = cortijo.translations?.[0]?.description ?? '';
    expect(text).not.toMatch(/[<>]/);
    expect(text).not.toContain('alert');
    expect(text).not.toContain('onclick');
    expect(text.startsWith('Restored country house.')).toBe(true);
    expect(htmlToPlainText('&lt;script&gt;x&lt;/script&gt; &amp;lt;b&amp;gt;')).toBe('x &lt;b&gt;');
    expect(htmlToPlainText('&lt;&lt;a&gt;script&gt;alert(1)&lt;&lt;a&gt;/script&gt;')).not.toMatch(/<\/?[a-z]/i);
    expect(htmlToPlainText('a‮b​c')).toBe('abc');
    expect(htmlToPlainText('<p>a<br/>b</p><p>c</p><!-- hidden --><style>p{}</style>')).toBe('a\nb\n\nc');
    expect(htmlToPlainText('x'.repeat(30_000), 20_000)).toHaveLength(20_000);
    expect(htmlToPlainText('bell\u0000 \u0007ring')).toBe('bell ring');
    expect(htmlToPlainText('<img src=x onerror=alert(1)')).toBe('');
  });

  it('[S6-03] items the feed gets wrong are refused one by one with the problem and the reference', async () => {
    const results = await mapped();
    expect(results.slice(5, 8).map((r) => (r.ok ? 'ok' : r.problems[0]?.code))).toEqual([
      'MISSING_FIELD',
      'INVALID_PRICE',
      'MISSING_FIELD',
    ]);
    expect(results[5]).toMatchObject({ ok: false, ref: 'K-1006', problems: [{ field: 'type' }] });
    expect(results[6]).toMatchObject({ ok: false, ref: 'K-1007', problems: [{ field: 'price' }] });
    expect(results[7]).toMatchObject({ ok: false, problems: [{ field: 'id' }] });
    expect(okItemOrNull(results[8])?.propertyType).toBe('Cortijo');
    expect(priceToCents('1250000')).toBe(125_000_000);
    expect(priceToCents('99.9')).toBe(9_990);
    expect(priceToCents('1,250')).toBeNull();
    expect(priceToCents('-5')).toBeNull();
  });

  it('[S6-03] validate checks the mapped item against the listing contract', async () => {
    const connector = getConnector('kyero');
    const ctx = {} as never;
    const good = okItemOrNull((await mapped())[0] as never) as FeedListingInput;
    expect(connector?.validate(good, ctx)).toEqual([]);
    expect(connector?.validate({ ...good, currency: 'euro' }, ctx)).toMatchObject([
      { code: 'INVALID_FIELD', field: 'currency' },
    ]);
    expect(connector?.validate({ ...good, bedrooms: 5_000 }, ctx)[0]?.field).toBe('bedrooms');
  });

  it('[S6-03] a query credential adds its parameter to the feed URL (and no header); header and basic are unchanged', () => {
    const q = { type: 'query', name: 'key', value: 'abc 123' } as const;
    expect(credentialUrl('https://feeds.example.test/k.xml?lang=en&key=old', q)).toBe(
      'https://feeds.example.test/k.xml?lang=en&key=abc+123',
    );
    expect(credentialHeaders(q)).toEqual({});
    expect(credentialUrl('https://feeds.example.test/k.xml', null)).toBe('https://feeds.example.test/k.xml');
    expect(credentialHeaders({ type: 'header', name: 'X-Api-Key', value: 'v' })).toEqual({ 'x-api-key': 'v' });
  });
});

function okItemOrNull(r: Awaited<ReturnType<typeof mapped>>[number] | undefined): FeedListingInput | null {
  return r?.ok ? r.item : null;
}
