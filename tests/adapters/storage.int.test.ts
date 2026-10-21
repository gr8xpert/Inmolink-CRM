import { createHash, randomBytes } from 'node:crypto';
import { loadStackEnv } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import { createS3Store, type ObjectStore, storageConfigFromEnv } from '@inmolink/platform/storage';
import { beforeAll, describe, expect, it } from 'vitest';

let store: ObjectStore;
let endpoint = '';
let privateBucket = '';

beforeAll(() => {
  loadStackEnv('test');
  const env = loadConfig(storageEnv);
  endpoint = env.S3_ENDPOINT.replace(/\/+$/, '');
  privateBucket = env.S3_BUCKET_PRIVATE;
  store = createS3Store(storageConfigFromEnv(env));
});

describe('storage (MinIO as R2)', () => {
  it('[S7-07] streams an upload in parts (multipart past one part) and reads it back as a stream', async () => {
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    for (const size of [1_000, 17 * 1024 * 1024 + 123]) {
      const key = `test/${newId()}`;
      const body = randomBytes(size);
      const up = store.upload('exports', key, { contentType: 'application/gzip' });
      for (let at = 0; at < size; at += 1_000_003) await up.write(body.subarray(at, at + 1_000_003));
      expect(await up.complete()).toEqual({ sizeBytes: size });
      const stream = await store.getStream('exports', key, { maxBytes: size });
      const chunks: Buffer[] = [];
      for await (const c of stream ?? []) chunks.push(c as Buffer);
      expect(sha(Buffer.concat(chunks))).toBe(sha(body));
      await expect(
        (async () => {
          for await (const _ of (await store.getStream('exports', key, { maxBytes: size - 1 })) ?? []) {
            // drain
          }
        })(),
      ).rejects.toThrow(/too large/);
      await store.delete('exports', key);
    }
    // An aborted upload leaves nothing.
    const key = `test/${newId()}`;
    const up = store.upload('exports', key, { contentType: 'application/gzip' });
    await up.write(randomBytes(9 * 1024 * 1024));
    await up.abort();
    expect(await store.head('exports', key)).toBeNull();
    expect(await store.getStream('exports', key, { maxBytes: 10 })).toBeNull();
  });

  it('[S1-03] puts, reads through a signed URL, and deletes an object in the private bucket', async () => {
    const key = `test/${newId()}`;
    const body = new TextEncoder().encode('%PDF-1.7 test document');
    await store.put('private', key, body, { contentType: 'application/pdf' });
    expect(await store.head('private', key)).toEqual({ sizeBytes: body.byteLength });

    const url = await store.signedGetUrl('private', key, { expiresInSeconds: 60, downloadName: 'cif.pdf' });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);

    await store.delete('private', key);
    expect(await store.head('private', key)).toBeNull();
    await store.delete('private', key); // idempotent
  });

  it('[S1-03] verification documents are never readable via public URLs: anonymous and tampered reads are refused', async () => {
    const key = `test/${newId()}`;
    await store.put('private', key, new TextEncoder().encode('%PDF-1.7 secret'), { contentType: 'application/pdf' });
    try {
      // The plain object URL (what a "public URL" would be) without a signature.
      const anonymous = await fetch(`${endpoint}/${privateBucket}/${key}`);
      expect(anonymous.status).toBe(403);
      // A signed URL for one key does not open another.
      const signed = new URL(await store.signedGetUrl('private', key, { expiresInSeconds: 60 }));
      signed.pathname = `/${privateBucket}/test/${newId()}`;
      expect((await fetch(signed)).status).toBe(403);
      // Nor can the expiry be stretched after signing.
      const stretched = new URL(await store.signedGetUrl('private', key, { expiresInSeconds: 60 }));
      stretched.searchParams.set('X-Amz-Expires', '3600');
      expect((await fetch(stretched)).status).toBe(403);
      // Listing the bucket anonymously is refused too.
      expect((await fetch(`${endpoint}/${privateBucket}/`)).status).toBe(403);
    } finally {
      await store.delete('private', key);
    }
  });
});
