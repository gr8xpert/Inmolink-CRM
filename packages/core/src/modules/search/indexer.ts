/**
 * Search indexer (S5-03, PLAN §5.3 #6): read models → the listings index, with no lost update.
 *
 * Every read-model change queues its target in `search_index_queue` in the same transaction (service `write`).
 * `syncIndex` claims queued targets with a lease, builds their index documents from the read models as they are
 * now, pushes upserts and deletes, waits for the engine to apply them and only then deletes the rows — unless the
 * target changed again meanwhile (its generation moved): that row stays for the next push. The engine being down
 * for any length of time leaves the rows where they are; the next sync after it is back pushes them.
 *
 * Ordering: a row has one holder at a time (the lease), and a push sends the current read model, so the last push
 * of a target is its newest state. A holder's lease (5 min) outlasts its longest push (two engine writes with 10 s
 * timeouts, two waits of ≤ 60 s): a push never runs after its lease expired and another holder pushed newer data.
 *
 * `checkIndexDrift` (nightly) compares the index's document count with the read models' target count and the
 * `sourceHash` of a sample; `repairIndex` walks every target and every index document and queues what differs.
 * Neither pushes: the sync stays the only writer of the index.
 *
 * Worker-facing (PATTERNS §12): `withSystem`, no actor. Engine calls never inside a transaction.
 */
import { withSystem } from '@inmolink/db';
import { type SearchEngine, SearchError, searchEngine } from '@inmolink/platform/search';
import { LISTINGS_INDEX_UID, type ListingIndexDoc, listingsIndex } from './index-doc';
import * as repo from './repo';
import { indexDocsFor } from './service';

let indexUid = LISTINGS_INDEX_UID;
let scope: readonly string[] | undefined;

/**
 * Tests: push to another index (the jobs read it when they run), and see only these targets — test files share one
 * database and its queue, so a file's sync, drift check and repair must not take another file's targets.
 */
export function configureSearchIndex(options: { uid: string; scope?: readonly string[] }): void {
  indexUid = options.uid;
  scope = options.scope;
}

/** The index the indexer writes. */
export const listingsIndexUid = (): string => indexUid;

/** Targets per push (one claim, one upsert, one delete). */
export const INDEX_SYNC_BATCH = 500;
/** How long a claim holds its rows: longer than the slowest push (see the header). */
export const INDEX_SYNC_LEASE_MS = 5 * 60_000;
/** Longest wait for the engine to apply one write. */
const ENGINE_TASK_TIMEOUT_MS = 60_000;
/** A sync run stops taking batches after this long (and queues the next run): jobs stay short. */
const SYNC_BUDGET_MS = 50_000;
/** Read-model targets sampled by the drift check. */
export const DRIFT_SAMPLE = 500;
/** Targets (or index documents) per repair page. */
export const REPAIR_PAGE = 1_000;

export interface SyncResult {
  /** Documents upserted and removed. */
  upserted: number;
  removed: number;
  /** Queue rows done (deleted). */
  done: number;
  /** Documents the engine refused: their rows back off (alert when `attempts` keeps growing). */
  rejected: { targetId: string; attempts: number }[];
  /** Rows were left when the run's budget ran out. */
  more: boolean;
}

/** A push must start with at least this much of its lease left (an engine write takes ≤ 10 s to be accepted). */
const LEASE_MARGIN_MS = 60_000;

class LeaseShort extends Error {}

/**
 * The engine refused the documents themselves (Meilisearch's document errors, a too-large payload) — not the engine
 * being down, slow, full or failing, which must leave every row queued as it is.
 */
const rejected = (err: unknown) =>
  err instanceof SearchError &&
  (err.status === 413 ||
    err.code === 'payload_too_large' ||
    err.code === 'missing_document_id' ||
    err.code === 'max_fields_limit_exceeded' ||
    (err.code?.startsWith('invalid_document_') ?? false));

/**
 * Pushes queued targets until the queue is empty, the budget is spent or `signal` aborts. Throws when the engine
 * fails (the rows go back to the queue). A batch the engine rejects is split until the rejected documents are
 * found; those back off (`rejected` in the result) and the rest are pushed.
 */
export async function syncIndex(
  options: { engine?: SearchEngine; batch?: number; budgetMs?: number; leaseMs?: number; signal?: AbortSignal } = {},
): Promise<SyncResult> {
  const engine = options.engine ?? searchEngine();
  const batch = options.batch ?? INDEX_SYNC_BATCH;
  const budgetMs = options.budgetMs ?? SYNC_BUDGET_MS;
  const leaseMs = options.leaseMs ?? INDEX_SYNC_LEASE_MS;
  const uid = indexUid;
  const started = Date.now();
  const total: SyncResult = { upserted: 0, removed: 0, done: 0, rejected: [], more: false };
  for (;;) {
    options.signal?.throwIfAborted();
    // Taken before the claim: the lease the database grants ends no earlier than this clock's.
    const claimedAt = Date.now();
    const claim = await withSystem('search.syncIndex', (tx) => repo.claimIndexSync(tx, batch, leaseMs, scope));
    if (claim.rows.length === 0) return total;
    // Every engine write starts well inside the lease: a sync that takes the rows over after it expired writes
    // after this one, so the engine applies the newer document last.
    const write = <T>(fn: () => Promise<T>) => {
      options.signal?.throwIfAborted();
      if (claimedAt + leaseMs - Date.now() < Math.min(LEASE_MARGIN_MS, leaseMs / 2)) throw new LeaseShort();
      return fn();
    };
    let refused: string[];
    try {
      const { docs, missing } = await withSystem('search.syncIndex', (tx) =>
        indexDocsFor(
          tx,
          claim.rows.map((r) => r.targetId),
        ),
      );
      refused = await upsertSplitting(engine, uid, docs, write);
      await engine.waitForTask(await write(() => engine.delete(uid, missing)), { timeoutMs: ENGINE_TASK_TIMEOUT_MS });
      total.upserted += docs.length - refused.length;
      total.removed += missing.length;
    } catch (err) {
      // Not pushed (or not known to be): the rows this claim still holds go back; the next sync pushes current state.
      await withSystem('search.syncIndex', (tx) => repo.releaseIndexSync(tx, claim.token));
      if (err instanceof LeaseShort) return { ...total, more: true };
      throw err;
    }
    total.done += await withSystem('search.syncIndex', async (tx) => {
      total.rejected.push(...(await repo.backOffIndexSync(tx, claim.token, refused)));
      return repo.finishIndexSync(tx, claim);
    });
    if (claim.rows.length < batch) return total;
    if (Date.now() - started > budgetMs) return { ...total, more: true };
  }
}

/** Upserts `docs`; a rejected batch is halved until the documents the engine refuses are found. Answers their ids. */
async function upsertSplitting(
  engine: SearchEngine,
  uid: string,
  docs: readonly ListingIndexDoc[],
  write: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<string[]> {
  if (docs.length === 0) return [];
  try {
    await engine.waitForTask(await write(() => engine.upsert(uid, docs)), { timeoutMs: ENGINE_TASK_TIMEOUT_MS });
    return [];
  } catch (err) {
    if (!rejected(err)) throw err;
    if (docs.length === 1) return [(docs[0] as ListingIndexDoc).id];
    const half = Math.ceil(docs.length / 2);
    return [
      ...(await upsertSplitting(engine, uid, docs.slice(0, half), write)),
      ...(await upsertSplitting(engine, uid, docs.slice(half), write)),
    ];
  }
}

export interface DriftReport {
  /** Targets with read models. */
  targets: number;
  /** Documents in the index (null: no index). */
  documents: number | null;
  /** Targets waiting for a push (their difference is lag, not drift). */
  queued: number;
  /** Age of the oldest waiting push. */
  oldestQueuedMs: number;
  sampled: number;
  /** Sampled targets whose index document is missing or other than their read models (now queued). */
  mismatched: string[];
  /** The count differs by more than the waiting pushes explain, or a sample mismatched: run `repairIndex`. */
  drift: boolean;
}

/**
 * Nightly drift check: index document count vs read-model targets, and a sample's `sourceHash` (same version,
 * other content included) vs the index. Mismatched samples are queued at once; the caller runs the repair walk on
 * drift. About five statements and three engine calls.
 */
export async function checkIndexDrift(options: { engine?: SearchEngine; sample?: number } = {}): Promise<DriftReport> {
  const engine = options.engine ?? searchEngine();
  const uid = indexUid;
  const { targets, sample, backlog } = await withSystem('search.checkIndexDrift', async (tx) => ({
    targets: await repo.countTargets(tx, scope),
    sample: scope ? [...scope] : await repo.sampleTargets(tx, options.sample ?? DRIFT_SAMPLE),
    backlog: await repo.indexSyncBacklog(tx, scope),
  }));
  const stats = await engine.stats(uid);
  const { docs } = await withSystem('search.checkIndexDrift', (tx) => indexDocsFor(tx, sample));
  const indexed = new Map(
    (await engine.fetch(uid, sample, ['id', 'sourceHash'])).map((d) => [String(d.id), d.sourceHash]),
  );
  const differing = docs.filter((d) => indexed.get(d.id) !== d.sourceHash).map((d) => d.id);
  const mismatched = await withSystem('search.checkIndexDrift', async (tx) => {
    const queued = await repo.queuedOf(tx, differing);
    const lost = differing.filter((id) => !queued.has(id));
    await repo.queueIndexSync(tx, lost);
    return lost;
  });
  const documents = stats?.documents ?? null;
  const countOff = documents === null || Math.abs(documents - targets) > backlog.queued;
  return {
    targets,
    documents,
    queued: backlog.queued,
    oldestQueuedMs: Math.round(backlog.oldestAgeMs),
    sampled: sample.length,
    mismatched,
    drift: countOff || mismatched.length > 0,
  };
}

export interface RepairResult {
  /** Read-model targets compared and those queued (missing or other in the index). */
  targets: number;
  stale: number;
  /** Index documents compared and those queued for removal (no read model). */
  documents: number;
  orphans: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Repair walk (after drift): every read-model target whose index document is missing or other, and every index
 * document without read models, is queued for the sync. Idempotent; a page per transaction and engine call. Both
 * sides page by id (S6-F2: the index too, `id > last`, not by offset), so documents deleted during the walk skip
 * nothing; one added behind the walk's position is the next check's.
 */
export async function repairIndex(
  options: { engine?: SearchEngine; page?: number; onPage?: (progress: RepairResult) => void | Promise<void> } = {},
): Promise<RepairResult> {
  const engine = options.engine ?? searchEngine();
  const page = options.page ?? REPAIR_PAGE;
  const uid = indexUid;
  const result: RepairResult = { targets: 0, stale: 0, documents: 0, orphans: 0 };

  // Read models → index.
  for (let after: string | null = null; ; ) {
    const from = after;
    const { ids, docs } = await withSystem('search.repairIndex', async (tx) => {
      const ids = await repo.targetPage(tx, from, page, scope);
      return { ids, docs: (await indexDocsFor(tx, ids)).docs };
    });
    if (ids.length === 0) break;
    const indexed = new Map(
      (await engine.fetch(uid, ids, ['id', 'sourceHash'])).map((d) => [String(d.id), d.sourceHash]),
    );
    const stale = docs.filter((d) => indexed.get(d.id) !== d.sourceHash).map((d) => d.id);
    await withSystem('search.repairIndex', (tx) => repo.queueIndexSync(tx, stale));
    result.targets += ids.length;
    result.stale += stale.length;
    await options.onPage?.({ ...result });
    if (ids.length < page) break;
    after = ids[ids.length - 1] as string;
  }

  // Index → read models: documents of targets that have none any more.
  const def = listingsIndex(uid);
  for (let after: string | null = null; ; ) {
    const { results } = await engine.browse(def, { after, limit: page, fields: ['id'] });
    if (results.length === 0) break;
    const ids = results.map((d) => String(d.id)).filter((id) => UUID.test(id));
    const orphans = await withSystem('search.repairIndex', async (tx) => {
      const existing = await repo.existingTargets(tx, ids);
      const gone = ids.filter((id) => !existing.has(id));
      await repo.queueIndexSync(tx, gone);
      return gone;
    });
    result.documents += results.length;
    result.orphans += orphans.length;
    await options.onPage?.({ ...result });
    if (results.length < page) break;
    const last = results[results.length - 1]?.id;
    if (last === undefined || last === null) throw new SearchError('repair walk: a document without an id');
    after = String(last);
  }
  return result;
}
