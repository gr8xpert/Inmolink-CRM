/**
 * Stored XML feed files (S10-F2): the one upload and the one serving helper of the per-site feeds (website-api, S7-07)
 * and the portal feeds (exports, S9-03). Both write a document in pieces through gzip into a multipart object upload
 * (`storage().upload`, the `feeds` bucket) — memory holds the gzip window and one part, never a whole file — and both
 * serve the stored gzip object by token URL: streamed, or (edge cache off) as a short-lived signed storage URL.
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { ErrorCode } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import { type ObjectUpload, storage } from '@inmolink/platform/storage';

/**
 * Lifetime of the signed storage URL a feed poll is redirected to while the edge cache is off (seconds, S8-F1), for
 * site and portal feeds alike (S10-F2: the shorter of the two former values): long enough to follow the redirect at
 * once, short enough that a URL copied from a log or a proxy is useless within a minute.
 */
export const STORED_FEED_REDIRECT_TTL = 60;

export interface GzipObjectUploadOptions {
  /**
   * What the SHA-256 covers: the document `text` (portal feeds: the content hash a rerun compares, independent of the
   * compression) or the stored `gzip` bytes (site feeds: the file's own hash).
   */
  hash: 'text' | 'gzip';
  /** Compressed size cap: past it `write` / `finish` throw `tooLarge()` (the caller aborts the upload). */
  maxBytes: number;
  tooLarge: () => Error;
}

export interface GzipObjectUploadResult {
  /** SHA-256, base64url (of the text or of the gzip bytes, as configured). */
  sha256: string;
  /** Compressed size. */
  bytes: number;
  /** The hash equalled `unchangedIf`: the upload was aborted, nothing was stored. */
  unchanged: boolean;
}

/** A document written in pieces, gzipped into an object upload as it is written, and hashed on the way. */
export class GzipObjectUpload {
  readonly #gzip = createGzip({ level: 6 });
  readonly #hash = createHash('sha256');
  readonly #pending: Buffer[] = [];
  #bytes = 0;

  constructor(
    private readonly upload: ObjectUpload,
    private readonly options: GzipObjectUploadOptions,
  ) {
    this.#gzip.on('data', (chunk: Buffer) => {
      this.#pending.push(chunk);
      if (options.hash === 'gzip') this.#hash.update(chunk);
      this.#bytes += chunk.length;
    });
  }

  async #drain(): Promise<void> {
    if (this.#bytes > this.options.maxBytes) throw this.options.tooLarge();
    for (let chunk = this.#pending.shift(); chunk; chunk = this.#pending.shift()) await this.upload.write(chunk);
  }

  async write(text: string): Promise<void> {
    if (text.length === 0) return;
    if (this.options.hash === 'text') this.#hash.update(text, 'utf8');
    if (!this.#gzip.write(text, 'utf8')) await once(this.#gzip, 'drain');
    await this.#drain();
  }

  /**
   * Ends the document. Its hash equal to `unchangedIf` (the served file's) → the upload is aborted (`unchanged`);
   * otherwise it completes.
   */
  async finish(unchangedIf: string | null = null): Promise<GzipObjectUploadResult> {
    this.#gzip.end();
    await finished(this.#gzip);
    await this.#drain();
    const sha256 = this.#hash.digest('base64url');
    if (sha256 === unchangedIf) {
      await this.upload.abort();
      return { sha256, bytes: this.#bytes, unchanged: true };
    }
    await this.upload.complete();
    return { sha256, bytes: this.#bytes, unchanged: false };
  }

  async abort(): Promise<void> {
    this.#gzip.destroy();
    await this.upload.abort().catch(() => undefined);
  }
}

/** How feed-api reads a stored feed file. */
export interface StoredFeedFile {
  /** The gzip bytes as a stream (a storage read): only when the client has no current copy. */
  open(): Promise<Readable>;
  /**
   * A short-lived signed storage URL serving the stored file as gzip-encoded XML (S8-F1): feed-api redirects polls to
   * it while the edge cache is off, so a feed (up to its cap) never streams through the origin on every poll.
   */
  signedUrl(): Promise<string>;
}

/**
 * The stored object `key` of the `feeds` bucket: read up to `maxBytes`; gone (replaced by a newer run between the
 * lookup and the read) → `notFoundCode`, and the client asks again.
 */
export function storedFeedFile(key: string, maxBytes: number, notFoundCode: ErrorCode): StoredFeedFile {
  return {
    async open() {
      const body = await storage().getStream('feeds', key, { maxBytes });
      if (!body) throw new AppError(notFoundCode);
      return body;
    },
    signedUrl() {
      return storage().signedGetUrl('feeds', key, {
        expiresInSeconds: STORED_FEED_REDIRECT_TTL,
        responseContentType: 'application/xml',
        responseContentEncoding: 'gzip',
      });
    },
  };
}
