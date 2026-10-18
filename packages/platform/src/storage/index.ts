import { createHash } from 'node:crypto';
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

export interface ObjectStore {
  put(bucket: BucketName, key: string, body: Uint8Array, options: PutOptions): Promise<void>;
  /** The whole object, or null when it does not exist (worker use: one image to process, S3-04). */
  get(bucket: BucketName, key: string, options: GetOptions): Promise<Uint8Array | null>;
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
  const doFetch = config.fetch ?? fetch;

  const urlOf = (bucket: BucketName, key: string): URL => {
    assertObjectKey(key);
    const name = config.buckets[bucket];
    return new URL(`${endpoint}/${encodeURIComponent(name)}/${key.split('/').map(encodeURIComponent).join('/')}`);
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
        body: body as Uint8Array<ArrayBuffer>,
        headers: {
          'content-type': options.contentType,
          ...(options.cacheControl ? { 'cache-control': assertCacheControl(options.cacheControl) } : {}),
          // Signed payload hash: the store rejects a body altered in transit.
          'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
        },
      });
      if (!res.ok) throw new StorageError(`storage PUT failed (${res.status})`, res.status);
      await res.body?.cancel();
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
      const url = new URL(`${endpoint}/${encodeURIComponent(config.buckets[bucket])}`);
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
    async get(bucket, key, options) {
      const max = assertMaxBytes(options.maxBytes);
      const o = objects.get(id(bucket, key));
      if (!o) return null;
      if (o.body.byteLength > max) throw new StorageError('storage GET: object too large', 413);
      return o.body.slice();
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
      return `memory://${id(bucket, key)}?expires=${options.expiresInSeconds}${type}`;
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
    },
  };
}

export { configureDocumentScanner, type DocumentScanner, scanDocument } from './scan';
export { type DetectedFile, detectFileType, SNIFF_BYTES } from './sniff';
