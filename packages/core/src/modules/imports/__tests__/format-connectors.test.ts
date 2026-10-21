import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { FeedListing, type FeedListingInput } from '@inmolink/contracts';
import { DEFAULT_CONTENT_LOCALE } from '@inmolink/i18n';
import { streamXmlRecords, type XmlElement } from '@inmolink/platform/xml';
import { describe, expect, it } from 'vitest';
import { formatSettings } from '../assemble';
import { FORMAT_DEFAULTS, formatDefaults } from '../config';
import { connectorKeys, getConnector, type MapResult } from '../connectors';
import { INFOCASA_FIELDS, renderInfocasaCoverageReport } from '../infocasa/coverage';
import { mapInfocasaPropiedad } from '../infocasa/mapping';
import { INMOBA_FIELDS, renderInmobaCoverageReport } from '../inmoba/coverage';
import { mapInmobaProperty } from '../inmoba/mapping';
import { kyeroSettings, mapKyeroProperty } from '../kyero/mapping';
import { MILENIO_FIELDS, renderMilenioCoverageReport } from '../milenio/coverage';
import { mapMilenioInmueble } from '../milenio/mapping';
import { resalesSettings } from '../resales/mapping';
import { renderThinkSpainCoverageReport, THINKSPAIN_FIELDS } from '../thinkspain/coverage';
import { mapThinkSpainProperty } from '../thinkspain/mapping';
import { localizedPriceToCents } from '../values';
import { coverageReport, type FieldRule } from '../xml-coverage';
import { xmlMappedSettings } from '../xml-mapped/mapping';
import '../infocasa/connector';
import '../inmoba/connector';
import '../kyero/connector';
import '../milenio/connector';
import '../resales/connector';
import '../sheet/connector';
import '../thinkspain/connector';
import '../xml-mapped/connector';

/**
 * The four format connectors of S6-07 (Milenio+, Infocasa, Inmoba, thinkSPAIN, [H14]): mapping of the fixture feeds
 * and the field-coverage report of each (accounted share >= 95%, the unmapped fields listed). The run through the
 * loader is in format-connectors.int.test.ts. Pure.
 */

interface Spec {
  name: string;
  key: string;
  fixture: string;
  recordElement: string;
  rules: readonly FieldRule[];
  report: () => string;
  map: (raw: XmlElement, s: ReturnType<typeof formatSettings>) => MapResult<FeedListingInput>;
  /** Fixture fields the table accounts for as not mapped (the "unmapped fields" list). */
  unmapped: string[];
  records: number;
  /** [ref, problem code, problem field] for the refused records, by position. */
  refused: Record<number, [string | undefined, string, string]>;
  first: Partial<FeedListingInput>;
  firstFeatures: string[];
  firstImages: string[];
  firstLocales: string[];
  longRent: number;
  shortRent: { period: 'NIGHT' | 'WEEK'; cents: number };
  sold: number;
}

const fixture = (dir: string) =>
  fileURLToPath(new URL(`../../../../../../tests/fixtures/${dir}/feed.xml`, import.meta.url));
const loadRecords = async (spec: Spec) => {
  const out: XmlElement[] = [];
  for await (const r of streamXmlRecords(createReadStream(fixture(spec.fixture)), {
    recordElement: spec.recordElement,
  }))
    out.push(r);
  return out;
};

const sold = (r: MapResult<FeedListingInput>) => (r.ok ? r.item.status : null);

const SPECS: Spec[] = [
  {
    name: 'Inmoba',
    key: 'inmoba',
    fixture: 'inmoba',
    recordElement: 'property',
    rules: INMOBA_FIELDS,
    report: renderInmobaCoverageReport,
    map: mapInmobaProperty,
    unmapped: [
      'agency_id',
      'cityname@id',
      'client_ref_num',
      'community',
      'country@id',
      'descriptions/price_description',
      'descriptions/price_description@lang',
      'development_reference',
      'dt_added_date',
      'dt_create_date',
      'dt_last_updated',
      'dt_review_date',
      'files',
      'files/file',
      'files/file@lang',
      'files/file@type',
      'files/file@url',
      'garbage',
      'htmls',
      'htmls/html',
      'htmls/html/html_code',
      'htmls/html/name',
      'htmls/html@lang',
      'htmls/html@type',
      'ibi',
      'images/image',
      'is_direct',
      'is_exclusive',
      'is_featured',
      'is_hot',
      'is_luxury',
      'is_new_property',
      'is_special',
      'links',
      'links/link',
      'links/link@lang',
      'links/link@type',
      'links/link@url',
      'listed_by',
      'listed_by/name',
      'listed_by/surname',
      'listed_by2',
      'listed_by2/name',
      'listed_by2/surname',
      'listed_by2@id',
      'listed_by@id',
      'mts_interior',
      'nr_floors',
      'nr_level',
      'nr_onsuite_bathrooms',
      'nr_toilet',
      'options/option@type',
      'postcode',
      'propertycategory',
      'propertycategory@id',
      'propertytype@id',
      'province@id',
      'rental_price_comment_long',
      'subarea@id',
      'tags',
      'tags/tag',
      'touristic_code',
      'tr_garage@id',
      'tr_garden@id',
      'tr_orientation',
      'tr_pool@id',
    ],
    records: 9,
    refused: {
      5: ['BAD-6', 'MISSING_FIELD', 'propertytype'],
      6: ['BAD-7', 'INVALID_PRICE', 'price'],
      7: [undefined, 'MISSING_FIELD', 'reference'],
      8: ['BAD-9', 'INVALID_FIELD', 'is_for_sale'],
    },
    first: {
      ref: '10-000017P',
      transactionType: 'SALE',
      priceCents: 26_000_000,
      priceOnRequest: false,
      propertyType: 'Town House',
      builtM2: 522,
      plotM2: 800,
      terraceM2: 120,
      bedrooms: 4,
      bathrooms: 3,
      yearBuilt: 1981,
      coordinates: { lat: 36.431116, lng: -5.119516 },
      location: { country: 'Spain', region: 'Málaga', city: 'Estepona', area: 'Alcazaba Beach' },
    },
    firstFeatures: ['Pool', 'Garden', 'Garage', 'Sea view', 'Air conditioning', 'Lift', 'Pool view'],
    firstImages: [1, 2, 3, 4].map((n) => `https://media.example.test/inmoba/10-000017P/${n}.jpg`),
    firstLocales: ['en', 'es', 'de'],
    longRent: 1,
    shortRent: { period: 'NIGHT', cents: 25_000 },
    sold: 4,
  },
  {
    name: 'Milenio+',
    key: 'milenio-plus',
    fixture: 'milenio',
    recordElement: 'inmueble',
    rules: MILENIO_FIELDS,
    report: renderMilenioCoverageReport,
    map: mapMilenioInmueble,
    unmapped: [
      'codigo_postal',
      'comision',
      'direccion',
      'fecha_alta',
      'fecha_modificacion',
      'notas_internas',
      'propietario',
      'propietario/nombre',
      'propietario/telefono',
      'ref_agencia',
      'subtipo',
      'video',
    ],
    records: 9,
    refused: {
      5: ['MIL-006', 'MISSING_FIELD', 'tipo'],
      6: ['MIL-007', 'INVALID_PRICE', 'precio'],
      7: [undefined, 'MISSING_FIELD', 'referencia'],
      8: ['MIL-009', 'INVALID_FIELD', 'operacion'],
    },
    first: {
      ref: 'MIL-001',
      transactionType: 'SALE',
      priceCents: 125_000_000,
      propertyType: 'Villa',
      builtM2: 420,
      plotM2: 1500,
      terraceM2: 80,
      bedrooms: 5,
      bathrooms: 4,
      yearBuilt: 2008,
      energyRating: 'C',
      energyEmissionsRating: 'B',
      coordinates: { lat: 36.5071, lng: -4.9573 },
      location: { country: 'España', region: 'Málaga', city: 'Marbella', area: 'Nueva Andalucía' },
    },
    firstFeatures: ['Piscina', 'Aire acondicionado', 'Vistas al mar'],
    // `orden` runs 3, 2, 1 in the fixture: the photos are sorted by it.
    firstImages: [3, 2, 1].map((n) => `https://media.example.test/milenio/MIL-001/${n}.jpg`),
    firstLocales: ['es', 'en'],
    longRent: 1,
    shortRent: { period: 'NIGHT', cents: 25_050 },
    sold: 4,
  },
  {
    name: 'Infocasa',
    key: 'infocasa',
    fixture: 'infocasa',
    recordElement: 'propiedad',
    rules: INFOCASA_FIELDS,
    report: renderInfocasaCoverageReport,
    map: mapInfocasaPropiedad,
    unmapped: [
      '@actualizado',
      'contacto',
      'contacto/nombre',
      'contacto/telefono',
      'direccion',
      'observaciones_privadas',
      'video_url',
    ],
    records: 9,
    refused: {
      5: ['IC-105', 'MISSING_FIELD', 'tipo_inmueble'],
      6: ['IC-106', 'INVALID_PRICE', 'precio'],
      7: [undefined, 'MISSING_FIELD', 'id'],
      8: ['IC-108', 'INVALID_FIELD', 'accion'],
    },
    first: {
      ref: 'IC-100',
      transactionType: 'SALE',
      priceCents: 125_000_000,
      propertyType: 'Villa',
      builtM2: 420,
      plotM2: 1500,
      terraceM2: 75,
      bedrooms: 5,
      bathrooms: 4,
      yearBuilt: 2010,
      energyRating: 'C',
      energyEmissionsRating: 'B',
      coordinates: { lat: 36.5071, lng: -4.9573 },
      location: { country: 'España', region: 'Málaga', city: 'Marbella', area: 'Nueva Andalucía' },
    },
    firstFeatures: ['Piscina', 'Aire acondicionado', 'Jardín'],
    firstImages: [1, 2, 3].map((n) => `https://media.example.test/infocasa/IC-100/${n}.jpg`),
    firstLocales: ['es', 'en', 'de'],
    longRent: 1,
    shortRent: { period: 'NIGHT', cents: 25_000 },
    sold: 4,
  },
  {
    name: 'thinkSPAIN',
    key: 'thinkspain',
    fixture: 'thinkspain',
    recordElement: 'property',
    rules: THINKSPAIN_FIELDS,
    report: renderThinkSpainCoverageReport,
    map: mapThinkSpainProperty,
    unmapped: [
      'address',
      'agent',
      'agent/email',
      'agent/name',
      'agent/phone',
      'last_updated',
      'new_build',
      'region',
      'url',
    ],
    records: 9,
    refused: {
      5: ['TS-6', 'MISSING_FIELD', 'type'],
      6: ['TS-7', 'INVALID_PRICE', 'price'],
      7: [undefined, 'MISSING_FIELD', 'reference'],
      8: ['TS-9', 'INVALID_FIELD', 'listing_type'],
    },
    first: {
      ref: 'TS-1',
      transactionType: 'SALE',
      priceCents: 125_000_000,
      propertyType: 'Villa',
      builtM2: 420,
      plotM2: 1500,
      terraceM2: 90,
      bedrooms: 5,
      bathrooms: 4,
      yearBuilt: 2012,
      energyRating: 'C',
      energyEmissionsRating: 'B',
      coordinates: { lat: 36.5071, lng: -4.9573 },
      location: { country: 'Spain', region: 'Málaga', city: 'Marbella', area: 'Nueva Andalucía' },
    },
    firstFeatures: ['Private pool', 'Air conditioning', 'Sea views'],
    firstImages: [1, 2, 3].map((n) => `https://media.example.test/thinkspain/TS-1/${n}.jpg`),
    firstLocales: ['en', 'es', 'fr'],
    longRent: 1,
    shortRent: { period: 'NIGHT', cents: 25_000 },
    sold: 4,
  },
];

describe.each(SPECS)('$name connector', (spec) => {
  const settings = formatSettings({}, spec.key);
  const mapAll = async () => (await loadRecords(spec)).map((r) => spec.map(r, settings));
  const item = (r: MapResult<FeedListingInput> | undefined) => (r?.ok ? r.item : undefined);

  it('[S6-07] is registered and the fixture streams through the XXE-safe parser', async () => {
    expect(getConnector(spec.key)?.key).toBe(spec.key);
    expect((await loadRecords(spec)).length).toBe(spec.records);
  });

  it('[S6-07] field coverage of the fixture is at least 95% (mapped or ignored for a stated reason) and the unmapped fields are listed', async () => {
    const report = coverageReport(spec.rules, await loadRecords(spec));
    expect(report.unaccounted).toEqual([]);
    expect(report.accountedPct).toBeGreaterThanOrEqual(95);
    expect(report.mappedPct).toBeGreaterThan(30);
    expect(report.unmapped).toEqual(spec.unmapped);
    // The fixture exercises every row of the table.
    expect(report.unexercised).toEqual([]);
    // Every ignored row says why; the Markdown report lists every row.
    expect(spec.rules.every((r) => r.note.length > 5)).toBe(true);
    for (const r of spec.rules) expect(spec.report()).toContain(`\`${r.path}\``);
    console.info(
      `[S6-07] ${spec.name}: ${report.fields.length} fixture fields, ${report.mappedPct}% feed a listing field, ${report.accountedPct}% accounted, ${report.unmapped.length} unmapped`,
    );
  });

  it('[S6-07] a full record maps: transaction, price in cents, areas, rooms, ratings, coordinates, taxonomy text, features, images', async () => {
    const first = item((await mapAll())[0]) as FeedListingInput;
    expect(first).toMatchObject({ ...spec.first, locationPrecision: 'APPROX', currency: 'EUR', status: 'ACTIVE' });
    expect(first.features).toEqual(spec.firstFeatures);
    expect(first.images).toEqual(spec.firstImages);
    expect(first.translations?.map((t) => t.locale)).toEqual(spec.firstLocales);
    expect(FeedListing.safeParse(first).success).toBe(true);
  });

  it('[S6-07] descriptions become plain text; owner contact, commission and internal notes never reach the item', async () => {
    const first = item((await mapAll())[0]) as FeedListingInput;
    const all = JSON.stringify(first);
    for (const t of first.translations ?? []) expect(t.description ?? '').not.toMatch(/[<>]/);
    expect(all).not.toMatch(
      /Propietario|Contacto Ejemplo|Agent Example|agent@example|Llamar antes|negocia|Calle Falsa|Avenida del Mar|600000000|611111111|622222222/,
    );
  });

  it('[S6-07] rentals map to a transaction type and period; sold maps to SOLD; price 0 is price on request; 0,0 and 0 m2 are no value', async () => {
    const results = await mapAll();
    expect(item(results[spec.longRent])).toMatchObject({ transactionType: 'RENT_LONG_TERM', pricePeriod: 'MONTH' });
    expect(item(results[spec.longRent])?.priceCents).toBe(180_000);
    const short = item(results[2]);
    expect(short).toMatchObject({
      transactionType: 'RENT_SHORT_TERM',
      pricePeriod: spec.shortRent.period,
      priceCents: spec.shortRent.cents,
      coordinates: null,
      terraceM2: null,
      builtM2: 210,
    });
    expect(item(results[3])).toMatchObject({ priceCents: null, priceOnRequest: true });
    expect(sold(results[spec.sold] as MapResult<FeedListingInput>)).toBe('SOLD');
    // No translation text at all still yields one title in the default locale.
    expect(item(results[3])?.translations).toHaveLength(1);
  });

  it('[S6-07] records the feed gets wrong are refused one by one with the problem and the reference', async () => {
    const results = await mapAll();
    for (const [pos, [ref, code, field]] of Object.entries(spec.refused)) {
      const r = results[Number(pos)];
      expect(r?.ok).toBe(false);
      if (r && !r.ok) {
        expect(r.ref).toBe(ref);
        expect(r.problems[0]).toMatchObject({ code, field });
      }
    }
    expect(results.filter((r) => r.ok)).toHaveLength(spec.records - Object.keys(spec.refused).length);
  });

  it('[S6-07] validate checks the mapped item against the listing contract', async () => {
    const connector = getConnector(spec.key);
    const good = item((await mapAll())[0]) as FeedListingInput;
    expect(connector?.validate(good, {} as never)).toEqual([]);
    expect(connector?.validate({ ...good, bedrooms: 5_000 }, {} as never)[0]?.field).toBe('bedrooms');
  });

  it('[S6-07] connection settings change the default country', async () => {
    const raw = (await loadRecords(spec))[3] as XmlElement;
    const own = spec.map(raw, formatSettings({ defaultCountry: 'Portugal', defaultLocale: 'pt' }, spec.key));
    // The fixture sends its own country; the setting applies only to records without one, and to untagged text.
    const bare = { ...raw, children: raw.children.filter((c) => !['country', 'pais'].includes(c.name)) };
    const r = spec.map(bare, formatSettings({ defaultCountry: 'Portugal', defaultLocale: 'pt' }, spec.key));
    expect(own.ok && own.item.location?.country).not.toBe('Portugal');
    expect(r.ok && r.item.location?.country).toBe('Portugal');
    expect(r.ok && r.item.translations?.[0]?.locale).toBe('pt');
    expect(formatSettings({ defaultCountry: 'Portugal', defaultLocale: 'pt' }, spec.key)).toEqual({
      defaultCountry: 'Portugal',
      defaultLocale: 'pt',
      defaultCurrency: 'EUR',
    });
    expect(formatSettings({ defaultCountry: '', defaultLocale: 'portuguese' }, spec.key)).toEqual({
      defaultCountry: 'Spain',
      defaultLocale: 'es',
      defaultCurrency: 'EUR',
    });
  });
});

describe('shared price reader', () => {
  it('[S6-07] Spanish price notation is read strictly', () => {
    expect(localizedPriceToCents('1.250.000,50')).toBe(125_000_050);
    expect(localizedPriceToCents('1.250.000')).toBe(125_000_000);
    expect(localizedPriceToCents('250,5')).toBe(25_050);
    expect(localizedPriceToCents('1250000.50')).toBe(125_000_050);
    expect(localizedPriceToCents('1250000 €')).toBe(125_000_000);
    expect(localizedPriceToCents('1,250,000')).toBeNull();
    expect(localizedPriceToCents('12.5.0')).toBeNull();
    expect(localizedPriceToCents('-5')).toBeNull();
    expect(localizedPriceToCents('1.25')).toBe(125);
  });
});

describe('shared decimal reader', () => {
  it('[S6-07] areas in Spanish notation are read strictly', async () => {
    const { localizedDecimal, localizedPositive } = await import('../values');
    expect(localizedDecimal('1.500')).toBe(1500);
    expect(localizedDecimal('1.500,5')).toBe(1500.5);
    expect(localizedDecimal('85,5')).toBe(85.5);
    expect(localizedDecimal('420')).toBe(420);
    expect(localizedDecimal('12.5.0')).toBeNull();
    expect(localizedPositive('0')).toBeNull();
  });
});

describe('per-format defaults (S7-F2)', () => {
  it('[S7-F2] default locale and currency come from one table in config.ts, keyed by connector', () => {
    // every real connector has its row
    for (const key of connectorKeys()) expect(FORMAT_DEFAULTS[key], key).toBeDefined();
    expect(FORMAT_DEFAULTS.kyero).toMatchObject({ locale: 'en', currency: 'EUR' });
    expect(FORMAT_DEFAULTS.inmoba).toMatchObject({ locale: 'es', currency: 'EUR' });
    expect(FORMAT_DEFAULTS['xml-mapped']?.locale).toBe(DEFAULT_CONTENT_LOCALE);
    // each format's settings read their row; a connection setting overrides locale and country
    expect(kyeroSettings({})).toEqual({ defaultCountry: 'Spain', defaultLocale: 'en', defaultCurrency: 'EUR' });
    expect(formatSettings({}, 'inmoba')).toEqual({
      defaultCountry: 'Spain',
      defaultLocale: 'es',
      defaultCurrency: 'EUR',
    });
    expect(resalesSettings({ defaultLocale: 'de' }, 'p1')).toMatchObject({
      defaultLocale: 'de',
      defaultCurrency: 'EUR',
    });
    expect(xmlMappedSettings({}, 'sheet-mapped')).toEqual({
      defaultLocale: DEFAULT_CONTENT_LOCALE,
      defaultCurrency: 'EUR',
    });
    expect(formatDefaults('unknown-format', { defaultLocale: 'XX', defaultCountry: 'Portugal' })).toEqual({
      locale: DEFAULT_CONTENT_LOCALE,
      currency: 'EUR',
      country: 'Portugal',
    });
  });

  it('[S7-F2] a mapper uses the table’s currency for a price without one', async () => {
    const one = async (xml: string) => {
      for await (const r of streamXmlRecords(Readable.from([Buffer.from(`<root>${xml}</root>`)]), {
        recordElement: 'property',
      })) {
        return r as XmlElement;
      }
      throw new Error('no record');
    };
    const body = '<id>C-1</id><type>Villa</type><town>Marbella</town><price>250000</price>';
    const bare = mapKyeroProperty(await one(`<property>${body}</property>`), {
      ...kyeroSettings({}),
      defaultCurrency: 'GBP',
    });
    expect(bare.ok && bare.item.currency).toBe('GBP');
    const tagged = mapKyeroProperty(
      await one(`<property>${body}<currency>usd</currency></property>`),
      kyeroSettings({}),
    );
    expect(tagged.ok && tagged.item.currency).toBe('USD');
  });
});
