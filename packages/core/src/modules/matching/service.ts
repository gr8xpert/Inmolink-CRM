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
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { type Ctx, memberUserId as userIdOf } from '../../context';
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
 * - `matchListings` (one per `search.listings.changed` event — the read models of up to 100 listings of one agency were
 *   written or dropped): each listing's read model is compared with the last state matching saw of it
 *   (`matching_listing_states`) — new on the market, price dropped, back on the market (`transitionOf`) — and only
 *   those few are matched against the saved searches, in one statement over the inverse index (`repo.matchQuery`). One
 *   alert per saved search, listing, kind and state (`saved_search_alerts_dedupe_uq`): a redelivered event, a retried
 *   job or a second rebuild of the same change alerts nobody twice. INSTANT searches' alerts are notified in the same
 *   transaction (`SAVED_SEARCH_ALERT`, one notification per saved search and kind, naming up to 10 references); DAILY
 *   ones wait for `sendDigest`. The notifications module does the rest: the bell, the live push and the e-mail summary.
 * - `sendDigest` (daily, per agency): one notification per saved search with what it matched since.
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

async function fieldsOf(ctx: Ctx, raw: SavedSearchBody): Promise<repo.SavedSearchFields> {
  const s = SavedSearchBody.parse(raw);
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
    matchKeys: searchKeys({ transactionType, locationIds }),
  };
}

/** `GET /v1/saved-searches`: the caller's own, oldest first (one query). */
export async function listSavedSearches(ctx: Ctx): Promise<SavedSearchList> {
  assertCan(ctx, 'matching.savedSearches.manage');
  const rows = await repo.savedSearchesOf(ctx.tx, ctx.tenant.agencyId, userIdOf(ctx), SAVED_SEARCH_LIMITS.perUser);
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
    userId: userIdOf(ctx),
    max: SAVED_SEARCH_LIMITS.perUser,
  });
  if (!row) throw new AppError('SAVED_SEARCH_LIMIT', { max: SAVED_SEARCH_LIMITS.perUser });
  return toDto(row);
}

/** `PUT /v1/saved-searches/:id`: the caller's saved search, every field replaced. */
export async function updateSavedSearch(ctx: Ctx, id: string, raw: SavedSearchBody): Promise<SavedSearchDto> {
  assertCan(ctx, 'matching.savedSearches.manage');
  const row = await repo.updateSavedSearch(ctx.tx, ctx.tenant.agencyId, userIdOf(ctx), id, await fieldsOf(ctx, raw));
  if (!row) throw new AppError('SAVED_SEARCH_NOT_FOUND');
  return toDto(row);
}

/** `DELETE /v1/saved-searches/:id` (its alerts go with it). */
export async function deleteSavedSearch(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, 'matching.savedSearches.manage');
  if (!(await repo.deleteSavedSearch(ctx.tx, ctx.tenant.agencyId, userIdOf(ctx), id))) {
    throw new AppError('SAVED_SEARCH_NOT_FOUND');
  }
}

/* ------------------------------------------------------------------ alerts (worker) */

export interface MatchResult {
  /** Listings that changed in a way that alerts (new, price drop, back on market). */
  transitions: number;
  /** Alerts written now (deduplicated). */
  alerts: number;
  /** Notifications raised now (INSTANT searches). */
  notified: number;
}

const safe = (params: Record<string, string | number>) =>
  NotificationParams.safeParse(params).success ? params : { ...params, subject: '', refs: '' };

/** The notification of `alerts` (one saved search, one kind or the digest): count, name and up to 10 references. */
function alertParams(name: string, kind: SavedSearchAlertKind | 'DIGEST', refs: readonly string[]) {
  const listed = refs.slice(0, SAVED_SEARCH_LIMITS.refsPerNotification).join(', ');
  const more = refs.length - SAVED_SEARCH_LIMITS.refsPerNotification;
  return safe({
    subject: notificationText(name),
    kind,
    count: refs.length,
    refs: notificationText(more > 0 ? `${listed} +${more}` : listed),
  });
}

/**
 * `matching.matchListings` (worker): one `search.listings.changed` event's listings against the saved searches — one
 * short transaction, about ten statements whatever the batch (read models, states, candidates, listed agencies,
 * alerts, notifications, states). `nowMs` for tests.
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

    let alerts = 0;
    let notified = 0;
    if (changed.length > 0) {
      const probes: repo.ListingProbe[] = changed.map(({ doc, t }) => ({
        listingId: doc.id,
        ownerAgencyId: doc.ownerAgencyId,
        kind: t.kind,
        keys: listingKeys(doc),
        propertyTypeId: doc.propertyTypeId,
        featureIds: doc.featureIds,
        priceCents: doc.priceOnRequest ? null : doc.priceCents,
        beds: doc.beds,
        baths: doc.baths,
        areaM2: doc.areaM2,
        network: !doc.networkHidden,
        shareAll: doc.shareScope === 'ALL',
        preferredAgencyIds: doc.preferredAgencyIds,
      }));
      const byId = new Map(changed.map((c) => [c.doc.id, c]));
      const candidates = await repo.matchCandidates(tx, probes);
      // another agency's search alerts only while that agency takes part in the network (listed: VERIFIED)
      const others = [...new Set(candidates.map((c) => c.agencyId).filter((a) => a !== input.agencyId))];
      const listed = await agencies.listedAgencyNamesOf(tx, others);
      const matched = candidates.filter((c) => {
        const owner = byId.get(c.listingId)?.doc.ownerAgencyId;
        return c.agencyId === owner || listed.has(c.agencyId);
      });
      const pairs = matched.flatMap((c) => {
        const hit = byId.get(c.listingId);
        if (!hit) return [];
        const row: repo.NewAlert = {
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
          notified: c.frequency === 'INSTANT',
        };
        return [{ c, row, kind: hit.t.kind }];
      });
      const written = await repo.insertAlerts(
        tx,
        pairs.map((p) => p.row),
      );
      alerts = written.size;

      // INSTANT: one notification per saved search and kind, for the alerts written now only
      const groups = new Map<string, { c: repo.Candidate; kind: SavedSearchAlertKind; refs: string[] }>();
      for (const { c, row, kind } of pairs) {
        if (!written.has(row.id) || !row.notified) continue;
        const key = `${row.savedSearchId}:${kind}`;
        const g = groups.get(key) ?? { c, kind, refs: [] };
        g.refs.push(row.ref);
        groups.set(key, g);
      }
      if (groups.size > 0) {
        const raised = await notifications.raiseNotificationsAcross(
          tx,
          'SAVED_SEARCH_ALERT',
          [...groups.values()].map((g) => ({
            agencyId: g.c.agencyId,
            userIds: [g.c.userId],
            params: alertParams(g.c.name, g.kind, g.refs),
            link: SAVED_SEARCHES_LINK,
          })),
        );
        notified = raised.notified.length;
      }
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
    return { transitions: changed.length, alerts, notified };
  });
}

/** Alerts claimed per digest transaction (an agency with more is digested over several). */
export const DIGEST_CLAIM = 2_000;
/** Agencies queued per statement of the daily sweep. */
export const DIGEST_SWEEP_PAGE = 500;
/** Alerts are kept this long (the dedupe of NEW keeps working: a listing is new once, within its first week). */
export const ALERT_RETENTION_DAYS = 90;
/** States of listings gone this long are dropped (a return later counts as new). */
export const GONE_RETENTION_DAYS = 180;
export const PRUNE_BATCH = 5_000;

/**
 * `matching.sendDigest` (worker, per agency): the agency's alerts waiting for their digest (DAILY searches), claimed
 * and marked notified, become one `SAVED_SEARCH_ALERT` notification per saved search (`kind` DIGEST: how many, and up
 * to 10 references) — in one transaction per `DIGEST_CLAIM` alerts. A search turned OFF meanwhile is skipped. `more`:
 * alerts are left, run again.
 */
export async function sendDigest(agencyId: string): Promise<{ notified: number; more: boolean }> {
  return withSystem(`matching.sendDigest: agency ${agencyId}`, async (tx) => {
    const claimed = await repo.claimPending(tx, agencyId, DIGEST_CLAIM);
    const groups = new Map<string, { userId: string; name: string; refs: string[] }>();
    for (const a of claimed) {
      if (a.frequency === 'OFF') continue;
      const g = groups.get(a.savedSearchId) ?? { userId: a.userId, name: a.name, refs: [] };
      g.refs.push(a.ref);
      groups.set(a.savedSearchId, g);
    }
    let notified = 0;
    if (groups.size > 0) {
      const raised = await notifications.raiseNotificationsAcross(
        tx,
        'SAVED_SEARCH_ALERT',
        [...groups.values()].map((g) => ({
          agencyId,
          userIds: [g.userId],
          params: alertParams(g.name, 'DIGEST', g.refs),
          link: SAVED_SEARCHES_LINK,
        })),
      );
      notified = raised.notified.length;
    }
    return { notified, more: claimed.length === DIGEST_CLAIM };
  });
}

/** The daily sweep's page of agencies with alerts waiting for their digest (keyset by agency id). */
export function digestAgencies(after: string | null, limit: number = DIGEST_SWEEP_PAGE): Promise<string[]> {
  return withSystem('matching.sweepDigests', (tx) => repo.pendingAgencies(tx, after, limit));
}

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
