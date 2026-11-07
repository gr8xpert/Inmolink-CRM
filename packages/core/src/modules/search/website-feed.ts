/**
 * Website API v2 reads (S7-03, PLAN §9.1): what the site-facing endpoints read from the search module's tables —
 * public documents in a site's language, a site reference's detail, sitemap pages and the public change log — each in
 * one statement, inside the caller's public read (`withPublicRead`, `app_public`). The site's inventory is always the
 * server-side `PublicSearchSite` (the site's policy), never the visitor's. White-labelling is the websites
 * serializer's: these rows still carry the owner (a filter and the serializer's input, never shown).
 */
import type { Tx } from '@inmolink/db';
import { withPublicRead, withSystem } from '@inmolink/db';
import { cache, cacheKey } from '@inmolink/platform/cache';
import { AppError } from '@inmolink/platform/errors';
import type { Filter } from '@inmolink/platform/search';
import { metrics } from '@opentelemetry/api';
import { attributeFilters } from './filters';
import { giveToGetSettings } from './network';
import * as repo from './repo';
import { clusterRuleOf, developmentRefMatch, type PublicSearchSite, refFilter, siteInventoryFilter } from './website';

export type { ChangeLogRow, DevelopmentRow, DevelopmentUnitsPage, PublicDocRow } from './repo';
export { siteInventoryFilter } from './website';

/** Change-log rows are kept this long; an older cursor or `since` must start again from the sitemap. */
export const PUBLIC_CHANGES_RETENTION_DAYS = 30;
/** Rows one prune run deletes per statement (database rules: batches ≤ 5,000). */
export const PUBLIC_CHANGES_PRUNE_BATCH = 5_000;

/**
 * Public documents of these targets in the best locale, with owner, public code and duplicate cluster (hydration of
 * selections and PDFs: they pick one member per cluster themselves, `oneMemberPerCluster`).
 */
export function publicDocs(
  tx: Tx,
  ids: readonly string[],
  part: 'card' | 'detail' | 'portal',
  locale: string,
  fallback: string,
): Promise<repo.PublicDocRow[]> {
  return repo.publicDocs(tx, ids, part, locale, fallback);
}

/**
 * Website search hydration (R2-03c): `publicDocs` of a page of this site's search, without the members of duplicate
 * clusters the site does not show (`clusterRuleOf`: the engine's pages hold every member; the fallback's hold one
 * already). Same statement: the cluster probe runs only for clustered documents.
 */
export function publicSiteDocs(
  tx: Tx,
  site: PublicSearchSite,
  ids: readonly string[],
  part: 'card' | 'detail' | 'portal',
  locale: string,
  fallback: string,
): Promise<repo.PublicDocRow[]> {
  return repo.publicDocs(tx, ids, part, locale, fallback, clusterRuleOf(site));
}

/**
 * R2-03c: of these documents (one client-facing list: a selection, a portfolio), the ones to leave out so that no two
 * members of one duplicate cluster show — per cluster the presenting agency's own member first, then the canonical
 * rank. Pure.
 */
export function oneMemberPerCluster(
  rows: readonly Pick<repo.PublicDocRow, 'targetId' | 'ownerAgencyId' | 'clusterId' | 'clusterRank'>[],
  presenterAgencyId: string,
): Set<string> {
  const best = new Map<string, { id: string; own: boolean; rank: number }>();
  const hidden = new Set<string>();
  for (const r of rows) {
    if (!r.clusterId) continue;
    const me = { id: r.targetId, own: r.ownerAgencyId === presenterAgencyId, rank: r.clusterRank ?? 0 };
    const cur = best.get(r.clusterId);
    if (!cur) {
      best.set(r.clusterId, me);
      continue;
    }
    const better = me.own !== cur.own ? me.own : me.rank < cur.rank;
    if (better) {
      hidden.add(cur.id);
      best.set(r.clusterId, me);
    } else if (me.id !== cur.id) hidden.add(me.id);
  }
  return hidden;
}

/**
 * The detail a reference names on this site (`/v2/listings/{ref}`): an own document by its own reference, a network
 * one only by `<prefix>-<code>` (`refFilter`), among the site's inventory. Null: no such document here.
 */
export async function publicDetailByRef(
  tx: Tx,
  site: PublicSearchSite,
  ref: string,
  locale: string,
  fallback: string,
): Promise<repo.PublicDocRow | null> {
  const byRef = refFilter(site, ref);
  if (byRef === null) return null;
  return repo.publicDetailWhere(tx, { op: 'and', filters: [siteInventoryFilter(site), byRef] }, locale, fallback);
}

/**
 * The detail a public code names among this inventory (S15-01: the portal's listing pages name a listing by its code,
 * unique across agencies — an owner's own reference is not). Null: no such document here. One statement
 * (`listing_search_docs_public_code_idx`).
 */
export async function publicDetailByCode(
  tx: Tx,
  site: PublicSearchSite,
  code: string,
  locale: string,
  fallback: string,
): Promise<repo.PublicDocRow | null> {
  return repo.publicDetailWhere(
    tx,
    { op: 'and', filters: [siteInventoryFilter(site), { op: 'eq', field: 'publicCode', value: code }] },
    locale,
    fallback,
  );
}

/**
 * One sitemap page of the site's inventory in public-code order (`limit + 1` rows: the extra one means more follow):
 * the site's own documents and the network's as two keyset walks (an agency's own by `(owner, code)`).
 */
export function sitemapPage(
  tx: Tx,
  site: PublicSearchSite,
  q: { after?: string; limit: number; locale: string; fallback: string; part?: 'card' | 'none' | 'sitemap' | 'portal' },
): Promise<repo.PublicDocRow[]> {
  return repo.sitemapPage(tx, {
    filter: siteInventoryFilter(site),
    own: site.ownerAgencyIds ?? [],
    network: site.ownerAgencyIds === null || site.networkOf !== undefined,
    // R2-03c: one member per duplicate cluster (sitemaps, the site's XML feed)
    cluster: clusterRuleOf(site),
    ...q,
  });
}

/**
 * S15-02: one page of the portal's sitemap walk — every PUBLIC coded document of the inventory's kind in public-code
 * order after `after` (one ordered keyset walk on `listing_search_docs_public_code_idx`, `limit` rows), the owner
 * scope (listed agencies, or every owner but the unlisted ones) applied to the page here: the owner filter in the
 * query let the planner pick the per-owner index and a top-N sort over all the listed owners' rows on every page
 * (S15-02 review: ~quadratic), and the walk is kept on the ordered index (`preferOrderedWalk`). Each row carries what
 * a portal listing URL is made of (kind, type, place). Two statements (the planner setting, the page); call it in its
 * own transaction. `next`: the cursor (the last scanned code), null after the last page.
 */
export async function portalSitemapPage(
  tx: Tx,
  site: PublicSearchSite,
  q: { after?: string; limit: number; locale: string; fallback: string },
): Promise<{ rows: repo.PublicDocRow[]; next: string | null }> {
  const everyOwner: PublicSearchSite = { ...site, ownerAgencyIds: null, excludeOwnerAgencyIds: undefined };
  await repo.preferOrderedWalk(tx);
  // R2-03c: one member per duplicate cluster, as the portal (its listed owners) shows them
  const walked = await repo.portalSitemapWalk(tx, {
    filter: siteInventoryFilter(everyOwner),
    cluster: clusterRuleOf(site),
    ...q,
  });
  const show = site.ownerAgencyIds ? new Set(site.ownerAgencyIds) : null;
  const hide = new Set(site.excludeOwnerAgencyIds ?? []);
  const rows = walked.rows.filter((r) => (show ? show.has(r.ownerAgencyId) : !hide.has(r.ownerAgencyId)));
  return { rows, next: walked.more && walked.last ? walked.last : null };
}

// ── Developments (S7-F6) ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The site's new-build unit filter: its units in the statuses a site shows (AVAILABLE, RESERVED) — PUBLIC units only,
 * so units of OPEN developments, never PRIVATE_NETWORK ones — with the site's unit-level rules (types, price band,
 * minimum commission). A development is on the site when one of its units matches.
 */
function unitFilter(site: PublicSearchSite): Filter {
  return { op: 'and', filters: [siteInventoryFilter(site), ...attributeFilters({ kind: 'UNIT' })] };
}

/** The site's development-level rules: whose developments, anywhere under its and the visitor's locations. */
function developmentScope(site: PublicSearchSite, locationIds?: readonly string[]): repo.DevelopmentScope {
  const sets: (readonly string[])[] = [];
  const restricted = site.restrict?.locationIds;
  if (restricted && restricted.length > 0) sets.push(restricted);
  if (locationIds && locationIds.length > 0) sets.push(locationIds);
  return { own: site.ownerAgencyIds, network: site.networkOf !== undefined, locationSets: sets };
}

/**
 * One page of the site's developments, newest first, after the development coded `after` (`limit + 1` rows: the extra
 * one means more follow). One statement over the development rows.
 */
export function developmentPage(
  tx: Tx,
  site: PublicSearchSite,
  q: { after?: string; limit: number; locale: string; fallback: string; locationIds?: readonly string[] },
): Promise<repo.DevelopmentRow[]> {
  const { locationIds, ...page } = q;
  return repo.developmentPage(tx, {
    filter: unitFilter(site),
    scope: developmentScope(site, locationIds),
    ...page,
  });
}

/**
 * The development a site reference names (an own development's own reference, another agency's `<prefix>-<code>`),
 * as this site shows it (detail document); null: not on this site.
 */
export function developmentByRef(
  tx: Tx,
  site: PublicSearchSite,
  ref: string,
  locale: string,
  fallback: string,
): Promise<repo.DevelopmentRow | null> {
  return repo.developmentByRef(tx, {
    filter: unitFilter(site),
    scope: developmentScope(site),
    ref: developmentRefMatch(site, ref),
    locale,
    fallback,
  });
}

/**
 * The development a public code names among this inventory (S15-01: the portal's development pages name a development
 * by its code, unique across agencies — a developer's own reference is not), detail document; null: not shown. One
 * statement.
 */
export function developmentByCode(
  tx: Tx,
  site: PublicSearchSite,
  code: string,
  locale: string,
  fallback: string,
): Promise<repo.DevelopmentRow | null> {
  return repo.developmentByRef(tx, {
    filter: unitFilter(site),
    // By code, whoever owns it (a code is unique): the unit filter keeps it to the inventory's owners.
    scope: { ...developmentScope(site), own: null },
    ref: { ownRef: null, code },
    locale,
    fallback,
  });
}

/** `developmentUnitsPage` by the development's public code (S15-01, the portal). One statement. */
export function developmentUnitsByCode(
  tx: Tx,
  site: PublicSearchSite,
  q: { code: string; after?: string; limit: number; locale: string; fallback: string },
): Promise<repo.DevelopmentUnitsPage> {
  const { code, ...page } = q;
  return repo.developmentUnitsPage(tx, {
    filter: unitFilter(site),
    // By code, whoever owns it (a code is unique): the unit filter keeps it to the inventory's owners.
    scope: { ...developmentScope(site), own: null },
    ref: { ownRef: null, code },
    ...page,
  });
}

/** One page of a development's units on this site, in the developer's order (`limit + 1` rows). One statement. */
export function developmentUnitsPage(
  tx: Tx,
  site: PublicSearchSite,
  q: { ref: string; after?: string; limit: number; locale: string; fallback: string },
): Promise<repo.DevelopmentUnitsPage> {
  const { ref, ...page } = q;
  return repo.developmentUnitsPage(tx, {
    filter: unitFilter(site),
    scope: developmentScope(site),
    ref: developmentRefMatch(site, ref),
    ...page,
  });
}

export type ChangePosition = repo.ChangePosition;
export type ChangeAudience = repo.ChangeAudience;

/** A change-log row as a site sees it: shown now (`present`), or gone from the site. */
export interface SiteChange extends repo.ChangeLogRow {
  present: boolean;
}

/**
 * How far before the first change at or after `since` a feed starts looking (S7-03 review): longer than any
 * read-model transaction waits before its first write (worker statements time out after 60 s).
 */
export const PUBLIC_CHANGES_SINCE_MARGIN_SECONDS = 300;

const meter = metrics.getMeter('@inmolink/core');
const held = meter.createGauge('inmolink.website.changes.held_seconds', {
  description: 'Seconds the oldest committed website change has waited behind a still-open transaction',
});

/**
 * One page of the public change log for a site (S7-03 `/v2/changes`): after `after` (a cursor), or from `since`.
 * `audience`: the site's agency's own rows, or (network sites) also other agencies' rows of targets shared with it
 * before or after the change. Every row once, in commit-safe order (`publicChangesPage`); each says whether the
 * target is in the site's inventory now. Two statements (three from `since`).
 */
export async function siteChanges(
  tx: Tx,
  site: PublicSearchSite,
  q: { after?: repo.ChangePosition; since?: Date; audience: repo.ChangeAudience; limit: number },
): Promise<{ rows: SiteChange[]; position: repo.ChangePosition }> {
  const after =
    q.after ?? (q.since ? await repo.publicChangesStart(tx, q.since, PUBLIC_CHANGES_SINCE_MARGIN_SECONDS) : undefined);
  if (!after) throw new AppError('VALIDATION_FAILED', { field: 'since' });
  const page = await repo.publicChangesPage(tx, { after, audience: q.audience, limit: q.limit });
  // Alert `WebsiteChangesHeld`: a long transaction holds every site's feed back (it loses nothing).
  held.record(page.heldSeconds);
  // R2-03c: a member of a duplicate cluster the site does not show is not present (the site drops it)
  const present = await repo.matchingTargets(
    tx,
    siteInventoryFilter(site),
    page.rows.map((r) => r.targetId),
    clusterRuleOf(site),
  );
  const last = page.rows[page.rows.length - 1];
  return {
    rows: page.rows.map((r) => ({ ...r, present: present.has(r.targetId) })),
    position: last ? { tx: last.tx, seq: last.seq } : after,
  };
}

/** Removes change-log rows past retention, `PUBLIC_CHANGES_PRUNE_BATCH` per transaction, up to `maxBatches`. */
export async function prunePublicChanges(now: Date, maxBatches = 20): Promise<number> {
  const before = new Date(now.getTime() - PUBLIC_CHANGES_RETENTION_DAYS * 86_400_000);
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await withSystem('search.prunePublicChanges', (tx) =>
      repo.prunePublicChanges(tx, before, PUBLIC_CHANGES_PRUNE_BATCH),
    );
    total += n;
    if (n < PUBLIC_CHANGES_PRUNE_BATCH) break;
  }
  return total;
}

/** How long an agency's website network standing is kept (as long as its site's cached scope, S7-01). */
export const NETWORK_GATE_CACHE = { TTL_SECONDS: 45, LOCAL_TTL_SECONDS: 15 } as const;

/**
 * May the agency's websites show network listings (S7-01 Decision 2: give-to-get, PLAN §3 #5)? Exempt, within its
 * grace period, or sharing at least the threshold with the whole network — the network search's rule, answered by
 * `website_network_open` (feed-api reads neither agencies nor listings). Cached like the site's scope: a change of
 * standing reaches websites within a minute.
 */
export async function websiteNetworkOpen(agencyId: string): Promise<boolean> {
  const { minShared, graceDays } = giveToGetSettings();
  const key = cacheKey({ v: 1, module: 'search', entity: 'site-network-gate', scope: { agencyId } });
  return cache.get(
    key,
    { ttlSeconds: NETWORK_GATE_CACHE.TTL_SECONDS, localTtlSeconds: NETWORK_GATE_CACHE.LOCAL_TTL_SECONDS, local: true },
    () => withPublicRead((tx) => repo.websiteNetworkOpen(tx, agencyId, minShared, graceDays)),
  );
}
