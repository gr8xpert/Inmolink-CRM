/**
 * Listing embeddings (R2-01a, PLAN §8 #4, §3 #47): one multilingual vector per live listing with a read model, for the
 * buyer match engine's kNN (R2-02). Worker-only (`withSystem`); the model call (`ai.embed`) runs outside any
 * transaction and is metered to the listing's agency.
 *
 * - **Text** (`listingEmbeddingText`): the read model's title and description with its structured facts (type,
 *   transaction, place, rooms, sizes, year, energy rating, features) — no price (a price edit must not cost a
 *   re-embed; matching filters price structurally), no reference, nothing private (read models hold none). Contact
 *   details typed into the free texts (e-mails, phones, web addresses, tax ids, handles) are removed before the text
 *   leaves (`.claude/rules/ai.md`: minimise PII), with the white-label pass's generic matchers.
 * - **Which listings:** read models in `PUBLIC_SEARCH_STATUSES` (what matching can show); a listing that leaves them,
 *   or loses its read model, loses its vector.
 * - **Never twice for the same text:** `content_hash` = sha256(model, text). A listing whose hash is unchanged only
 *   moves its `source_version` / `source_updated_at` on; a model change (env `AI_EMBED_MODEL`) changes every hash, so
 *   the next backfill re-embeds everything once.
 * - **Re-embed on change:** `search.listings.changed` (a listing's read model written with a new version, status or
 *   price, or dropped) queues `search.embedListings` for those listings.
 * - **Backfill:** `search.embeddingsSweep` (daily) queues one `search.embeddingsBackfill` walk per agency, which reads
 *   `EMBED_BACKFILL_WINDOW` listings at a time, embeds the stale ones (missing, older version or write — a rename
 *   rewrites a read model at the same version —, or another model; `EMBED_BATCH` texts per `ai.embed` call) and drops
 *   the window's orphan vectors. Off (`AI_EMBED_PROVIDER=none`): every step returns at once.
 * - **Degrades, never fails the pipeline:** the budget cap or an outage (`AI_DEGRADE_CODES`) stops the page; the
 *   listings stay stale and the next event or sweep picks them up. A misconfigured provider (another vector size, a
 *   broken answer) fails the job without retries (`INTERNAL`, not retryable).
 */

import { createHash } from 'node:crypto';
import { type ListingDetailDoc, PUBLIC_SEARCH_STATUSES } from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { LISTING_EMBEDDING_DIMENSIONS } from '@inmolink/db/schema/search';
import { AI_DEGRADE_CODES, type AiCtx, ai } from '@inmolink/platform/ai';
import { AppError, type ErrorCode, isAppError } from '@inmolink/platform/errors';
import { compileOwner, NO_OWNER } from '../../white-label';
import * as billing from '../billing';
import * as repo from './repo';

/** The AI feature (usage records, budgets). */
export const LISTING_EMBED_FEATURE = 'search.listing-embeddings';
/** Texts per `ai.embed` call (the gateway takes ≤ 256). */
export const EMBED_BATCH = 64;
/** Listings a backfill page reads (one job; the stale ones among them are embedded). */
export const EMBED_BACKFILL_WINDOW = 500;
/** The text sent is cut to this many characters (multilingual models take ~512 tokens; the start carries the facts). */
export const EMBED_TEXT_MAX_CHARS = 2_000;
/** Candidates the HNSW search keeps (recall vs. latency; pgvector's default is 40). */
export const KNN_EF_SEARCH = 64;
export const KNN_MAX_LIMIT = 100;
/** halfvec's largest finite value. */
const HALFVEC_MAX = 65_504;

const DEGRADE: ReadonlySet<ErrorCode> = new Set(AI_DEGRADE_CODES);
const LIVE: readonly string[] = PUBLIC_SEARCH_STATUSES;

/** The `detail` fields the text is built from (the only ones read). */
const FACT_KEYS = [
  'title',
  'description',
  'transactionType',
  'propertyType',
  'place',
  'bedrooms',
  'bathrooms',
  'builtM2',
  'plotM2',
  'terraceM2',
  'yearBuilt',
  'energyRating',
  'features',
] as const satisfies readonly (keyof ListingDetailDoc)[];

export type EmbeddingFacts = Partial<Pick<ListingDetailDoc, (typeof FACT_KEYS)[number]>>;

/** Contact details anyone may have typed into a free text (no owner identity: the generic matchers only). */
const contacts = compileOwner(NO_OWNER);
/**
 * Collapses whitespace (an edit that only re-wraps a description is no text change) and removes contact details.
 * R2-01b: shared with the client-profile embeddings (wishes).
 */
export const embeddingClean = (s: string | null | undefined): string =>
  contacts.clean((s ?? '').replace(/\s+/g, ' ')).trim();

/**
 * The text a listing is embedded from (pure; the same document always gives the same text). Facts first, so the cut
 * at `EMBED_TEXT_MAX_CHARS` only ever shortens the description.
 */
export function listingEmbeddingText(doc: EmbeddingFacts): string {
  const place = doc.place
    ? [doc.place.area, doc.place.city, doc.place.region, doc.place.country].flatMap((t) => (t ? [t.name] : []))
    : [];
  const sizes = [
    doc.bedrooms != null ? `${doc.bedrooms} bedrooms` : null,
    doc.bathrooms != null ? `${doc.bathrooms} bathrooms` : null,
    doc.builtM2 != null ? `${doc.builtM2} m² built` : null,
    doc.plotM2 != null ? `${doc.plotM2} m² plot` : null,
    doc.terraceM2 != null ? `${doc.terraceM2} m² terrace` : null,
    doc.yearBuilt != null ? `built ${doc.yearBuilt}` : null,
    doc.energyRating ? `energy ${doc.energyRating}` : null,
  ].filter((s): s is string => s !== null);
  const features = (doc.features ?? []).map((f) => f.name).sort();
  const lines = [
    embeddingClean(doc.title),
    [doc.propertyType?.name, doc.transactionType?.toLowerCase()].filter(Boolean).join(', '),
    place.join(', '),
    sizes.join(', '),
    features.length > 0 ? `Features: ${features.join(', ')}` : '',
    embeddingClean(doc.description),
  ].filter((l) => l.length > 0);
  return lines.join('\n').slice(0, EMBED_TEXT_MAX_CHARS);
}

/** sha256 hex of the model and the text: equal hashes are never embedded again. */
export function embeddingHash(model: string, text: string): string {
  return createHash('sha256').update(model).update('\u0000').update(text).digest('hex');
}

export interface EmbedListingsResult {
  /** Off (no provider): nothing read, nothing called. */
  disabled: boolean;
  embedded: number;
  /** Hash unchanged: no model call. */
  unchanged: number;
  /** Vectors dropped (no live read model any more). */
  deleted: number;
  /** Left stale: the gateway said no (budget, outage) — the next event or sweep tries again. */
  degraded: number;
  degradeCode: ErrorCode | null;
}

const NOTHING: EmbedListingsResult = {
  disabled: false,
  embedded: 0,
  unchanged: 0,
  deleted: 0,
  degraded: 0,
  degradeCode: null,
};

/** A configuration or provider-contract error: retrying cannot help, and it must not read as an outage. */
const misconfigured = (reason: string, details: Record<string, unknown> = {}) =>
  new AppError('INTERNAL', { reason, ...details }, false);

/** The size of every embedding (listings', and the client profiles' that are scored against them: R2-01b). */
export const EMBEDDING_DIMENSIONS = LISTING_EMBEDDING_DIMENSIONS;

/**
 * The embedding model, checked against the columns' size; null while embeddings are off. R2-01b: shared with the
 * matching module's client-profile embeddings (one model, one vector space).
 */
export function embeddingModel(): string | null {
  const m = ai.embeddingModel();
  if (!m) return null;
  if (m.dimensions !== EMBEDDING_DIMENSIONS) {
    throw misconfigured('EMBED_DIMENSIONS', { expected: EMBEDDING_DIMENSIONS, got: m.dimensions });
  }
  return m.model;
}

/**
 * One `ai.embed` call (≤ `EMBED_BATCH` texts; never inside a transaction): the vectors, in order, or the degrade code
 * when the gateway said no (budget, outage — the caller leaves the rest stale). An answer of another model, size or
 * count, or with a non-finite value, is a misconfigured provider: thrown, not retried (`INTERNAL`). R2-01b: shared
 * with the client-profile embeddings.
 */
export async function embedChunk(
  ctx: AiCtx,
  feature: string,
  model: string,
  texts: readonly string[],
): Promise<{ vectors: number[][]; degradeCode: null } | { vectors: null; degradeCode: ErrorCode }> {
  let res: Awaited<ReturnType<typeof ai.embed>>;
  try {
    res = await ai.embed(ctx, { feature, texts: [...texts] });
  } catch (err) {
    if (isAppError(err) && DEGRADE.has(err.code)) return { vectors: null, degradeCode: err.code };
    throw err;
  }
  if (
    res.model !== model ||
    res.dimensions !== EMBEDDING_DIMENSIONS ||
    res.vectors.length !== texts.length ||
    res.vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS || !v.every(Number.isFinite))
  ) {
    throw misconfigured('EMBED_ANSWER', { texts: texts.length, vectors: res.vectors.length });
  }
  return { vectors: res.vectors, degradeCode: null };
}

/**
 * Embeds these listings of one agency (≤ a few hundred ids): reads their read models, skips unchanged texts, embeds
 * the rest in `EMBED_BATCH` calls outside any transaction, then writes the vectors (never over a newer row). Listings
 * without a live read model lose their vector. Idempotent: a re-run finds every hash unchanged.
 */
export async function embedListings(
  input: { agencyId: string; listingIds: readonly string[] },
  options: { requestId?: string } = {},
): Promise<EmbedListingsResult> {
  const model = embeddingModel();
  if (model === null) return { ...NOTHING, disabled: true };
  const ids = [...new Set(input.listingIds)];
  if (ids.length === 0) return NOTHING;

  const read = await withSystem('search.embedListings', async (tx) => {
    const sources = await repo.embeddingSources(tx, { agencyId: input.agencyId, ids, live: LIVE, factKeys: FACT_KEYS });
    const live = sources.filter((s) => s.live && s.facts !== null);
    const keep = new Set(live.map((s) => s.targetId));
    const deleted = await repo.deleteEmbeddings(
      tx,
      input.agencyId,
      ids.filter((id) => !keep.has(id)),
    );
    const hashes = await repo.embeddingHashes(
      tx,
      live.map((s) => s.targetId),
    );
    const todo: { source: repo.EmbeddingSource; text: string; hash: string }[] = [];
    const same: repo.EmbeddingSource[] = [];
    for (const s of live) {
      const text = listingEmbeddingText(s.facts as EmbeddingFacts);
      const hash = embeddingHash(model, text);
      if (hashes.get(s.targetId) === hash) same.push(s);
      else todo.push({ source: s, text, hash });
    }
    await repo.touchEmbeddings(tx, same);
    const plan = todo.length > 0 ? (await billing.planOf(tx, input.agencyId)).code : null;
    return { todo, unchanged: same.length, deleted, plan };
  });

  const ctx: AiCtx = { tenant: { agencyId: input.agencyId, plan: read.plan }, requestId: options.requestId };
  let embedded = 0;
  for (let i = 0; i < read.todo.length; i += EMBED_BATCH) {
    const chunk = read.todo.slice(i, i + EMBED_BATCH);
    const res = await embedChunk(
      ctx,
      LISTING_EMBED_FEATURE,
      model,
      chunk.map((c) => c.text),
    );
    if (res.vectors === null) {
      return {
        ...NOTHING,
        embedded,
        unchanged: read.unchanged,
        deleted: read.deleted,
        degraded: read.todo.length - i,
        degradeCode: res.degradeCode,
      };
    }
    const vectors = res.vectors;
    embedded += await withSystem('search.embedListings', (tx) =>
      repo.upsertEmbeddings(
        tx,
        chunk.map((c, j) => ({
          targetId: c.source.targetId,
          ownerAgencyId: input.agencyId,
          embedding: vectors[j] ?? [],
          model,
          contentHash: c.hash,
          sourceVersion: c.source.version,
          sourceUpdatedAt: c.source.updatedAt,
        })),
      ),
    );
  }
  return { ...NOTHING, embedded, unchanged: read.unchanged, deleted: read.deleted };
}

export interface EmbeddingBackfillResult extends EmbedListingsResult {
  /** The next page's cursor; null when the walk is done (or stopped: degraded / off). */
  next: string | null;
}

/**
 * One page of an agency's backfill walk: the next `EMBED_BACKFILL_WINDOW` listings after `after`; their orphan
 * vectors are dropped and the stale ones embedded.
 */
export async function embeddingBackfillPage(
  input: { agencyId: string; after: string | null },
  options: { requestId?: string; window?: number } = {},
): Promise<EmbeddingBackfillResult> {
  const model = embeddingModel();
  if (model === null) return { ...NOTHING, disabled: true, next: null };
  const page = await withSystem('search.embeddingsBackfill', async (tx) => {
    const w = await repo.embeddingWindow(tx, {
      agencyId: input.agencyId,
      model,
      live: LIVE,
      after: input.after,
      window: options.window ?? EMBED_BACKFILL_WINDOW,
    });
    const orphans = await repo.deleteOrphanEmbeddings(tx, {
      agencyId: input.agencyId,
      live: LIVE,
      after: input.after,
      upTo: w.last,
    });
    return { ...w, orphans };
  });
  const res = await embedListings({ agencyId: input.agencyId, listingIds: page.stale }, options);
  return { ...res, deleted: res.deleted + page.orphans, next: res.degraded > 0 ? null : page.last };
}

/**
 * The listings nearest to a vector (cosine), for workers (matching: R2-02). Approximate (HNSW); no visibility filter —
 * every agency's live listings: the caller filters by `ownerAgencyId` / visibility and hydrates only what it may
 * show. Not in the module's public API until R2-02 adds that filter. `limit` ≤ `KNN_MAX_LIMIT`.
 */
export async function nearestListings(
  tx: Tx,
  vector: readonly number[],
  limit = 20,
): Promise<{ targetId: string; ownerAgencyId: string; distance: number }[]> {
  if (
    vector.length !== EMBEDDING_DIMENSIONS ||
    !vector.every((x) => Number.isFinite(x) && Math.abs(x) <= HALFVEC_MAX)
  ) {
    throw new AppError('VALIDATION_FAILED', { reason: 'EMBED_VECTOR', dimensions: EMBEDDING_DIMENSIONS });
  }
  const n = Math.max(1, Math.min(KNN_MAX_LIMIT, Math.trunc(limit)));
  return repo.nearestListingEmbeddings(tx, vector, { limit: n, efSearch: Math.max(KNN_EF_SEARCH, n) });
}

/** R2-02b, the match engine (worker): these listings' vectors as halfvec text, with their model. */
export function listingVectors(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, { model: string; vector: string }>> {
  return repo.listingVectors(tx, ids);
}

/**
 * R2-02b, the match engine (worker): cosine similarity of each client profile's vector (halfvec text read from the
 * database, never caller input) to its candidate listings' vectors of the same model, in one statement; keyed
 * `<key>:<listing id>`, listings without one left out.
 */
export function listingSimilarities(
  tx: Tx,
  probes: readonly { key: string; vector: string; model: string; ids: readonly string[] }[],
): Promise<Map<string, number>> {
  return repo.listingSimilarities(tx, probes);
}
