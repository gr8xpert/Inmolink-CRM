import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FeedListing } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { type ConnectorContext, getConnector } from '../connectors';
import { type ItemError, type PendingBatch, runFeedPipeline } from '../pipeline';
import {
  createResalesConnector,
  RESALES_PAGE_SIZE,
  ResalesApiError,
  ResalesConfigError,
  resalesPageUrl,
} from '../resales/connector';
import { RESALES_V6_FIELDS, unaccountedPaths } from '../resales/coverage';
import { classifyRunError } from '../runner';
import '../resales/connector';

/** The Resales Online connector (S6-06): own listings only, mapping coverage, request shape. Pure; no network. */

const dir = fileURLToPath(new URL('../../../../../../tests/fixtures/resales/', import.meta.url));
const page = (n: number) => readFileSync(`${dir}search-page${n}.json`, 'utf8');
const OWN = 'AG-1001';

const ctx = (over: Partial<ConnectorContext> = {}): ConnectorContext => ({
  connectionId: 'c1',
  agencyId: 'a1',
  url: 'https://webapi.resales-online.com/V6/SearchProperties',
  settings: { agencyId: OWN },
  mapping: null,
  credentials: { type: 'basic', username: 'ident-123', password: 'secret-key-456' },
  signal: new AbortController().signal,
  ...over,
});

function servePages(pages: string[]) {
  const urls: string[] = [];
  const connector = createResalesConnector(async ({ url }) => {
    urls.push(url);
    return pages[urls.length - 1] ?? JSON.stringify({ transaction: { status: 'success' }, Property: [] });
  }, 'resales-fixture');
  return { connector, urls };
}

async function run(connector: ReturnType<typeof servePages>['connector'], c = ctx()) {
  const batches: PendingBatch<unknown>[] = [];
  const totals = await runFeedPipeline({
    connector,
    ctx: c,
    batchSize: 100,
    commit: async (b) => void batches.push(b),
  });
  const valid = batches.flatMap((b) => b.valid);
  const errors: ItemError[] = batches.flatMap((b) => b.errors);
  return { totals, valid, errors };
}

describe('Resales Online connector', () => {
  it('[S6-06] is registered under the key resales-online', () => {
    expect(getConnector('resales-online')?.key).toBe('resales-online');
  });

  it('[S6-06] the field map accounts for every field of the recorded response pages (100% coverage)', () => {
    const unaccounted = new Set<string>();
    for (const n of [1, 2]) {
      const doc = JSON.parse(page(n)) as { Property: unknown[] };
      for (const p of doc.Property) for (const path of unaccountedPaths(p)) unaccounted.add(path);
    }
    expect([...unaccounted]).toEqual([]);
    expect(RESALES_V6_FIELDS.every((f) => f.maps === null || f.note !== undefined)).toBe(true);
  });

  it('[S6-06] the request asks for own listings only, with our own paging, whatever the stored URL carries', () => {
    const u = new URL(
      resalesPageUrl(
        ctx({ url: 'https://webapi.resales-online.com/V6/SearchProperties?p_agency_filterid=2&p_PageSize=500&p_x=1' }),
        3,
      ),
    );
    expect(u.searchParams.get('p_agency_filterid')).toBe('1');
    expect(u.searchParams.get('p_PageNo')).toBe('3');
    expect(u.searchParams.get('p_PageSize')).toBe(String(RESALES_PAGE_SIZE));
    expect(u.searchParams.get('p1')).toBe('ident-123');
    expect(u.searchParams.get('p2')).toBe('secret-key-456');
    expect(u.searchParams.has('p_x')).toBe(false);
  });

  it('[S6-06] credentials only go to https Resales Online hosts, and are required', () => {
    expect(() => resalesPageUrl(ctx({ url: 'https://evil.example.com/V6/SearchProperties' }), 1)).toThrow(
      ResalesConfigError,
    );
    expect(() => resalesPageUrl(ctx({ url: 'https://resales-online.com.evil.example/x' }), 1)).toThrow(
      ResalesConfigError,
    );
    expect(() => resalesPageUrl(ctx({ url: 'http://webapi.resales-online.com/V6/SearchProperties' }), 1)).toThrow(
      ResalesConfigError,
    );
    expect(() => resalesPageUrl(ctx({ credentials: null }), 1)).toThrow(ResalesConfigError);
  });

  it('[S6-06] a fixture with own and network listings imports only the own ones; the rest are counted, never imported', async () => {
    const { connector, urls } = servePages([page(1), page(2)]);
    const { totals, valid, errors } = await run(connector);
    expect(urls).toHaveLength(2); // paged until PropertyCount (6) was reached
    expect(totals).toMatchObject({ total: 6, valid: 3, failed: 3 });
    expect(valid.map((v) => v.ref).sort()).toEqual(['R3000001', 'R3000002', 'R3000003']);
    // network listings of another agency AND a record without an owner id: dropped, counted, no ref, no content
    expect(errors.map((e) => e.code)).toEqual(['NOT_OWN_LISTING', 'NOT_OWN_LISTING', 'NOT_OWN_LISTING']);
    const stored = JSON.stringify(errors);
    expect(stored).not.toMatch(/R9000|AG-7777|Marbella|Fuengirola|Nerja/);
    for (const v of valid) expect(FeedListing.safeParse(v.item).success).toBe(true);
  });

  it('[S6-06] the connector filter holds even if the API ignored the filter: a feed of only network listings imports nothing', async () => {
    const doc = JSON.parse(page(1)) as { Property: { AgencyId: string }[] };
    for (const p of doc.Property) p.AgencyId = 'AG-7777';
    const { connector } = servePages([JSON.stringify(doc)]);
    const { totals, valid } = await run(connector);
    expect(valid).toHaveLength(0);
    expect(totals).toMatchObject({ total: 3, valid: 0, failed: 3 });
  });

  it('[S6-06] the own agency id defaults to the API identifier when no agencyId setting is given', async () => {
    const { connector } = servePages([page(1), page(2)]);
    const none = await run(connector, ctx({ settings: {} })); // identifier ident-123 matches nothing
    expect(none.valid).toHaveLength(0);
    const { connector: c2 } = servePages([page(1), page(2)]);
    const some = await run(c2, ctx({ settings: {}, credentials: { type: 'basic', username: OWN, password: 'k' } }));
    expect(some.valid).toHaveLength(3);
  });

  it('[S6-06] maps the own listings: price, taxonomy text, features, images, plain-text description', async () => {
    const { connector } = servePages([page(1), page(2)]);
    const { valid } = await run(connector);
    const first = valid.find((v) => v.ref === 'R3000001')?.item as Record<string, unknown>;
    expect(first).toMatchObject({
      transactionType: 'SALE',
      priceCents: 125_000_000,
      currency: 'EUR',
      bedrooms: 4,
      builtM2: 120,
      plotM2: 500,
      propertyType: 'Villa',
      location: { country: 'Spain', region: 'Málaga', city: 'Marbella', area: 'Centro' },
      coordinates: { lat: 36.51, lng: -4.88 },
    });
    expect(first.features).toEqual(['Pool', 'Close To Golf', 'Close To Sea', 'Private']);
    expect(first.images).toHaveLength(2);
    expect((first.translations as { description: string }[])[0]?.description).toBe('Lovely home in Marbella.');
  });

  it('[S6-06] a non-success API answer fails the run', async () => {
    const { connector } = servePages([JSON.stringify({ transaction: { status: 'error' } })]);
    await expect(run(connector)).rejects.toBeInstanceOf(ResalesApiError);
  });

  it('[S6-06] an unavailable property is a per-item error without a ref, so the loader sees it as missing and withdraws it', async () => {
    const doc = JSON.parse(page(1)) as { Property: { Status: { system: string } }[] };
    (doc.Property[0] as { Status: { system: string } }).Status.system = 'Sold';
    const { connector } = servePages([JSON.stringify(doc)]);
    const { errors, valid } = await run(connector);
    expect(errors.map((e) => e.code)).toContain('NOT_AVAILABLE');
    expect(errors.every((e) => !e.itemRef)).toBe(true);
    expect(valid.map((v) => v.ref)).not.toContain('R3000001');
  });

  it('[S6-06] an API that ignores the page number fails the run instead of paging for ever', async () => {
    const doc = JSON.parse(page(1)) as { QueryInfo: { PropertyCount: number } };
    doc.QueryInfo.PropertyCount = 9999;
    const text = JSON.stringify(doc);
    const { connector, urls } = servePages([text, text, text]);
    await expect(run(connector)).rejects.toBeInstanceOf(ResalesApiError);
    expect(urls.length).toBe(2);
  });

  it('[S6-06] configuration and API errors are final, not retried', () => {
    expect(classifyRunError(new ResalesConfigError('CREDENTIALS_REQUIRED'))).toEqual({
      code: 'FEED_DESTINATION_BLOCKED',
      retryable: false,
    });
    expect(classifyRunError(new ResalesApiError())).toEqual({ code: 'FEED_MALFORMED', retryable: false });
  });
});
