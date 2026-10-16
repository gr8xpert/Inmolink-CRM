import { describe, expect, it } from 'vitest';
import {
  assertObjectKey,
  attachmentDisposition,
  createMemoryStore,
  createS3Store,
  detectFileType,
  parseListPage,
} from './index';

const store = createS3Store({
  endpoint: 'http://localhost:9000/',
  region: 'auto',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  buckets: { media: 'm', exports: 'e', private: 'p', work: 'w' },
});

describe('storage', () => {
  it('[S1-03] detects uploads by magic bytes, not by name or header', () => {
    const bytes = (s: number[]) => new Uint8Array(s);
    expect(detectFileType(new TextEncoder().encode('%PDF-1.7\n'))?.contentType).toBe('application/pdf');
    expect(detectFileType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.contentType).toBe('image/png');
    expect(detectFileType(bytes([0xff, 0xd8, 0xff, 0xe0]))?.contentType).toBe('image/jpeg');
    expect(detectFileType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))?.contentType).toBe('image/webp');
    expect(detectFileType(new TextEncoder().encode('<html><script>'))).toBeNull();
    expect(detectFileType(new TextEncoder().encode('%PD'))).toBeNull();
    expect(detectFileType(new Uint8Array())).toBeNull();
  });

  it('[S1-03] refuses object keys that could escape their prefix', () => {
    expect(() => assertObjectKey('verification/a/b')).not.toThrow();
    for (const bad of ['', '/abs', 'a/../b', 'a//b', 'a/./b', 'a b', 'a\\b', 'a?x=1', 'x'.repeat(1025)]) {
      expect(() => assertObjectKey(bad), bad).toThrow(/invalid object key/);
    }
  });

  it('[S1-03] signed GET URLs are path-style, short-lived and download as attachments', async () => {
    const url = new URL(
      await store.signedGetUrl('private', 'verification/a/doc', {
        expiresInSeconds: 300,
        downloadName: 'CIF "B1".pdf',
      }),
    );
    expect(url.origin + url.pathname).toBe('http://localhost:9000/p/verification/a/doc');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="CIF _B1_.pdf"; filename*=UTF-8''CIF%20%22B1%22.pdf`,
    );
    await expect(store.signedGetUrl('private', 'k', { expiresInSeconds: 3_601 })).rejects.toThrow(RangeError);
    await expect(store.signedGetUrl('private', 'k', { expiresInSeconds: 0 })).rejects.toThrow(RangeError);
  });

  it('[S1-06] signed GET URLs can pin the response content type', async () => {
    const url = new URL(
      await store.signedGetUrl('private', 'agency-logos/a/logo', {
        expiresInSeconds: 300,
        responseContentType: 'image/png',
      }),
    );
    expect(url.searchParams.get('response-content-type')).toBe('image/png');
    await expect(
      store.signedGetUrl('private', 'k', { expiresInSeconds: 300, responseContentType: 'text/html\r\nx: y' }),
    ).rejects.toThrow(TypeError);
  });

  it('[S3-03] signed PUT URLs bind the content type, exact length and SHA-256 into the signature', async () => {
    const sha256Hex = 'ab'.repeat(32);
    const put = await store.signedPutUrl('media', `originals/${sha256Hex}`, {
      expiresInSeconds: 900,
      contentType: 'image/jpeg',
      contentLength: 2_048,
      sha256Hex,
    });
    const url = new URL(put.url);
    expect(url.origin + url.pathname).toBe(`http://localhost:9000/m/originals/${sha256Hex}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match;x-amz-checksum-sha256',
    );
    expect(put.headers).toEqual({
      'content-length': '2048',
      'content-type': 'image/jpeg',
      'x-amz-checksum-sha256': Buffer.from(sha256Hex, 'hex').toString('base64'),
      'if-none-match': '*',
    });
    const base = { expiresInSeconds: 900, contentType: 'image/jpeg', contentLength: 1, sha256Hex };
    await expect(store.signedPutUrl('media', 'k', { ...base, sha256Hex: 'AB'.repeat(32) })).rejects.toThrow(TypeError);
    await expect(store.signedPutUrl('media', 'k', { ...base, contentLength: 0 })).rejects.toThrow(RangeError);
    await expect(store.signedPutUrl('media', 'k', { ...base, contentType: 'image/jpeg\r\nx: y' })).rejects.toThrow(
      TypeError,
    );
    await expect(store.signedPutUrl('media', 'k', { ...base, expiresInSeconds: 3_601 })).rejects.toThrow(RangeError);
  });

  it('[S3-03] detects HEIC by its ISO-BMFF brand, not AVIF or other ftyp files', () => {
    const ftyp = (brand: string) => new TextEncoder().encode(`\0\0\0\x18ftyp${brand}\0\0\0\0`);
    expect(detectFileType(ftyp('heic'))?.contentType).toBe('image/heic');
    expect(detectFileType(ftyp('mif1'))?.contentType).toBe('image/heic');
    expect(detectFileType(ftyp('avif'))).toBeNull();
    expect(detectFileType(ftyp('isom'))).toBeNull(); // an MP4 video
  });

  it('[S3-03] the memory store reads byte ranges', async () => {
    const memory = createMemoryStore();
    await memory.put('media', 'originals/x', new Uint8Array([1, 2, 3, 4, 5]), { contentType: 'image/jpeg' });
    expect(await memory.getRange('media', 'originals/x', 1, 3)).toEqual({
      bytes: new Uint8Array([2, 3, 4]),
      sizeBytes: 5,
    });
    expect(await memory.getRange('media', 'originals/x', 0, 99)).toEqual({
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
      sizeBytes: 5,
    });
    expect(await memory.getRange('media', 'originals/none', 0, 9)).toBeNull();
  });

  it('[S3-04] whole-object reads stop at the byte cap, with or without a Content-Length', async () => {
    const body = new Uint8Array(10).fill(7);
    const answer = (withLength: boolean) => async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(body.subarray(0, 6));
            c.enqueue(body.subarray(6));
            c.close();
          },
        }),
        { status: 200, headers: withLength ? { 'content-length': '10' } : {} },
      );
    const s3 = (withLength: boolean) =>
      createS3Store({
        endpoint: 'http://localhost:9000',
        region: 'auto',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret',
        buckets: { media: 'm', exports: 'e', private: 'p', work: 'w' },
        fetch: answer(withLength) as unknown as typeof fetch,
      });
    expect(await s3(true).get('media', 'masters/x', { maxBytes: 10 })).toEqual(body);
    await expect(s3(true).get('media', 'masters/x', { maxBytes: 9 })).rejects.toMatchObject({ status: 413 });
    await expect(s3(false).get('media', 'masters/x', { maxBytes: 9 })).rejects.toMatchObject({ status: 413 });
    // A transfer cut short is an error, never a shorter object.
    const cut = createS3Store({
      endpoint: 'http://localhost:9000',
      region: 'auto',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      buckets: { media: 'm', exports: 'e', private: 'p', work: 'w' },
      fetch: (async () =>
        new Response(body.subarray(0, 6), {
          status: 200,
          headers: { 'content-length': '10' },
        })) as unknown as typeof fetch,
    });
    await expect(cut.get('media', 'masters/x', { maxBytes: 10 })).rejects.toThrow(/incomplete/);

    const memory = createMemoryStore();
    await memory.put('media', 'masters/x', body, { contentType: 'image/webp', cacheControl: 'private' });
    expect(await memory.get('media', 'masters/x', { maxBytes: 10 })).toEqual(body);
    expect(await memory.get('media', 'masters/none', { maxBytes: 10 })).toBeNull();
    await expect(memory.get('media', 'masters/x', { maxBytes: 9 })).rejects.toMatchObject({ status: 413 });
    await expect(
      memory.put('media', 'masters/y', body, { contentType: 'image/webp', cacheControl: 'a\r\nb' }),
    ).rejects.toThrow(TypeError);
  });

  it('[S1-03] content disposition strips controls and non-ASCII from the fallback name', () => {
    expect(attachmentDisposition('añ\r\nb.pdf')).toBe(
      `attachment; filename="a___b.pdf"; filename*=UTF-8''a%C3%B1%0D%0Ab.pdf`,
    );
  });
});

describe('storage list (S1-F7)', () => {
  it('reads a ListObjectsV2 page and its continuation token', () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
      <Contents><Key>verification/a/1</Key><LastModified>2026-10-01T10:00:00.000Z</LastModified></Contents>
      <Contents><Key>verification/a/2&amp;3</Key><LastModified>2026-10-02T10:00:00.000Z</LastModified></Contents>
      <NextContinuationToken>tok</NextContinuationToken></ListBucketResult>`;
    expect(parseListPage(xml)).toEqual({
      objects: [
        { key: 'verification/a/1', lastModified: new Date('2026-10-01T10:00:00.000Z') },
        { key: 'verification/a/2&3', lastModified: new Date('2026-10-02T10:00:00.000Z') },
      ],
      next: 'tok',
    });
    expect(parseListPage('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')).toEqual({
      objects: [],
      next: null,
    });
  });

  it('pages the memory store by key order under a prefix', async () => {
    const mem = createMemoryStore();
    for (const k of ['verification/a/1', 'verification/a/2', 'verification/b/1', 'other/x'])
      await mem.put('private', k, new Uint8Array([1]), { contentType: 'application/pdf' });
    const first = await mem.list('private', 'verification/', { limit: 2 });
    expect(first.objects.map((o) => o.key)).toEqual(['verification/a/1', 'verification/a/2']);
    const second = await mem.list('private', 'verification/', { limit: 2, after: first.next ?? undefined });
    expect(second.objects.map((o) => o.key)).toEqual(['verification/b/1']);
    expect(second.next).toBeNull();
  });
});
