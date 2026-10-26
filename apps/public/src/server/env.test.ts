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
  S3_ENDPOINT: 'https://r2.example.com',
  S3_REGION: 'auto',
  S3_ACCESS_KEY_ID: 'feeds-read',
  S3_SECRET_ACCESS_KEY: 'feeds-read-secret',
  S3_BUCKET_FEEDS: 'inmolink-feeds',
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

  it('[S15-02] the feeds bucket (the portal sitemaps) is required in production, optional elsewhere', () => {
    const ok = { ...BASE, PUBLIC_URL: 'https://sites.inmolink.es' };
    expect(loadPublicConfig(ok).S3_BUCKET_FEEDS).toBe('inmolink-feeds');
    const { S3_ENDPOINT: _e, S3_ACCESS_KEY_ID: _k, ...noStorage } = ok;
    expect(() => loadPublicConfig(noStorage)).toThrow(/S3_ENDPOINT/);
    expect(loadPublicConfig({ ...noStorage, NODE_ENV: 'development' }).S3_ENDPOINT).toBeUndefined();
  });
});
