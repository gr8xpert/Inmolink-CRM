import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FeedListing } from '@inmolink/contracts';
import { CONTENT_LOCALES } from '@inmolink/i18n';
import { describe, expect, it } from 'vitest';
import { type ConnectorContext, getConnector } from '../connectors';
import { emptyFeed } from '../guard';
import { type ItemError, type PendingBatch, runFeedPipeline } from '../pipeline';
import {
  createResalesConnector,
  RESALES_ATTEMPTS,
  RESALES_BACKOFF_MS,
  RESALES_CONCURRENCY,
  RESALES_PAGE_SIZE,
  ResalesApiError,
  ResalesConfigError,
  type ResalesFetcher,
  type ResalesResponse,
  redactSecrets,
  resalesDetailsUrl,
  resalesPageUrl,
} from '../resales/connector';
import { RESALES_V6_FIELDS, unaccountedPaths } from '../resales/coverage';
import { RESALES_LANGUAGE_CODES, resalesSettings } from '../resales/mapping';
import { classifyRunError } from '../runner';
import '../resales/connector';

/**
 * The Resales Online connector (S6-06, reworked in S6-F4 against the SPW project's production adapter): own listings
 * only, paging at the API's page cap, details and translations (or the listing kept as stored), unchanged listings
 * seen only, the account gate's retries, error handling. Pure; no network. The fixtures are hand-made in the shapes
 * SPW documents (tests/fixtures/resales); real recordings replace them at H13.
 */

const dir = fileURLToPath(new URL('../../../../../../tests/fixtures/resales/', import.meta.url));
const fixture = (name: string) => readFileSync(`${dir}${name}.json`, 'utf8');
const ok = (text: string): ResalesResponse => ({ status: 200, text });
const json = (v: unknown) => JSON.stringify(v);
const P1 = '1000';
const P2 = 'a3f1c2d4e5b6a7980f1e2d3c4b5a69788f7e6d5c';

const ctx = (over: Partial<ConnectorContext> = {}): ConnectorContext => ({
  connectionId: 'c1',
  agencyId: 'a1',
  url: 'https://webapi.resales-online.com/V6/SearchProperties',
  settings: { languages: '' },
  mapping: null,
  credentials: { type: 'basic', username: P1, password: P2 },
  signal: new AbortController().signal,
  ...over,
});

const isDetails = (u: URL) => u.pathname.endsWith('/PropertyDetails');
/** A details answer that only names the property (the list record is merged under it). */
const detailsEcho = (u: URL) =>
  ok(json({ transaction: { status: 'success' }, Property: { Reference: u.searchParams.get('P_RefId') } }));

/** A fake Resales API with a fake clock: `route` answers each request; every request is recorded. */
function fakeApi(
  route: (u: URL) => ResalesResponse | Promise<ResalesResponse>,
  options: { deadline?: { BASE_MS: number; PER_LISTING_MS: number }; delayMs?: number } = {},
) {
  const requests: URL[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let now = 1_000_000;
  const sleeps: number[] = [];
  const fetcher: ResalesFetcher = async ({ url }) => {
    const u = new URL(url);
    requests.push(u);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      else await Promise.resolve(); // every call started together is in flight before any answers
      return await route(u);
    } finally {
      inFlight--;
    }
  };
  const connector = createResalesConnector(fetcher, {
    key: 'resales-fixture',
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    ...(options.deadline ? { deadline: options.deadline } : {}),
  });
  return {
    connector,
    requests,
    sleeps,
    maxInFlight: () => maxInFlight,
    searches: () => requests.filter((u) => u.pathname.endsWith('/SearchProperties')),
    details: () => requests.filter(isDetails),
  };
}

/** The SPW-shaped fixtures: two pages; details for R3000001 / R3000002 recorded, the others echo their reference. */
const fixtureRoute = (u: URL): ResalesResponse => {
  if (isDetails(u)) {
    const ref = u.searchParams.get('P_RefId');
    return ref === 'R3000001' || ref === 'R3000002' ? ok(fixture(`details-${ref}`)) : detailsEcho(u);
  }
  return ok(fixture(u.searchParams.get('P_PageNo') === '1' ? 'search-page1' : 'search-page2'));
};

async function run(connector: ReturnType<typeof fakeApi>['connector'], c = ctx()) {
  const batches: PendingBatch<unknown>[] = [];
  let stats: Record<string, number> = {};
  const totals = await runFeedPipeline({
    connector,
    ctx: c,
    batchSize: 100,
    commit: async (b) => void batches.push(b),
    onStats: (s) => {
      stats = s;
    },
  });
  const valid = batches.flatMap((b) => b.valid);
  const errors: ItemError[] = batches.flatMap((b) => b.errors);
  const seen = batches.flatMap((b) => b.seen);
  const byRef = (ref: string) => valid.find((v) => v.ref === ref)?.item as Record<string, unknown>;
  return { totals, valid, errors, seen, byRef, stats };
}

/** A synthetic account: `total` records, every page capped at `cap` whatever is asked (the live API caps at 40). */
function cappedAccount(total: number, opts: { ownEvery?: number; cap?: number; perPage?: string | null } = {}) {
  const { ownEvery = 1, cap = 40, perPage = String(cap) } = opts;
  return (u: URL): ResalesResponse => {
    if (isDetails(u)) return detailsEcho(u);
    const page = Number(u.searchParams.get('P_PageNo'));
    const start = (page - 1) * cap;
    const Property = Array.from({ length: Math.max(0, Math.min(cap, total - start)) }, (_, i) => ({
      Reference: `R${String(start + i + 1).padStart(7, '0')}`,
      OwnProperty: (start + i) % ownEvery === 0 ? '1' : '0',
      Province: 'Málaga',
      Location: 'Marbella',
      PropertyType: { NameType: 'Detached Villa', Type: 'House' },
      Price: '1,000,000',
      Description: 'A villa.',
    }));
    return ok(
      json({
        transaction: { status: 'success' },
        QueryInfo: {
          PropertyCount: String(total),
          CurrentPage: String(page),
          ...(perPage === null ? {} : { PropertiesPerPage: perPage }),
          SearchType: 'Sale',
        },
        Property,
      }),
    );
  };
}

describe('Resales Online connector', () => {
  it('[S6-06] is registered under the key resales-online', () => {
    expect(getConnector('resales-online')?.key).toBe('resales-online');
  });

  it('[S6-F4] the field map accounts for every field of the SPW-shaped list and details fixtures', () => {
    const unaccounted = new Set<string>();
    const page1 = JSON.parse(fixture('search-page1')) as { Property: unknown[] };
    const page2 = JSON.parse(fixture('search-page2')) as { root: { Property: unknown[] } };
    const d1 = JSON.parse(fixture('details-R3000001')) as { Property: unknown };
    const d2 = JSON.parse(fixture('details-R3000002')) as { Property: unknown[] };
    for (const p of [...page1.Property, ...page2.root.Property, d1.Property, ...d2.Property])
      for (const path of unaccountedPaths(p)) unaccounted.add(path);
    expect([...unaccounted]).toEqual([]);
    expect(RESALES_V6_FIELDS.find((f) => f.path === 'AgencyId')).toBeUndefined();
  });

  it('[S6-F4] the request: SPW parameter names, the filter alias from the settings, our paging, whatever the stored URL carries', () => {
    const c = ctx({
      url: 'https://webapi.resales-online.com/V6/SearchProperties?p_agency_filterid=9&P_PageSize=500&p_x=1',
      settings: { filterAlias: '3' },
    });
    const u = new URL(resalesPageUrl(c, 3));
    expect(u.pathname).toBe('/V6/SearchProperties');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      p_agency_filterid: '3',
      p1: P1,
      p2: P2,
      P_PageNo: '3',
      P_PageSize: String(RESALES_PAGE_SIZE),
    });
    expect(new URL(resalesPageUrl(c, 1, 2)).searchParams.get('P_Lang')).toBe('2');
    const d = new URL(resalesDetailsUrl(ctx({ url: 'https://webapi.resales-online.com/V6' }), 'R1'));
    expect(d.pathname).toBe('/V6/PropertyDetails');
    expect(Object.fromEntries(d.searchParams)).toMatchObject({
      p_agency_filterid: '1',
      P_RefId: 'R1',
      P_ShowGPSCoords: 'TRUE',
      P_DecimalBaths: '1',
      p_pricelist: 'TRUE',
    });
    for (const bad of [{ filterAlias: '54031' }, { filterAlias: 0 }, { filterAlias: '' }])
      expect(() => resalesPageUrl(ctx({ settings: bad }), 1)).toThrow(ResalesConfigError);
  });

  it('[S6-F4] settings are checked when a connection is saved: the filter alias is 1-4, languages a list of codes', () => {
    const connector = getConnector('resales-online');
    expect(connector?.settingsProblem?.({ filterAlias: '5' })).toBe('filterAlias');
    expect(connector?.settingsProblem?.({ filterAlias: 54031 })).toBe('filterAlias');
    expect(connector?.settingsProblem?.({ languages: 'es;de' })).toBe('languages');
    expect(connector?.settingsProblem?.({ filterAlias: '2', languages: 'es, de', defaultCountry: 'Spain' })).toBeNull();
    expect(connector?.settingsProblem?.({})).toBeNull();
    expect(classifyRunError(new ResalesConfigError('FILTER_ALIAS_INVALID'))).toEqual({
      code: 'FEED_SETTINGS_INVALID',
      retryable: false,
    });
  });

  it('[S6-06] credentials only go to https://webapi.resales-online.com on port 443, and are required', () => {
    for (const url of [
      'https://evil.example.com/V6/SearchProperties',
      'https://resales-online.com.evil.example/x',
      'https://www.resales-online.com/V6/SearchProperties',
      'https://other.webapi.resales-online.com/V6',
      'https://webapi.resales-online.com:8443/V6',
      'http://webapi.resales-online.com/V6/SearchProperties',
    ])
      expect(() => resalesPageUrl(ctx({ url }), 1), url).toThrow(ResalesConfigError);
    expect(() => resalesPageUrl(ctx({ url: 'https://WEBAPI.resales-online.com:443/V6' }), 1)).not.toThrow();
    expect(() => resalesPageUrl(ctx({ credentials: null }), 1)).toThrow(ResalesConfigError);
    expect(classifyRunError(new ResalesConfigError('CREDENTIALS_REQUIRED')).code).toBe('FEED_CREDENTIALS_REJECTED');
  });

  it('[S6-F4] the SPW-shaped SearchProperties fixture (own and shared listings) imports exactly the own listings', async () => {
    const api = fakeApi(fixtureRoute);
    const { totals, valid, errors, stats } = await run(api.connector);
    expect(api.searches()).toHaveLength(2); // paged until PropertyCount (5)
    // shared listings (OwnProperty "0" and a record without the field) are dropped and counted, never items
    expect(totals).toMatchObject({ total: 3, valid: 3, failed: 0 });
    expect(stats).toMatchObject({ pages: 2, notOwn: 2, detailed: 3, detailsFailed: 0 });
    expect(errors).toEqual([]);
    expect(valid.map((v) => v.ref).sort()).toEqual(['R3000001', 'R3000002', 'R3000003']);
    expect(
      api
        .details()
        .map((u) => u.searchParams.get('P_RefId'))
        .sort(),
    ).toEqual(['R3000001', 'R3000002', 'R3000003']);
    expect(JSON.stringify(valid)).not.toMatch(/R9000|NET-|Fuengirola|Nerja|Network/);
    for (const v of valid) {
      expect(FeedListing.safeParse(v.item).success).toBe(true);
      expect(v.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('[S6-F4] a 1,227-listing account with a 40-per-page cap imports all pages', async () => {
    const api = fakeApi(cappedAccount(1_227));
    const { totals, valid } = await run(api.connector);
    expect(api.searches()).toHaveLength(31); // 30 × 40 + 27
    expect(api.searches().every((u) => u.searchParams.get('P_PageSize') === '40')).toBe(true);
    expect(totals).toMatchObject({ total: 1_227, valid: 1_227, failed: 0 });
    expect(new Set(valid.map((v) => v.ref)).size).toBe(1_227);
  });

  it('[S6-F4] paging follows the size the API used: a 20 cap with PropertiesPerPage 20, and without PropertiesPerPage', async () => {
    const capped = fakeApi(cappedAccount(1_227, { cap: 20, perPage: '20' }));
    expect((await run(capped.connector)).totals).toMatchObject({ total: 1_227, valid: 1_227 });
    expect(capped.searches()).toHaveLength(62); // 61 × 20 + 7: never stopped at the size asked for
    const unsaid = fakeApi(cappedAccount(1_227, { cap: 20, perPage: null }));
    expect((await run(unsaid.connector)).totals).toMatchObject({ total: 1_227, valid: 1_227 });
    expect(unsaid.searches()).toHaveLength(62);
    // a count above what the account holds: the short page ends it
    const overCounted = fakeApi((u) => {
      const res = cappedAccount(50, { cap: 20, perPage: null })(u);
      return isDetails(u) ? res : ok(res.text.replace('"PropertyCount":"50"', '"PropertyCount":"5000"'));
    });
    expect((await run(overCounted.connector)).totals).toMatchObject({ total: 50 });
    expect(overCounted.searches()).toHaveLength(3);
  });

  it('[S6-F4] shared listings are counted, not item errors; a feed of only shared listings still trips the empty-feed guard', async () => {
    const api = fakeApi(cappedAccount(1_227, { ownEvery: 3 }));
    const { totals, errors, stats } = await run(api.connector);
    expect(api.searches()).toHaveLength(31);
    expect(totals).toMatchObject({ total: 409, valid: 409, failed: 0 });
    expect(errors).toHaveLength(0);
    expect(stats.notOwn).toBe(818);
    const none = await run(fakeApi(cappedAccount(80, { ownEvery: 1_000_000 })).connector);
    // record 0 is own (0 % n === 0); everything else shared
    expect(none.totals.total).toBe(1);
    const allShared = fakeApi((u) =>
      ok(cappedAccount(80)(u).text.replaceAll('"OwnProperty":"1"', '"OwnProperty":"0"')),
    );
    const empty = await run(allShared.connector);
    expect(empty.totals).toMatchObject({ total: 0, valid: 0 });
    expect(emptyFeed(5, empty.totals.total)).not.toBeNull(); // live listings + an empty run: paused, nothing withdrawn
  });

  it('[S6-F4] fails closed when a page has no own-property field at all (unconfirmed until H13)', async () => {
    const api = fakeApi((u) => ok(cappedAccount(10)(u).text.replaceAll('"OwnProperty"', '"Owner"')));
    const err = await run(api.connector).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'MALFORMED' });
    expect(api.details()).toHaveLength(0);
  });

  it('[S6-F4] maps the own listings: separators, ranges, POA, development type, decimal baths, plot/built fallbacks, nested location, details coordinates', async () => {
    const { byRef } = await run(fakeApi(fixtureRoute).connector);
    expect(byRef('R3000001')).toMatchObject({
      transactionType: 'SALE',
      priceCents: 125_000_000,
      priceOnRequest: false,
      currency: 'EUR',
      bedrooms: 4,
      bathrooms: 3, // "3.5" from details: whole numbers only
      builtM2: 320,
      plotM2: 1_200, // "1,200"
      terraceM2: 60,
      yearBuilt: 2015,
      energyRating: 'C',
      propertyType: 'Detached Villa', // NameType first
      location: { country: 'Spain', region: 'Málaga', city: 'Marbella', area: 'Nueva Andalucía' },
      coordinates: { lat: 36.496, lng: -4.962 }, // GpsX / GpsY told apart
      features: ['Pool', 'Close To Golf', 'Close To Sea', 'Private', 'Air Conditioning'],
    });
    expect(byRef('R3000001').images).toHaveLength(2);
    expect((byRef('R3000001').translations as { description: string }[])[0]).toMatchObject({
      locale: 'en',
      description: expect.stringContaining('South facing.'), // the details' description
    });
    expect(byRef('R3000002')).toMatchObject({
      propertyType: 'Ground Floor Apartment',
      priceCents: 9_609_100,
      bedrooms: 1,
      bathrooms: 1,
      builtM2: 39,
      terraceM2: 10,
      plotM2: null,
      coordinates: { lat: 36.427, lng: -5.146 },
      location: { country: 'Spain', region: 'Málaga', city: 'Estepona' },
    });
    expect(byRef('R3000003')).toMatchObject({
      priceCents: 55_000_000,
      bathrooms: 2,
      builtM2: 145,
      plotM2: 210,
      coordinates: null,
      features: ['Sea', 'Mountain'],
      location: { region: 'Málaga', city: 'Benalmádena', area: 'Arroyo de la Miel' },
    });
  });

  it('[S6-F4] prices: POA and zero are on request, rentals read RentalPrice1 and RentalPeriod, the alias sets the transaction type', async () => {
    const page = (Property: unknown[], SearchType?: string) => (u: URL) =>
      isDetails(u)
        ? detailsEcho(u)
        : ok(
            json({
              transaction: { status: 'success' },
              QueryInfo: { PropertyCount: Property.length, SearchType },
              Property,
            }),
          );
    const base = { OwnProperty: '1', Location: 'Marbella', PropertyType: { NameType: 'Villa' } };
    const props = [
      { ...base, Reference: 'A', Price: 'POA' },
      { ...base, Reference: 'B', Price: '0' },
      { ...base, Reference: 'C', RentalPrice1: '1,500', RentalPrice2: '2,000', RentalPeriod: 'Week' },
      { ...base, Reference: 'D', Price: '12.5.0' },
    ];
    const short = await run(fakeApi(page(props)).connector, ctx({ settings: { filterAlias: '2', languages: '' } }));
    expect(short.byRef('A')).toMatchObject({
      transactionType: 'RENT_SHORT_TERM',
      priceCents: null,
      priceOnRequest: true,
    });
    expect(short.byRef('B')).toMatchObject({ priceCents: null, priceOnRequest: true });
    expect(short.byRef('C')).toMatchObject({ priceCents: 150_000, pricePeriod: 'WEEK', priceOnRequest: false });
    expect(short.errors.find((e) => e.itemRef === 'D')?.code).toBe('INVALID_PRICE');
    const long = await run(
      fakeApi(page(props.slice(2, 3), 'Long Term Rental')).connector,
      ctx({ settings: { filterAlias: '4', languages: '' } }),
    );
    expect(long.byRef('C')).toMatchObject({ transactionType: 'RENT_LONG_TERM', pricePeriod: 'WEEK' });
    const sale = await run(fakeApi(page(props.slice(2, 3))).connector);
    expect(sale.byRef('C')).toMatchObject({ transactionType: 'SALE', pricePeriod: null, priceOnRequest: true });
  });

  /** Page 1 per language: Spanish for R3000001 (R3000002's is the English fallback), nl = the English text. */
  const languageRoute =
    (opts: { failLang?: string; dropRef?: string } = {}) =>
    (u: URL): ResalesResponse => {
      const lang = u.searchParams.get('P_Lang');
      if (lang && lang === opts.failLang) return { status: 500, text: '' };
      if (isDetails(u) || u.searchParams.get('P_PageNo') !== '1' || !lang) return fixtureRoute(u);
      const doc = JSON.parse(fixture('search-page1')) as { Property: { Reference: string; Description: string }[] };
      doc.Property = doc.Property.filter((p) => p.Reference !== opts.dropRef);
      for (const p of doc.Property) {
        if (lang === '2' && p.Reference === 'R3000001') p.Description = '<p>Preciosa villa en Nueva Andalucía.</p>';
        if (lang === '2' && p.Reference === 'R9000001') p.Description = 'Anuncio de otra agencia.';
        if (lang === '5' && p.Reference === 'R3000001')
          p.Description = '<p>Lovely villa in Nueva Andalucía.</p><p>South facing.</p>';
      }
      return ok(json(doc));
    };

  it('[S6-F4] translations: one SearchProperties call per language with numeric P_Lang; text identical to the English is dropped', async () => {
    const api = fakeApi(languageRoute());
    const { byRef, totals } = await run(api.connector, ctx({ settings: { languages: 'es, nl, xx, en' } }));
    expect(totals).toMatchObject({ valid: 3, failed: 0 });
    const langs = api.searches().map((u) => u.searchParams.get('P_Lang'));
    expect(langs.sort()).toEqual([null, null, '2', '2', '5', '5'].sort()); // es 2, nl 5 per page; en is the base
    const t1 = byRef('R3000001').translations as { locale: string; description: string }[];
    expect(t1.map((t) => t.locale)).toEqual(['en', 'es']); // nl equal to the English: dropped
    expect(t1[1]?.description).toBe('Preciosa villa en Nueva Andalucía.');
    expect((byRef('R3000002').translations as unknown[]).length).toBe(1);
    expect(JSON.stringify(byRef('R3000001'))).not.toMatch(/otra agencia/);
    expect(resalesSettings({}).languages.sort()).toEqual(
      CONTENT_LOCALES.filter((l) => l !== 'en' && RESALES_LANGUAGE_CODES[l] !== undefined).sort(),
    );
  });

  it("[S6-F4] a failed language never writes a reduced translation set: the page's changed listings fail with their reference", async () => {
    const api = fakeApi(languageRoute({ failLang: '3' }));
    const { valid, errors, stats } = await run(api.connector, ctx({ settings: { languages: 'es,de' } }));
    expect(api.searches().filter((u) => u.searchParams.get('P_Lang') === '3')).toHaveLength(2 * RESALES_ATTEMPTS);
    expect(valid).toHaveLength(0);
    expect(errors.map((e) => [e.itemRef, e.code])).toEqual([
      ['R3000001', 'TRANSLATIONS_UNAVAILABLE'],
      ['R3000002', 'TRANSLATIONS_UNAVAILABLE'],
      ['R3000003', 'TRANSLATIONS_UNAVAILABLE'],
    ]);
    expect(stats.languagesFailed).toBe(2);
  });

  it('[S6-F4] a listing missing from a language call (it moved between the calls) fails with its reference; the rest import', async () => {
    const api = fakeApi(languageRoute({ dropRef: 'R3000002' }));
    const { valid, errors } = await run(api.connector, ctx({ settings: { languages: 'es' } }));
    expect(errors.map((e) => [e.itemRef, e.code])).toEqual([['R3000002', 'TRANSLATIONS_UNAVAILABLE']]);
    expect(valid.map((v) => v.ref).sort()).toEqual(['R3000001', 'R3000003']);
  });

  it(`[S6-F4] details and languages run together, at most ${RESALES_CONCURRENCY} calls in flight, own listings only`, async () => {
    const api = fakeApi(cappedAccount(80, { ownEvery: 2 }));
    const { totals } = await run(api.connector, ctx({ settings: { languages: 'es,de,fr,nl,sv' } }));
    expect(totals).toMatchObject({ total: 40, valid: 40 });
    expect(api.details()).toHaveLength(40); // every own listing, no shared one
    expect(api.maxInFlight()).toBe(RESALES_CONCURRENCY);
    // page 1's language calls start before its last details call
    const firstLang = api.requests.findIndex((u) => u.searchParams.has('P_Lang') && !isDetails(u));
    const lastDetailsOfPage1 = api.requests.findLastIndex((u) => isDetails(u) && api.requests.indexOf(u) < 70);
    expect(firstLang).toBeLessThan(lastDetailsOfPage1);
  });

  it('[S6-F4] a details call that keeps failing is retried with backoff, then the listing fails with its reference (kept as stored, never written with less)', async () => {
    const api = fakeApi((u) =>
      isDetails(u) && u.searchParams.get('P_RefId') === 'R3000001' ? { status: 503, text: '' } : fixtureRoute(u),
    );
    const { valid, errors, stats } = await run(api.connector);
    expect(api.details().filter((u) => u.searchParams.get('P_RefId') === 'R3000001')).toHaveLength(RESALES_ATTEMPTS);
    expect(api.sleeps).toEqual(expect.arrayContaining([RESALES_BACKOFF_MS, 2 * RESALES_BACKOFF_MS]));
    expect(errors).toEqual([
      expect.objectContaining({ itemRef: 'R3000001', code: 'DETAILS_UNAVAILABLE', field: 'PropertyDetails' }),
    ]);
    expect(valid.map((v) => v.ref)).not.toContain('R3000001');
    expect(stats.detailsFailed).toBe(1);
  });

  it('[S6-F4] an unchanged listing (same list hash) is seen only: no details or language call, not written, not an error', async () => {
    const first = await run(fakeApi(fixtureRoute).connector, ctx({ settings: { languages: 'es' } }));
    const hashes = new Map(first.valid.map((v) => [v.ref, v.sourceHash as string]));
    hashes.delete('R3000003'); // changed (or never stored)
    const api = fakeApi(languageRoute());
    const asked: string[][] = [];
    const again = await run(
      api.connector,
      ctx({
        settings: { languages: 'es' },
        sourceHashes: async (refs) => {
          asked.push([...refs]);
          return new Map([...hashes].filter(([ref]) => refs.includes(ref)));
        },
      }),
    );
    expect(asked).toEqual([['R3000001', 'R3000002'], ['R3000003']]);
    expect(again.seen.sort()).toEqual(['R3000001', 'R3000002']);
    expect(again.valid.map((v) => v.ref)).toEqual(['R3000003']);
    expect(again.totals).toMatchObject({ total: 3, valid: 1, failed: 0, seen: 2 });
    expect(api.details().map((u) => u.searchParams.get('P_RefId'))).toEqual(['R3000003']);
    // page 1 had nothing changed: no language call for it
    expect(
      api
        .searches()
        .filter((u) => u.searchParams.get('P_Lang') === '2')
        .map((u) => u.searchParams.get('P_PageNo')),
    ).toEqual(['2']);
    expect(again.stats.unchanged).toBe(2);
  });

  it('[S6-F4] a busy-server "P1 or P2 not valid" answer is retried with backoff, not failed', async () => {
    let calls = 0;
    const busy = ok(
      json({ transaction: { status: 'error', errordescription: { '1': 'P1 or P2 not valid; check your IP' } } }),
    );
    const api = fakeApi((u) =>
      !isDetails(u) && u.searchParams.get('P_PageNo') === '1' && calls++ < 2 ? busy : fixtureRoute(u),
    );
    const { totals } = await run(api.connector);
    expect(totals).toMatchObject({ valid: 3 });
    expect(api.sleeps).toEqual([RESALES_BACKOFF_MS, 2 * RESALES_BACKOFF_MS]);
  });

  it('[S6-F4] "P1 or P2 not valid" three times, whatever the HTTP status, is a credentials error: FEED_CREDENTIALS_REJECTED, never the key', async () => {
    for (const status of [200, 500]) {
      const api = fakeApi(() => ({
        status,
        text: json({
          root: {
            transaction: {
              status: 'error',
              incomingIp: '203.0.113.10',
              errordescription: { '1': `P1 or P2 not valid (p2=${P2})`, '2': 'incoming IP not allowed' },
            },
          },
        }),
      }));
      const err = await run(api.connector).catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'CREDENTIALS' });
      expect((err as ResalesApiError).descriptions).toEqual([
        'P1 or P2 not valid (p2=[redacted])',
        'incoming IP not allowed',
      ]);
      expect((err as Error).message).not.toContain(P2);
      expect(api.searches()).toHaveLength(RESALES_ATTEMPTS);
      expect(classifyRunError(err)).toEqual({ code: 'FEED_CREDENTIALS_REJECTED', retryable: false });
    }
  });

  it('[S6-F4] fails only on transaction.status "error"; any other answer without it is read', async () => {
    const refused = fakeApi(() =>
      ok(json({ transaction: { status: 'error', errordescription: { '1': 'FilterAgencyId not valid' } } })),
    );
    const err = await run(refused.connector).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'REFUSED', descriptions: ['FilterAgencyId not valid'] });
    expect(refused.searches()).toHaveLength(1); // not transient: no retry
    const noStatus = fakeApi((u) =>
      isDetails(u)
        ? detailsEcho(u)
        : ok(
            json({
              QueryInfo: { PropertyCount: 1 },
              Property: {
                Reference: 'X1',
                OwnProperty: 1,
                Location: 'Mijas',
                PropertyType: { NameType: 'Villa' },
                Price: '1',
              },
            }),
          ),
    );
    expect((await run(noStatus.connector)).totals).toMatchObject({ valid: 1 }); // a single Property object
  });

  it("[S6-F4] a non-2xx answer keeps Resales' error body; 5xx is retried, then retries the run; 429 waits its Retry-After", async () => {
    const body = json({ transaction: { status: 'error', errordescription: { '1': 'Service unavailable' } } });
    const down = fakeApi(() => ({ status: 503, text: body }));
    const e503 = await run(down.connector).catch((e: unknown) => e);
    expect(e503).toMatchObject({ kind: 'HTTP', status: 503, descriptions: ['Service unavailable'] });
    expect(down.searches()).toHaveLength(RESALES_ATTEMPTS);
    expect(classifyRunError(e503)).toEqual({ code: 'FEED_HTTP_STATUS', retryable: true });
    const e403 = await run(fakeApi(() => ({ status: 403, text: 'Forbidden' })).connector).catch((e: unknown) => e);
    expect(classifyRunError(e403)).toEqual({ code: 'FEED_HTTP_STATUS', retryable: false });
    const junk = await run(fakeApi(() => ok('<html>')).connector).catch((e: unknown) => e);
    expect(classifyRunError(junk)).toEqual({ code: 'FEED_MALFORMED', retryable: false });
    let limited = 0;
    const slow = fakeApi((u) =>
      !isDetails(u) && limited++ === 0 ? { status: 429, text: '', retryAfter: '7' } : fixtureRoute(u),
    );
    expect((await run(slow.connector)).totals).toMatchObject({ valid: 3 });
    expect(slow.sleeps[0]).toBe(7_000);
  });

  it('[S6-F4] the run has a deadline sized to PropertyCount: past it the run fails as a timeout', async () => {
    const api = fakeApi(cappedAccount(1_227), { delayMs: 5, deadline: { BASE_MS: 40, PER_LISTING_MS: 0 } });
    const err = await run(api.connector).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'DEADLINE' });
    expect(classifyRunError(err)).toEqual({ code: 'FEED_TIMEOUT', retryable: false });
    expect(api.searches().length).toBeLessThan(31);
  });

  it('[S6-F4] credentials are removed from API texts in every form: raw, URL-encoded, URLSearchParams, any case, p1= / p2= pairs', () => {
    const key = 'Ab+c/d e&F';
    const out = (t: string) => redactSecrets(t, ['1000', key]);
    expect(out(`bad key ${key}`)).toBe('bad key [redacted]');
    expect(out(`bad key ${encodeURIComponent(key)}`)).toBe('bad key [redacted]');
    expect(out(`bad key ${new URLSearchParams({ k: key }).toString().slice(2)}`)).toBe('bad key [redacted]');
    expect(out(`bad key ${key.toUpperCase()}`)).toBe('bad key [redacted]');
    expect(out('url ?p1=1234&P2=zzzz&x=1')).toBe('url ?p1=[redacted]&P2=[redacted]&x=1');
    expect(out('p2%3Dzzz')).toBe('p2=[redacted]');
    expect(out('client 1000 refused')).toBe('client [redacted] refused');
  });

  it('[S6-06] an unavailable property is a per-item error without a ref, so the loader sees it as missing and withdraws it', async () => {
    const api = fakeApi((u) => {
      if (isDetails(u)) return detailsEcho(u);
      const doc = JSON.parse(fixture('search-page1')) as { Property: { Status: unknown }[] };
      doc.Property[0] = { ...doc.Property[0], Status: { system: 'Sold', en: 'Sold' } } as { Status: unknown };
      (doc.Property[2] as { Status: unknown }).Status = 'Under Offer';
      return ok(json({ ...doc, QueryInfo: { PropertyCount: 3 } }));
    });
    const { errors, valid, byRef } = await run(api.connector);
    expect(errors.map((e) => e.code)).toContain('NOT_AVAILABLE');
    expect(errors.every((e) => !e.itemRef)).toBe(true);
    expect(valid.map((v) => v.ref)).not.toContain('R3000001');
    expect(byRef('R3000002')).toMatchObject({ status: 'UNDER_OFFER' });
  });

  it('[S6-06] an API that ignores the page number fails the run instead of paging for ever', async () => {
    const doc = JSON.parse(fixture('search-page1')) as { QueryInfo: Record<string, unknown> };
    doc.QueryInfo = { PropertyCount: 9999 };
    const api = fakeApi((u) => (isDetails(u) ? detailsEcho(u) : ok(json(doc))));
    await expect(run(api.connector)).rejects.toBeInstanceOf(ResalesApiError);
    expect(api.searches()).toHaveLength(2);
  });
});
