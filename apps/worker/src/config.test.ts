import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@inmolink/platform/config';
import { describe, expect, it } from 'vitest';
import { workerEnvFor } from './config';

/** Least privilege per container (S3-F4): a process validates only what its pools need. */

const read = (file: string) => readFileSync(join(import.meta.dirname, file), 'utf8');

const MEDIA_ONLY = {
  NODE_ENV: 'production',
  RELEASE: '0123456789abcdef0123456789abcdef01234567',
  OTEL_TRACES_SAMPLE_RATIO: '0.05',
  WORKER_POOLS: 'media',
  REDIS_QUEUE_URL: 'redis://localhost:6379',
  DATABASE_URL_APP_MEDIA: 'postgres://app_media:x@localhost:6432/inmolink',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'auto',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET_MEDIA: 'inmolink-media',
  S3_BUCKET_EXPORTS: 'inmolink-exports',
  S3_BUCKET_PRIVATE: 'inmolink-private',
  S3_BUCKET_MEDIA_WORK: 'inmolink-media-work',
  MEDIA_URL_KEY: 'media-url-key-0123456789abcdef0123456789',
};

describe('worker env per pool', () => {
  it('[S3-F4] the media container boots with only the media variables', () => {
    const config: Record<string, unknown> = loadConfig(workerEnvFor(['media']), { ...MEDIA_ONLY, APP_ROLE: 'worker' });
    expect(config.WORKER_POOLS).toEqual(['media']);
    expect(config.DATABASE_URL_APP_MEDIA).toBe(MEDIA_ONLY.DATABASE_URL_APP_MEDIA);
    expect(config.DATABASE_URL_APP_SYSTEM).toBeUndefined();
  });

  it('[S3-F4] SMTP only with the email pool; app_system, encryption and HMAC keys never for media alone', () => {
    const media = Object.keys(workerEnvFor(['media']));
    for (const name of ['SMTP_URL', 'EMAIL_FROM', 'ENCRYPTION_KEYS', 'ENCRYPTION_ACTIVE_KEY_ID', 'HMAC_KEY']) {
      expect(media, name).not.toContain(name);
    }
    expect(media).not.toContain('DATABASE_URL_APP_SYSTEM');
    expect(Object.keys(workerEnvFor(['outbox', 'indexing']))).not.toContain('SMTP_URL');
    expect(Object.keys(workerEnvFor(['email']))).toEqual(expect.arrayContaining(['SMTP_URL', 'ENCRYPTION_KEYS']));
    expect(Object.keys(workerEnvFor(['outbox']))).not.toContain('DATABASE_URL_APP_MEDIA');
  });

  it('[S3-F7] the media container has no cache URL; every other pool keeps it', () => {
    expect(Object.keys(workerEnvFor(['media']))).not.toContain('REDIS_CACHE_URL');
    expect(Object.keys(workerEnvFor(['media', 'indexing']))).toContain('REDIS_CACHE_URL');
    expect(read('main.ts')).toContain('if (config.REDIS_CACHE_URL) await configureCache(');
  });

  it('[S13 e2e] every pool that builds image variant keys validates the media URL key and configures it at boot', () => {
    for (const pool of ['indexing', 'ai', 'maintenance', 'exports', 'media'] as const) {
      expect(Object.keys(workerEnvFor([pool]))).toContain('MEDIA_URL_KEY');
    }
    expect(read('main.ts')).toContain('media.configureMedia({ urlKey: config.MEDIA_URL_KEY })');
  });

  it('[S5-02] the search admin key only with the indexing pool, which applies index settings at boot', () => {
    expect(Object.keys(workerEnvFor(['indexing']))).toEqual(expect.arrayContaining(['MEILI_URL', 'MEILI_MASTER_KEY']));
    expect(Object.keys(workerEnvFor(['media']))).not.toContain('MEILI_MASTER_KEY');
    expect(Object.keys(workerEnvFor(['outbox', 'email']))).not.toContain('MEILI_MASTER_KEY');
    expect(read('main.ts')).toContain('.ensureListingsIndex()');
  });

  it('[S7-05] the email pool reads the public inventory as app_public (lead acknowledgements); media never does', () => {
    expect(Object.keys(workerEnvFor(['email']))).toEqual(
      expect.arrayContaining(['DATABASE_URL_APP_PUBLIC', 'MEDIA_CDN_URL']),
    );
    expect(Object.keys(workerEnvFor(['media']))).not.toContain('DATABASE_URL_APP_PUBLIC');
    expect(read('main.ts')).toContain('websiteApi.configureWebsiteApi(');
  });
});
