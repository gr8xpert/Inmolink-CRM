/**
 * Per-site XML feeds (S7-07, PLAN §9.5): generation (worker) and serving (feed-api).
 *
 * **Generation** (`generateSiteFeed`, job `websiteApi.generateSiteFeed`, pool `exports`): the site's whole inventory
 * through the website API's own read path — `siteForKey` (policy, give-to-get), the sitemap keyset over the site's
 * inventory (`search.sitemapPage`, public-code order: never a raw join), public read models per locale
 * (`search.publicDocs`) and the website serializer (`serializeDetailsFor`: white-label, overrides), each document
 * checked against the strict `WebsiteDetail` contract — in batches of `SITE_FEED_BATCH`, each in its own short
 * `app_public` transaction. Both documents stream through the escaping writer into gzip and from gzip straight into a
 * multipart upload (`storage().upload`, the `feeds` bucket, `site-feeds/<site>/<run>/`): memory holds one batch, the
 * writer's 64 K buffer and one 8 MiB upload part per file — never a whole file. The run is recorded only if no later
 * run was recorded first, then the previous run's files are deleted. Running twice writes the same content again:
 * idempotent.
 *
 * **Serving** (`siteFeedFile`): the token's live feed (one statement), the site's cached scope (its agency must be
 * verified, like API keys), the strong ETag (the file's SHA-256) — a 304 needs no storage read; otherwise the stored
 * object is streamed, never buffered — or, with the edge cache off, the poll is redirected to a short-lived signed
 * storage URL (S8-F1). Feeds are exempt from the 150 KB JSON budget of website answers: a whole inventory, gzip.
 */
import { WebsiteDetail } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import type { Logger } from '@inmolink/platform/logger';
import { storage } from '@inmolink/platform/storage';
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
import { GzipObjectUpload, type StoredFeedFile, storedFeedFile } from '../../stored-feed';
import * as search from '../search';
import * as websites from '../websites';
import { edgeTag, edgeTagsConfigured } from './edge';
import { serializeDetailsFor, siteForKey } from './service';
import { assertSiteServes } from './settings';

/** Items per batch (one sitemap page, then one read-model statement — and one view statement — per site locale). */
export const SITE_FEED_BATCH = 200;
/** A feed file's compressed size cap (a run over it fails for good: `TOO_LARGE`). */
export const SITE_FEED_MAX_GZIP_BYTES = 64 * 1024 * 1024;
/** Edge lifetime of a feed file (s-maxage and stale-while-revalidate, seconds): consumers poll hourly at most. */
export const SITE_FEED_TTL = 900;
/**
 * How long the CDN may serve a feed while the origin errors (seconds). Short (S7-07 review): a revoked or rotated
 * token's copy must not outlive a failed purge by a day, as the API's 24 h would allow.
 */
export const SITE_FEED_STALE_IF_ERROR = 300;
/** A live feed is regenerated at least this often (network listings, overrides: no per-site event names them). */
export const SITE_FEED_MAX_AGE_MS = 6 * 3_600_000;
/** Runs of `websiteApi.generateSiteFeed` before it gives up (the last failure is recorded on the feed). */
export const SITE_FEED_ATTEMPTS = 3;

export const SITE_FEED_FILES = {
  'kyero.xml': { object: 'kyero.xml.gz', sha: 'kyeroSha256' },
  'inmolink.xml': { object: 'inmolink.xml.gz', sha: 'genericSha256' },
} as const;
export type SiteFeedFileName = keyof typeof SITE_FEED_FILES;

export const siteFeedPrefix = (siteId: string) => `site-feeds/${siteId}/`;
export const siteFeedObjectKey = (siteId: string, runId: string, file: SiteFeedFileName) =>
  `${siteFeedPrefix(siteId)}${runId}/${SITE_FEED_FILES[file].object}`;

/** A run failed for good (no retry helps): its error code is recorded on the feed. */
export class SiteFeedError extends Error {
  constructor(readonly code: 'TOO_LARGE') {
    super(`site feed: ${code}`);
    this.name = 'SiteFeedError';
  }
}

/** Flush the writer into its upload once it holds this many characters. */
const FLUSH_CHARS = 64 * 1024;

async function flush(w: XmlWriter, sink: GzipObjectUpload): Promise<void> {
  if (w.pending >= FLUSH_CHARS) await sink.write(w.take());
}

export interface SiteFeedRunResult {
  skipped?: 'no-feed' | 'not-verified' | 'superseded';
  runId?: string;
  items?: number;
  kyero?: number;
  /** Documents left out because they failed the contract (logged by target id). */
  invalid?: number;
  bytes?: { kyero: number; generic: number };
}

type Site = Awaited<ReturnType<typeof siteForKey>>;

/**
 * One batch of the site's inventory as feed items: the sitemap page after `after`, its details in every site locale
 * (own text only per locale), serialized as the site shows them and checked against the contract — a document that
 * fails it is left out (`invalid`), never the whole feed. `next`: the cursor, null after the last page.
 */
async function batch(
  site: Site,
  inventory: websites.SiteSearchScope,
  baseLocale: string,
  after: string | undefined,
  invalid: (targetId: string, locale: string) => void,
): Promise<{ items: FeedItem[]; next: string | null }> {
  const { defaultLocale, locales } = site.scope;
  return search.withSiteRead(inventory, async (tx) => {
    // Codes and ids only: the documents come per locale below.
    const rows = await search.sitemapPage(tx, inventory, {
      after,
      limit: SITE_FEED_BATCH,
      locale: baseLocale,
      fallback: defaultLocale,
      part: 'none',
    });
    const page = rows.slice(0, SITE_FEED_BATCH);
    const ids = page.map((r) => r.targetId);
    const base = new Map<string, WebsiteDetail>();
    const own = new Map<string, Map<string, WebsiteDetail>>();
    const updated = new Map<string, Date>();
    for (const locale of [baseLocale, ...locales.filter((l) => l !== baseLocale)]) {
      const fallback = locale === baseLocale ? defaultLocale : baseLocale;
      const docs = await search.publicDocs(tx, ids, 'detail', locale, fallback);
      const shown = await serializeDetailsFor(tx, site, locale, docs);
      const texts = new Map<string, WebsiteDetail>();
      shown.forEach(({ row, detail: raw, overridden }) => {
        // The strict contract is the white-label safety net, as for every API answer (`sendSiteJson`).
        const checked = WebsiteDetail.safeParse(raw);
        if (!checked.success) {
          invalid(row.targetId, locale);
          return;
        }
        const detail = checked.data;
        if (locale === baseLocale) {
          base.set(row.targetId, detail);
          updated.set(row.targetId, row.updatedAt);
        }
        // A language's text only where the listing has its own text in it (not another language's fallback), or the
        // site agency wrote its own in it (an override).
        if (overridden || (row.locale === locale && detail.textLocale === null)) texts.set(row.targetId, detail);
      });
      own.set(locale, texts);
    }
    const items: FeedItem[] = [];
    for (const id of ids) {
      const detail = base.get(id);
      // Withdrawn between the page and its documents, or failed the contract: left out.
      if (!detail) continue;
      const texts = new Map<string, WebsiteDetail>();
      for (const locale of locales) {
        const t = own.get(locale)?.get(id);
        if (t) texts.set(locale, t);
      }
      items.push({ base: detail, texts, updatedAt: updated.get(id) ?? new Date(0) });
    }
    const last = page[page.length - 1];
    return { items, next: rows.length > SITE_FEED_BATCH && last?.publicCode ? last.publicCode : null };
  });
}

/**
 * Generates the site's feed files and records the run (worker). Skipped when the site has no live feed or its agency
 * is not verified (feed-api refuses those anyway).
 */
export async function generateSiteFeed(
  siteId: string,
  opts: { signal?: AbortSignal; log?: Logger; progress?: (items: number) => Promise<void> } = {},
): Promise<SiteFeedRunResult> {
  const live = await withSystem('websiteApi.generateSiteFeed feed', (tx) => websites.liveSiteFeed(tx, siteId));
  if (!live) return { skipped: 'no-feed' };
  const site = await siteForKey({ agencyId: live.agencyId, siteId }, `site-feed:${siteId}`);
  if (!site.scope.verified) return { skipped: 'not-verified' };
  const startedAt = clock.now();
  const runId = newId();
  const baseLocale = site.scope.locales.includes('en') ? 'en' : site.scope.defaultLocale;
  // Object storage: streamed, outside any transaction (CLAUDE.md rule 6; each batch's read is its own).
  const store = storage();
  const sink = (file: SiteFeedFileName) =>
    new GzipObjectUpload(
      store.upload('feeds', siteFeedObjectKey(siteId, runId, file), { contentType: 'application/gzip' }),
      {
        // The ETag is the stored file's own hash.
        hash: 'gzip',
        maxBytes: SITE_FEED_MAX_GZIP_BYTES,
        tooLarge: () => new SiteFeedError('TOO_LARGE'),
      },
    );
  const kyero = { w: new XmlWriter(), sink: sink('kyero.xml') };
  const generic = { w: new XmlWriter(), sink: sink('inmolink.xml') };
  let items = 0;
  let kyeroItems = 0;
  let invalid = 0;
  const onInvalid = (targetId: string, locale: string) => {
    invalid++;
    opts.log?.warn({ siteId, targetId, locale }, 'site feed: document failed the website contract, left out');
  };
  let files: { kyero: { sha256: string; bytes: number }; generic: { sha256: string; bytes: number } };
  try {
    writeKyeroStart(kyero.w);
    writeGenericStart(generic.w, {
      generatedAt: startedAt,
      siteName: site.scope.name,
      locales: site.scope.locales,
      agency: site.scope.presenter,
    });
    const inventory = site.inventory;
    let after: string | undefined;
    while (inventory) {
      opts.signal?.throwIfAborted();
      const page = await batch(site, inventory, baseLocale, after, onInvalid);
      for (const item of page.items) {
        writeGenericItem(generic.w, item);
        if (writeKyeroProperty(kyero.w, item)) kyeroItems++;
        items++;
      }
      await flush(kyero.w, kyero.sink);
      await flush(generic.w, generic.sink);
      await opts.progress?.(items);
      if (page.next === null) break;
      after = page.next;
    }
    writeKyeroEnd(kyero.w);
    writeGenericEnd(generic.w);
    await kyero.sink.write(kyero.w.end());
    await generic.sink.write(generic.w.end());
    files = { kyero: await kyero.sink.finish(), generic: await generic.sink.finish() };
  } catch (err) {
    await kyero.sink.abort();
    await generic.sink.abort();
    // A file that completed before the other failed is this run's only: never served.
    await deleteRun(siteId, runId, opts.log);
    throw err;
  }
  const recorded = await withSystem('websiteApi.generateSiteFeed record', (tx) =>
    websites.recordFeedRun(tx, {
      siteId,
      runId,
      startedAt,
      generatedAt: clock.now(),
      itemCount: items,
      kyeroCount: kyeroItems,
      kyeroSha256: files.kyero.sha256,
      genericSha256: files.generic.sha256,
    }),
  );
  // The files no longer served: this run's when a later one won (or the feed was revoked), else the previous run's.
  const stale = recorded.recorded ? recorded.previousRunId : runId;
  if (stale) await deleteRun(siteId, stale, opts.log);
  if (!recorded.recorded) return { skipped: 'superseded', runId };
  opts.log?.info({ siteId, runId, items, kyero: kyeroItems, invalid }, 'site feed generated');
  return {
    runId,
    items,
    kyero: kyeroItems,
    invalid,
    bytes: { kyero: files.kyero.bytes, generic: files.generic.bytes },
  };
}

async function deleteRun(siteId: string, runId: string, log?: Logger): Promise<void> {
  for (const file of Object.keys(SITE_FEED_FILES) as SiteFeedFileName[]) {
    try {
      await storage().delete('feeds', siteFeedObjectKey(siteId, runId, file));
    } catch (err) {
      // An orphan run folder is harmless (never served); the revoke sweep removes the site's folder.
      log?.warn({ siteId, runId, err: err instanceof Error ? err.name : 'error' }, 'old site feed files not deleted');
    }
  }
}

/**
 * Deletes every stored file of a site's feed (a revoked feed, S7-07 review) unless it is live again by now (a new
 * token after the revocation). Pages through the site's prefix.
 */
export async function deleteSiteFeedFiles(siteId: string, log?: Logger): Promise<number> {
  const live = await withSystem('websiteApi.deleteSiteFeedFiles', (tx) => websites.liveSiteFeed(tx, siteId));
  if (live) return 0;
  let deleted = 0;
  let after: string | undefined;
  for (;;) {
    const page = await storage().list('feeds', siteFeedPrefix(siteId), { limit: 1_000, after });
    for (const o of page.objects) {
      await storage().delete('feeds', o.key);
      deleted++;
    }
    if (!page.next) break;
    after = page.next;
  }
  if (deleted > 0) log?.info({ siteId, deleted }, 'revoked site feed files deleted');
  return deleted;
}

/** Records why a run failed (worker), as an error code. */
export async function recordSiteFeedFailure(siteId: string, err: unknown): Promise<void> {
  const code = err instanceof SiteFeedError ? err.code : 'GENERATION_FAILED';
  await withSystem('websiteApi.generateSiteFeed failure', (tx) => websites.recordFeedFailure(tx, siteId, code));
}

// ── Serving (feed-api) ──────────────────────────────────────────────────────────────────────────────────────────

/** A feed file as feed-api answers it (`open` / `signedUrl`: the stored object, `storedFeedFile`). */
export interface SiteFeedFile extends StoredFeedFile {
  siteId: string;
  /** Strong ETag: the stored file's SHA-256. */
  etag: string;
  /** The `Cache-Tag`s of the answer (site and feed), or null before boot configured the tags. */
  tags: string[] | null;
}

/**
 * The feed file a token URL names (feed-api, `app_public`): the live feed of that token (unknown, rotated or revoked
 * → `SITE_FEED_NOT_FOUND`, the same answer as for a site whose agency is not verified or a feed not generated yet).
 * One statement, plus the site's scope on a cache miss.
 */
export async function siteFeedFile(token: string, file: SiteFeedFileName): Promise<SiteFeedFile> {
  const feed = await websites.feedByToken(token);
  if (!feed?.runId) throw new AppError('SITE_FEED_NOT_FOUND');
  const scope = await websites.siteScope(feed.siteId);
  if (scope.agencyId !== feed.agencyId || !scope.verified) throw new AppError('SITE_FEED_NOT_FOUND');
  // S13-F21: past the site's plan cut-off the feed answers 402 like the website API (while plans are enforced).
  assertSiteServes(scope, clock.now());
  const sha = feed[SITE_FEED_FILES[file].sha];
  if (!sha) throw new AppError('SITE_FEED_NOT_FOUND');
  return {
    siteId: feed.siteId,
    etag: `"${sha}"`,
    tags: edgeTagsConfigured() ? [edgeTag('s', feed.siteId), edgeTag('f', feed.siteId)] : null,
    ...storedFeedFile(
      siteFeedObjectKey(feed.siteId, feed.runId, file),
      SITE_FEED_MAX_GZIP_BYTES,
      'SITE_FEED_NOT_FOUND',
    ),
  };
}
