import {
  NotificationParams,
  notificationText,
  SAVED_SEARCH_LIMITS,
  type SavedSearchAlertKind,
  SavedSearchBody,
  type SavedSearchDto,
  type SavedSearchFrequency,
  type SavedSearchList,
  type SavedSearchScope,
  type TransactionType,
} from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { type Ctx, memberUserId } from '../../context';
import * as agencies from '../agencies';
import * as notifications from '../notifications';
import * as search from '../search';
import * as taxonomy from '../taxonomy';
import { listingKeys, NEW_LISTING_WINDOW_MS, searchKeys, type Transition, transitionOf } from './alerts';
import { assertCan } from './policy';
import * as repo from './repo';

/**
 * matching use cases (S5-06, PLAN §7 M9): an agent's saved searches (request side, the member's own under RLS) and
 * their alerts (worker side, `app_system`):
 *
 * - `matchListings` (one per `search.listings.changed` event — up to 100 listings of one agency whose read models'
 *   status, price or version changed): each listing's read model is compared with the last state matching saw of it
 *   (`matching_listing_states`) — new on the market, price dropped, back on the market (`transitionOf`) — and only
 *   those few are matched against the saved searches over the inverse index (`repo.matchQuery`: the owner's own
 *   searches, and the network's only when other agencies may see the listing). One alert per saved search, listing,
 *   kind and state (`saved_search_alerts_dedupe_uq`): a redelivered event, a retried job or a second rebuild of the
 *   same change alerts nobody twice. Another agency's search alerts only while that agency takes part in the network
 *   (listed, give-to-get not LOCKED — network search's gate) and the listing's owner is listed.
 * - `sendAlerts` (per agency): the waiting alerts, re-checked against the listings' current visibility and the
 *   agency's standing, as one `SAVED_SEARCH_ALERT` notification per member — INSTANT searches within
 *   `INSTANT_WINDOW_MS` of the first alert (a short digest), DAILY ones once a day. The notifications module does the
 *   rest: the bell, the live push and the e-mail summary.
 * - `rekeyAgency`: an agency's searches' keys follow its network standing (`net:` keys only while it takes part).
 */

/** Where an alert opens: the member's saved searches. */
export const SAVED_SEARCHES_LINK = '/network/saved-searches';

/* ------------------------------------------------------------------ saved searches (requests) */

function toDto(r: repo.SavedSearchRow): SavedSearchDto {
  const alerts: SavedSearchAlertKind[] = [];
  if (r.alertNew) alerts.push('NEW');
  if (r.alertPriceDrop) alerts.push('PRICE_DROP');
  if (r.alertBackOnMarket) alerts.push('BACK_ON_MARKET');
  return {
    id: r.id,
    name: r.name,
    scope: r.scope as SavedSearchScope,
    frequency: r.frequency as SavedSearchFrequency,
    alerts,
    transactionType: r.transactionType as TransactionType | null,
    propertyTypeIds: r.propertyTypeIds,
    locationIds: r.locationIds,
    featureIds: r.featureIds,
    priceMinCents: r.priceMinCents,
    priceMaxCents: r.priceMaxCents,
    bedsMin: r.bedsMin,
    bathsMin: r.bathsMin,
    areaMinM2: r.areaMinM2 === null ? null : Number(r.areaMinM2),
    areaMaxM2: r.areaMaxM2 === null ? null : Number(r.areaMaxM2),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const unique = <T>(xs: readonly T[] | undefined): T[] => [...new Set(xs ?? [])];

/**
 * The saved search's columns from the body. A search over the network (scope ALL or NETWORK) follows network search's
 * rules: a verified agency only (`VERIFICATION_REQUIRED`), and not while its give-to-get gate is LOCKED
 * (`NETWORK_GIVE_TO_GET_LOCKED`, with the gate) — the agency may still watch its own listings (scope OWN).
 */
async function fieldsOf(ctx: Ctx, raw: SavedSearchBody): Promise<repo.SavedSearchFields> {
  const s = SavedSearchBody.parse(raw);
  if (s.scope !== 'OWN') {
    agencies.assertVerified(ctx, 'network.search');
    const gate = await search.networkGate(ctx);
    if (gate.state === 'LOCKED') throw new AppError('NETWORK_GIVE_TO_GET_LOCKED', { gate });
  }
  const locationIds = unique(s.locationIds);
  if (locationIds.length > 0) {
    const lines = await taxonomy.locationLineages(ctx.tx, locationIds);
    if (locationIds.some((id) => !lines.has(id))) {
      throw new AppError('VALIDATION_FAILED', { field: 'locationIds', reason: 'unknown' });
    }
  }
  const transactionType = s.transactionType ?? null;
  return {
    name: s.name,
    scope: s.scope,
    frequency: s.frequency,
    alertNew: s.alerts.includes('NEW'),
    alertPriceDrop: s.alerts.includes('PRICE_DROP'),
    alertBackOnMarket: s.alerts.includes('BACK_ON_MARKET'),
    transactionType,
    propertyTypeIds: unique(s.propertyTypeIds),
    locationIds,
    featureIds: unique(s.featureIds),
    priceMinCents: s.priceMinCents ?? null,
    priceMaxCents: s.priceMaxCents ?? null,
    bedsMin: s.bedsMin ?? null,
    bathsMin: s.bathsMin ?? null,
    areaMinM2: s.areaMinM2 ?? null,
    areaMaxM2: s.areaMaxM2 ?? null,
    // a network scope got here only for a verified agency whose gate is open
    matchKeys: searchKeys(
      { agencyId: ctx.tenant.agencyId, scope: s.scope, transactionType, locationIds },
      s.scope !== 'OWN',
    ),
  };
}

/** `GET /v1/saved-searches`: the caller's own, oldest first (one query; at most `perUser`, so no cursor). */
export async function listSavedSearches(ctx: Ctx): Promise<SavedSearchList> {
  assertCan(ctx, 'matching.savedSearches.manage');
  const rows = await repo.savedSearchesOf(ctx.tx, ctx.tenant.agencyId, memberUserId(ctx), SAVED_SEARCH_LIMITS.perUser);
  return { items: rows.map(toDto) };
}

/** `POST /v1/saved-searches`: at most `perUser` per member (`SAVED_SEARCH_LIMIT`). */
export async function createSavedSearch(ctx: Ctx, raw: SavedSearchBody): Promise<SavedSearchDto> {
  assertCan(ctx, 'matching.savedSearches.manage');
  const fields = await fieldsOf(ctx, raw);
  const row = await repo.insertSavedSearch(ctx.tx, {
    ...fields,
    agencyId: ctx.tenant.agencyId,
    id: newId(),
    userId: memberUserId(ctx),
    max: SAVED_SEARCH_LIMITS.perUser,
  });
  if (!row) throw new AppError('SAVED_SEARCH_LIMIT', { max: SAVED_SEARCH_LIMITS.perUser });
  return toDto(row);
}

/** `PUT /v1/saved-searches/:id`: the caller's saved search, every field replaced. */
export async function updateSavedSearch(ctx: Ctx, id: string, raw: SavedSearchBody): Promise<SavedSearchDto> {
  assertCan(ctx, 'matching.savedSearches.manage');
  const row = await repo.updateSavedSearch(
    ctx.tx,
    ctx.tenant.agencyId,
    memberUserId(ctx),
    id,
    await fieldsOf(ctx, raw),
  );
  if (!row) throw new AppError('SAVED_SEARCH_NOT_FOUND');
  return toDto(row);
}

/** `DELETE /v1/saved-searches/:id` (its alerts go with it). */
export async function deleteSavedSearch(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, 'matching.savedSearches.manage');
  if (!(await repo.deleteSavedSearch(ctx.tx, ctx.tenant.agencyId, memberUserId(ctx), id))) {
    throw new AppError('SAVED_SEARCH_NOT_FOUND');
  }
}

/* ------------------------------------------------------------------ network standing (worker) */

/**
 * Of these agencies, those taking part in the network now: listed (VERIFIED) and give-to-get not LOCKED. Three
 * statements (listed, standings, shared counts) for any number; none when `ids` is empty.
 */
async function networkOpenAmong(tx: Tx, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const listed = await agencies.listedAgencyNamesOf(tx, unique);
  const gates = await search.networkGatesOf(
    tx,
    unique.filter((id) => listed.has(id)),
  );
  return new Set([...gates].filter(([, g]) => g.state !== 'LOCKED').map(([id]) => id));
}

/** May the members of `agencyId` see this listing in network search now (its owner listed: `ownerListed`)? */
function sharedWith(doc: search.ListingIndexDoc, agencyId: string, ownerListed: boolean): boolean {
  if (!ownerListed || doc.networkHidden) return false;
  return doc.shareScope === 'ALL' || doc.preferredAgencyIds.includes(agencyId);
}

/* ------------------------------------------------------------------ alerts (worker) */

export interface MatchResult {
  /** Listings that changed in a way that alerts (new, price drop, back on market). */
  transitions: number;
  /** Alerts written now (deduplicated), waiting to be sent. */
  alerts: number;
  /** The agencies of those alerts (their `sendAlerts` is queued). */
  agencies: string[];
}

/**
 * `matching.matchListings` (worker): one `search.listings.changed` event's listings against the saved searches — one
 * short transaction, about a dozen statements whatever the batch (read models, states, owners' standing, candidate
 * pages, other agencies' standing, alerts, states). `nowMs` for tests.
 */
export async function matchListings(
  input: { agencyId: string; listingIds: readonly string[] },
  options: { nowMs?: number; newWindowMs?: number } = {},
): Promise<MatchResult> {
  const nowMs = options.nowMs ?? clock.nowMs();
  const ids = [...new Set(input.listingIds)];
  return withSystem(`matching.matchListings: agency ${input.agencyId}`, async (tx) => {
    const { docs, missing } = await search.indexDocsFor(tx, ids, { text: false });
    const listings = docs.filter((d) => d.kind === 'LISTING');
    const seen = await repo.statesFor(tx, ids);

    const changed: { doc: search.ListingIndexDoc; t: Transition }[] = [];
    for (const doc of listings) {
      const t = transitionOf(seen.get(doc.id), doc, nowMs, options.newWindowMs ?? NEW_LISTING_WINDOW_MS);
      if (t) changed.push({ doc, t });
    }

    let written = { written: 0, agencies: [] as string[] };
    if (changed.length > 0) {
      // other agencies see a listing only while its owner is listed (network search's rule)
      const listedOwners = await agencies.listedAgencyNamesOf(tx, [
        ...new Set(changed.map((c) => c.doc.ownerAgencyId)),
      ]);
      const probes: repo.ListingProbe[] = changed.map(({ doc, t }) => {
        const network = listedOwners.has(doc.ownerAgencyId) && !doc.networkHidden;
        return {
          listingId: doc.id,
          ownerAgencyId: doc.ownerAgencyId,
          kind: t.kind,
          keys: listingKeys({ ...doc, network }),
          transactionType: doc.transactionType,
          locationIds: doc.locationIds,
          propertyTypeId: doc.propertyTypeId,
          featureIds: doc.featureIds,
          priceCents: doc.priceOnRequest ? null : doc.priceCents,
          beds: doc.beds,
          baths: doc.baths,
          areaM2: doc.areaM2,
          network,
          shareAll: doc.shareScope === 'ALL',
          preferredAgencyIds: doc.preferredAgencyIds,
        };
      });
      const byId = new Map(changed.map((c) => [c.doc.id, c]));
      const candidates = await repo.matchCandidates(tx, probes);
      // another agency's search alerts only while that agency takes part in the network (listed, gate not LOCKED)
      const open = await networkOpenAmong(
        tx,
        candidates.filter((c) => c.agencyId !== byId.get(c.listingId)?.doc.ownerAgencyId).map((c) => c.agencyId),
      );
      const rows: repo.NewAlert[] = candidates.flatMap((c) => {
        const hit = byId.get(c.listingId);
        if (!hit || (c.agencyId !== hit.doc.ownerAgencyId && !open.has(c.agencyId))) return [];
        return [
          {
            id: newId(),
            agencyId: c.agencyId,
            userId: c.userId,
            savedSearchId: c.savedSearchId,
            listingId: c.listingId,
            kind: hit.t.kind,
            dedupeKey: hit.t.dedupeKey,
            ref: hit.doc.ref,
            priceCents: hit.doc.priceOnRequest ? null : hit.doc.priceCents,
            previousPriceCents: hit.t.previousPriceCents,
          },
        ];
      });
      written = await repo.insertAlerts(tx, rows, ALERT_DAILY_CAP);
    }

    await repo.upsertStates(
      tx,
      listings.map((d) => ({
        listingId: d.id,
        agencyId: d.ownerAgencyId,
        status: d.status,
        priceCents: d.priceOnRequest ? null : d.priceCents,
        version: d.version,
      })),
    );
    await repo.markGone(tx, missing);
    return { transitions: changed.length, alerts: written.written, agencies: written.agencies };
  });
}

/** INSTANT alerts wait this long after the agency's first one, then go out together (one notification per member). */
export const INSTANT_WINDOW_MS = 5 * 60_000;
/** Alerts claimed per send transaction (an agency with more is sent over several). */
export const SEND_CLAIM = 2_000;

const safe = (params: Record<string, string | number>) =>
  NotificationParams.safeParse(params).success ? params : { ...params, subject: '', refs: '' };

/**
 * One member's notification of their alerts: one alert names its kind, several are counted (`DIGEST`); the saved
 * searches' names and up to 10 references.
 */
function alertParams(names: readonly string[], kinds: readonly string[], refs: readonly string[]) {
  const listed = refs.slice(0, SAVED_SEARCH_LIMITS.refsPerNotification).join(', ');
  const more = refs.length - SAVED_SEARCH_LIMITS.refsPerNotification;
  return safe({
    subject: notificationText([...new Set(names)].join(', ')),
    kind: refs.length === 1 ? (kinds[0] ?? 'DIGEST') : 'DIGEST',
    count: refs.length,
    refs: notificationText(more > 0 ? `${listed} +${more}` : listed),
  });
}

/**
 * `matching.sendAlerts` (worker, per agency): the agency's alerts waiting to be sent of saved searches with this
 * frequency (`INSTANT` also claims those of searches turned OFF meanwhile, and drops them), claimed and marked sent —
 * re-checked first: the listing still ACTIVE, and for another agency's listing still shared with this agency, its
 * owner listed and this agency still taking part in the network (listed, gate not LOCKED). What remains becomes one
 * `SAVED_SEARCH_ALERT` notification per member, in one transaction per `SEND_CLAIM` alerts. `more`: alerts are left.
 */
export async function sendAlerts(
  agencyId: string,
  frequency: 'INSTANT' | 'DAILY',
): Promise<{ notified: number; dropped: number; more: boolean }> {
  return withSystem(`matching.sendAlerts: agency ${agencyId}`, async (tx) => {
    const claimed = await repo.claimPending(
      tx,
      agencyId,
      frequency === 'INSTANT' ? ['INSTANT', 'OFF'] : ['DAILY'],
      SEND_CLAIM,
    );
    const live = claimed.filter((a) => a.frequency !== 'OFF');
    const { docs } = await search.indexDocsFor(tx, [...new Set(live.map((a) => a.listingId))], { text: false });
    const docOf = new Map(docs.map((d) => [d.id, d]));
    const owners = [...new Set(docs.map((d) => d.ownerAgencyId).filter((o) => o !== agencyId))];
    const listed = owners.length > 0 ? await agencies.listedAgencyNamesOf(tx, owners) : new Map<string, string>();
    const open = owners.length > 0 ? await networkOpenAmong(tx, [agencyId]) : new Set<string>();
    const visible = live.filter((a) => {
      const doc = docOf.get(a.listingId);
      if (doc?.kind !== 'LISTING' || doc.status !== 'ACTIVE') return false;
      if (doc.ownerAgencyId === agencyId) return a.scope !== 'NETWORK';
      return a.scope !== 'OWN' && open.has(agencyId) && sharedWith(doc, agencyId, listed.has(doc.ownerAgencyId));
    });
    const byUser = new Map<string, { names: string[]; kinds: string[]; refs: string[] }>();
    for (const a of visible) {
      const g = byUser.get(a.userId) ?? { names: [], kinds: [], refs: [] };
      g.names.push(a.name);
      g.kinds.push(a.kind);
      g.refs.push(a.ref);
      byUser.set(a.userId, g);
    }
    let notified = 0;
    if (byUser.size > 0) {
      const raised = await notifications.raiseNotificationsAcross(
        tx,
        'SAVED_SEARCH_ALERT',
        [...byUser].map(([userId, g]) => ({
          agencyId,
          userIds: [userId],
          params: alertParams(g.names, g.kinds, g.refs),
          link: SAVED_SEARCHES_LINK,
        })),
      );
      notified = raised.notified.length;
    }
    return { notified, dropped: claimed.length - visible.length, more: claimed.length === SEND_CLAIM };
  });
}

/** Agencies queued per statement of the sweeps. */
export const SWEEP_PAGE = 500;

/** A page of agencies with alerts waiting to be sent (keyset by agency id); `olderThan`: only older alerts. */
export function pendingAlertAgencies(
  after: string | null,
  olderThan: Date | null = null,
  limit: number = SWEEP_PAGE,
): Promise<string[]> {
  return withSystem('matching.sweepAlerts', (tx) => repo.pendingAgencies(tx, after, limit, olderThan));
}

/* ------------------------------------------------------------------ keys, backfill, prune (worker) */

/**
 * `matching.rekeyAgency` (worker): the agency's saved searches' keys rewritten for its network standing now —
 * `net:` keys only while it takes part in the network (listed, give-to-get not LOCKED) — and from any older key
 * format. One transaction; answers how many changed.
 */
export async function rekeyAgency(agencyId: string): Promise<{ searches: number; changed: number; open: boolean }> {
  return withSystem(`matching.rekeyAgency: agency ${agencyId}`, async (tx) => {
    const searches = await repo.searchesOfAgency(tx, agencyId);
    if (searches.length === 0) return { searches: 0, changed: 0, open: false };
    const open = (await networkOpenAmong(tx, [agencyId])).has(agencyId);
    const changed = await repo.setMatchKeys(
      tx,
      searches.map((s) => ({ id: s.id, keys: searchKeys(s, open) })),
    );
    return { searches: searches.length, changed, open };
  });
}

/** A page of agencies with saved searches (keyset by agency id), for the daily re-key sweep. */
export function savedSearchAgencies(after: string | null, limit: number = SWEEP_PAGE): Promise<string[]> {
  return withSystem('matching.sweepRekey', (tx) => repo.agenciesWithSearches(tx, after, limit));
}

/** Listing states written per backfill transaction. */
export const BACKFILL_BATCH = 5_000;

/**
 * `matching.backfillListingStates` (worker, once after deploy): the state of every listing with a read model that
 * matching has not seen yet, `BACKFILL_BATCH` per transaction (keyset on the listing id) — so the first change of an
 * existing listing after deploy is told apart (a price drop, back on the market). Answers where to go on (null: done).
 */
export async function backfillListingStates(
  after: string | null,
  limit: number = BACKFILL_BATCH,
): Promise<{ inserted: number; next: string | null }> {
  return withSystem('matching.backfillListingStates', async (tx) => {
    const page = await search.listingAlertStatesPage(tx, after, limit);
    const inserted = await repo.insertMissingStates(
      tx,
      page.map((p) => ({
        listingId: p.targetId,
        agencyId: p.agencyId,
        status: p.status,
        priceCents: p.priceCents,
        version: p.version,
      })),
    );
    return { inserted, next: page.length < limit ? null : (page.at(-1)?.targetId ?? null) };
  });
}

/** Alerts are kept this long (the dedupe of NEW keeps working: a listing is new once, within its first week). */
export const ALERT_RETENTION_DAYS = 90;
/** States of listings gone this long are dropped (a return later counts as new). */
export const GONE_RETENTION_DAYS = 180;
export const PRUNE_BATCH = 5_000;
/**
 * S13-F9: at most this many alerts per saved search in 24 hours (a broad search meeting a bulk import would otherwise
 * write — and digest — thousands); the rest of the day's matches for it are not alerted.
 */
export const ALERT_DAILY_CAP = 50;

/** The daily prune: old alerts and long-gone listing states, `PRUNE_BATCH` rows per statement. */
export async function pruneMatching(nowMs: number = clock.nowMs()): Promise<{ alerts: number; states: number }> {
  const day = 86_400_000;
  let alerts = 0;
  let states = 0;
  for (;;) {
    const n = await withSystem('matching.prune', (tx) =>
      repo.pruneAlerts(tx, new Date(nowMs - ALERT_RETENTION_DAYS * day), PRUNE_BATCH),
    );
    alerts += n;
    if (n < PRUNE_BATCH) break;
  }
  for (;;) {
    const n = await withSystem('matching.prune', (tx) =>
      repo.pruneGoneStates(tx, new Date(nowMs - GONE_RETENTION_DAYS * day), PRUNE_BATCH),
    );
    states += n;
    if (n < PRUNE_BATCH) break;
  }
  return { alerts, states };
}
