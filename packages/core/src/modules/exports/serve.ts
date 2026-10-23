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
 * strong ETag is the XML's SHA-256 (the content hash): a 304 needs no storage read. Reading and redirecting to the
 * stored object: `storedFeedFile` (S10-F2, shared with the site feeds; one redirect TTL). The file a URL names must be the
 * connection's portal format (`kyero.xml` or `inmolink.xml`).
 */
import type { PortalFeedFile as PortalFeedFileName } from '@inmolink/contracts';
import { withPublicRead } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import { type StoredFeedFile, storedFeedFile } from '../../stored-feed';
import * as websiteApi from '../website-api';
import { portalFeedTokenHash } from './config';
import { feedFileOf } from './profiles';
import * as repo from './repo';

/** A feed file's compressed size cap (a run over it fails for good: `TOO_LARGE`). */
export const PORTAL_FEED_MAX_GZIP_BYTES = 64 * 1024 * 1024;
/** Edge lifetime of a portal feed (s-maxage and stale-while-revalidate, seconds): portals poll hourly at most. */
export const PORTAL_FEED_TTL = 900;
/** How long the CDN may serve a feed while the origin errors: short, so a revoked token's copy dies soon (S7-07). */
export const PORTAL_FEED_STALE_IF_ERROR = 300;

export const portalFeedPrefix = (connectionId: string) => `portal-feeds/${connectionId}/`;
export const portalFeedObjectKey = (connectionId: string, runId: string) =>
  `${portalFeedPrefix(connectionId)}${runId}/feed.xml.gz`;

/** A portal feed file as feed-api answers it. */
export interface PortalFeedFile extends StoredFeedFile {
  connectionId: string;
  /** Strong ETag: the XML's SHA-256 (base64url). */
  etag: string;
  /** The `Cache-Tag` of the answer (the connection), or null before boot configured the tags. */
  tags: string[] | null;
}

/** The feed file a token URL names (feed-api). One statement. See the file comment. */
export async function portalFeedFile(token: string, file: PortalFeedFileName): Promise<PortalFeedFile> {
  const hash = portalFeedTokenHash(token);
  const row = await withPublicRead((tx) => repo.feedByTokenHash(tx, hash));
  // Found by equality on the keyed hash (unique index): the lookup never depends on the token beyond its hash.
  if (!row || feedFileOf(row.channelCode) !== file) {
    throw new AppError('PORTAL_FEED_NOT_FOUND');
  }
  return {
    connectionId: row.connectionId,
    etag: `"${row.sha256}"`,
    tags: websiteApi.edgeTagsConfigured() ? [websiteApi.edgeTag('p', row.connectionId)] : null,
    ...storedFeedFile(
      portalFeedObjectKey(row.connectionId, row.runId),
      PORTAL_FEED_MAX_GZIP_BYTES,
      'PORTAL_FEED_NOT_FOUND',
    ),
  };
}
