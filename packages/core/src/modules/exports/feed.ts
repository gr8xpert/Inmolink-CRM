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
 * One pass per agency (S9-03): `planAgencyFeeds` + `writePlannedFeeds` write several connections of one agency at
 * once, reading each batch's documents once for all of them (see `writePlannedFeeds`); `writeConnectionFeed` is the
 * one-connection case.
 *
 * Concurrency: runs of ONE connection must not overlap (the generator, S9-03, serializes them per agency — two
 * interleaved runs would mix their range deletes and summaries); runs of different agencies are independent.
 */
import { type ListingDetailDoc, type PortalIssue, WebsiteDetail, type WebsiteImage } from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
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
import { PortalFeedError } from './feed-error';
import { PORTAL_PREFERRED_LOCALE, type PortalProfile, portalWriterEnabled, profileOf } from './profiles';
import { isPushChannel } from './push/registry';
import * as repo from './repo';
import { selectConnectionListings, type WorkerConnection, workerConnections } from './service';
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
  /** The connection's version when read (a change meanwhile queues its own run through `exports.connection.changed`). */
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

/** A connection a pass writes: loaded once, with its portal's profile. */
export interface PlannedConnection {
  connection: WorkerConnection;
  profile: PortalProfile;
}

export type PortalFeedSkip = NonNullable<PortalFeedResult['skipped']>;

/**
 * What one pass over an agency writes (S9-03): the agency's content locales and presenter (read once), the connections
 * ready to write and the ones skipped with why. `skipped` set: nothing at all is written for the agency.
 */
export interface FeedPlan {
  agencyId: string;
  skipped?: Extract<PortalFeedSkip, 'not-verified' | 'no-locales'>;
  ready: PlannedConnection[];
  /** S9-04: connections of push portals (idealista, Fotocasa) the pass found: no file; `push/engine.ts` sends or takes down. */
  push: string[];
  skippedConnections: { connectionId: string; reason: PortalFeedSkip }[];
  locales: string[];
  baseLocale: string;
  presenter: FeedPresenter;
}

/**
 * Loads a pass (one transaction): `connectionIds` the connections to write, or `'live'` for every live one (enabled,
 * token not revoked) of the agency. A named connection that is gone, off, revoked or whose portal writer is not enabled
 * is skipped with that reason.
 */
export async function planAgencyFeeds(agencyId: string, connectionIds: readonly string[] | 'live'): Promise<FeedPlan> {
  return withSystem('exports.planAgencyFeeds', async (tx) => {
    const rows = await workerConnections(tx, agencyId, connectionIds === 'live' ? null : connectionIds);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ready: PlannedConnection[] = [];
    const push: string[] = [];
    const skippedConnections: FeedPlan['skippedConnections'] = [];
    const wanted = connectionIds === 'live' ? rows.map((r) => r.id) : [...new Set(connectionIds)];
    for (const id of wanted) {
      const connection = byId.get(id);
      const skip = (reason: PortalFeedSkip) => skippedConnections.push({ connectionId: id, reason });
      if (!connection) skip('no-connection');
      else if (isPushChannel(connection.channelCode))
        push.push(id); // the push engine decides: send or take down
      else if (!connection.enabled) skip('disabled');
      else if (connection.revokedAt) skip('revoked');
      else {
        const profile = profileOf(connection.channelCode);
        if (!profile) skip('no-profile');
        else if (!(await portalWriterEnabled({ tx, tenant: { agencyId } }, profile))) skip('writer-disabled');
        else ready.push({ connection, profile });
      }
    }
    const empty = { agencyId, ready, push, skippedConnections, locales: [], baseLocale: '', presenter: NO_PRESENTER };
    if (ready.length === 0 && push.length === 0) return empty;
    const shown = await agencyPresentation(tx, agencyId);
    if ('skipped' in shown) return { ...empty, skipped: shown.skipped };
    return { agencyId, ready, push, skippedConnections, ...shown };
  });
}

/**
 * What every export of an agency shares (feeds and pushes): its content locales, the base locale and the presenting
 * agency; or why nothing may be sent (unverified agency, no locales). One transaction, read once per pass.
 */
export async function agencyPresentation(
  tx: Tx,
  agencyId: string,
): Promise<
  { skipped: 'not-verified' | 'no-locales' } | { locales: string[]; baseLocale: string; presenter: FeedPresenter }
> {
  const owner = (await agencies.readModelOwnersOf(tx, [agencyId])).get(agencyId);
  // A suspended or unverified agency's listings are not public (S6-F1): nothing to send, and not a fault of any listing.
  if (!owner?.publishes) return { skipped: 'not-verified' };
  const locales = owner.locales;
  if (locales.length === 0) return { skipped: 'no-locales' };
  const listed = (await agencies.publicAgencies(tx, [agencyId])).get(agencyId);
  const name = listed?.name ?? (await agencies.getAgencyName(tx, agencyId)) ?? '';
  return {
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
}

const NO_PRESENTER: FeedPresenter = {
  name: '',
  email: null,
  phone: null,
  whatsapp: null,
  website: null,
  primaryColor: null,
  accentColor: null,
};

export interface PlannedFeedOptions {
  /** Media CDN base (`MEDIA_CDN_URL`): image variant keys are served under it. */
  mediaBaseUrl: string;
  batchSize?: number;
  signal?: AbortSignal;
  log?: Logger;
  /**
   * Write each completed connection's totals (`last_*`) here (default). The generator (S9-03) passes false and records
   * them with the run, after its upload completed.
   */
  recordSummary?: boolean;
}

/** One connection's outcome in a pass: written (totals) or failed (its sink threw; the others went on). */
export type PlannedFeedOutcome =
  | { connectionId: string; valid: number; invalid: number; version: number; checkedAt: Date }
  | { connectionId: string; error: unknown };

interface Lane {
  planned: PlannedConnection;
  sink: (chunk: string) => Promise<void>;
  w: XmlWriter;
  cursor: string | null;
  done: boolean;
  valid: number;
  invalid: number;
  error?: unknown;
}

/**
 * Writes the planned connections' feeds in **one pass** over the agency (S9-03, S9-02 review follow-up 2): each
 * round, every unfinished connection takes its next selection page (ids only); the round is cut at the smallest
 * `next` among the pages that continue, so every connection covers the same key range; the documents of the union
 * of their ids are read **once** (one statement) and built once; each connection validates them against its own
 * portal profile, stores its issues for the range, and writes its valid listings into its own writer and sink (after
 * the round's transaction has ended). A listing's document is read once per pass however many connections send it.
 * A sink that throws fails its connection alone; the others finish. A database error fails the pass.
 */
export async function writePlannedFeeds(
  plan: FeedPlan,
  sinks: ReadonlyMap<string, (chunk: string) => Promise<void>>,
  opts: PlannedFeedOptions,
): Promise<PlannedFeedOutcome[]> {
  if (plan.skipped) return [];
  const { agencyId, locales, baseLocale, presenter } = plan;
  const runStart = clock.now();
  const mediaBase = opts.mediaBaseUrl.replace(/\/+$/, '');
  const size = opts.batchSize ?? FEED_BATCH;
  const lanes: Lane[] = [];
  for (const planned of plan.ready) {
    const sink = sinks.get(planned.connection.id);
    if (!sink) continue;
    const w = new XmlWriter();
    if (planned.profile.format === 'kyero-v3') writeKyeroStart(w);
    // The agency's public name, never the connection's label (an internal name); no timestamp: same data, same bytes.
    else writeGenericStart(w, { generatedAt: null, siteName: presenter.name, locales, agency: presenter });
    lanes.push({ planned, sink, w, cursor: null, done: false, valid: 0, invalid: 0 });
  }
  const fail = (lane: Lane, err: unknown) => {
    lane.error = err;
    lane.done = true;
    opts.log?.warn(
      { connectionId: lane.planned.connection.id, err: err instanceof Error ? err.name : 'error' },
      'portal feed sink failed',
    );
  };

  for (;;) {
    const open = lanes.filter((l) => !l.done);
    if (open.length === 0) break;
    opts.signal?.throwIfAborted();
    // One transaction per round: every connection's selection page, the documents once, the issue rows. The sinks run
    // after it has ended.
    const round = await withSystem('exports.writeFeeds batch', async (tx) => {
      const pages: { ids: string[]; nextCursor: string | null }[] = [];
      for (const lane of open) {
        pages.push(await selectConnectionListings(tx, lane.planned.connection, { cursor: lane.cursor, limit: size }));
      }
      // Ids compare as lower-case canonical UUID text, like Postgres' uuid order (`selection.ts`).
      let bound: string | null = null;
      for (const p of pages)
        if (p.nextCursor !== null && (bound === null || p.nextCursor < bound)) bound = p.nextCursor;
      const kept = pages.map((p) => (bound === null ? p.ids : p.ids.filter((id) => id <= (bound as string))));
      const upTo = pages.map((p, i) =>
        bound === null || (p.nextCursor === null && kept[i]?.length === p.ids.length) ? null : bound,
      );
      const union = [...new Set(kept.flat())].sort();
      const docs = union.length > 0 ? await search.ownListingDetails(tx, agencyId, union, locales) : [];
      const built = buildItems(union, docs, { locales, baseLocale, mediaBase, presenter });
      const items = new Map(built.items.map((x) => [x.id, x.item]));
      const missing = new Set(built.missing);
      const out: { ready: FeedItem[]; upTo: string | null }[] = [];
      for (const [i, lane] of open.entries()) {
        const { connection, profile } = lane.planned;
        const failures: { propertyId: string; errors: PortalIssue[] }[] = [];
        const ready: FeedItem[] = [];
        for (const id of kept[i] ?? []) {
          const item = items.get(id);
          if (!item || missing.has(id)) {
            failures.push({ propertyId: id, errors: [{ code: 'NO_DOCUMENT' }] });
            continue;
          }
          const issues = validateItem(profile, item);
          if (issues.length > 0) failures.push({ propertyId: id, errors: issues });
          else ready.push(item);
        }
        // Everything this connection's selection examined for the round is `(cursor, upTo]`: rows there that no longer
        // fail go.
        const range = { after: lane.cursor, upTo: upTo[i] ?? null };
        await repo.syncIssues(tx, connection, range, failures, runStart);
        lane.invalid += failures.length;
        out.push({ ready, upTo: range.upTo });
      }
      return out;
    });

    for (const [i, lane] of open.entries()) {
      const { ready, upTo } = round[i] as { ready: FeedItem[]; upTo: string | null };
      const { profile } = lane.planned;
      try {
        for (const item of ready) {
          if (profile.format === 'kyero-v3') {
            // Validation refused everything the writer would drop: a drop here is a bug, never a silent loss.
            if (!writeKyeroProperty(lane.w, item, { maxImages: profile.maxPhotos ?? undefined })) {
              opts.log?.error(
                { connectionId: lane.planned.connection.id, ref: item.base.ref, channel: profile.code },
                'portal feed: a validated listing was dropped by the writer',
              );
              throw new PortalFeedError('WRITER_DROPPED');
            }
          } else writeGenericItem(lane.w, item);
          lane.valid++;
          // Bounded buffer: per listing, not per batch (a listing is at most a few tens of KB).
          if (lane.w.pending >= FLUSH_CHARS) await lane.sink(lane.w.take());
        }
        lane.cursor = upTo;
        if (upTo === null) {
          if (profile.format === 'kyero-v3') writeKyeroEnd(lane.w);
          else writeGenericEnd(lane.w);
          await lane.sink(lane.w.end());
          lane.done = true;
        }
      } catch (err) {
        fail(lane, err);
      }
    }
  }

  const outcomes: PlannedFeedOutcome[] = lanes.map((l) =>
    l.error !== undefined
      ? { connectionId: l.planned.connection.id, error: l.error }
      : {
          connectionId: l.planned.connection.id,
          valid: l.valid,
          invalid: l.invalid,
          version: l.planned.connection.version,
          checkedAt: runStart,
        },
  );
  if (opts.recordSummary !== false) {
    const written = outcomes.filter((o): o is Extract<PlannedFeedOutcome, { valid: number }> => 'valid' in o);
    if (written.length > 0) {
      // Only connections whose sink completed are recorded: a failed one keeps its last good totals.
      await withSystem('exports.writeFeeds record', async (tx) => {
        for (const o of written) {
          await repo.setValidationSummary(tx, agencyId, o.connectionId, {
            checkedAt: o.checkedAt,
            valid: o.valid,
            invalid: o.invalid,
          });
        }
      });
    }
  }
  for (const o of outcomes) {
    if ('valid' in o)
      opts.log?.info({ connectionId: o.connectionId, valid: o.valid, invalid: o.invalid }, 'portal feed written');
  }
  return outcomes;
}

/** Writes one connection's feed to `sink` and records each listing's check (S9-02). See the file comment. */
export async function writeConnectionFeed(
  agencyId: string,
  connectionId: string,
  opts: PortalFeedOptions,
): Promise<PortalFeedResult> {
  const plan = await planAgencyFeeds(agencyId, [connectionId]);
  const skipped = plan.skippedConnections[0]?.reason ?? plan.skipped;
  if (skipped) return { skipped };
  const [outcome] = await writePlannedFeeds(plan, new Map([[connectionId, opts.sink]]), opts);
  if (!outcome) return { skipped: 'no-connection' };
  if ('error' in outcome) throw outcome.error;
  return { valid: outcome.valid, invalid: outcome.invalid, version: outcome.version };
}
