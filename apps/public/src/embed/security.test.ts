import { describe, expect, it } from 'vitest';
import { readFormBody } from './form-body';
import { gateMarker, gateMarkerValid, minuteOf } from './gate';
import { canonicalSearch, EMBED_PAGE_CACHE, pageCacheHeaders } from './handlers';

/** Embed transport hardening (S7-F8 security review): bounded form bodies, time-bound gate markers, purgeable caching. */

const MAX = 16 * 1024;
const post = (body: BodyInit | null, headers: Record<string, string>) =>
  new Request('https://sites.test/embed/x/en/listing/A', {
    method: 'POST',
    body,
    headers,
    // A streamed body (no Content-Length): what a chunked upload looks like.
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);

describe('embed form body (S7-F8)', () => {
  it('[S7-F8] a chunked oversize body is refused (413) at the cap, without reading the rest', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(4 * 1024).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1_000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await readFormBody(post(stream, { 'content-type': 'application/x-www-form-urlencoded' }), MAX);
    expect(res).toEqual({ ok: false, status: 413 });
    // 16 KB = four 4 KB chunks; the fifth trips the cap and the stream is cancelled (a few more may be queued ahead).
    expect(pulled).toBeLessThan(10);
  });

  it('[S7-F8] only urlencoded bodies are read: multipart and anything else is refused (415); a lying Content-Length too', async () => {
    const multipart = new FormData();
    multipart.set('name', 'Ana');
    expect(await readFormBody(post(multipart, {}), MAX)).toEqual({ ok: false, status: 415 });
    expect(await readFormBody(post('{"name":"Ana"}', { 'content-type': 'application/json' }), MAX)).toEqual({
      ok: false,
      status: 415,
    });
    expect(
      await readFormBody(
        post('a=1', { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '99999' }),
        MAX,
      ),
    ).toEqual({ ok: false, status: 413 });
    const ok = await readFormBody(
      post('name=Ana+B%C3%BAyer&privacyAccepted=on', {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      }),
      MAX,
    );
    expect(ok.ok && ok.fields.get('name')).toBe('Ana Búyer');
  });
});

describe('embed gate marker (S7-F8)', () => {
  it('[S7-F8] the gate marker is bound to the site and the minute: the current and previous minute pass, older ones fail', () => {
    const key = 'test-key-0123456789abcdef0123456789';
    const now = Date.UTC(2026, 9, 22, 12, 30, 10);
    const m = gateMarker(key, 'site-a', minuteOf(now));
    expect(gateMarkerValid(key, 'site-a', m, now)).toBe(true);
    expect(gateMarkerValid(key, 'site-a', m, now + 60_000)).toBe(true);
    expect(gateMarkerValid(key, 'site-a', m, now + 120_000)).toBe(false);
    expect(gateMarkerValid(key, 'site-b', m, now)).toBe(false);
    expect(gateMarkerValid('another-key-0123456789abcdef01234', 'site-a', m, now)).toBe(false);
    expect(gateMarkerValid(key, 'site-a', null, now)).toBe(false);
  });
});

describe('embed page caching (S7-F8, S8-F2)', () => {
  it('[S7-F8] a page without purge tags is never edge-cached (no-store); with them it is public for 60 s', () => {
    expect(pageCacheHeaders('public', null)).toEqual({ 'Cache-Control': 'no-store' });
    expect(pageCacheHeaders('public', [])).toEqual({ 'Cache-Control': 'no-store' });
    expect(pageCacheHeaders('public', ['s1', 't2'])).toEqual({
      'Cache-Control': EMBED_PAGE_CACHE,
      'Cache-Tag': 's1,t2',
    });
    expect(pageCacheHeaders('no-store', ['s1'])).toEqual({ 'Cache-Control': 'no-store' });
    expect(pageCacheHeaders('private', ['s1'])).toEqual({ 'Cache-Control': 'private, max-age=0, must-revalidate' });
    // S8-F2: the feed cache shape, with a short stale-if-error (an old frame-ancestors never outlives a failed purge long).
    expect(EMBED_PAGE_CACHE).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=300');
  });

  it('[S8-F2] only canonical search URLs are public: known parameters in the form order, no free text, no cursor', () => {
    const ok = (search: string) => canonicalSearch(search, true);
    expect(ok('')).toBe(true);
    expect(ok('?transaction=SALE&priceMin=100000&sort=price_asc')).toBe(true);
    // The form's submission: every field, empty ones included.
    expect(ok('?q=&transaction=SALE&priceMin=&priceMax=&bedsMin=2&sort=')).toBe(true);
    expect(ok('?utm_source=x')).toBe(false); // unknown parameter
    expect(ok('?q=villa')).toBe(false); // free text
    expect(ok('?cursor=abc')).toBe(false); // deep page
    expect(ok('?priceMin=1&priceMin=1')).toBe(false); // repeated
    expect(ok('?sort=price_asc&transaction=SALE')).toBe(false); // out of order
    expect(ok('?priceMin=0100000')).toBe(false); // another spelling of one amount
    expect(ok('?bedsMin=02')).toBe(false);
    expect(ok('?priceMin=abc')).toBe(false); // dropped by the handler: the same page as `?`
    expect(ok('?transaction=&priceMin=100000')).toBe(false); // some empties, not the whole form
    expect(canonicalSearch('?transaction=SALE', false)).toBe(false); // refused by the contract
    // Other written forms of a canonical query (S8-F2 review): each would be another edge entry for the same page.
    for (const variant of [
      '?transaction=%53ALE',
      '?%74ransaction=SALE',
      '?transaction=SALE+',
      '?transaction=SALE%20%20',
      '?priceMin=%31000',
      '?priceMin=1000%00',
      '?',
    ]) {
      expect(ok(variant), variant).toBe(false);
    }
    expect(ok('https://sites.test/embed/s/en?transaction=SALE')).toBe(true); // the URL as received
  });
});
