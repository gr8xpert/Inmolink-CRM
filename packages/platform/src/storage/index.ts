import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AwsClient } from 'aws4fetch';

/**
 * Object storage (S1-03): Cloudflare R2 in production, MinIO locally — both S3-compatible, addressed
 * path-style (`<endpoint>/<bucket>/<key>`) and signed with SigV4 (aws4fetch, no AWS SDK). Calls are
 * network I/O: never inside a DB transaction (CLAUDE.md rule 6). Buckets are private; reads by
 * browsers go through short signed URLs only.
 */
export interface StorageBuckets {
  media: string;
  exports: string;
  /** Private documents (agency verification, listing documents): never public, signed URLs only. */
  private: string;
  /**
   * Media originals and masters (S3-F9): never public. Its own bucket, so the media container's credentials
   * (bucket-scoped on R2) cover it and the media bucket without reaching private documents.
   */
  work: string;
  /**
   * Per-site XML feeds (S7-07): served by feed-api, whose token reaches this bucket only. Unset, the feeds live in
   * the exports bucket (local stacks; production sets `inmolink-feeds`, H3).
   */
  feeds?: string;
}

export type BucketName = keyof StorageBuckets;

export interface PutOptions {
  contentType: string;
  /** Served as `Cache-Control` (e.g. immutable media variants, S3-04). */
  cacheControl?: string;
}

export interface GetOptions {
  /** Refuse (`StorageError`, status 413) an object larger than this, without reading it into memory. */
  maxBytes: number;
}

export interface SignedUrlOptions {
  /** 1 s … 1 h. Keep it short: anyone holding the URL can read the object until it expires. */
  expiresInSeconds: number;
  /** Served as `Content-Disposition: attachment; filename=…`, so a browser downloads instead of rendering. */
  downloadName?: string;
  /**
   * Served as this `Content-Type` (`response-content-type`), whatever metadata the object carries: pin it
   * to the type checked at upload so a browser never renders the object as something else (S1-06 logos).
   */
  responseContentType?: string;
  /**
   * Served with this `Content-Encoding` (`response-content-encoding`, S8-F1): a gzip object (a site feed) that clients
   * decompress as they read it, like any gzip answer.
   */
  responseContentEncoding?: 'gzip';
}

export interface SignedPutOptions {
  /** 1 s … 1 h. */
  expiresInSeconds: number;
  /** Signed: the client must send exactly this `Content-Type`. */
  contentType: string;
  /** Signed: the store refuses a body of any other length (size cap enforced by the store, S3-03). */
  contentLength: number;
  /**
   * Signed as `x-amz-checksum-sha256` (hex in, base64 on the wire): the store refuses a body whose SHA-256
   * differs, so a content-addressed key can only ever hold its own content (S3-03).
   */
  sha256Hex: string;
}

export interface SignedPut {
  url: string;
  /** Headers the client must send with the PUT, exactly as given (they are part of the signature). */
  headers: Record<string, string>;
}

export interface RangeRead {
  bytes: Uint8Array;
  /** The whole object's size. */
  sizeBytes: number;
}

export interface ListOptions {
  limit: number;
  /** The previous page's `next` (a continuation token). */
  after?: string;
  /** Start after this key (S5-F2: a sweep resumes from the last key a run saved); not with `after`. */
  startAfter?: string;
}

export interface ListPage {
  objects: { key: string; lastModified: Date }[];
  next: string | null;
}

/**
 * An object written in pieces (S7-07: a generated feed, never held whole in memory): a multipart upload whose parts
 * are sent as they fill, so at most one part is buffered. Small objects (one part) go up as a plain PUT on `complete`.
 */
export interface ObjectUpload {
  write(chunk: Uint8Array): Promise<void>;
  /** Sends the rest and makes the object visible; returns its size. */
  complete(): Promise<{ sizeBytes: number }>;
  /** Drops the parts sent so far (idempotent); nothing becomes visible. */
  abort(): Promise<void>;
}

/** Multipart part size: equal parts (R2 requires it), above S3's 5 MiB minimum. */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
/** S3's smallest multipart part (every part but the last). */
export const MIN_UPLOAD_PART_BYTES = 5 * 1024 * 1024;

export interface UploadOptions extends PutOptions {
  /**
   * This upload's part size (default the store's, `UPLOAD_PART_BYTES`), at least `MIN_UPLOAD_PART_BYTES`: smaller parts
   * hold less in memory while many uploads stream at once (S7-F3 feed images).
   */
  partBytes?: number;
}

export interface ObjectStore {
  put(bucket: BucketName, key: string, body: Uint8Array, options: PutOptions): Promise<void>;
  /** A streamed write (`ObjectUpload`); call `complete()` or `abort()`. */
  upload(bucket: BucketName, key: string, options: UploadOptions): ObjectUpload;
  /**
   * The object as a stream (S7-07: served as it is read, never buffered whole), or null when it does not exist. Fails
   * (`StorageError` 413) on an object larger than `maxBytes`, before or while streaming.
   */
  getStream(bucket: BucketName, key: string, options: GetOptions): Promise<Readable | null>;
  /** The whole object, or null when it does not exist (worker use: one image to process, S3-04). */
  get(bucket: BucketName, key: string, options: GetOptions): Promise<Uint8Array | null>;
  /**
   * Copies an object to another key of the same bucket inside the store (S7-F3: a streamed feed image lands under a
   * staging key, then moves to its content-addressed key once hashed) — no bytes through this process. Keeps the
   * source's metadata (content type). Fails (`StorageError` 404) when the source does not exist.
   */
  copy(bucket: BucketName, fromKey: string, toKey: string): Promise<void>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(bucket: BucketName, key: string): Promise<void>;
  /** Size of the object, or null when it does not exist. */
  head(bucket: BucketName, key: string): Promise<{ sizeBytes: number } | null>;
  /**
   * One page of objects whose key starts with `prefix` (key order), at most `limit` (1–1000). Pass the
   * previous page's `next` as `after` to continue; `next` is null on the last page.
   */
  list(bucket: BucketName, prefix: string, options: ListOptions): Promise<ListPage>;
  /**
   * Bytes `start`…`end` (inclusive) of an object — fewer when it is shorter — and its total size, or null when
   * it does not exist. One request: the magic-byte and size check of an object uploaded straight to the store
   * (S3-03).
   */
  getRange(bucket: BucketName, key: string, start: number, end: number): Promise<RangeRead | null>;
  /** A time-limited GET URL. Local signing only: no network call. */
  signedGetUrl(bucket: BucketName, key: string, options: SignedUrlOptions): Promise<string>;
  /**
   * A time-limited, create-only PUT URL bound to one content type, length and SHA-256 (`If-None-Match: *` is
   * signed too: answered 412 when the key exists). Local signing only.
   */
  signedPutUrl(bucket: BucketName, key: string, options: SignedPutOptions): Promise<SignedPut>;
}

export interface S3StoreConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  buckets: StorageBuckets;
  /** Per request. Default 15 s. */
  timeoutMs?: number;
  /** Multipart part size (`UPLOAD_PART_BYTES`). */
  partBytes?: number;
  fetch?: typeof fetch;
}

export class StorageError extends Error {
  override readonly name = 'StorageError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** S3 key rules we allow: safe characters, no `..` segments, no leading slash. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9!_.*'()/-]{0,1023}$/;

export function assertObjectKey(key: string): void {
  if (!KEY.test(key) || key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new TypeError('storage: invalid object key');
  }
}

const MAX_SIGNED_SECONDS = 3_600;
/** `type/subtype` only: no parameters, nothing a header could be injected with. */
const CONTENT_TYPE_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function assertSignedSeconds(value: number): number {
  const seconds = Math.floor(value);
  if (!(seconds >= 1 && seconds <= MAX_SIGNED_SECONDS)) {
    throw new RangeError(`storage: signed URLs live 1–${MAX_SIGNED_SECONDS} s`);
  }
  return seconds;
}

/** The signed headers of a PUT URL (validated: they end up in a signature and in the client's request). */
function putHeaders(options: SignedPutOptions): Record<string, string> {
  if (!CONTENT_TYPE_RE.test(options.contentType)) throw new TypeError('storage: invalid content type');
  if (!(Number.isSafeInteger(options.contentLength) && options.contentLength > 0)) {
    throw new RangeError('storage: content length must be a positive integer');
  }
  if (!SHA256_HEX_RE.test(options.sha256Hex)) throw new TypeError('storage: invalid sha256');
  return {
    'content-length': String(options.contentLength),
    'content-type': options.contentType,
    'x-amz-checksum-sha256': Buffer.from(options.sha256Hex, 'hex').toString('base64'),
    // Create only: a stored object is never overwritten through a signed URL (412 = stored already).
    'if-none-match': '*',
  };
}

/** A header value we send: visible ASCII only (nothing a header could be injected with). */
function assertCacheControl(value: string): string {
  if (!/^[ -~]{1,200}$/.test(value)) throw new TypeError('storage: invalid cache-control');
  return value;
}

function assertMaxBytes(value: number): number {
  if (!(Number.isSafeInteger(value) && value > 0)) throw new RangeError('storage: maxBytes must be a positive integer');
  return value;
}

/** Passes bytes through, failing the stream past `max` (a missing or wrong Content-Length cannot exceed it). */
function capped(max: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.byteLength;
      if (total > max) done(new StorageError('storage GET: object too large', 413));
      else done(null, chunk);
    },
  });
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** `attachment; filename="…"; filename*=UTF-8''…` with the ASCII fallback stripped of quotes and controls. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** A key prefix: `assertObjectKey` rules, with a trailing slash allowed (`verification/`). */
function assertListPrefix(prefix: string): void {
  assertObjectKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
}

const unescapeXml = (v: string) =>
  v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const xmlText = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m?.[1] === undefined ? null : unescapeXml(m[1]);
};

/**
 * ListObjectsV2 answer → page. The XML is flat, with fixed tags, from our own bucket: it is read with
 * patterns, not an XML parser (no entities or DTDs are ever resolved).
 */
export function parseListPage(xml: string): ListPage {
  const objects: ListPage['objects'] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = xmlText(m[1] ?? '', 'Key');
    const modified = xmlText(m[1] ?? '', 'LastModified');
    if (key && modified) objects.push({ key, lastModified: new Date(modified) });
  }
  const truncated = xmlText(xml, 'IsTruncated') === 'true';
  return { objects, next: truncated ? xmlText(xml, 'NextContinuationToken') : null };
}

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

/**
 * A request body of known length sent without a copy (S7-F3): a byte-array body is copied by every `Request` built
 * around it, which kept about twice the in-flight bytes in memory while many uploads ran; a one-chunk stream with an
 * explicit `content-length` is sent as is (no chunked encoding).
 */
function lengthBody(bytes: Uint8Array): { body: ReadableStream<Uint8Array> } {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

export function createS3Store(config: S3StoreConfig): ObjectStore {
  const endpoint = config.endpoint.replace(/\/+$/, '');
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region,
    // Retries are the caller's (a job retries with backoff); a request fails fast.
    retries: 0,
  });
  const timeoutMs = config.timeoutMs ?? 15_000;
  const partBytes = config.partBytes ?? UPLOAD_PART_BYTES;
  const bucketName = (bucket: BucketName): string =>
    (bucket === 'feeds' ? (config.buckets.feeds ?? config.buckets.exports) : config.buckets[bucket]) ?? '';
  const doFetch = config.fetch ?? fetch;

  const urlOf = (bucket: BucketName, key: string): URL => {
    assertObjectKey(key);
    const name = bucketName(bucket);
    // A store built for some buckets only (`storageConfigForBuckets`) reaches nothing else.
    if (!name) throw new StorageError(`storage: bucket ${bucket} is not configured`);
    return new URL(`${endpoint}/${encodeURIComponent(name)}/${encodeKey(key)}`);
  };

  const send = async (url: URL, init: RequestInit & { method: string }): Promise<Response> => {
    const signed = await aws.sign(url.href, init);
    try {
      return await doFetch(signed, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // Network errors may carry the URL; keep only the kind.
      throw new StorageError(`storage ${init.method} failed (${(err as Error).name})`);
    }
  };

  return {
    async put(bucket, key, body, options) {
      const res = await send(urlOf(bucket, key), {
        method: 'PUT',
        ...lengthBody(body),
        headers: {
          'content-type': options.contentType,
          ...(options.cacheControl ? { 'cache-control': assertCacheControl(options.cacheControl) } : {}),
          'content-length': String(body.byteLength),
          // Signed payload hash: the store rejects a body altered in transit.
          'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
        },
      });
      if (!res.ok) throw new StorageError(`storage PUT failed (${res.status})`, res.status);
      await res.body?.cancel();
    },
    upload(bucket, key, options) {
      const target = urlOf(bucket, key);
      const meta = {
        'content-type': options.contentType,
        ...(options.cacheControl ? { 'cache-control': assertCacheControl(options.cacheControl) } : {}),
      };
      const at = (params: Record<string, string>) => {
        const url = new URL(target.href);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        return url;
      };
      const partSize = options.partBytes ?? partBytes;
      if (options.partBytes !== undefined && (!Number.isInteger(partSize) || partSize < MIN_UPLOAD_PART_BYTES)) {
        throw new RangeError(`storage upload: partBytes must be an integer >= ${MIN_UPLOAD_PART_BYTES}`);
      }
      const part = Buffer.allocUnsafe(partSize);
      let fill = 0;
      let size = 0;
      let uploadId: string | null = null;
      let state: 'open' | 'done' | 'aborted' = 'open';
      const etags: string[] = [];
      const sendPart = async (bytes: Uint8Array) => {
        if (uploadId === null) {
          const res = await send(at({ uploads: '' }), { method: 'POST', headers: meta });
          const xml = await res.text();
          const started = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
          if (!res.ok || !started) throw new StorageError(`storage upload start failed (${res.status})`, res.status);
          uploadId = started;
        }
        const res = await send(at({ partNumber: String(etags.length + 1), uploadId }), {
          method: 'PUT',
          ...lengthBody(bytes),
          headers: {
            'content-length': String(bytes.byteLength),
            'x-amz-content-sha256': createHash('sha256').update(bytes).digest('hex'),
          },
        });
        await res.body?.cancel();
        const etag = res.headers.get('etag');
        if (!res.ok || !etag) throw new StorageError(`storage upload part failed (${res.status})`, res.status);
        etags.push(etag);
      };
      const assertOpen = () => {
        if (state !== 'open') throw new StorageError(`storage upload is ${state}`);
      };
      return {
        async write(chunk) {
          assertOpen();
          let from = 0;
          while (from < chunk.byteLength) {
            const n = Math.min(partSize - fill, chunk.byteLength - from);
            part.set(chunk.subarray(from, from + n), fill);
            fill += n;
            from += n;
            size += n;
            if (fill === partSize) {
              await sendPart(part);
              fill = 0;
            }
          }
        },
        async complete() {
          assertOpen();
          if (uploadId === null) {
            // One part at most: a plain PUT (no multipart for small objects).
            const body = part.subarray(0, fill);
            const res = await send(target, {
              method: 'PUT',
              ...lengthBody(body),
              headers: {
                ...meta,
                'content-length': String(body.byteLength),
                'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
              },
            });
            await res.body?.cancel();
            if (!res.ok) throw new StorageError(`storage PUT failed (${res.status})`, res.status);
          } else {
            if (fill > 0) await sendPart(part.subarray(0, fill));
            const parts = etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`);
            const res = await send(at({ uploadId }), {
              method: 'POST',
              body: `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`,
              headers: { 'content-type': 'application/xml' },
            });
            const xml = await res.text();
            // S3 may answer 200 with an error document.
            if (!res.ok || xml.includes('<Error>')) {
              throw new StorageError(`storage upload completion failed (${res.status})`, res.status);
            }
          }
          state = 'done';
          return { sizeBytes: size };
        },
        async abort() {
          if (state !== 'open') return;
          state = 'aborted';
          if (uploadId === null) return;
          const res = await send(at({ uploadId }), { method: 'DELETE' });
          await res.body?.cancel();
          // S9-03 review: a refused abort leaves the parts billed until the bucket's lifecycle rule removes them
          // (runbook deploy.md step 6) — the caller must know. 404: already gone (aborted or completed elsewhere).
          if (!res.ok && res.status !== 404) {
            throw new StorageError(`storage upload abort failed (${res.status})`, res.status);
          }
        },
      };
    },
    async getStream(bucket, key, options) {
      const max = assertMaxBytes(options.maxBytes);
      const res = await send(urlOf(bucket, key), { method: 'GET' });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new StorageError(`storage GET failed (${res.status})`, res.status);
      }
      if (Number(res.headers.get('content-length') ?? 0) > max) {
        await res.body.cancel();
        throw new StorageError('storage GET: object too large', 413);
      }
      return Readable.fromWeb(res.body as WebReadableStream<Uint8Array>).pipe(capped(max));
    },
    async get(bucket, key, options) {
      const max = assertMaxBytes(options.maxBytes);
      const res = await send(urlOf(bucket, key), { method: 'GET' });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new StorageError(`storage GET failed (${res.status})`, res.status);
      }
      const declared = res.headers.get('content-length');
      if (Number(declared ?? 0) > max) {
        await res.body?.cancel();
        throw new StorageError('storage GET: object too large', 413);
      }
      // Counted while streaming too: a missing or wrong Content-Length cannot make us buffer more than `max`.
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = res.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel();
          throw new StorageError('storage GET: object too large', 413);
        }
        chunks.push(value);
      }
      // A cut-off transfer is an error to retry, never a (shorter) object: callers hash what they get.
      if (declared !== null && total !== Number(declared)) {
        throw new StorageError('storage GET: incomplete body');
      }
      return concat(chunks, total);
    },
    async copy(bucket, fromKey, toKey) {
      if (fromKey === toKey) throw new StorageError('storage COPY: source and target are the same key');
      assertObjectKey(fromKey);
      const target = urlOf(bucket, toKey);
      const res = await send(target, {
        method: 'PUT',
        // `<bucket>/<key>`, each part URL-encoded (S3 CopyObject); same bucket as the target
        headers: { 'x-amz-copy-source': `${encodeURIComponent(bucketName(bucket))}/${encodeKey(fromKey)}` },
      });
      const xml = await res.text();
      // S3 may answer 200 with an error document.
      if (!res.ok || xml.includes('<Error>')) throw new StorageError(`storage COPY failed (${res.status})`, res.status);
    },
    async delete(bucket, key) {
      const res = await send(urlOf(bucket, key), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new StorageError(`storage DELETE failed (${res.status})`, res.status);
      await res.body?.cancel();
    },
    async head(bucket, key) {
      const res = await send(urlOf(bucket, key), { method: 'HEAD' });
      if (res.status === 404) return null;
      if (!res.ok) throw new StorageError(`storage HEAD failed (${res.status})`, res.status);
      return { sizeBytes: Number(res.headers.get('content-length') ?? 0) };
    },
    async list(bucket, prefix, options) {
      assertListPrefix(prefix);
      const limit = Math.min(Math.max(Math.floor(options.limit), 1), 1_000);
      const url = new URL(`${endpoint}/${encodeURIComponent(bucketName(bucket))}`);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      url.searchParams.set('max-keys', String(limit));
      if (options.after) url.searchParams.set('continuation-token', options.after);
      else if (options.startAfter) url.searchParams.set('start-after', options.startAfter);
      const res = await send(url, { method: 'GET' });
      if (!res.ok) throw new StorageError(`storage LIST failed (${res.status})`, res.status);
      return parseListPage(await res.text());
    },
    async getRange(bucket, key, start, end) {
      if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start)) {
        throw new RangeError('storage: invalid byte range');
      }
      const res = await send(urlOf(bucket, key), { method: 'GET', headers: { range: `bytes=${start}-${end}` } });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (res.status === 416) {
        // Nothing at `start`: an empty object (or one shorter than `start`), whose size the answer names.
        await res.body?.cancel();
        const size = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1];
        return { bytes: new Uint8Array(), sizeBytes: Number(size ?? 0) };
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new StorageError(`storage GET failed (${res.status})`, res.status);
      }
      // 206: `Content-Range: bytes 0-15/<total>`. A store that ignores Range answers 200 with the whole object.
      const total =
        res.status === 206
          ? /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]
          : (res.headers.get('content-length') ?? undefined);
      if (total === undefined) {
        await res.body?.cancel();
        throw new StorageError('storage GET: object size unknown');
      }
      // Read only the asked bytes, then stop (a 200 may stream megabytes).
      const want = end - start + 1;
      const out = new Uint8Array(want);
      let got = 0;
      const reader = res.body?.getReader();
      while (reader && got < want) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = value.subarray(0, want - got);
        out.set(take, got);
        got += take.byteLength;
      }
      await reader?.cancel();
      return { bytes: out.slice(0, got), sizeBytes: Number(total) };
    },
    async signedGetUrl(bucket, key, options) {
      const seconds = assertSignedSeconds(options.expiresInSeconds);
      const url = urlOf(bucket, key);
      url.searchParams.set('X-Amz-Expires', String(seconds));
      if (options.downloadName) {
        url.searchParams.set('response-content-disposition', attachmentDisposition(options.downloadName));
      }
      if (options.responseContentType) {
        if (!CONTENT_TYPE_RE.test(options.responseContentType)) throw new TypeError('storage: invalid content type');
        url.searchParams.set('response-content-type', options.responseContentType);
      }
      if (options.responseContentEncoding === 'gzip') url.searchParams.set('response-content-encoding', 'gzip');
      const signed = await aws.sign(url.href, { method: 'GET', aws: { signQuery: true } });
      return signed.url;
    },
    async signedPutUrl(bucket, key, options) {
      const url = urlOf(bucket, key);
      url.searchParams.set('X-Amz-Expires', String(assertSignedSeconds(options.expiresInSeconds)));
      const headers = putHeaders(options);
      // `allHeaders`: aws4fetch leaves content-type and content-length out of signatures by default.
      const signed = await aws.sign(url.href, { method: 'PUT', headers, aws: { signQuery: true, allHeaders: true } });
      return { url: signed.url, headers };
    },
  };
}

/** In-memory store for unit tests. Signed URLs are fake (`memory://…`). */
export interface MemoryStore extends ObjectStore {
  readonly objects: Map<string, { body: Uint8Array; contentType: string; lastModified: Date }>;
}

export function createMemoryStore(): MemoryStore {
  const objects = new Map<string, { body: Uint8Array; contentType: string; lastModified: Date }>();
  const id = (bucket: BucketName, key: string) => {
    assertObjectKey(key);
    return `${bucket}/${key}`;
  };
  return {
    objects,
    async put(bucket, key, body, options) {
      if (options.cacheControl) assertCacheControl(options.cacheControl);
      objects.set(id(bucket, key), { body: body.slice(), contentType: options.contentType, lastModified: new Date() });
    },
    upload(bucket, key, options) {
      const target = id(bucket, key);
      const chunks: Uint8Array[] = [];
      let size = 0;
      let state: 'open' | 'done' | 'aborted' = 'open';
      return {
        async write(chunk) {
          if (state !== 'open') throw new StorageError(`storage upload is ${state}`);
          chunks.push(chunk.slice());
          size += chunk.byteLength;
        },
        async complete() {
          if (state !== 'open') throw new StorageError(`storage upload is ${state}`);
          state = 'done';
          objects.set(target, {
            body: concat(chunks, size),
            contentType: options.contentType,
            lastModified: new Date(),
          });
          return { sizeBytes: size };
        },
        async abort() {
          if (state === 'open') state = 'aborted';
        },
      };
    },
    async getStream(bucket, key, options) {
      const max = assertMaxBytes(options.maxBytes);
      const o = objects.get(id(bucket, key));
      if (!o) return null;
      if (o.body.byteLength > max) throw new StorageError('storage GET: object too large', 413);
      return Readable.from([Buffer.from(o.body)]);
    },
    async get(bucket, key, options) {
      const max = assertMaxBytes(options.maxBytes);
      const o = objects.get(id(bucket, key));
      if (!o) return null;
      if (o.body.byteLength > max) throw new StorageError('storage GET: object too large', 413);
      return o.body.slice();
    },
    async copy(bucket, fromKey, toKey) {
      if (fromKey === toKey) throw new StorageError('storage COPY: source and target are the same key');
      const o = objects.get(id(bucket, fromKey));
      if (!o) throw new StorageError('storage COPY failed (404)', 404);
      objects.set(id(bucket, toKey), { ...o, lastModified: new Date() });
    },
    async delete(bucket, key) {
      objects.delete(id(bucket, key));
    },
    async head(bucket, key) {
      const o = objects.get(id(bucket, key));
      return o ? { sizeBytes: o.body.byteLength } : null;
    },
    async list(bucket, prefix, options) {
      assertListPrefix(prefix);
      const start = `${bucket}/${prefix}`;
      const keys = [...objects.keys()]
        .filter((k) => {
          const from = options.after ?? options.startAfter;
          return k.startsWith(start) && (from === undefined || k > `${bucket}/${from}`);
        })
        .sort();
      const page = keys.slice(0, options.limit);
      const last = page.at(-1);
      return {
        objects: page.map((k) => ({
          key: k.slice(bucket.length + 1),
          lastModified: objects.get(k)?.lastModified ?? new Date(0),
        })),
        next: keys.length > page.length && last ? last.slice(bucket.length + 1) : null,
      };
    },
    async getRange(bucket, key, start, end) {
      const o = objects.get(id(bucket, key));
      return o ? { bytes: o.body.slice(start, end + 1), sizeBytes: o.body.byteLength } : null;
    },
    async signedGetUrl(bucket, key, options) {
      const type = options.responseContentType ? `&type=${encodeURIComponent(options.responseContentType)}` : '';
      const encoding = options.responseContentEncoding ? `&encoding=${options.responseContentEncoding}` : '';
      return `memory://${id(bucket, key)}?expires=${options.expiresInSeconds}${type}${encoding}`;
    },
    async signedPutUrl(bucket, key, options) {
      assertSignedSeconds(options.expiresInSeconds);
      return { url: `memory://${id(bucket, key)}?expires=${options.expiresInSeconds}`, headers: putHeaders(options) };
    },
  };
}

let current: ObjectStore | undefined;

/** Sets the process-wide store (app boot, or a memory store in tests). */
export function configureStorage(next: S3StoreConfig | ObjectStore): void {
  current = 'put' in next ? next : createS3Store(next);
}

export function storage(): ObjectStore {
  if (!current) throw new Error('storage is not configured (call configureStorage at boot)');
  return current;
}

/** The `storageEnv` config section → store config. */
export function storageConfigFromEnv(env: {
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_BUCKET_MEDIA: string;
  S3_BUCKET_EXPORTS: string;
  S3_BUCKET_PRIVATE: string;
  S3_BUCKET_MEDIA_WORK: string;
  S3_BUCKET_FEEDS?: string;
}): S3StoreConfig {
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    buckets: {
      media: env.S3_BUCKET_MEDIA,
      exports: env.S3_BUCKET_EXPORTS,
      private: env.S3_BUCKET_PRIVATE,
      work: env.S3_BUCKET_MEDIA_WORK,
      ...(env.S3_BUCKET_FEEDS ? { feeds: env.S3_BUCKET_FEEDS } : {}),
    },
  };
}

/**
 * A store that reaches only `buckets` (S7-07: feed-api reads site feeds from `exports` and nothing else); a call on
 * any other bucket fails before a request is made. Pair it with credentials scoped the same way.
 */
export function storageConfigForBuckets(
  env: { S3_ENDPOINT: string; S3_REGION: string; S3_ACCESS_KEY_ID: string; S3_SECRET_ACCESS_KEY: string },
  buckets: Partial<StorageBuckets>,
): S3StoreConfig {
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    buckets: { media: '', exports: '', private: '', work: '', ...buckets },
  };
}

export { configureDocumentScanner, type DocumentScanner, scanDocument } from './scan';
export { type DetectedFile, detectFileType, SNIFF_BYTES } from './sniff';
