/**
 * The match engine's inverse-index keys (R2-02b), pure. One vocabulary on both sides, so either direction is a GIN
 * `&&` probe:
 *
 * - a client profile's keys (`client_profiles.match_keys`): per transaction (its own, or `*` for any) and per place (each
 *   of its locations, or `*` for anywhere) — `a:<agency>:<tx>:<loc>` (its agency's own listings) and `n:<tx>:<loc>`
 *   (network listings);
 * - a listing's keys (`matching_listing_facts.match_keys`, and the probe of a changed listing): for its transaction and
 *   `*`, at each of its places (country, region, city, area) and `*` — `a:<owner>:…` always, `n:…` only while other
 *   agencies may see it (on the network, not hidden; its owner listed when probing).
 *
 * A key shared by both says: same agency or network, the profile's transaction (or any), one of its places (or
 * anywhere). The other criteria, the sharing scope and the agencies' network standing are checked on those candidates.
 */

/** A key part left open: any transaction, or anywhere. */
export const ANY_KEY = '*';

export function profileMatchKeys(p: {
  agencyId: string;
  transactionType: string | null;
  locationIds: readonly string[];
}): string[] {
  const tx = p.transactionType ?? ANY_KEY;
  const places = p.locationIds.length > 0 ? [...new Set(p.locationIds)] : [ANY_KEY];
  const keys: string[] = [];
  for (const loc of places) keys.push(`a:${p.agencyId}:${tx}:${loc}`, `n:${tx}:${loc}`);
  return keys.sort();
}

/** The profile's probe keys: its own-agency keys, and its network keys only while its agency takes part in the network. */
export function profileProbeKeys(
  p: { agencyId: string; transactionType: string | null; locationIds: readonly string[] },
  networkOpen: boolean,
): string[] {
  return profileMatchKeys(p).filter((k) => networkOpen || !k.startsWith('n:'));
}

export function listingMatchKeys(l: {
  ownerAgencyId: string;
  transactionType: string;
  locationIds: readonly string[];
  /** Other agencies may see it on the network. */
  network: boolean;
}): string[] {
  const keys: string[] = [];
  for (const tx of [l.transactionType, ANY_KEY]) {
    for (const loc of [...new Set(l.locationIds), ANY_KEY]) {
      keys.push(`a:${l.ownerAgencyId}:${tx}:${loc}`);
      if (l.network) keys.push(`n:${tx}:${loc}`);
    }
  }
  return keys.sort();
}

/** Place tiers below the country: region, city, area at most (`locations_depth_ck`). */
export const EVENT_KEY_TIERS = 3;

/**
 * The keys a changed listing probes profiles with (the event direction), per place: `listingMatchKeys` at its places
 * below the country (region, city, area — the first of `locationIds` is its country), never `*`. Broad profiles
 * (anywhere, or a whole country) would be most of all profiles for every listing; the profile → listings direction
 * (their change, the nightly sweep) matches them instead.
 *
 * R2-02f: the most specific place first (area, city, region), always `EVENT_KEY_TIERS` arrays (empty where the listing
 * has no such place). The event probe reads the tiers in this order and stops at its cap: in a dense market the
 * profiles that named the listing's area fill it before those of its whole city or region are read.
 */
export function listingEventKeyTiers(l: {
  ownerAgencyId: string;
  transactionType: string;
  locationIds: readonly string[];
  network: boolean;
}): string[][] {
  const places = [...new Set(l.locationIds.slice(1))].reverse().slice(0, EVENT_KEY_TIERS);
  const tiers: string[][] = [];
  for (let i = 0; i < EVENT_KEY_TIERS; i++) {
    const loc = places[i];
    const keys: string[] = [];
    if (loc !== undefined) {
      for (const tx of [l.transactionType, ANY_KEY]) {
        keys.push(`a:${l.ownerAgencyId}:${tx}:${loc}`);
        if (l.network) keys.push(`n:${tx}:${loc}`);
      }
    }
    tiers.push(keys.sort());
  }
  return tiers;
}
