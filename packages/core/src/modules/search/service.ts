/**
 * Read models (S5-01, PATTERNS §14, PLAN §5.3 #3): the search worker rebuilds a listing's or new-build unit's
 * documents — card and detail JSON per content locale of the owner agency — from outbox events, and
 * `pnpm ops:rebuild-read-models` rebuilds every one. Worker-facing (PATTERNS §12): raw `tx` under `withSystem`,
 * no actor or policy; request code never writes read models.
 *
 * A rebuild takes an advisory lock per target, then reads the sources: two builders of one target run one after
 * the other, the later one reading at least what the earlier one read. The upsert never lowers `version`, so
 * events delivered late, twice or out of order cannot move a read model backwards.
 */
import type { Tx } from '@inmolink/db';
import { withSystem } from '@inmolink/db';
import {
  type EnsureIndexResult,
  type IndexDefinition,
  type SearchEngine,
  searchEngine,
} from '@inmolink/platform/search';
import * as agencies from '../agencies';
import * as developments from '../developments';
import * as media from '../media';
import * as properties from '../properties';
import * as taxonomy from '../taxonomy';
import { type BuiltDoc, buildListingDocs, buildUnitDocs } from './build';
import { buildIndexDoc, type IndexSourceRow, type ListingIndexDoc, listingsIndex } from './index-doc';
import * as repo from './repo';

export type ReadModelKind = BuiltDoc['kind'];

export interface RebuildResult {
  /** Targets that have documents now. */
  built: number;
  /** Rows written (new or changed). */
  written: number;
  /** Rows deleted (gone targets, removed locales). */
  deleted: number;
  /** Listings with images still processing: their documents lack them until a later rebuild. */
  pendingMedia: string[];
}

/** Rebuilds the read models of these listings (any agency). About ten statements for any number. */
export async function rebuildListingReadModels(tx: Tx, ids: readonly string[]): Promise<RebuildResult> {
  const unique = [...new Set(ids)];
  await repo.lockTargets(tx, unique);
  const listings = await properties.listingsForReadModels(tx, unique);
  const live = listings.map((l) => l.id);
  const localesOf = await agencies.contentLocalesOf(
    tx,
    listings.map((l) => l.agencyId),
  );
  const [mediaOf, tax] = await Promise.all([
    media.mediaForReadModels(tx, live),
    // Names in every locale these agencies use (a batch spans agencies).
    taxonomy.taxonomyForReadModels(
      tx,
      {
        locations: listings.map((l) => l.locationId),
        propertyTypes: listings.map((l) => l.propertyTypeId),
        features: listings.flatMap((l) => l.featureIds),
      },
      [...new Set([...localesOf.values()].flat())],
    ),
  ]);
  const docs = listings.flatMap((l) => buildListingDocs(l, mediaOf.get(l.id), tax, localesOf.get(l.agencyId) ?? []));
  return {
    ...(await write(tx, unique, docs)),
    built: new Set(docs.map((d) => d.targetId)).size,
    pendingMedia: listings.filter((l) => (mediaOf.get(l.id)?.pending ?? 0) > 0).map((l) => l.id),
  };
}

/** Rebuilds the read models of these new-build units (any agency). About eight statements for any number. */
export async function rebuildUnitReadModels(tx: Tx, ids: readonly string[]): Promise<RebuildResult> {
  const unique = [...new Set(ids)];
  await repo.lockTargets(tx, unique);
  const units = await developments.unitsForReadModels(tx, unique);
  const localesOf = await agencies.contentLocalesOf(
    tx,
    units.map((u) => u.agencyId),
  );
  const tax = await taxonomy.taxonomyForReadModels(
    tx,
    {
      locations: units.map((u) => u.development.locationId),
      propertyTypes: units.map((u) => u.propertyTypeId),
      features: [],
    },
    [...new Set([...localesOf.values()].flat())],
  );
  const docs = units.flatMap((u) => buildUnitDocs(u, tax, localesOf.get(u.agencyId) ?? []));
  return {
    ...(await write(tx, unique, docs)),
    built: new Set(docs.map((d) => d.targetId)).size,
    pendingMedia: [],
  };
}

async function write(tx: Tx, ids: readonly string[], docs: BuiltDoc[]) {
  const deleted = await repo.deleteOthers(tx, ids, docs);
  const written = await repo.upsertDocs(tx, docs);
  return { written, deleted };
}

export const rebuildReadModels = (tx: Tx, kind: ReadModelKind, ids: readonly string[]) =>
  kind === 'LISTING' ? rebuildListingReadModels(tx, ids) : rebuildUnitReadModels(tx, ids);

/** A development changed (text, place, access, deleted): its units' documents, and drops those of gone ones. */
export async function rebuildDevelopmentReadModels(
  developmentId: string,
  options: { batch?: number } = {},
): Promise<RebuildResult> {
  const batch = options.batch ?? READ_MODEL_BATCH;
  const targets = await withSystem('search.buildDevelopmentReadModels', async (tx) => {
    const [unitIds, existing] = await Promise.all([
      developments.unitIdsForDevelopment(tx, developmentId),
      repo.targetsOfDevelopment(tx, developmentId),
    ]);
    const listingIds = existing.filter((t) => t.kind === 'LISTING').map((t) => t.targetId);
    const units = [...new Set([...unitIds, ...existing.filter((t) => t.kind === 'UNIT').map((t) => t.targetId)])];
    return { units, listingIds };
  });
  const total: RebuildResult = { built: 0, written: 0, deleted: 0, pendingMedia: [] };
  const chunks: [ReadModelKind, string[]][] = [];
  for (let i = 0; i < targets.units.length; i += batch) chunks.push(['UNIT', targets.units.slice(i, i + batch)]);
  for (let i = 0; i < targets.listingIds.length; i += batch) {
    chunks.push(['LISTING', targets.listingIds.slice(i, i + batch)]);
  }
  for (const [kind, ids] of chunks) {
    add(total, await withSystem('search.buildDevelopmentReadModels', (tx) => rebuildReadModels(tx, kind, ids)));
  }
  return total;
}

function add(total: RebuildResult, r: RebuildResult): void {
  total.built += r.built;
  total.written += r.written;
  total.deleted += r.deleted;
  total.pendingMedia.push(...r.pendingMedia);
}

/** Targets per rebuild transaction: ~10 statements and ≤ this many advisory locks each. */
export const READ_MODEL_BATCH = 250;
/** Advisory locks a full rebuild may hold at once (batch × concurrency); the shared lock table has ~6,400 slots. */
export const MAX_LOCKS_IN_FLIGHT = 2_000;

/** The full rebuild's progress totals: targets of `kind` that have a read model (one agency's, or all). */
export function countReadModelTargets(tx: Tx, kind: ReadModelKind, agencyId?: string): Promise<number> {
  return kind === 'LISTING'
    ? properties.countListingsForReadModels(tx, agencyId)
    : developments.countUnitsForReadModels(tx, agencyId);
}

export interface FullRebuildProgress {
  kind: ReadModelKind;
  /** Targets processed so far (this kind). */
  done: number;
  built: number;
  written: number;
  deleted: number;
  elapsedMs: number;
}

export interface FullRebuildOptions {
  /** One agency only (its locales changed, `--agency`). */
  agencyId?: string;
  kinds?: readonly ReadModelKind[];
  batch?: number;
  /** Batches in flight at once (each its own transaction). */
  concurrency?: number;
  onProgress?: (p: FullRebuildProgress) => void;
  /** System reason for the audit trail. */
  reason?: string;
}

/**
 * Rebuilds every read model (or one agency's): walks live listings and units in id order, a page per transaction,
 * and deletes the documents of targets that no longer have one — those between two live ids of a page that are
 * not live. Idempotent and restartable; unchanged documents are not rewritten.
 */
export async function rebuildAllReadModels(
  options: FullRebuildOptions = {},
): Promise<Record<ReadModelKind, FullRebuildProgress>> {
  const batch = options.batch ?? READ_MODEL_BATCH;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  // Each batch holds an advisory lock per target until it commits: keep the run's share of the lock table small.
  if (batch * concurrency > MAX_LOCKS_IN_FLIGHT) {
    throw new RangeError(`batch × concurrency must be ≤ ${MAX_LOCKS_IN_FLIGHT} (advisory locks held at once)`);
  }
  const reason = options.reason ?? 'search.rebuildAllReadModels';
  // The database's clock: `updated_at` is written by it.
  const since = await withSystem(reason, (tx) => repo.dbNow(tx));
  const out = {} as Record<ReadModelKind, FullRebuildProgress>;
  for (const kind of options.kinds ?? (['LISTING', 'UNIT'] as const)) {
    const started = Date.now();
    const progress: FullRebuildProgress = { kind, done: 0, built: 0, written: 0, deleted: 0, elapsedMs: 0 };
    const pageOf = (tx: Tx, after: string | null) => {
      const page = { after, limit: batch, agencyId: options.agencyId };
      return kind === 'LISTING'
        ? properties.listingIdsForReadModels(tx, page)
        : developments.unitIdsForReadModels(tx, page);
    };
    // Pages are read one after another (cheap: an index walk); their rebuilds run `concurrency` at a time.
    let after: string | null = null;
    // Set at the last page, and at the first failure: every lane then stops taking pages.
    let finished = false;
    let reading: Promise<unknown> = Promise.resolve();
    const nextPage = () => {
      const page = reading.then(async () => {
        if (finished) return null;
        const from = after;
        const ids = await withSystem(reason, (tx) => pageOf(tx, from));
        if (ids.length < batch) finished = true;
        const until = finished ? null : (ids[ids.length - 1] as string);
        after = until;
        return { from, until, ids };
      });
      reading = page.catch(() => undefined);
      return page;
    };
    const lane = async () => {
      try {
        await walk();
      } catch (err) {
        finished = true;
        throw err;
      }
    };
    const walk = async () => {
      for (let page = await nextPage(); page; page = await nextPage()) {
        const { from, until, ids } = page;
        const r = await withSystem(reason, async (tx) => {
          const res = await rebuildReadModels(tx, kind, ids);
          const swept = await repo.deleteBetween(tx, {
            kind,
            after: from,
            until,
            live: ids,
            since,
            agencyId: options.agencyId,
          });
          return { ...res, deleted: res.deleted + swept };
        });
        progress.done += ids.length;
        progress.built += r.built;
        progress.written += r.written;
        progress.deleted += r.deleted;
        progress.elapsedMs = Date.now() - started;
        options.onProgress?.({ ...progress });
      }
    };
    // Every lane settles before the run answers (or fails): none outlives the caller's connection pool.
    const lanes = await Promise.allSettled(Array.from({ length: concurrency }, lane));
    const failed = lanes.find((l): l is PromiseRejectedResult => l.status === 'rejected');
    if (failed) throw failed.reason;
    out[kind] = progress;
  }
  return out;
}

/** Tests and ops checks: these targets' stored documents. */
export function readModelDocs(tx: Tx, ids: readonly string[], locale?: string) {
  return repo.readDocs(tx, ids, locale);
}

/**
 * Index documents of these targets, built from their read models (S5-02); `missing` have no read model any more
 * (their index documents must go). One statement per `READ_MODEL_BATCH` targets. Worker-facing: raw `tx` under `withSystem`.
 */
export async function indexDocsFor(
  tx: Tx,
  ids: readonly string[],
): Promise<{ docs: ListingIndexDoc[]; missing: string[] }> {
  const unique = [...new Set(ids)];
  const rows: Awaited<ReturnType<typeof repo.readIndexRows>> = [];
  // Bounded statements: one per READ_MODEL_BATCH targets.
  for (let i = 0; i < unique.length; i += READ_MODEL_BATCH) {
    rows.push(...(await repo.readIndexRows(tx, unique.slice(i, i + READ_MODEL_BATCH))));
  }
  const byTarget = new Map<string, IndexSourceRow[]>();
  for (const { features, ...r } of rows) {
    const list = byTarget.get(r.targetId) ?? [];
    list.push({ ...r, featureIds: (features ?? []).map((f) => f.id) });
    byTarget.set(r.targetId, list);
  }
  const docs = [...byTarget.values()].flatMap((r) => buildIndexDoc(r) ?? []);
  return { docs, missing: unique.filter((id) => !byTarget.has(id)) };
}

/**
 * Creates the listings index if missing and applies its settings when they differ (worker boot; idempotent: an
 * unchanged definition sends nothing). Network I/O: never inside a transaction.
 */
export function ensureListingsIndex(
  engine: SearchEngine = searchEngine(),
  def: IndexDefinition = listingsIndex(),
): Promise<EnsureIndexResult> {
  return engine.ensureIndex(def);
}
