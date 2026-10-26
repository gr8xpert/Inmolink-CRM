import { describe, expect, it } from 'vitest';
import {
  BREAKER_FAILURES,
  BREAKER_OPEN_MS,
  markPageTagsChanged,
  PAGE_TAG_TTL_SECONDS,
  PageCache,
  type PageTagStore,
  RENDER_MARGIN_MS,
} from './page-cache';

/** redis-cache as a map (`redisPageTagStore`'s contract); `down` makes every call fail like an outage. */
function memoryStore() {
  const values = new Map<string, number>();
  const state = { down: false, reads: 0 };
  const store: PageTagStore = {
    async read(tags) {
      state.reads++;
      if (state.down) throw new Error('redis-cache down');
      return tags.map((t) => values.get(t) ?? null);
    },
    async markMax(tags, atMs) {
      if (state.down) throw new Error('redis-cache down');
      for (const t of tags) if ((values.get(t) ?? 0) < atMs) values.set(t, atMs);
    },
  };
  return { store, values, state };
}

const page = (html: string, tags = '') => ({
  kind: 'APP_PAGE',
  html,
  rscData: Buffer.from(html),
  headers: tags ? { 'x-next-cache-tags': tags } : {},
  status: 200,
  segmentData: new Map([['/_tree', Buffer.from('tree')]]),
});

describe('ISR page cache (S15-F7)', () => {
  it('[S15-F7] a marked tag drops the pages carrying it on every instance (shared tag times)', async () => {
    const { store } = memoryStore();
    let now = 1_000_000;
    // Two public instances: separate page caches, one redis-cache.
    const a = new PageCache({ store, maxBytes: 10_000_000, now: () => now });
    const b = new PageCache({ store, maxBytes: 10_000_000, now: () => now });
    for (const c of [a, b]) {
      await c.set('/en/property/villa-m2q7zk4p', page('<p>€300,000</p>', '_N_T_/layout,portal:t:L1,portal:a:A1'), {
        cacheControl: { revalidate: 300 },
      });
      await c.set('/en/property/flat-k4p2q7zm', page('<p>other</p>', 'portal:t:L2,portal:a:A2'));
    }
    now += 1_000;
    expect(await a.get('/en/property/villa-m2q7zk4p')).toMatchObject({ cacheControl: { revalidate: 300 } });

    // The worker marks the listing changed (price change, withdrawal): both instances miss it, the other page stays.
    await markPageTagsChanged(store, ['portal:t:L1'], now);
    now += 10;
    expect(await a.get('/en/property/villa-m2q7zk4p')).toBeNull();
    expect(await b.get('/en/property/villa-m2q7zk4p')).toBeNull();
    expect(await b.get('/en/property/flat-k4p2q7zm')).not.toBeNull();

    // Rendered again once the render margin has passed: cached again.
    now += RENDER_MARGIN_MS;
    await a.set('/en/property/villa-m2q7zk4p', page('<p>€290,000</p>', 'portal:t:L1,portal:a:A1'));
    now += 10;
    expect(await a.get('/en/property/villa-m2q7zk4p')).toMatchObject({ value: { html: '<p>€290,000</p>' } });
  });

  it('[S15-F7] a render that read before the change and was stored seconds after it is dropped (render margin)', async () => {
    const { store } = memoryStore();
    let now = 2_000_000;
    const c = new PageCache({ store, maxBytes: 10_000_000, now: () => now });
    // The change is marked at T; a slow render that read the old price is stored at T + 10 s.
    await markPageTagsChanged(store, ['portal:t:L1'], now);
    now += 10_000;
    await c.set('/en/property/villa', page('<p>old price</p>', 'portal:t:L1'));
    now += 1;
    expect(await c.get('/en/property/villa')).toBeNull();
    // Stored after the margin: kept.
    now = 2_000_000 + RENDER_MARGIN_MS + 1;
    await c.set('/en/property/villa', page('<p>new price</p>', 'portal:t:L1'));
    now += 1;
    expect(await c.get('/en/property/villa')).not.toBeNull();
  });

  it('[S15-F7] a settle keeps the tag’s pages uncached until it has passed, without storing them; an older mark never shortens it', async () => {
    const { store, state } = memoryStore();
    const start = 5_000_000;
    let now = start;
    const c = new PageCache({ store, maxBytes: 10_000_000, now: () => now });
    await markPageTagsChanged(store, ['portal:a:A1'], start + 60_000);
    await markPageTagsChanged(store, ['portal:a:A1'], start); // a redelivered / older event
    const key = '/en/property/villa';
    // The first page stored learns the settle on its next lookup (dropped)…
    await c.set(key, page('x', 'portal:a:A1'));
    now += 1;
    expect(await c.get(key)).toBeNull();
    // …then pages carrying the tag are not stored at all, and no lookup is spent on them.
    const reads = state.reads;
    for (const step of [10_000, 59_000, 60_000 + RENDER_MARGIN_MS - 1]) {
      now = start + step;
      await c.set(key, page('x', 'portal:a:A1'));
      expect(c.lru.size).toBe(0);
      expect(await c.get(key)).toBeNull();
    }
    expect(state.reads).toBe(reads);
    now = start + 60_000 + RENDER_MARGIN_MS + 1;
    await c.set(key, page('x', 'portal:a:A1'));
    now += 1;
    expect(await c.get(key)).not.toBeNull();
  });

  it('[S15-F7] bounded: the page cache holds at most its byte budget, oldest pages first out', async () => {
    const { store } = memoryStore();
    const c = new PageCache({ store, maxBytes: 200_000, now: () => 1 });
    const html = 'x'.repeat(20_000);
    for (let i = 0; i < 50; i++) await c.set(`/en/property/p-${i}`, page(html, `portal:t:L${i}`));
    expect(c.lru.bytes).toBeLessThanOrEqual(200_000);
    expect(c.lru.size).toBeLessThan(50);
    expect(await c.get('/en/property/p-0')).toBeNull();
    expect(await c.get('/en/property/p-49')).not.toBeNull();
    // A page larger than the whole budget is not kept at all.
    await c.set('/en/property/huge', page('y'.repeat(200_000)));
    expect(await c.get('/en/property/huge')).toBeNull();
  });

  it('[S15-F7] fails open: redis-cache down serves the cached page; untagged pages cost no lookup; old pages expire', async () => {
    const { store, state } = memoryStore();
    let now = 1_000;
    const errors: unknown[] = [];
    const c = new PageCache({ store, maxBytes: 1_000_000, now: () => now, onError: (e) => errors.push(e) });
    await c.set('/en/property/a', page('a', 'portal:t:L1'));
    await c.set('/en', page('home', '_N_T_/layout'));
    state.down = true;
    expect(await c.get('/en/property/a')).not.toBeNull();
    expect(errors).toHaveLength(1);
    state.down = false;
    const reads = state.reads;
    expect(await c.get('/en')).not.toBeNull();
    expect(state.reads).toBe(reads);
    // Older than a tag time can live: never served (an expired tag time could no longer drop it).
    now += PAGE_TAG_TTL_SECONDS * 1_000 + 1;
    expect(await c.get('/en/property/a')).toBeNull();
  });

  it('[S15-F7] circuit breaker: after repeated lookup failures, lookups are skipped for a few seconds (pages served)', async () => {
    const { store, state } = memoryStore();
    let now = 10_000;
    const c = new PageCache({ store, maxBytes: 1_000_000, now: () => now });
    await c.set('/en/property/a', page('a', 'portal:t:L1'));
    state.down = true;
    for (let i = 0; i < BREAKER_FAILURES; i++) expect(await c.get('/en/property/a')).not.toBeNull();
    expect(c.lookups).toBe(BREAKER_FAILURES);
    // Open: no lookup (no cut-off added to the hit), the page is served.
    for (let i = 0; i < 20; i++) expect(await c.get('/en/property/a')).not.toBeNull();
    expect(c.lookups).toBe(BREAKER_FAILURES);
    // Closed again after the open window: lookups resume (and see redis-cache back).
    state.down = false;
    now += BREAKER_OPEN_MS + 1;
    expect(await c.get('/en/property/a')).not.toBeNull();
    expect(c.lookups).toBe(BREAKER_FAILURES + 1);
  });

  it('[S15-F7] revalidateTag in one instance reaches the others; local path tags drop local copies', async () => {
    const { store, values } = memoryStore();
    let now = 1_000;
    const a = new PageCache({ store, maxBytes: 1_000_000, now: () => now });
    const b = new PageCache({ store, maxBytes: 1_000_000, now: () => now });
    await b.set('/en/development/x', page('d', 'portal:d:D1'));
    await a.set('/en', page('home', '_N_T_/en'));
    now += 1;
    await a.revalidateTag(['portal:d:D1', '_N_T_/en']);
    now += 1;
    expect(await b.get('/en/development/x')).toBeNull();
    expect(await a.get('/en')).toBeNull();
    // Only the portal's own tags are written to redis-cache.
    await markPageTagsChanged(store, ['_N_T_/en', 'not a tag'], now);
    expect([...values.keys()]).toEqual(['portal:d:D1']);
  });
});
