import { describe, expect, it } from 'vitest';
import { compileOwner, cutAtWord, deterministicSanitizer, NO_OWNER, type OwnerIdentity } from '../../../white-label';
import { buildIndexDoc, INDEXED_DESCRIPTION_CHARS, type IndexSourceRow } from '../index-doc';

/** The listings index document's text (S7-F5): the owner's text as the white-label sanitizer leaves it. */

const IDENTITY: OwnerIdentity = {
  names: ['Costa Homes S.L.', 'Costa Homes', 'Avenida del Mar 12', 'B12345678', 'María Núñez'],
  emails: ['sales@costa-homes.example'],
  phones: ['+34 611 222 333'],
  hosts: ['costahomes.es'],
};
const OWNER = compileOwner(IDENTITY);

const row = (over: Partial<IndexSourceRow> & { title: string }): IndexSourceRow => ({
  targetId: '0190f000-0000-7000-8000-000000000001',
  locale: 'en',
  kind: 'LISTING',
  agencyId: '0190f000-0000-7000-8000-0000000000aa',
  developmentId: null,
  public: true,
  status: 'ACTIVE',
  shareScope: 'ALL',
  allowedAgencyIds: null,
  networkHidden: false,
  preferredAgencyIds: null,
  version: 3,
  etag: 'etag-1',
  card: {
    kind: 'LISTING',
    id: '0190f000-0000-7000-8000-000000000001',
    ref: 'CH1234',
    title: over.title,
    transactionType: 'SALE',
    propertyType: { id: '0190f000-0000-7000-8000-0000000000bb', name: 'Villa' },
    place: { country: { id: 'c', name: 'Spain' }, region: null, city: { id: 'm', name: 'Marbella' }, area: null },
    price: { amountCents: 95_000_000, currency: 'EUR', onRequest: false },
    bedrooms: 3,
    bathrooms: 2,
    builtM2: 250,
    plotM2: 900,
    geo: null,
  },
  description: null,
  featureIds: [],
  createdAt: new Date('2026-10-01T00:00:00Z'),
  publicCode: 'ABCD2345',
  commissionBp: null,
  ...over,
});

const clean = (text: string) => OWNER.clean(text, ['CH1234']);

describe('index document text (S7-F5)', () => {
  it("[S7-F5] the indexed title and description carry no owner name, phone, e-mail, website or own reference; the listing's own words and facts stay", () => {
    const doc = buildIndexDoc(
      [
        row({
          title: 'Sea-view villa by Costa Homes S.L.',
          description:
            'Villa of 250 m2 for 950.000 €, built 2015. Ref. CH1234. Call Costa Homes on 611 222 333, ' +
            'e-mail <b>sales@costa-homes.example</b> or visit https://www.costahomes.es/villa &amp; COSTAHOMES.ES.',
        }),
      ],
      OWNER,
    );
    expect(doc?.title_en).toBe('Sea-view villa by');
    const description = doc?.description_en ?? '';
    expect(description).toContain('Villa of 250 m2 for 950.000 €, built 2015.');
    for (const leak of ['Costa', 'costa', 'COSTA', '611', 'sales@', 'CH1234', '<b>', '&amp;']) {
      expect(description, leak).not.toContain(leak);
    }
    // Place names come from the taxonomy: indexed as they are.
    expect(doc?.place_en).toBe('Marbella, Spain');
    // The owner's reference stays a field of its own (own sites look it up there).
    expect(doc?.ref).toBe('CH1234');
  });

  it('[S7-F5] names match in any case, accents and spacing: run together, hyphenated, possessive, across lines', () => {
    for (const variant of [
      'CostaHomes',
      'Costa-Homes',
      'COSTA HOMES',
      'costa_homes',
      'Cósta Hómes',
      "Costa Homes's",
      'Costa Homes’',
      'Costa\nHomes',
      'Costa Homes',
      'Costa Homes SL',
      'COSTAHOMES',
      'costahomes',
      'Maria Nunez',
      'MARÍA NÚÑEZ',
      'María-Núñez',
    ]) {
      expect(clean(`Villa with pool by ${variant} today`), variant).toBe('Villa with pool by today');
    }
    // A name inside another word is not touched; the words of the name alone are kept.
    expect(clean('Costa del Sol homes, Costahomesteads')).toBe('Costa del Sol homes, Costahomesteads');
    // Text written with combining accents (NFD) matches too.
    expect(clean('by María Núñez today')).toBe('by today');
  });

  it('[S7-F5] tax ids (any CIF, NIF or NIE, with or without separators) and the office address are removed', () => {
    expect(clean('Agency CIF B12345678, also B-1234567-8 and 12345678-Z, NIE X1234567L.')).toBe(
      'Agency CIF, also and, NIE.',
    );
    expect(clean('Visit our office at Avenida del Mar 12, Marbella')).toBe('Visit our office at, Marbella');
    // Prices, areas and years stay.
    expect(clean('Price 1.250.000 €, 250 m2, built 2015, 3 bedrooms')).toBe(
      'Price 1.250.000 €, 250 m2, built 2015, 3 bedrooms',
    );
  });

  it('[S7-F5] text without owner details is indexed as it was; long text is cut at a word boundary, never inside an e-mail', () => {
    const plain = 'Bright villa with a pool and sea views, close to the beach and golf.';
    const doc = buildIndexDoc([row({ title: 'Bright villa', description: plain })], OWNER);
    expect(doc?.title_en).toBe('Bright villa');
    expect(doc?.description_en).toBe(plain);
    const long = buildIndexDoc([row({ title: 'Long', description: 'word '.repeat(5_000) })], OWNER);
    expect(long?.description_en?.length).toBeLessThanOrEqual(INDEXED_DESCRIPTION_CHARS);
    expect(long?.description_en?.length).toBeGreaterThan(INDEXED_DESCRIPTION_CHARS - 10);
    expect(long?.description_en?.endsWith('word')).toBe(true);
    // An e-mail across a cap is dropped whole, never left half (a half the sanitizer could not recognise).
    expect(cutAtWord('Call us at info@costahomes.es today', 20)).toBe('Call us at');
    expect(cutAtWord('Short', 20)).toBe('Short');
  });

  it("[S7-F5] the owner's identity is part of sourceHash: an identity change re-pushes the document", () => {
    const rows = [row({ title: 'Bright villa' })];
    const before = buildIndexDoc(rows, OWNER)?.sourceHash;
    expect(buildIndexDoc(rows, compileOwner(IDENTITY))?.sourceHash).toBe(before);
    expect(buildIndexDoc(rows, compileOwner({ ...IDENTITY, hosts: ['other.example'] }))?.sourceHash).not.toBe(before);
    expect(buildIndexDoc(rows, compileOwner(NO_OWNER))?.sourceHash).not.toBe(before);
    // The fallback rows' documents (no owner): no text, and a hash that no identity change moves.
    const bare = buildIndexDoc(rows, null);
    expect(bare?.title_en).toBeUndefined();
    expect(bare?.description_en).toBeUndefined();
    expect(bare?.sourceHash).not.toBe(before);
  });

  it('[S7-F5] the compiled matcher and the per-call sanitizer agree', () => {
    const text = 'Costa-Homes villa, call +34 611 222 333 or sales@costa-homes.example, ref CH1234.';
    expect(deterministicSanitizer(text, { ...IDENTITY, ownerRefs: ['CH1234'] })).toBe(clean(text));
  });

  it('[S7-F5] the sanitizer stays fast on hostile descriptions (bounded input)', () => {
    const hostile = `${'a-'.repeat(50_000)}${'1 '.repeat(50_000)}`;
    const started = performance.now();
    buildIndexDoc([row({ title: 'x'.repeat(10_000), description: hostile })], OWNER);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('[S7-F5] a 500-document batch in three locales builds in well under a second (one compiled matcher per owner)', () => {
    const description =
      'Stunning south-facing villa with panoramic sea views, 4 bedrooms, 3 bathrooms, private pool and landscaped ' +
      'garden of 1.200 m2, close to golf courses, the beach and all amenities. Price 1.250.000 EUR. ';
    const rows = ['de', 'en', 'es'].map((locale) =>
      row({ title: 'Stunning villa with sea views in Marbella', locale, description: description.repeat(6) }),
    );
    buildIndexDoc(rows, OWNER); // warm up
    const started = performance.now();
    for (let i = 0; i < 500; i++) buildIndexDoc(rows, OWNER);
    const ms = performance.now() - started;
    console.log(`[S7-F5] 500 documents × 3 locales: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1_000);
  });
});
