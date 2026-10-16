import { createHash } from 'node:crypto';
import { loadStackEnv } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { configureStorage, createS3Store, storage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as media from '../index';

/**
 * The public media host (S3-F4): only variant keys (`v<n>/<32 hex>/…`) of the `media` bucket are readable without
 * credentials. Locally the MinIO bucket policy (`infra/storage/media-public-policy.json`, applied by the compose
 * init); in production the R2 rule of `docs/runbooks/media-public-host.md` holds the same line.
 */

let endpoint = '';
const keys: string[] = [];

beforeAll(() => {
  loadStackEnv('test');
  const config = loadConfig(storageEnv);
  endpoint = config.S3_ENDPOINT.replace(/\/+$/, '');
  configureStorage(createS3Store(storageConfigFromEnv(config)));
  media.configureMedia({ urlKey: `media-public-host-test-${newId()}` });
});

afterAll(async () => {
  for (const key of keys) await storage().delete('media', key);
});

const anonymous = (key: string) => fetch(`${endpoint}/inmolink-media/${key}`).then((r) => r.status);

it('[S3-F4] a request for a key outside v<n>/… on the public media host is refused', async () => {
  const sha = createHash('sha256').update(newId()).digest('hex');
  const variant = media.variantKey(sha, media.VARIANT_NAMES[0] as (typeof media.VARIANT_NAMES)[number]);
  expect(variant).toMatch(/^v\d+\/[0-9a-f]{32}\//);
  // MinIO's `?`/`*` also match `/` (a local limit; production holds the anchored WAF regex of the runbook)
  const outside = [`private/${newId()}.webp`, `v1/not-a-public-id/${newId()}.webp`, `${newId()}.webp`, `x${variant}`];
  for (const key of [variant, ...outside]) {
    await storage().put('media', key, new Uint8Array([1, 2, 3]), { contentType: 'image/webp' });
    keys.push(key);
  }
  expect(await anonymous(variant)).toBe(200);
  for (const key of outside) expect(await anonymous(key), key).toBe(403);
});
