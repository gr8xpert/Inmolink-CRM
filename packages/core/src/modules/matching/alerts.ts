import type { SavedSearchAlertKind } from '@inmolink/contracts';

/**
 * Saved-search alert rules (S5-06), pure: which change of a listing alerts, and the inverse-index keys that find the
 * saved searches that could match it and may see it.
 */

/** A key part left open: any transaction type, or anywhere. */
export const ANY = '*';

/** A listing is NEW only within this long of its first read model: an old listing first seen by matching is not. */
export const NEW_LISTING_WINDOW_MS = 7 * 86_400_000;

/** The status of a listing that has no read model (withdrawn, deleted, made private, a draft again). */
export const GONE = 'GONE';

/**
 * A saved search's `match_keys` (S5-06 perf review: keys carry who may see what, so a listing probes only the searches
 * that could see it):
 * - `own:<agency>:<transaction>` (`*`: any) when it watches its agency's own listings (scope ALL or OWN) — one key; its
 *   places are checked on the few candidates of that agency;
 * - `net:<transaction>:<location>` per location (`*`: anywhere) when it watches the network (ALL or NETWORK) and its
 *   agency takes part in it (`networkOpen`: VERIFIED and give-to-get not LOCKED, re-keyed when that changes);
 * - `off:<agency>` when neither applies (a NETWORK search of an agency whose network is closed): no listing probes it.
 */
export function searchKeys(
  s: { agencyId: string; scope: string; transactionType: string | null; locationIds: readonly string[] },
  networkOpen: boolean,
): string[] {
  const tx = s.transactionType ?? ANY;
  const keys: string[] = [];
  if (s.scope !== 'NETWORK') keys.push(`own:${s.agencyId}:${tx}`);
  if (s.scope !== 'OWN' && networkOpen) {
    const locations = s.locationIds.length > 0 ? [...new Set(s.locationIds)] : [ANY];
    for (const l of locations) keys.push(`net:${tx}:${l}`);
  }
  if (keys.length === 0) keys.push(`off:${s.agencyId}`);
  return keys.sort();
}

/**
 * A listing's keys: its owner's own searches for its transaction type or any (`own:<owner>:…`, 2 keys), and — when
 * other agencies may see it (on the network, its owner listed) — the network searches for its transaction type or any,
 * at each of its places (country, region, city, area) or anywhere (`net:…`, at most 2 × 5 = 10).
 */
export function listingKeys(l: {
  ownerAgencyId: string;
  transactionType: string;
  locationIds: readonly string[];
  network: boolean;
}): string[] {
  const keys = [`own:${l.ownerAgencyId}:${l.transactionType}`, `own:${l.ownerAgencyId}:${ANY}`];
  if (l.network) {
    for (const tx of [l.transactionType, ANY]) {
      for (const loc of [...new Set(l.locationIds), ANY]) keys.push(`net:${tx}:${loc}`);
    }
  }
  return keys;
}

export interface SeenState {
  status: string;
  priceCents: number | null;
  version: number;
}

export interface CurrentListing {
  status: string;
  priceCents: number | null;
  version: number;
  /** First time the listing had a read model, epoch seconds. */
  publishedAt: number;
}

export interface Transition {
  kind: SavedSearchAlertKind;
  /** 0 for NEW (a listing is new once), else the listing version that changed. */
  dedupeKey: number;
  previousPriceCents: number | null;
}

/**
 * What the change from `seen` (the last state matching saw; undefined: never seen) to `now` (the listing's read model;
 * null: it has none) alerts, if anything. Only an ACTIVE listing alerts:
 * - never seen, and its first read model is recent (`NEW_LISTING_WINDOW_MS`) → NEW
 * - seen in another status (under offer, sold, withdrawn, gone) → BACK_ON_MARKET
 * - seen ACTIVE at a higher price → PRICE_DROP
 */
export function transitionOf(
  seen: SeenState | undefined,
  now: CurrentListing | null,
  nowMs: number,
  windowMs: number = NEW_LISTING_WINDOW_MS,
): Transition | null {
  if (now?.status !== 'ACTIVE') return null;
  if (!seen) {
    return now.publishedAt * 1000 >= nowMs - windowMs ? { kind: 'NEW', dedupeKey: 0, previousPriceCents: null } : null;
  }
  // an older state than the one already seen (a late rebuild): nothing new
  if (now.version < seen.version) return null;
  if (seen.status !== 'ACTIVE') {
    return { kind: 'BACK_ON_MARKET', dedupeKey: now.version, previousPriceCents: null };
  }
  if (seen.priceCents !== null && now.priceCents !== null && now.priceCents < seen.priceCents) {
    return { kind: 'PRICE_DROP', dedupeKey: now.version, previousPriceCents: seen.priceCents };
  }
  return null;
}
