/**
 * Portal feed files (S9-03, PLAN §7 M7): where the generator stores them and how feed-api serves them.
 *
 * Storage: `portal-feeds/<connection>/<run>/feed.xml.gz` in the `feeds` bucket — one object per written run (the
 * served one is `agency_portal_connections.feed_run_id`); the previous run's object is deleted once a new one is
 * recorded, every object of a connection once it is turned off, revoked or deleted.
 *
 * Serving (`portalFeedFile`, feed-api as `app_public`): the token's keyed hash (`HMAC_KEY`, purpose
 * `exports.feed-token`) is looked up through the SECURITY DEFINER `portal_feed_by_token` — one statement that answers
 * the live connection's id, portal, served run and content hash and no other column (never the credentials). Unknown, rotated or
 * revoked tokens, connections turned off, agencies not verified and feeds not generated yet answer the same 404. The
 * strong ETag is the XML's SHA-256 (the content hash): a 304 needs no storage read. The file a URL names must be the
 * connection's portal format (`kyero.xml` or `inmolink.xml`).
 */
import type { Readable } from 'node:stream';
import type { PortalFeedFile as PortalFeedFileName } from '@inmolink/contracts';
import { withPublicRead } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import { storage } from '@inmolink/platform/storage';
import * as websiteApi from '../website-api';
import { feedFileOf } from './profiles';
import * as repo from './repo';
import { portalFeedTokenHash } from './service';

/** A feed file's compressed size cap (a run over it fails for good: `TOO_LARGE`). */
export const PORTAL_FEED_MAX_GZIP_BYTES = 64 * 1024 * 1024;
/** Edge lifetime of a portal feed (s-maxage and stale-while-revalidate, seconds): portals poll hourly at most. */
export const PORTAL_FEED_TTL = 900;
/** How long the CDN may serve a feed while the origin errors: short, so a revoked token's copy dies soon (S7-07). */
export const PORTAL_FEED_STALE_IF_ERROR = 300;
/**
 * Lifetime of the signed storage URL a poll is redirected to while the edge cache is off (seconds, S8-F1): long enough
 * to follow the redirect at once, short enough that a URL copied from a log or a proxy is useless within a minute.
 */
export const PORTAL_FEED_REDIRECT_TTL = 60;

export const portalFeedPrefix = (connectionId: string) => `portal-feeds/${connectionId}/`;
export const portalFeedObjectKey = (connectionId: string, runId: string) =>
  `${portalFeedPrefix(connectionId)}${runId}/feed.xml.gz`;

/** A portal feed file as feed-api answers it. */
export interface PortalFeedFile {
  connectionId: string;
  /** Strong ETag: the XML's SHA-256 (base64url). */
  etag: string;
  /** The `Cache-Tag` of the answer (the connection), or null before boot configured the tags. */
  tags: string[] | null;
  /** The gzip bytes as a stream (a storage read): only when the client has no current copy. */
  open(): Promise<Readable>;
  /** A short-lived signed storage URL serving the gzip-encoded XML (edge cache off: the poll is redirected). */
  signedUrl(): Promise<string>;
}

/** The feed file a token URL names (feed-api). One statement. See the file comment. */
export async function portalFeedFile(token: string, file: PortalFeedFileName): Promise<PortalFeedFile> {
  const hash = portalFeedTokenHash(token);
  const row = await withPublicRead((tx) => repo.feedByTokenHash(tx, hash));
  // Found by equality on the keyed hash (unique index): the lookup never depends on the token beyond its hash.
  if (!row || feedFileOf(row.channelCode) !== file) {
    throw new AppError('PORTAL_FEED_NOT_FOUND');
  }
  const key = portalFeedObjectKey(row.connectionId, row.runId);
  return {
    connectionId: row.connectionId,
    etag: `"${row.sha256}"`,
    tags: websiteApi.edgeTagsConfigured() ? [websiteApi.edgeTag('p', row.connectionId)] : null,
    async open() {
      const body = await storage().getStream('feeds', key, { maxBytes: PORTAL_FEED_MAX_GZIP_BYTES });
      // Replaced by a newer run between the lookup and the read: the client asks again.
      if (!body) throw new AppError('PORTAL_FEED_NOT_FOUND');
      return body;
    },
    signedUrl() {
      return storage().signedGetUrl('feeds', key, {
        expiresInSeconds: PORTAL_FEED_REDIRECT_TTL,
        responseContentType: 'application/xml',
        responseContentEncoding: 'gzip',
      });
    },
  };
}
