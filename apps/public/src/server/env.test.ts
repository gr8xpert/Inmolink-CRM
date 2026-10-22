import { describe, expect, it } from 'vitest';
import { loadPublicConfig } from './env';

const BASE = {
  NODE_ENV: 'production',
  DATABASE_URL_APP_PUBLIC: 'postgres://app_public:x@db:5432/inmolink',
  REDIS_CACHE_URL: 'redis://cache:6379',
  REDIS_LIMITS_URL: 'redis://queue:6379',
  MEILI_URL: 'http://meili:7700',
  MEILI_SEARCH_KEY: 'search-key',
  HMAC_KEY: 'prod-hmac-key-0123456789abcdef0123456789abcdef',
  MEDIA_CDN_URL: 'https://media.inmolink.es',
  TRUST_PROXY: '10.200.0.0/24',
};

describe('public pages config (S7-F8)', () => {
  it('[S7-F8] PUBLIC_URL is required (https) in production, like TRUST_PROXY', () => {
    expect(() => loadPublicConfig(BASE)).toThrow(/PUBLIC_URL/);
    expect(() => loadPublicConfig({ ...BASE, PUBLIC_URL: 'http://sites.inmolink.es' })).toThrow(/PUBLIC_URL/);
    expect(loadPublicConfig({ ...BASE, PUBLIC_URL: 'https://sites.inmolink.es/' }).PUBLIC_URL).toBe(
      'https://sites.inmolink.es',
    );
    expect(() => loadPublicConfig({ ...BASE, TRUST_PROXY: 'false', PUBLIC_URL: 'https://sites.inmolink.es' })).toThrow(
      /TRUST_PROXY/,
    );
    // Elsewhere it may be unset (the local default applies).
    expect(loadPublicConfig({ ...BASE, NODE_ENV: 'development', TRUST_PROXY: 'false' }).PUBLIC_URL).toBeUndefined();
  });
});
