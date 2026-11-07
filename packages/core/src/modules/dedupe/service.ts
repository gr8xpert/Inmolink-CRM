/**
 * Duplicate detection (R2-03a, PLAN §10) — worker functions (PATTERNS §12): no request path, no authorization; every
 * read and write is `withSystem` (both tables are global and worker-only). R2-03b adds the member-facing use cases.
 *
 * `rescoreListings` (one `search.listings.changed` batch, a backfill or sweep window), one transaction:
 * 1. **Signatures**: the listings locked (advisory, sorted), their read models (`search.indexDocsFor`, rule 9) and
 *    first processed images (`media.listingImageHashes`) → `dedupe_listing_signatures`. A listing no longer ACTIVE or
 *    without a read model loses its signature and every pair it is in. Media changes arrive here too: a processed,
 *    added or removed image rebuilds the read model, which raises `search.listings.changed`. Only signatures that
 *    changed go on (unless `force`: the backfill after a scorer change) — the other side of a new pair finds it when
 *    its own listing is processed.
 * 2. **Candidates** by blocking: one GIN probe per probe key counts its listings (up to `COMMON_KEY_LISTINGS + 1`) and
 *    names them; keys held by more are skipped (logos, placeholders, a dense tower's cell) and remembered for an hour
 *    (not probed again); each listing takes at most `MAX_CANDIDATES` others, most shared keys first. Never all pairs.
 * 3. **Scores**: each candidate pair and each stored pair of the listings (their best `PAIRS_READ_PER_LISTING`) is
 *    scored (`scoring.ts`), images held by more than `WIDE_IMAGE_LISTINGS` listings (both galleries counted) not
 *    evidence, with the embedding cosine when embeddings are on and both have a vector. Pairs ≥ `PAIR_STORE_MIN` are
 *    upserted (unchanged ones untouched, never over a score from newer signatures), at most `MAX_PAIRS_PER_LISTING` a
 *    listing (its lowest go); stored pairs now below it, or whose other listing has no signature, are deleted.
 *    Re-running the same batch changes nothing (idempotent). Writes go in key order (no deadlock between jobs).
 */
import { type Tx, withSystem } from '@inmolink/db';
import * as media from '../media';
import * as search from '../search';
import * as repo from './repo';
import { PAIR_STORE_MIN, type PairSignals, SCORER_VERSION, scorePair, WIDE_IMAGE_LISTINGS } from './scoring';
import { MAX_IMAGES, probeKeysOf, SIGNATURE_VERSION, type Signature, signatureOf } from './signature';

/** A key held by more listings than this is not used to find candidates. */
export const COMMON_KEY_LISTINGS = 100;
/** Candidates per listing and run (most shared keys first). */
export const MAX_CANDIDATES = 50;
/** Stored pairs kept per listing (highest scores); a run reads twice as many from each side. */
export const MAX_PAIRS_PER_LISTING = 50;
const PAIRS_READ_PER_LISTING = 2 * MAX_PAIRS_PER_LISTING;
/** Listings per run: one `search.listings.changed` event's batch. */
export const RESCORE_BATCH = search.PUBLIC_DOCS_EVENT_TARGETS;
/** Listings per backfill / sweep window. */
export const BACKFILL_WINDOW = 500;
/** The backfill's run key: a new signature or scorer version is a new walk (its job ids differ). */
export const BACKFILL_RUN = `s${SIGNATURE_VERSION}.${SCORER_VERSION}`;

export interface RescoreResult {
  signatures: number;
  changed: number;
  dropped: number;
  candidates: number;
  stored: number;
  deleted: number;
}

type ScoreResult = Pick<RescoreResult, 'candidates' | 'stored' | 'deleted'>;

/**
 * Keys found common (held by more than `COMMON_KEY_LISTINGS`) are remembered per worker process for
 * `COMMON_KEY_TTL_MS` and not probed again meanwhile: a logo in 50k listings costs one ~30 ms bitmap probe an hour,
 * not one per batch. Bounded (`COMMON_KEY_CACHE`, oldest first out). A key only becomes common by growing, so the
 * stale case is a key that stopped being common: found again after the TTL.
 */
export const COMMON_KEY_TTL_MS = 3_600_000;
const COMMON_KEY_CACHE = 100_000;
const commonKeys = new Map<bigint, number>();

function knownCommon(key: bigint, now: number): boolean {
  const until = commonKeys.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  commonKeys.delete(key);
  return false;
}

function rememberCommon(key: bigint, now: number): void {
  commonKeys.delete(key);
  commonKeys.set(key, now + COMMON_KEY_TTL_MS);
  if (commonKeys.size > COMMON_KEY_CACHE) commonKeys.delete(commonKeys.keys().next().value as bigint);
}

/** Tests: forget the remembered common keys. */
export function resetCommonKeys(): void {
  commonKeys.clear();
}

const live = (d: search.ListingIndexDoc) => d.kind === 'LISTING' && d.status === 'ACTIVE';

const ordered = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
const pairKey = (x: string, y: string) => ordered(x, y).join(':');

function sameSignals(a: PairSignals, b: PairSignals): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a as never)[k] !== (b as never)[k]) return false;
  return true;
}

/** Step 1: these listings' signatures from their read models and images (caller's transaction). */
async function refreshSignatures(
  tx: Tx,
  listingIds: readonly string[],
): Promise<{ live: Signature[]; changed: Set<string>; dropped: number }> {
  await repo.lockListings(tx, listingIds);
  const { docs } = await search.indexDocsFor(tx, listingIds, { text: false });
  const liveDocs = docs.filter(live);
  const images = await media.listingImageHashes(
    tx,
    liveDocs.map((d) => d.id),
    MAX_IMAGES,
  );
  const built = liveDocs
    .map((d) =>
      signatureOf({
        listingId: d.id,
        ownerAgencyId: d.ownerAgencyId,
        version: d.version,
        transactionType: d.transactionType,
        propertyTypeId: d.propertyTypeId,
        locationIds: d.locationIds,
        beds: d.beds,
        baths: d.baths,
        areaM2: d.areaM2,
        priceCents: d.priceOnRequest ? null : d.priceCents,
        geo: d.geo,
        images: images.get(d.id) ?? [],
      }),
    )
    .sort((x, y) => (x.listingId < y.listingId ? -1 : 1));
  const liveIds = new Set(built.map((s) => s.listingId));
  const gone = listingIds.filter((id) => !liveIds.has(id));
  const changed = new Set(await repo.upsertSignatures(tx, built));
  await repo.deleteListings(tx, gone);
  // as stored: an older event's read never overwrote a newer signature
  const stored = await repo.signaturesOf(tx, [...liveIds]);
  return { live: [...stored.values()], changed, dropped: gone.length };
}

/** Steps 2–3 for signatures already written (caller's transaction). */
async function score(tx: Tx, mine: readonly Signature[]): Promise<ScoreResult> {
  if (mine.length === 0) return { candidates: 0, stored: 0, deleted: 0 };
  const probes = mine.map((s) => ({ s, keys: probeKeysOf(s) }));
  const now = Date.now();
  const postings = await repo.keyPostings(
    tx,
    probes.flatMap((p) => p.keys).filter((k) => !knownCommon(k, now)),
    COMMON_KEY_LISTINGS,
    true,
  );
  for (const [k, v] of postings) if (v.n > COMMON_KEY_LISTINGS) rememberCommon(k, now);
  const COMMON = { n: COMMON_KEY_LISTINGS + 1, ids: [] as string[] };
  for (const { keys } of probes) for (const k of keys) if (!postings.has(k)) postings.set(k, COMMON);

  // each listing's candidates: the listings of its rare keys, most shared keys first
  const todo = new Map<string, [string, string]>();
  let candidates = 0;
  for (const { s, keys } of probes) {
    const shared = new Map<string, number>();
    for (const k of keys) {
      const post = postings.get(k);
      if (!post || post.n > COMMON_KEY_LISTINGS) continue;
      for (const id of post.ids) if (id !== s.listingId) shared.set(id, (shared.get(id) ?? 0) + 1);
    }
    const best = [...shared]
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, MAX_CANDIDATES)
      .map(([id]) => id);
    candidates += best.length;
    for (const c of best) todo.set(pairKey(s.listingId, c), ordered(s.listingId, c));
  }
  const existing = await repo.pairsOf(
    tx,
    mine.map((s) => s.listingId),
    PAIRS_READ_PER_LISTING,
  );
  const stored = new Map(existing.map((p) => [pairKey(p.listingA, p.listingB), p]));
  for (const [key, p] of stored) todo.set(key, [p.listingA, p.listingB]);

  const mineById = new Map(mine.map((s) => [s.listingId, s]));
  const others = [...new Set([...todo.values()].flat())].filter((id) => !mineById.has(id));
  const sigs = new Map([...mineById, ...(await repo.signaturesOf(tx, others))]);

  // image frequencies of both galleries of every pair (a pair scores the same from either side)
  const counts = new Map([...postings].map(([k, v]) => [k, v.n]));
  const uncounted = [...new Set([...sigs.values()].flatMap((s) => s.imageKeys))].filter((k) => !counts.has(k));
  // only whether more than WIDE_IMAGE_LISTINGS hold it matters here: a probe reads at most that many + 1 rows
  for (const [k, v] of await repo.keyPostings(
    tx,
    uncounted.filter((k) => !knownCommon(k, now)),
    WIDE_IMAGE_LISTINGS,
    false,
  )) {
    counts.set(k, v.n);
  }
  for (const k of uncounted) if (!counts.has(k)) counts.set(k, COMMON_KEY_LISTINGS + 1);

  const cosine = await cosines(tx, mine, [...todo.values()]);
  const upserts = new Map<string, repo.PairRow>();
  const deletes = new Map<string, [string, string]>();
  /** Every pair of these listings after this run, with its score (for the per-listing cap). */
  const after = new Map<string, { a: string; b: string; score: number }>();
  for (const [key, [a, b]] of todo) {
    const sa = sigs.get(a);
    const sb = sigs.get(b);
    const before = stored.get(key);
    const scored =
      sa && sb
        ? scorePair(sa, sb, {
            wideImages: new Set(
              [...sa.imageKeys, ...sb.imageKeys].filter((k) => (counts.get(k) ?? 0) > WIDE_IMAGE_LISTINGS),
            ),
            cosine: cosine.get(key) ?? null,
          })
        : null;
    if (!sa || !sb || !scored || scored.score < PAIR_STORE_MIN) {
      if (before) deletes.set(key, [a, b]);
      continue;
    }
    after.set(key, { a, b, score: scored.score });
    const row: repo.PairRow = {
      listingA: a,
      listingB: b,
      agencyA: sa.ownerAgencyId,
      agencyB: sb.ownerAgencyId,
      score: scored.score,
      signals: scored.signals,
      scorerVersion: SCORER_VERSION,
      versionA: sa.sourceVersion,
      versionB: sb.sourceVersion,
    };
    const same =
      before &&
      before.score === row.score &&
      before.scorerVersion === row.scorerVersion &&
      before.versionA === row.versionA &&
      before.versionB === row.versionB &&
      sameSignals(before.signals, row.signals);
    if (!same) upserts.set(key, row);
  }
  // at most MAX_PAIRS_PER_LISTING pairs a listing: its lowest go
  for (const s of mine) {
    const own = [...after].filter(([, p]) => p.a === s.listingId || p.b === s.listingId);
    if (own.length <= MAX_PAIRS_PER_LISTING) continue;
    own.sort((x, y) => y[1].score - x[1].score || (x[0] < y[0] ? -1 : 1));
    for (const [key, p] of own.slice(MAX_PAIRS_PER_LISTING)) {
      after.delete(key);
      upserts.delete(key);
      if (stored.has(key)) deletes.set(key, [p.a, p.b]);
    }
  }
  const byKey = <T>(m: Map<string, T>) => [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([, v]) => v);
  const written = await repo.upsertPairs(tx, byKey(upserts));
  await repo.deletePairs(tx, byKey(deletes));
  return { candidates, stored: written, deleted: deletes.size };
}

/** Steps 2–3 for signatures already written, in a transaction of their own (tests: fixture signatures). */
export function scoreSignatures(mine: readonly Signature[]): Promise<ScoreResult> {
  return withSystem('dedupe.scoreSignatures', (tx) => score(tx, mine));
}

/**
 * Description embedding cosines of the pairs, keyed `a:b`, when embeddings are on: the batch's vectors, then one
 * similarity probe per listing against its pairs' other listings (same model only). Empty when off.
 */
async function cosines(
  tx: Tx,
  mine: readonly Signature[],
  todo: readonly (readonly [string, string])[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (todo.length === 0 || search.embeddingModel() === null) return out;
  const vectors = await search.listingVectors(
    tx,
    mine.map((s) => s.listingId),
  );
  if (vectors.size === 0) return out;
  const partners = new Map<string, string[]>();
  for (const [a, b] of todo) {
    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      if (!vectors.has(me)) continue;
      const list = partners.get(me) ?? [];
      list.push(other);
      partners.set(me, list);
    }
  }
  const probes = [...partners].flatMap(([id, ids]) => {
    const v = vectors.get(id);
    return v ? [{ key: id, vector: v.vector, model: v.model, ids }] : [];
  });
  const sims = await search.listingSimilarities(tx, probes);
  for (const [k, sim] of sims) {
    const [me, other] = [k.slice(0, 36), k.slice(37)];
    out.set(pairKey(me, other), sim);
  }
  return out;
}

/**
 * `dedupe.rescoreListings` (worker): these listings' signatures refreshed, then the changed ones' candidates found and
 * scored (`force`: every live one). At most `RESCORE_BATCH` listings (one event). One transaction: a failed run leaves
 * nothing half done, so its retry sees the same changes.
 */
export async function rescoreListings(
  listingIds: readonly string[],
  options: { force?: boolean } = {},
): Promise<RescoreResult> {
  const ids = [...new Set(listingIds.map((id) => id.toLowerCase()))].slice(0, RESCORE_BATCH);
  return withSystem('dedupe.rescoreListings', async (tx) => {
    const { live: mine, changed, dropped } = await refreshSignatures(tx, ids);
    const todo = options.force ? mine : mine.filter((s) => changed.has(s.listingId));
    const scored = await score(tx, todo);
    return { signatures: mine.length, changed: changed.size, dropped, ...scored };
  });
}

/**
 * `dedupe.backfill` (worker, once after deploy and after a `SIGNATURE_VERSION` / `SCORER_VERSION` change): one window
 * of listings with read models (keyset on the id), rescored in batches (forced: the scorer may have changed); answers
 * the next cursor (null: done). One pass finds every pair: blocking is symmetric, so a pair is found when its second
 * listing is processed.
 */
export async function backfillWindow(
  after: string | null,
  limit = BACKFILL_WINDOW,
): Promise<{ next: string | null; listings: number; stored: number }> {
  const page = await withSystem('dedupe.backfill', (tx) => search.listingAlertStatesPage(tx, after, limit));
  let stored = 0;
  const ids = page.map((p) => p.targetId);
  for (let i = 0; i < ids.length; i += RESCORE_BATCH) {
    stored += (await rescoreListings(ids.slice(i, i + RESCORE_BATCH), { force: true })).stored;
  }
  return { next: page.length < limit ? null : (ids.at(-1) ?? null), listings: ids.length, stored };
}

/**
 * `dedupe.sweepWindow` (worker, daily walk): one window of stored signatures, refreshed — a listing whose read model is
 * gone (an event lost, an agency erased) loses its signature and pairs; one that changed unnoticed is rescored.
 */
export async function sweepWindow(
  after: string | null,
  limit = BACKFILL_WINDOW,
): Promise<{ next: string | null; listings: number; dropped: number }> {
  const ids = await withSystem('dedupe.sweep', (tx) => repo.signatureIdsPage(tx, after, limit));
  let dropped = 0;
  for (let i = 0; i < ids.length; i += RESCORE_BATCH) {
    dropped += (await rescoreListings(ids.slice(i, i + RESCORE_BATCH))).dropped;
  }
  return { next: ids.length < limit ? null : (ids.at(-1) ?? null), listings: ids.length, dropped };
}
