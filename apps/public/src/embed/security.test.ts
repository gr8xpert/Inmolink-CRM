import { describe, expect, it } from 'vitest';
import { readFormBody } from './form-body';
import { gateMarker, gateMarkerValid, minuteOf } from './gate';
import { EMBED_PAGE_CACHE, pageCacheHeaders } from './handlers';

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

describe('embed page caching (S7-F8)', () => {
  it('[S7-F8] a page without purge tags is never edge-cached (no-store); with them it is public for 60 s', () => {
    expect(pageCacheHeaders(null)).toEqual({ 'Cache-Control': 'no-store' });
    expect(pageCacheHeaders([])).toEqual({ 'Cache-Control': 'no-store' });
    expect(pageCacheHeaders(['s1', 't2'])).toEqual({ 'Cache-Control': EMBED_PAGE_CACHE, 'Cache-Tag': 's1,t2' });
  });
});
