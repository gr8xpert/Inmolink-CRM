/**
 * Portal selection (S9-01, PLAN §7 M7): which listings a connection sends. Pure functions over a `tx`, no
 * authorization (the service authorizes) — writers (S9-02) and the generator (S9-03, a worker under `withSystem`)
 * call them with a rule.
 *
 * The rule, for one connection of one agency:
 *   selected = ( rule matches ∪ INCLUDEd ) ∖ EXCLUDEd, among the agency's ACTIVE, PUBLIC, not deleted listings
 * where "rule matches" is every such listing (ALL_PUBLIC), those carrying the tag (TAGGED) or none (MANUAL: only the
 * INCLUDEd ones). A per-property choice never publishes anything: a listing that is not ACTIVE and PUBLIC is never
 * selected, whatever the connection says.
 *
 * The set is ordered by listing id, so it is deterministic and keyset-paged: `selectionPage` merges two id-ordered
 * streams (the rule's, the INCLUDEs; ALL_PUBLIC and MANUAL need only one) up to the shorter one's last id, so memory
 * and statements are bounded by the page size however large the agency (≤ 4 statements per page, all index-backed),
 * and every listing appears in exactly one page.
 */
import type { Tx } from '@inmolink/db';
import * as properties from '../properties';
import * as repo from './repo';

/** Default and largest page of a selection. */
export const SELECTION_BATCH = 500;
export const SELECTION_MAX_BATCH = 1000;

export interface SelectionRule {
  agencyId: string;
  connectionId: string;
  mode: repo.SelectionMode;
  /** TAGGED only. */
  tag: string | null;
}

export interface SelectionPage {
  /** Selected listing ids, ascending. May be fewer than asked (or none) while `next` continues. */
  ids: string[];
  /** The `after` of the next page; null: the selection is complete. */
  next: string | null;
}

const clamp = (limit: number) => Math.max(1, Math.min(limit, SELECTION_MAX_BATCH));

/**
 * One page of the selection after `after` (a listing id, exclusive) — see the file comment. Statements: ALL_PUBLIC
 * 2 (the page, the EXCLUDEs among it; every INCLUDE is in the page already), MANUAL 2 (the INCLUDEs, which of them are
 * exportable; an INCLUDE is never an EXCLUDE: one row per listing), TAGGED 4 (+ the INCLUDEs and which are exportable).
 * A page can be short, even empty, while `next` continues (EXCLUDEs, listings that stopped being exportable).
 *
 * Ids are compared as strings: the merge relies on lower-case canonical UUID text sorting like Postgres' `uuid`
 * order (bytewise), which holds for UUIDs as the database prints them.
 */
export async function selectionPage(
  tx: Tx,
  rule: SelectionRule,
  after: string | null,
  limit: number = SELECTION_BATCH,
): Promise<SelectionPage> {
  const size = clamp(limit);
  const { agencyId, connectionId } = rule;

  if (rule.mode === 'MANUAL') {
    const includeIds = (await repo.overrideIdPage(tx, connectionId, { action: 'INCLUDE', after, limit: size })).map(
      (r) => r.propertyId,
    );
    const eligible = new Set(await properties.exportableListingIds(tx, agencyId, includeIds));
    return {
      ids: includeIds.filter((id) => eligible.has(id)),
      next: includeIds.length === size ? (includeIds.at(-1) ?? null) : null,
    };
  }

  const base = await properties.exportableListingPage(tx, agencyId, {
    tag: rule.mode === 'TAGGED' ? rule.tag : null,
    after,
    limit: size,
  });
  const baseFull = base.length === size;
  const kept = await withoutExcluded(tx, connectionId, base);
  if (rule.mode === 'ALL_PUBLIC') return { ids: kept, next: baseFull ? (base.at(-1) ?? null) : null };

  // TAGGED: plus the INCLUDEs. Both streams are complete up to the smaller of their last ids when full; unbounded when not.
  const includeIds = (await repo.overrideIdPage(tx, connectionId, { action: 'INCLUDE', after, limit: size })).map(
    (r) => r.propertyId,
  );
  const includesFull = includeIds.length === size;
  const eligibleIncludes = new Set(await properties.exportableListingIds(tx, agencyId, includeIds));
  const bounds = [baseFull ? base.at(-1) : undefined, includesFull ? includeIds.at(-1) : undefined].filter(
    (x): x is string => x !== undefined,
  );
  const cutoff = bounds.length > 0 ? bounds.reduce((a, b) => (a < b ? a : b)) : null;
  const union = [...new Set([...kept, ...includeIds.filter((id) => eligibleIncludes.has(id))])]
    .filter((id) => cutoff === null || id <= cutoff)
    .sort();
  const ids = union.slice(0, size);
  return { ids, next: union.length > size ? (ids.at(-1) ?? null) : cutoff };
}

async function withoutExcluded(tx: Tx, connectionId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return ids;
  const excluded = new Set(
    (await repo.overridesOf(tx, connectionId, ids)).filter((o) => o.action === 'EXCLUDE').map((o) => o.propertyId),
  );
  return excluded.size === 0 ? ids : ids.filter((id) => !excluded.has(id));
}

/** Pages a batch may merge before it returns what it has (short, `next` continuing): bounds the statements per call. */
const MAX_ROUNDS = 10;

/**
 * Up to `limit` selected ids after `after`: full pages are merged until the limit is reached, the selection ends or
 * `MAX_ROUNDS` pages were read — so a batch is short only at the end, or when many EXCLUDEs / stale INCLUDEs thinned
 * the pages (then `next` is non-null: continue from it). A page that overshoots is cut at the limit and `next` is
 * the last id kept, so no listing is read twice or skipped.
 */
export async function selectionBatch(
  tx: Tx,
  rule: SelectionRule,
  after: string | null,
  limit: number = SELECTION_BATCH,
): Promise<SelectionPage> {
  const size = clamp(limit);
  const ids: string[] = [];
  let cursor = after;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const page = await selectionPage(tx, rule, cursor, size);
    const room = size - ids.length;
    if (page.ids.length > room) {
      ids.push(...page.ids.slice(0, room));
      return { ids, next: ids.at(-1) ?? null };
    }
    ids.push(...page.ids);
    cursor = page.next;
    if (cursor === null || ids.length >= size) break;
  }
  return { ids, next: cursor };
}

/**
 * Grouped selection (S10-F9, a portal pass): one page after `after` for **every** connection in `connectionIds` that
 * shares this rule (mode and tag) — the base page and the per-property choices are read once for all of them, two
 * statements per rule whatever the connection count:
 *
 * - ALL_PUBLIC: the page; the EXCLUDEs of all the connections among it.
 * - MANUAL: each connection's next `limit` INCLUDEs (one statement, a probe per connection); which of them are exportable.
 * - TAGGED: each connection's next `limit` INCLUDEs and EXCLUDEs (one statement); the tag's page together with which of
 *   the INCLUDEs are exportable (one statement). A connection's page is complete up to the smallest last id of its full
 *   streams (like `selectionPage`).
 *
 * Same sets as `selectionPage` per connection; a page may be short (or empty) while `next` continues. Ids compare as
 * lower-case canonical UUID text (see `selectionPage`).
 */
export async function groupSelectionPages(
  tx: Tx,
  agencyId: string,
  rule: Pick<SelectionRule, 'mode' | 'tag'>,
  connectionIds: readonly string[],
  after: string | null,
  limit: number = SELECTION_BATCH,
): Promise<Map<string, SelectionPage>> {
  const size = clamp(limit);
  const out = new Map<string, SelectionPage>();
  if (connectionIds.length === 0) return out;
  const ascending = (xs: string[]) => xs.sort();

  if (rule.mode === 'ALL_PUBLIC') {
    const base = await properties.exportableListingPage(tx, agencyId, { tag: null, after, limit: size });
    const next = base.length === size ? (base.at(-1) ?? null) : null;
    const excluded = new Set(
      (await repo.overridesAmong(tx, agencyId, connectionIds, base, 'EXCLUDE')).map(
        (o) => `${o.connectionId}/${o.propertyId}`,
      ),
    );
    for (const c of connectionIds) out.set(c, { ids: base.filter((id) => !excluded.has(`${c}/${id}`)), next });
    return out;
  }

  const streams = await repo.overridePages(tx, agencyId, connectionIds, {
    actions: rule.mode === 'TAGGED' ? ['INCLUDE', 'EXCLUDE'] : ['INCLUDE'],
    after,
    limit: size,
  });
  const includes = new Map<string, string[]>(connectionIds.map((c) => [c, []]));
  const excludes = new Map<string, string[]>(connectionIds.map((c) => [c, []]));
  for (const o of streams) (o.action === 'INCLUDE' ? includes : excludes).get(o.connectionId)?.push(o.propertyId);
  const includeIds = [...new Set(streams.filter((o) => o.action === 'INCLUDE').map((o) => o.propertyId))];

  if (rule.mode === 'MANUAL') {
    const eligible = new Set(await properties.exportableListingIds(tx, agencyId, includeIds));
    for (const c of connectionIds) {
      const mine = ascending(includes.get(c) ?? []);
      out.set(c, {
        ids: mine.filter((id) => eligible.has(id)),
        next: mine.length === size ? (mine.at(-1) ?? null) : null,
      });
    }
    return out;
  }

  // TAGGED
  const { page: base, eligible: eligibleIds } = await properties.exportableListingPageWith(
    tx,
    agencyId,
    { tag: rule.tag, after, limit: size },
    includeIds,
  );
  const eligible = new Set(eligibleIds);
  const baseLast = base.length === size ? base.at(-1) : undefined;
  for (const c of connectionIds) {
    const inc = ascending(includes.get(c) ?? []);
    const exc = ascending(excludes.get(c) ?? []);
    const bounds = [
      baseLast,
      inc.length === size ? inc.at(-1) : undefined,
      exc.length === size ? exc.at(-1) : undefined,
    ].filter((x): x is string => x !== undefined);
    const cutoff = bounds.length > 0 ? bounds.reduce((x, y) => (x < y ? x : y)) : null;
    const excluded = new Set(exc);
    const union = [...new Set([...base.filter((id) => !excluded.has(id)), ...inc.filter((id) => eligible.has(id))])]
      .filter((id) => cutoff === null || id <= cutoff)
      .sort();
    const ids = union.slice(0, size);
    out.set(c, { ids, next: union.length > size ? (ids.at(-1) ?? null) : cutoff });
  }
  return out;
}

/** The rule a connection row stands for. */
export const ruleOf = (c: repo.ConnectionRow): SelectionRule => ({
  agencyId: c.agencyId,
  connectionId: c.id,
  mode: c.selectionMode,
  tag: c.selectionTag,
});
