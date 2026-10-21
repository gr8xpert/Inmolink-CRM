import { describe, expect, it } from 'vitest';
import { CDN_PURGE_MAX_TAGS, CdnPurgeError, createCloudflarePurger, createMemoryCdn } from './index';

const ZONE = '0123456789abcdef0123456789abcdef';

function recorder(answer: (n: number) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(calls.length);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const ok = () => new Response(JSON.stringify({ success: true, errors: [], result: { id: 'x' } }), { status: 200 });

describe('cdn purge adapter', () => {
  it('[S7-06] purges tags through the zone API, at most 100 per request, paced, with the token as bearer', async () => {
    const { calls, fetch } = recorder(ok);
    const waits: number[] = [];
    const purger = createCloudflarePurger({
      zoneId: ZONE,
      apiToken: 'tok-secret',
      minIntervalMs: 250,
      fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const tags = Array.from({ length: 250 }, (_, i) => `t${i}`);
    await purger.purgeTags([...tags, 't0']);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`);
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer tok-secret');
    const sent = calls.map((c) => (JSON.parse(String(c.init.body)) as { tags: string[] }).tags);
    expect(sent.map((s) => s.length)).toEqual([CDN_PURGE_MAX_TAGS, CDN_PURGE_MAX_TAGS, 50]);
    expect(new Set(sent.flat())).toEqual(new Set(tags));
    // Each request holds the caller for the pacing interval (the job's global slot keeps the pace account-wide).
    expect(waits).toEqual([250, 250, 250]);
  });

  it('[S7-06] a rate-limited or failed purge throws a retryable error naming the status, never the token', async () => {
    const limited = recorder(
      () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 1134 }] }), {
          status: 429,
          headers: { 'retry-after': '7' },
        }),
    );
    const purger = createCloudflarePurger({ zoneId: ZONE, apiToken: 'tok-secret', fetch: limited.fetch });
    const err = await purger.purgeTags(['a']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdnPurgeError);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 7 });
    expect(String((err as Error).message)).not.toContain('tok-secret');
    const unsuccessful = recorder(() => new Response(JSON.stringify({ success: false }), { status: 200 }));
    await expect(
      createCloudflarePurger({ zoneId: ZONE, apiToken: 't', fetch: unsuccessful.fetch }).purgeTags(['a']),
    ).rejects.toMatchObject({ status: 200 });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    await expect(
      createCloudflarePurger({ zoneId: ZONE, apiToken: 't', fetch: down }).purgeTags(['a']),
    ).rejects.toMatchObject({
      status: 0,
    });
  });

  it('[S7-06] refuses malformed tags and zone ids; the memory purger records batches', async () => {
    expect(() => createCloudflarePurger({ zoneId: 'nope', apiToken: 't' })).toThrow(TypeError);
    const { fetch, calls } = recorder(ok);
    const purger = createCloudflarePurger({ zoneId: ZONE, apiToken: 't', fetch });
    await expect(purger.purgeTags(['has space'])).rejects.toThrow(TypeError);
    await expect(purger.purgeTags(['a,b'])).rejects.toThrow(TypeError);
    await purger.purgeTags([]);
    expect(calls).toHaveLength(0);
    const memory = createMemoryCdn();
    await memory.purgeTags(Array.from({ length: 101 }, (_, i) => `m${i}`));
    expect(memory.purged.map((b) => b.length)).toEqual([100, 1]);
    expect(memory.tags().has('m100')).toBe(true);
  });
});
