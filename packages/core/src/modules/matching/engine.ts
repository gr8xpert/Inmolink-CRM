import { type Tx, withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import * as agencies from '../agencies';
import * as search from '../search';
import * as taxonomy from '../taxonomy';
import { type AffinitySummary, boostOf } from './boost';
import { explainMatch, MATCH_MIN_TOTAL, passesHardFilters, scoreMatch } from './explain';
import { listingEventKeys, listingMatchKeys, profileProbeKeys } from './match-keys';
import * as repo from './repo';
import { networkOpenAmong, sharedWith } from './service';

/**
 * The client-profile match engine (R2-02b, PLAN §7 M9, §3 #23), worker-only (`app_system`). Two directions over one key
 * vocabulary (`match-keys.ts`), both index-driven:
 *
 * - **listing → profiles** (`matchListingsToProfiles`, one `search.listings.changed` batch): the listings' read models
 *   (`search.indexDocsFor`, rule 9) refresh `matching_listing_facts` (ACTIVE listings only; others are dropped), then
 *   each live listing probes `client_profiles_match_keys_idx` for the active profiles that could see it;
 * - **profile → listings** (`matchProfilesToListings`: a profile's change, and the nightly sweep's windows): each
 *   active profile probes `matching_listing_facts_match_keys_idx` for the newest live listings it could see.
 *
 * Then, in both: the hard filters (with their two tolerances, `explain.ts`) → the semantic score (cosine of the
 * profile's and the listing's vectors when both exist, same model; else neutral) → the learned boost (R2-02c,
 * `boost.ts`: the profile's likes and dismissals, its summary read once per batch) → the total (≥ `MATCH_MIN_TOTAL`), at
 * most `MATCH_TOP_N` a profile a run → the structured explanation, written once per profile and listing ever
 * (`client_profile_matches_pair_uq`): `PENDING_REVIEW` for REVIEW profiles, `QUEUED` for AUTO_SEND ones (R2-02e
 * sends; nothing is sent here). OFF profiles are never read.
 *
 * Visibility: a profile sees its own agency's listings, and another agency's only when network search would show it to
 * the profile's agency — the listing on the network (not hidden) and shared with it (scope ALL, or the agency is
 * preferred), its owner listed, and the profile's agency taking part in the network (listed, give-to-get not LOCKED:
 * `networkOpenAmong`, the saved-search alerts' rule). PRIVATE listings have no read model, so no facts.
 */

/** Matches written per profile and run at most (the best totals first). */
export const MATCH_TOP_N = 20;
/** Profiles per sweep window (one transaction). */
export const MATCH_SWEEP_WINDOW = 100;
/** Listings per facts backfill transaction. */
export const FACTS_BACKFILL_BATCH = 500;

export interface EngineResult {
  /** Candidate pairs the SQL hard filters returned. */
  candidates: number;
  /** Matches written now (never a pair matched before). */
  matched: number;
  /** The profiles' agencies that got matches (R2-02d/e's queues). */
  agencies: string[];
  /** R2-02e: the AUTO_SEND profiles that got `QUEUED` matches now, with their agency (INSTANT delivery). */
  queued: { agencyId: string; profileId: string }[];
}

const NONE: EngineResult = { candidates: 0, matched: 0, agencies: [], queued: [] };

/**
 * Scores and explains the candidates (the learned boost from each profile's affinity summary, none: 0); keeps those
 * over the threshold, `MATCH_TOP_N` a profile, as new rows.
 */
export function decideMatches(
  candidates: readonly repo.MatchCandidateRow[],
  options: { topN?: number; affinities?: ReadonlyMap<string, AffinitySummary> } = {},
): repo.NewMatch[] {
  const topN = options.topN ?? MATCH_TOP_N;
  const byProfile = new Map<string, Map<string, repo.NewMatch>>();
  for (const c of candidates) {
    const hard = explainMatch(c.profile, c.listing);
    if (!passesHardFilters(hard)) continue;
    const boost = boostOf(options.affinities?.get(c.profile.id), c.listing);
    const explanation = boost.reason ? { ...hard, boost: boost.reason } : hard;
    const s = scoreMatch(explanation, c.similarity, boost.value);
    if (s.total < MATCH_MIN_TOTAL) continue;
    const mine = byProfile.get(c.profile.id) ?? new Map<string, repo.NewMatch>();
    if (mine.has(c.listing.listingId)) continue;
    mine.set(c.listing.listingId, {
      id: newId(),
      agencyId: c.profile.agencyId,
      profileId: c.profile.id,
      listingId: c.listing.listingId,
      listingAgencyId: c.listing.agencyId,
      listingVersion: c.listing.version,
      profileVersion: c.profile.version,
      hardScore: s.hard,
      semanticScore: s.semantic,
      boostScore: s.boost,
      totalScore: s.total,
      explanation,
      status: c.profile.mode === 'AUTO_SEND' ? 'QUEUED' : 'PENDING_REVIEW',
    });
    byProfile.set(c.profile.id, mine);
  }
  const order = (a: repo.NewMatch, b: repo.NewMatch) =>
    b.totalScore - a.totalScore || (a.listingId < b.listingId ? 1 : a.listingId > b.listingId ? -1 : 0);
  return [...byProfile.values()].flatMap((mine) => [...mine.values()].sort(order).slice(0, topN));
}

/**
 * The rows another agency's listing would reach, re-checked against the listing's current read model (S5-06's
 * `sharedWith`: on the network, not hidden, shared with the profile's agency, its owner listed): the facts are written
 * on `search.listings.changed`, which a sharing-only change (an agency dropped from the preferred list) does not
 * raise. Own listings pass. Statements: the survivors' read models and their owners' standing (none without any).
 */
async function stillShared(tx: Tx, rows: readonly repo.NewMatch[]): Promise<repo.NewMatch[]> {
  const cross = [...new Set(rows.filter((r) => r.listingAgencyId !== r.agencyId).map((r) => r.listingId))];
  if (cross.length === 0) return [...rows];
  const { docs } = await search.indexDocsFor(tx, cross, { text: false });
  const byId = new Map(docs.filter(live).map((d) => [d.id, d]));
  const listed = await agencies.listedAgencyNamesOf(tx, [...new Set([...byId.values()].map((d) => d.ownerAgencyId))]);
  return rows.filter((r) => {
    if (r.listingAgencyId === r.agencyId) return true;
    const doc = byId.get(r.listingId);
    return doc !== undefined && sharedWith(doc, r.agencyId, listed.has(doc.ownerAgencyId));
  });
}

async function write(
  tx: Tx,
  candidates: readonly repo.MatchCandidateRow[],
  options: { recheck?: boolean } = {},
): Promise<EngineResult> {
  // R2-02c: the affinity summaries of the profiles with a candidate past the hard filters (one statement a batch)
  const passing = candidates.filter((c) => passesHardFilters(explainMatch(c.profile, c.listing)));
  const affinities = await repo.affinitiesOf(
    tx,
    passing.map((c) => c.profile.id),
  );
  const decided = decideMatches(passing, { affinities });
  const rows = options.recheck ? await stillShared(tx, decided) : decided;
  const written = await repo.insertMatches(tx, rows);
  return {
    candidates: candidates.length,
    matched: written.reduce((s, w) => s + w.n, 0),
    agencies: written.map((w) => w.agencyId),
    queued: written.flatMap((w) => w.queued.map((profileId) => ({ agencyId: w.agencyId, profileId }))),
  };
}

function factsOf(doc: search.ListingIndexDoc): repo.ListingFactsRow {
  return {
    listingId: doc.id,
    agencyId: doc.ownerAgencyId,
    version: doc.version,
    transactionType: doc.transactionType,
    propertyTypeId: doc.propertyTypeId,
    locationIds: doc.locationIds,
    featureIds: doc.featureIds,
    priceCents: doc.priceOnRequest ? null : doc.priceCents,
    beds: doc.beds,
    baths: doc.baths,
    areaM2: doc.areaM2,
    shareScope: doc.shareScope,
    preferredAgencyIds: doc.preferredAgencyIds,
    // stored keys: network keys while not hidden (owner listed and sharing are re-checked when a profile reads them)
    matchKeys: listingMatchKeys({ ...doc, network: !doc.networkHidden }),
  };
}

/** ACTIVE listings with a read model: what the engine offers. */
const live = (d: search.ListingIndexDoc) => d.kind === 'LISTING' && d.status === 'ACTIVE';

/** Refreshes these listings' facts from their read models (one transaction's work); answers the live docs. */
async function refreshFacts(tx: Tx, ids: readonly string[]): Promise<search.ListingIndexDoc[]> {
  const { docs } = await search.indexDocsFor(tx, ids, { text: false });
  const liveDocs = docs.filter(live);
  const liveIds = new Set(liveDocs.map((d) => d.id));
  await repo.upsertListingFacts(tx, liveDocs.map(factsOf));
  await repo.deleteListingFacts(
    tx,
    ids.filter((id) => !liveIds.has(id)),
  );
  return liveDocs;
}

/**
 * `matching.matchListingsToProfiles` (worker): one `search.listings.changed` event's listings (≤ 100, one agency) —
 * their facts refreshed (a transaction of its own: the facts' row locks are not held while matching), then matched
 * against every agency's active profiles that may see them, over the listing's places below the country
 * (`listingEventKeys`: broad profiles — anywhere, or a whole country — are left to the sweep). Statements: read models
 * (+ commission), facts (2); owners listed, vectors, a candidate statement per `LISTING_PROBE_CHUNK` listings,
 * standings of the profiles' agencies (≤ 3), the profiles' affinity summaries (R2-02c), the inserts.
 */
export async function matchListingsToProfiles(input: {
  agencyId: string;
  listingIds: readonly string[];
}): Promise<EngineResult> {
  const ids = [...new Set(input.listingIds)];
  const docs = await withSystem(`matching.refreshListingFacts: agency ${input.agencyId}`, (tx) =>
    refreshFacts(tx, ids),
  );
  if (docs.length === 0) return NONE;
  return withSystem(`matching.matchListingsToProfiles: agency ${input.agencyId}`, async (tx) => {
    const listed = await agencies.listedAgencyNamesOf(tx, [...new Set(docs.map((d) => d.ownerAgencyId))]);
    const vectors = await search.listingVectors(
      tx,
      docs.map((d) => d.id),
    );
    const probes: repo.ListingMatchProbe[] = docs.flatMap((d) => {
      const { matchKeys: _stored, ...facts } = factsOf(d);
      const network = listed.has(d.ownerAgencyId) && !d.networkHidden;
      const keys = listingEventKeys({ ...d, network });
      const v = vectors.get(d.id);
      return keys.length === 0 ? [] : [{ ...facts, keys, network, vector: v?.vector ?? null, model: v?.model ?? null }];
    });
    const candidates = await repo.listingToProfiles(tx, probes);
    // another agency's profile only while that agency takes part in the network (listed, give-to-get not LOCKED)
    const open = await networkOpenAmong(
      tx,
      candidates.filter((c) => c.profile.agencyId !== c.listing.agencyId).map((c) => c.profile.agencyId),
    );
    return write(
      tx,
      candidates.filter((c) => c.profile.agencyId === c.listing.agencyId || open.has(c.profile.agencyId)),
    );
  });
}

/** A broad profile: no place, or only countries (roots: no ancestor). */
const isBroad = (p: repo.MatchProfileRow, ancestors: Map<string, Set<string>>) =>
  p.locationIds.length === 0 || p.locationIds.every((id) => (ancestors.get(id)?.size ?? 0) === 0);

/**
 * `matching.matchProfilesToListings` (worker): these profiles of one agency (a `matching.clientProfiles.changed` event,
 * or a sweep window: `since`, only facts written since then) against the live listings they may see —
 * `LISTINGS_PER_PROFILE` newest candidates each; broad profiles read the `BROAD_WINDOW` most recently written facts.
 * One transaction; statements: profiles, the agency's standing (≤ 3), the places' levels, a candidate statement per
 * `PROFILE_PROBE_CHUNK` profiles of each kind, owners listed, profile vectors, one similarity statement (none while
 * embeddings are off), the affinity summaries (R2-02c), the survivors' sharing re-check (≤ 3), the inserts.
 */
export async function matchProfilesToListings(
  input: { agencyId: string; profileIds: readonly string[] },
  options: { since?: Date | null } = {},
): Promise<EngineResult> {
  const ids = [...new Set(input.profileIds)];
  return withSystem(`matching.matchProfilesToListings: agency ${input.agencyId}`, async (tx) => {
    const profiles = await repo.activeMatchProfiles(tx, input.agencyId, ids);
    if (profiles.length === 0) return NONE;
    const open = (await networkOpenAmong(tx, [input.agencyId])).has(input.agencyId);
    const ancestors = await taxonomy.locationAncestors(tx, [...new Set(profiles.flatMap((p) => p.locationIds))]);
    const probes = profiles.map((p) => ({ ...p, keys: profileProbeKeys(p, open) }));
    const broad = probes.filter((p) => isBroad(p, ancestors));
    const narrow = probes.filter((p) => !isBroad(p, ancestors));
    const raw = [
      ...(await repo.profileToListings(tx, narrow, { since: options.since ?? null })),
      ...(await repo.profileToListings(tx, broad, { broad: true })),
    ];
    // another agency's listing only while its owner is listed (network search's rule; re-checked on the survivors)
    const owners = [...new Set(raw.map((c) => c.listing.agencyId).filter((a) => a !== input.agencyId))];
    const listed = await agencies.listedAgencyNamesOf(tx, owners);
    const candidates = raw.filter((c) => c.listing.agencyId === input.agencyId || listed.has(c.listing.agencyId));

    const vectors = await repo.profileVectors(
      tx,
      profiles.map((p) => p.id),
    );
    const byProfile = new Map<string, string[]>();
    for (const c of candidates)
      byProfile.set(c.profile.id, [...(byProfile.get(c.profile.id) ?? []), c.listing.listingId]);
    const sims = await search.listingSimilarities(
      tx,
      [...byProfile].flatMap(([id, listingIds]) => {
        const v = vectors.get(id);
        return v ? [{ key: id, vector: v.vector, model: v.model, ids: listingIds }] : [];
      }),
    );
    const scored = candidates.map((c) => ({
      ...c,
      similarity: sims.get(`${c.profile.id}:${c.listing.listingId}`) ?? null,
    }));
    return write(tx, scored, { recheck: true });
  });
}

/** The nightly sweep reads facts written this long before it (twice its period: a late or missed run is covered). */
export const MATCH_SWEEP_SINCE_MS = 2 * 86_400_000;

/**
 * One sweep window of an agency's active profiles (keyset on the id) against the facts written in the last
 * `MATCH_SWEEP_SINCE_MS` (broad profiles: the newest window); `next` null: the agency is done.
 */
export async function profileMatchWindow(input: {
  agencyId: string;
  after: string | null;
  window?: number;
  nowMs?: number;
}): Promise<EngineResult & { profiles: number; next: string | null }> {
  const window = input.window ?? MATCH_SWEEP_WINDOW;
  const ids = await withSystem('matching.profileMatchWindow', async (tx) => {
    const page = await repo.profileWindow(tx, { agencyId: input.agencyId, after: input.after, window, active: true });
    // profiles written before match keys existed (R2-02a) get them here, so listing events reach them from now on
    await repo.keyUnkeyedProfiles(tx, input.agencyId, page);
    return page;
  });
  const since = new Date((input.nowMs ?? clock.nowMs()) - MATCH_SWEEP_SINCE_MS);
  const r =
    ids.length > 0 ? await matchProfilesToListings({ agencyId: input.agencyId, profileIds: ids }, { since }) : NONE;
  return { ...r, profiles: ids.length, next: ids.length < window ? null : (ids.at(-1) ?? null) };
}

/**
 * The facts of these listings from their read models, in one transaction (≤ a few hundred ids): what a listing event
 * does before it matches, without the match. Answers how many are live (ACTIVE listings with a read model).
 */
export async function refreshListingFacts(ids: readonly string[]): Promise<{ live: number }> {
  if (ids.length === 0) return { live: 0 };
  return withSystem('matching.refreshListingFacts', async (tx) => ({ live: (await refreshFacts(tx, ids)).length }));
}

/**
 * `matching.backfillListingFacts` (worker, once after deploy): the facts of every ACTIVE listing with a read model,
 * `FACTS_BACKFILL_BATCH` listings per transaction (keyset on the listing id). Answers where to go on (null: done).
 */
export async function backfillListingFacts(
  after: string | null,
  limit: number = FACTS_BACKFILL_BATCH,
): Promise<{ live: number; next: string | null }> {
  return withSystem('matching.backfillListingFacts', async (tx) => {
    const page = await search.listingAlertStatesPage(tx, after, limit);
    const docs = await refreshFacts(
      tx,
      page.map((p) => p.targetId),
    );
    return { live: docs.length, next: page.length < limit ? null : (page.at(-1)?.targetId ?? null) };
  });
}
