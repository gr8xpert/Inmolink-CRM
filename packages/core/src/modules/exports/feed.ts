/**
 * Portal feed writing (S9-02, PLAN §7 M7): one connection's feed as a stream of XML, with every selected listing
 * checked first. `writeConnectionFeed` is what the generator job (S9-03) runs, with a sink that gzips into object
 * storage; here nothing touches storage or the network, and no database transaction stays open while the sink runs
 * (CLAUDE.md rule 6).
 *
 * Data: the agency's **own** listings (the connection's selection: ACTIVE, PUBLIC, not deleted) read from
 * `listing_read_models` — the client-safe documents (strict shapes: no owner, commission, private data, internal
 * notes, exact pin) — in each of the agency's content locales, never from the raw tables (CLAUDE.md rule 9). The
 * presenting agency is the agency itself (its directory name and published contacts). Images are the processed
 * variants under the media CDN. Each document is turned into the same `WebsiteListingDetail` the site feeds use, so the
 * Kyero v3 and generic writers (`../../feed-xml`) are the ones the per-site feeds run — one writer per format.
 *
 * Streaming: one batch of `FEED_BATCH` listings at a time (ids, then their documents in one statement), written into
 * the escaping `XmlWriter` and handed to the sink whenever 64 K characters are pending (checked per listing). Memory
 * is one batch plus the writer's buffer, however many listings the agency has. Validation results are stored per
 * listing in the batch's own transaction (`portal_connection_issues`): the batch's failures are upserted (an unchanged
 * reason is not rewritten) and rows in the key range the batch examined that no longer fail are deleted — no sweep.
 * A listing with any issue is left out and the rest still go out. The totals on the connection (`last_*`) are written
 * only after the sink has completed, so a failed run leaves the last good summary; the issue rows are the latest
 * per-listing checks either way. Running twice over unchanged data writes the same bytes (no timestamp in the
 * document, the agency's public name as the header) and no rows: idempotent.
 *
 * Concurrency: runs of ONE connection must not overlap (the generator, S9-03, serializes them per connection — two
 * interleaved runs would mix their range deletes and summaries); runs of different connections are independent.
 */
import { type ListingDetailDoc, type PortalIssue, WebsiteDetail, type WebsiteImage } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import type { Logger } from '@inmolink/platform/logger';
import { XmlWriter } from '@inmolink/platform/xml';
import {
  type FeedItem,
  writeGenericEnd,
  writeGenericItem,
  writeGenericStart,
  writeKyeroEnd,
  writeKyeroProperty,
  writeKyeroStart,
} from '../../feed-xml';
import * as agencies from '../agencies';
import * as search from '../search';
import { PORTAL_PREFERRED_LOCALE, type PortalProfile, portalWriterEnabled, profileOf } from './profiles';
import * as repo from './repo';
import { connectionForWorker, selectConnectionListings, type WorkerConnection } from './service';
import { validateItem } from './validate';

/** Listings per batch (one selection page, then one document statement, one issue write). */
export const FEED_BATCH = 200;
/** The writer hands its buffer to the sink once it holds this many characters. */
const FLUSH_CHARS = 64 * 1024;

export interface PortalFeedOptions {
  /** Media CDN base (`MEDIA_CDN_URL`): image variant keys are served under it. */
  mediaBaseUrl: string;
  /** Receives the document in pieces, in order; awaited, so a slow sink slows the writer (backpressure). */
  sink: (chunk: string) => Promise<void>;
  batchSize?: number;
  signal?: AbortSignal;
  log?: Logger;
}

export interface PortalFeedResult {
  /** Why nothing was written: the connection is gone, off, revoked, or its portal's writer is not enabled (H6). */
  skipped?: 'no-connection' | 'disabled' | 'revoked' | 'no-profile' | 'writer-disabled' | 'not-verified' | 'no-locales';
  /** Listings written / left out for an issue. */
  valid?: number;
  invalid?: number;
  /** The connection's version when read: the generator re-queues when it changed meanwhile. */
  version?: number;
}

const noText = (s: string | null | undefined) => (s ?? '').trim() === '';

type ReadModelImage = NonNullable<ListingDetailDoc['cover']>;

/** A processed image as a feed lists it: its variant keys behind the media CDN. */
function imageOf(base: string, image: ReadModelImage): WebsiteImage {
  const { variants, ...rest } = image;
  const urls: WebsiteImage['urls'] = {};
  for (const [size, key] of Object.entries(variants)) {
    if (key) urls[size as keyof WebsiteImage['urls']] = `${base}/${key}`;
  }
  return { ...rest, urls };
}

/** The strict website detail of one document: the agency itself presents its own listing. */
function detailOf(doc: ListingDetailDoc, mediaBase: string, presenter: FeedPresenter): WebsiteDetail | null {
  const parsed = WebsiteDetail.safeParse({
    ...doc,
    cover: doc.cover ? imageOf(mediaBase, doc.cover) : null,
    media: doc.media.map((m) => (m.kind === 'VIDEO' ? m : imageOf(mediaBase, m))),
    developmentRef: null,
    agency: presenter,
  });
  return parsed.success ? parsed.data : null;
}

export interface FeedPresenter {
  name: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  website: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}

/**
 * The batch's feed items: per listing the base-locale detail and its own-language texts. A listing without a usable
 * document comes back in `missing`. Pure.
 */
export function buildItems(
  ids: readonly string[],
  docs: readonly search.OwnListingDetail[],
  q: { locales: readonly string[]; baseLocale: string; mediaBase: string; presenter: FeedPresenter },
): { items: { id: string; item: FeedItem }[]; missing: string[] } {
  const byTarget = new Map<string, Map<string, search.OwnListingDetail>>();
  for (const d of docs) {
    const perLocale = byTarget.get(d.targetId) ?? new Map<string, search.OwnListingDetail>();
    perLocale.set(d.locale, d);
    byTarget.set(d.targetId, perLocale);
  }
  const items: { id: string; item: FeedItem }[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const perLocale = byTarget.get(id);
    const baseDoc = perLocale?.get(q.baseLocale) ?? (perLocale ? [...perLocale.values()][0] : undefined);
    const base = baseDoc ? detailOf(baseDoc.doc, q.mediaBase, q.presenter) : null;
    if (!baseDoc || !base) {
      missing.push(id);
      continue;
    }
    // A language's text only where the listing has its own text in it (not another language's fallback).
    const texts = new Map<string, WebsiteDetail>();
    for (const locale of q.locales) {
      const d = perLocale?.get(locale);
      if (!d || d.doc.textLocale !== null || noText(d.doc.description)) continue;
      const detail = locale === baseDoc.locale ? base : detailOf(d.doc, q.mediaBase, q.presenter);
      if (detail) texts.set(locale, detail);
    }
    items.push({ id, item: { base, texts, updatedAt: baseDoc.updatedAt } });
  }
  return { items, missing };
}

interface Setup {
  connection: WorkerConnection;
  profile: PortalProfile;
  locales: string[];
  baseLocale: string;
  presenter: FeedPresenter;
}

async function setup(agencyId: string, connectionId: string): Promise<Setup | PortalFeedResult> {
  return withSystem('exports.writeConnectionFeed setup', async (tx) => {
    const connection = await connectionForWorker(tx, agencyId, connectionId);
    if (!connection) return { skipped: 'no-connection' as const };
    if (!connection.enabled) return { skipped: 'disabled' as const };
    if (connection.revokedAt) return { skipped: 'revoked' as const };
    const profile = profileOf(connection.channelCode);
    if (!profile) return { skipped: 'no-profile' as const };
    if (!(await portalWriterEnabled({ tx, tenant: { agencyId } }, profile))) {
      return { skipped: 'writer-disabled' as const };
    }
    const owner = (await agencies.readModelOwnersOf(tx, [agencyId])).get(agencyId);
    // A suspended or unverified agency's listings are not public (S6-F1): nothing to send, and not a fault of any listing.
    if (!owner?.publishes) return { skipped: 'not-verified' as const };
    const locales = owner.locales;
    if (locales.length === 0) return { skipped: 'no-locales' as const };
    const listed = (await agencies.publicAgencies(tx, [agencyId])).get(agencyId);
    const name = listed?.name ?? (await agencies.getAgencyName(tx, agencyId)) ?? '';
    return {
      connection,
      profile,
      locales,
      baseLocale: locales.includes(PORTAL_PREFERRED_LOCALE) ? PORTAL_PREFERRED_LOCALE : (locales[0] as string),
      presenter: {
        name,
        email: listed?.contactEmail ?? null,
        phone: listed?.contactPhone ?? null,
        whatsapp: null,
        website: listed?.websiteUrl ?? null,
        primaryColor: listed?.primaryColor ?? null,
        accentColor: listed?.accentColor ?? null,
      },
    };
  });
}

/** Writes the connection's feed to `sink` and records each listing's check. See the file comment. */
export async function writeConnectionFeed(
  agencyId: string,
  connectionId: string,
  opts: PortalFeedOptions,
): Promise<PortalFeedResult> {
  const prepared = await setup(agencyId, connectionId);
  if (!('connection' in prepared)) return prepared;
  const { connection, profile, locales, baseLocale, presenter } = prepared;
  const runStart = clock.now();
  const mediaBase = opts.mediaBaseUrl.replace(/\/+$/, '');
  const size = opts.batchSize ?? FEED_BATCH;
  const w = new XmlWriter();
  const flush = async (force = false) => {
    if (force || w.pending >= FLUSH_CHARS) await opts.sink(w.take());
  };

  if (profile.format === 'kyero-v3') writeKyeroStart(w);
  // The agency's public name, never the connection's label (an internal name); no timestamp: same data, same bytes.
  else writeGenericStart(w, { generatedAt: null, siteName: presenter.name, locales, agency: presenter });
  let valid = 0;
  let invalid = 0;
  let cursor: string | null = null;
  for (;;) {
    opts.signal?.throwIfAborted();
    // One transaction per batch: selection, documents and the issue rows. The sink runs after it has ended.
    const batch: { ready: FeedItem[]; next: string | null } = await withSystem(
      'exports.writeConnectionFeed batch',
      async (tx) => {
        const page = await selectConnectionListings(tx, connection, { cursor, limit: size });
        const docs = await search.ownListingDetails(tx, agencyId, page.ids, locales);
        const built = buildItems(page.ids, docs, { locales, baseLocale, mediaBase, presenter });
        const failures: { propertyId: string; errors: PortalIssue[] }[] = built.missing.map((propertyId) => ({
          propertyId,
          errors: [{ code: 'NO_DOCUMENT' }],
        }));
        const ready: FeedItem[] = [];
        for (const { id, item } of built.items) {
          const issues = validateItem(profile, item);
          if (issues.length > 0) failures.push({ propertyId: id, errors: issues });
          else ready.push(item);
        }
        // Everything the selection examined for this batch is `(cursor, next]`: rows there that no longer fail go.
        await repo.syncIssues(tx, connection, { after: cursor, upTo: page.nextCursor }, failures, runStart);
        invalid += failures.length;
        return { ready, next: page.nextCursor };
      },
    );
    for (const item of batch.ready) {
      if (profile.format === 'kyero-v3') {
        // Validation refused everything the writer would drop: a drop here is a bug, never a silent loss.
        if (!writeKyeroProperty(w, item, { maxImages: profile.maxPhotos ?? undefined })) {
          throw new Error(`exports: validated listing ${item.base.ref} was dropped by the ${profile.code} writer`);
        }
      } else writeGenericItem(w, item);
      valid++;
      // Bounded buffer: per listing, not per batch (a listing is at most a few tens of KB).
      await flush();
    }
    if (batch.next === null) break;
    cursor = batch.next;
  }
  if (profile.format === 'kyero-v3') writeKyeroEnd(w);
  else writeGenericEnd(w);
  await opts.sink(w.end());

  // Only a run whose sink completed is recorded: a failed run leaves the last good totals (S9-03 retries it).
  await withSystem('exports.writeConnectionFeed record', (tx) =>
    repo.setValidationSummary(tx, agencyId, connection.id, { checkedAt: runStart, valid, invalid }),
  );
  opts.log?.info({ connectionId, channel: profile.code, valid, invalid }, 'portal feed written');
  return { valid, invalid, version: connection.version };
}
