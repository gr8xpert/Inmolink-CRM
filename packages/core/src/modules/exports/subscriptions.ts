import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { subscribe } from '@inmolink/platform/outbox';
import * as agencies from '../agencies';
import * as imports from '../imports';
import * as properties from '../properties';
import * as search from '../search';
import * as websiteApi from '../website-api';
import { exportsEvents } from './events';
import {
  PORTAL_FEED_CONNECTION_THROTTLE_MS,
  PORTAL_FEED_SOON_MS,
  queueAgencyPortalFeeds,
  queueAgencyPortalPush,
  queueConnectionPortalFeed,
} from './jobs';
import { PUSH_CHANNEL_CODES } from './push/registry';
import * as repo from './repo';

let unsubscribe: (() => void)[] | undefined;

/**
 * Whether an agency has a live connection, cached per process for `LIVE_CACHE_MS` (S9-03 review): a burst of listing
 * events costs one index probe per agency and minute, not one per event. A new or revived connection queues its own
 * run (`exports.connection.changed`), which also drops the entry here.
 */
export const LIVE_CACHE_MS = 60_000;
const LIVE_CACHE_MAX = 10_000;
const liveCache = new Map<string, { live: boolean; at: number }>();

async function hasLiveConnection(agencyId: string): Promise<boolean> {
  const now = clock.now().getTime();
  const hit = liveCache.get(agencyId);
  if (hit && now - hit.at < LIVE_CACHE_MS) return hit.live;
  const live = await withSystem('exports.feed live connection', (tx) => repo.hasLiveConnection(tx, agencyId));
  if (liveCache.size >= LIVE_CACHE_MAX) liveCache.clear();
  liveCache.set(agencyId, { live, at: now });
  return live;
}

/** Tests: forgets the cached answers. */
export function resetLiveConnectionCache(): void {
  liveCache.clear();
}

/**
 * A listing change of an agency with a live portal connection: one throttled pass over its connections — unless an
 * import of the agency is running (it rewrites listings for minutes; its `imports.run.finished` queues the pass).
 */
async function agencyChanged(agencyId: string, opts: { afterImport?: boolean } = {}): Promise<void> {
  if (!(await hasLiveConnection(agencyId))) return;
  if (!opts.afterImport) {
    const importing = await withSystem('exports.feed import active', (tx) => imports.agencyImportActive(tx, agencyId));
    if (importing) return;
  }
  await queueAgencyPortalFeeds(agencyId);
}

/**
 * Outbox → portal feeds (S9-03). Exported through the worker-only entry (`./worker`); called once by the worker.
 *
 * - `search.publicDocs.changed` — the agency's own read models changed (a listing's documents, or it became or stopped
 *   being public): every live connection of the agency, throttled per agency (`queueAgencyPortalFeeds`); skipped while
 *   an import of the agency runs.
 * - `imports.run.finished` — the import is done: one pass (throttled like the rest).
 * - `properties.listing.updated` with `tags` — a TAGGED selection may have changed (tags are not in the documents).
 * - `exports.connection.changed` — the connection's setup, selection or token: its URL's edge copies are purged and
 *   it is regenerated (throttled per connection; at once for a new connection or token). A connection turned off,
 *   revoked or deleted is skipped by the run, which removes its files.
 * - `agencies.status.changed` — suspended or verified again: the edge copies of every connection of the agency are
 *   purged at once (the token lookup already refuses an unverified agency; this ends what the CDN still holds).
 *
 * Idempotent: enqueues are throttled (a redelivered event folds into the queued run) and purges are tag sets.
 */
export function registerExportsSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(search.searchEvents.publicDocsChanged, (payload) => agencyChanged(payload.agencyId), {
      name: 'exports.feed.publicDocsChanged',
    }),
    subscribe(imports.importsEvents.runFinished, (payload) => agencyChanged(payload.agencyId, { afterImport: true }), {
      name: 'exports.feed.importFinished',
    }),
    subscribe(
      properties.propertiesEvents.updated,
      async (payload) => {
        if (payload.changed.includes('tags')) await agencyChanged(payload.agencyId);
      },
      { name: 'exports.feed.listingTags' },
    ),
    subscribe(
      exportsEvents.connectionChanged,
      async (payload, meta) => {
        liveCache.delete(payload.agencyId);
        await websiteApi.queueEdgePurge(payload.agencyId, [{ kind: 'p', id: payload.connectionId }], meta.createdAt);
        const soon = payload.action === 'CREATED' || payload.action === 'TOKEN_ROTATED';
        await queueConnectionPortalFeed(
          payload.agencyId,
          payload.connectionId,
          soon ? PORTAL_FEED_SOON_MS : PORTAL_FEED_CONNECTION_THROTTLE_MS,
        );
      },
      { name: 'exports.feed.connectionChanged' },
    ),
    subscribe(
      agencies.agenciesEvents.statusChanged,
      async (payload, meta) => {
        const ids = await withSystem('exports.feed agency status', (tx) => repo.connectionIdsOf(tx, payload.agencyId));
        await websiteApi.queueEdgePurge(
          payload.agencyId,
          ids.map((id) => ({ kind: 'p' as const, id })),
          meta.createdAt,
        );
        // S9-04: a suspended agency's adverts come down while the credentials are readable; verified again, they go up.
        if (
          await withSystem('exports.feed push connections', (tx) =>
            repo.hasChannelConnection(tx, payload.agencyId, PUSH_CHANNEL_CODES),
          )
        ) {
          await queueAgencyPortalPush(payload.agencyId, undefined, { throttleMs: PORTAL_FEED_SOON_MS });
        }
      },
      { name: 'exports.feed.agencyStatus' },
    ),
  ];
}

/** Tests: removes the subscriptions again. */
export function unregisterExportsSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
