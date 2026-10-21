import { describe, expect, it } from 'vitest';
import { createWebsiteClient, WebsiteApiError } from './index';

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
    expect(seen.url).toBe('https://feed.example/v2/listings?types=a%2Cb&priceMin=100&sort=price_asc');
    expect(seen.init?.headers).toMatchObject({ 'x-api-key': 'inl_test_key' });
    await client.getListing({ ref: 'CH-7KQ2 M9' }, { lang: 'es' });
    expect(seen.url).toBe('https://feed.example/v2/listings/CH-7KQ2%20M9?lang=es');
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
});
