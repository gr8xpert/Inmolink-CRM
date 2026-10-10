import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('public /healthz', () => {
  it('[S0-08] public answers liveness without caching', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
