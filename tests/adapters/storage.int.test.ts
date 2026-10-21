import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadStackEnv } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import {
  createS3Store,
  MIN_UPLOAD_PART_BYTES,
  type ObjectStore,
  storageConfigFromEnv,
} from '@inmolink/platform/storage';
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

  it('[S7-F3] upload parts and puts go out with their length (no chunked encoding) and a smaller part size when asked', async () => {
    const seen: { method: string; length: string | undefined; chunked: boolean; bytes: number }[] = [];
    const server = createServer((req, res) => {
      let bytes = 0;
      req.on('data', (c: Buffer) => {
        bytes += c.length;
      });
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          length: req.headers['content-length'],
          chunked: req.headers['transfer-encoding'] === 'chunked',
          bytes,
        });
        if (req.method === 'POST' && req.url?.includes('uploads='))
          res.end('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>');
        else if (req.method === 'PUT') res.writeHead(200, { etag: '"e"' }).end();
        else res.end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const local = createS3Store({
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        region: 'auto',
        accessKeyId: 'a',
        secretAccessKey: 's',
        buckets: { media: 'm', exports: 'e', private: 'p', work: 'w' },
      });
      expect(() => local.upload('work', 'k', { contentType: 'image/jpeg', partBytes: 1024 })).toThrow(RangeError);
      const up = local.upload('work', 'feed-staging/k', {
        contentType: 'image/jpeg',
        partBytes: MIN_UPLOAD_PART_BYTES,
      });
      await up.write(randomBytes(MIN_UPLOAD_PART_BYTES * 2 + 10));
      await up.complete();
      const parts = seen.filter((s) => s.method === 'PUT');
      expect(parts.map((p) => p.bytes)).toEqual([MIN_UPLOAD_PART_BYTES, MIN_UPLOAD_PART_BYTES, 10]);
      expect(parts.every((p) => !p.chunked && p.length === String(p.bytes))).toBe(true);
      // a plain PUT the same way
      await local.put('work', 'originals/k', randomBytes(1_000), { contentType: 'image/jpeg' });
      expect(seen.at(-1)).toEqual({ method: 'PUT', length: '1000', chunked: false, bytes: 1_000 });
    } finally {
      server.close();
    }
  });

  it('[S7-F3] copies an object inside the store, keeping its content type; a missing source fails', async () => {
    const from = `test/${newId()}`;
    const to = `test/${newId()}`;
    const body = randomBytes(2_000);
    await store.put('work', from, body, { contentType: 'image/jpeg' });
    await store.copy('work', from, to);
    expect(Buffer.from((await store.get('work', to, { maxBytes: 4_000 })) ?? [])).toEqual(body);
    const signed = await store.signedGetUrl('work', to, { expiresInSeconds: 60 });
    expect((await fetch(signed)).headers.get('content-type')).toBe('image/jpeg');
    await expect(store.copy('work', `test/${newId()}`, `test/${newId()}`)).rejects.toThrow(/COPY failed/);
    await Promise.all([store.delete('work', from), store.delete('work', to)]);
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
