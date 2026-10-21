import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createWebsiteClient, edgeKeyToken, WebsiteApiError } from './index';

/** A fetch that records the request and answers `body` with `status`. */
function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }) {
  return (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('website API client (S7-03)', () => {
  it('[S7-03] the generated SDK calls each operation with its path, query and key', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const page = { items: [], total: 0, facets: {}, nextCursor: null, degraded: false };
    const client = createWebsiteClient({
      baseUrl: 'https://feed.example/',
      apiKey: 'inl_test_key',
      fetch: fakeFetch(200, page, seen),
    });
    expect(await client.listListings({ types: ['a', 'b'], priceMin: 100, sort: 'price_asc' })).toEqual(page);
    const k = await edgeKeyToken('inl_test_key');
    expect(seen.url).toBe(`https://feed.example/v2/listings?types=a%2Cb&priceMin=100&sort=price_asc&_k=${k}`);
    expect(seen.init?.headers).toMatchObject({ 'x-api-key': 'inl_test_key' });
    await client.getListing({ ref: 'CH-7KQ2 M9' }, { lang: 'es' });
    expect(seen.url).toBe(`https://feed.example/v2/listings/CH-7KQ2%20M9?lang=es&_k=${k}`);
  });

  it('[S7-05] website forms post a JSON body with their Idempotency-Key', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const accepted = {
      id: '01900000-0000-7000-8000-000000000001',
      kind: 'ENQUIRY',
      status: 'RECEIVED',
      replayed: false,
    };
    const client = createWebsiteClient({
      baseUrl: 'https://feed.example',
      apiKey: 'k',
      fetch: fakeFetch(201, accepted, seen),
    });
    const body = { name: 'Ana', email: 'ana@example.com', privacyAccepted: true as const, turnstileToken: 't' };
    expect(await client.createLead(body, { 'idempotency-key': 'form-0123456789abcdef' })).toEqual(accepted);
    expect(seen.url).toBe('https://feed.example/v2/leads');
    expect(seen.init?.method).toBe('POST');
    expect(seen.init?.headers).toMatchObject({
      'x-api-key': 'k',
      'content-type': 'application/json',
      'idempotency-key': 'form-0123456789abcdef',
    });
    expect(JSON.parse(String(seen.init?.body))).toEqual(body);
  });

  it('[S7-03] error answers throw WebsiteApiError with the API code', async () => {
    const client = createWebsiteClient({
      baseUrl: 'https://feed.example',
      apiKey: 'k',
      fetch: fakeFetch(404, { error: { code: 'LISTING_NOT_FOUND', message: 'x' } }, {}),
    });
    await expect(client.getListing({ ref: 'X' })).rejects.toMatchObject({ status: 404, code: 'LISTING_NOT_FOUND' });
    await expect(client.getListing({ ref: 'X' })).rejects.toBeInstanceOf(WebsiteApiError);
  });

  it('[S7-06] reads carry the edge-cache token of the key and origin (the value feed-api checks); posts do not', async () => {
    const node = (key: string, origin: string) =>
      createHash('sha256')
        .update(`${key}
${origin}`)
        .digest('base64url')
        .slice(0, 22);
    expect(await edgeKeyToken('inl_live_abc')).toBe(node('inl_live_abc', ''));
    expect(await edgeKeyToken('inl_live_abc', 'https://www.site.example')).toBe(
      node('inl_live_abc', 'https://www.site.example'),
    );
    expect(await edgeKeyToken('inl_live_abc')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const seen: { url?: string; init?: RequestInit } = {};
    const widget = createWebsiteClient({
      baseUrl: 'https://feed.example',
      apiKey: 'pk',
      origin: 'https://www.site.example',
      fetch: fakeFetch(200, { items: [], nextCursor: null }, seen),
    });
    await widget.getSitemap();
    expect(new URL(seen.url as string).searchParams.get('_k')).toBe(node('pk', 'https://www.site.example'));
    await widget.createLead(
      { name: 'Ana', email: 'ana@example.com', privacyAccepted: true as const, turnstileToken: 't' },
      { 'idempotency-key': 'form-0123456789abcdef' },
    );
    expect(seen.url).toBe('https://feed.example/v2/leads');
  });
});
