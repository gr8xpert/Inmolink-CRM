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
  /** Private documents (agency verification): never public, signed URLs only. */
  private: string;
}

export type BucketName = keyof StorageBuckets;

export interface PutOptions {
  contentType: string;
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

export interface ObjectStore {
  put(bucket: BucketName, key: string, body: Uint8Array, options: PutOptions): Promise<void>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(bucket: BucketName, key: string): Promise<void>;
  /** Size of the object, or null when it does not exist. */
  head(bucket: BucketName, key: string): Promise<{ sizeBytes: number } | null>;
  /** A time-limited GET URL. Local signing only: no network call. */
  signedGetUrl(bucket: BucketName, key: string, options: SignedUrlOptions): Promise<string>;
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

/** `attachment; filename="…"; filename*=UTF-8''…` with the ASCII fallback stripped of quotes and controls. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
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
          // Signed payload hash: the store rejects a body altered in transit.
          'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
        },
      });
      if (!res.ok) throw new StorageError(`storage PUT failed (${res.status})`, res.status);
      await res.body?.cancel();
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
    async signedGetUrl(bucket, key, options) {
      const seconds = Math.floor(options.expiresInSeconds);
      if (!(seconds >= 1 && seconds <= MAX_SIGNED_SECONDS)) {
        throw new RangeError(`storage: signed URLs live 1–${MAX_SIGNED_SECONDS} s`);
      }
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
  };
}

/** In-memory store for unit tests. Signed URLs are fake (`memory://…`). */
export interface MemoryStore extends ObjectStore {
  readonly objects: Map<string, { body: Uint8Array; contentType: string }>;
}

export function createMemoryStore(): MemoryStore {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const id = (bucket: BucketName, key: string) => {
    assertObjectKey(key);
    return `${bucket}/${key}`;
  };
  return {
    objects,
    async put(bucket, key, body, options) {
      objects.set(id(bucket, key), { body: body.slice(), contentType: options.contentType });
    },
    async delete(bucket, key) {
      objects.delete(id(bucket, key));
    },
    async head(bucket, key) {
      const o = objects.get(id(bucket, key));
      return o ? { sizeBytes: o.body.byteLength } : null;
    },
    async signedGetUrl(bucket, key, options) {
      const type = options.responseContentType ? `&type=${encodeURIComponent(options.responseContentType)}` : '';
      return `memory://${id(bucket, key)}?expires=${options.expiresInSeconds}${type}`;
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
}): S3StoreConfig {
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    buckets: { media: env.S3_BUCKET_MEDIA, exports: env.S3_BUCKET_EXPORTS, private: env.S3_BUCKET_PRIVATE },
  };
}

export { type DetectedFile, detectFileType } from './sniff';
