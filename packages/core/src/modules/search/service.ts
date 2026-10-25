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
import { ListingDetailDoc, PUBLIC_SEARCH_STATUSES } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { withSystem } from '@inmolink/db';
import { emit, type OutboxMessage } from '@inmolink/platform/outbox';
import {
  type EnsureIndexResult,
  type IndexDefinition,
  type SearchEngine,
  searchEngine,
} from '@inmolink/platform/search';
import { compileOwner, NO_OWNER as NO_IDENTITY, type OwnerIdentity, type OwnerMatcher } from '../../white-label';
import * as agencies from '../agencies';
import * as developments from '../developments';
import * as identity from '../identity';
import * as media from '../media';
import * as properties from '../properties';
import * as taxonomy from '../taxonomy';
import { type BuiltDoc, buildListingDocs, buildUnitDocs, type DocOwner } from './build';
import { NETWORK_LOST_AGENCIES, PUBLIC_DOCS_EVENT_TARGETS, searchEvents } from './events';
import {
  buildIndexDoc,
  commissionShareBp,
  type IndexSourceRow,
  type ListingIndexDoc,
  listingsIndex,
} from './index-doc';
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
  /** The developers' own references of the units' developments (S7-F6: their development rows keep them). */
  developmentRefs?: ReadonlyMap<string, string>;
}

/** An agency without settings: no locales, so no documents. */
const NO_OWNER: DocOwner = { locales: [], publishes: false, preferred: [] };

/** Every content locale these owners use (a batch spans agencies). */
const localesIn = (owners: Map<string, agencies.ReadModelOwner>) => [
  ...new Set([...owners.values()].flatMap((o) => o.locales)),
];

/**
 * Rebuilds the read models of these listings (any agency). About ten statements for any number. A PUBLIC listing of an
 * owner that does not publish (suspended, unlisted: S6-F1) keeps its documents for its own and network paths, with
 * `public` false — so it leaves `app_public`'s reads, the fallback rows and the PUBLIC index.
 */
export async function rebuildListingReadModels(
  tx: Tx,
  ids: readonly string[],
  options: WriteOptions = {},
): Promise<RebuildResult> {
  const unique = [...new Set(ids)];
  await repo.lockTargets(tx, unique);
  const listings = await properties.listingsForReadModels(tx, unique);
  const live = listings.map((l) => l.id);
  const ownerOf = await agencies.readModelOwnersOf(
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
      localesIn(ownerOf),
    ),
  ]);
  const docs = listings.flatMap((l) =>
    buildListingDocs(l, mediaOf.get(l.id), tax, ownerOf.get(l.agencyId) ?? NO_OWNER),
  );
  return {
    ...(await write(tx, 'LISTING', unique, docs, options)),
    built: new Set(docs.map((d) => d.targetId)).size,
    pendingMedia: listings.filter((l) => (mediaOf.get(l.id)?.pending ?? 0) > 0).map((l) => l.id),
  };
}

/** Rebuilds the read models of these new-build units (any agency). About eight statements for any number. */
export async function rebuildUnitReadModels(
  tx: Tx,
  ids: readonly string[],
  options: WriteOptions = {},
): Promise<RebuildResult> {
  const unique = [...new Set(ids)];
  await repo.lockTargets(tx, unique);
  const units = await developments.unitsForReadModels(tx, unique);
  const ownerOf = await agencies.readModelOwnersOf(
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
    localesIn(ownerOf),
  );
  const docs = units.flatMap((u) => buildUnitDocs(u, tax, ownerOf.get(u.agencyId) ?? NO_OWNER));
  return {
    ...(await write(tx, 'UNIT', unique, docs, options)),
    built: new Set(docs.map((d) => d.targetId)).size,
    pendingMedia: [],
  };
}

export interface WriteOptions {
  /**
   * Refresh the changed targets' fallback rows (default). The full rebuild passes false: it refreshes every target of
   * its page once itself (S6-F3), changed or not.
   */
  refreshSearchDocs?: boolean;
}

/**
 * Writes the documents and, in the same transaction, queues the changed targets' index push (S5-03) and brings their
 * fallback rows up to date (S5-04) unless the caller does (`refreshSearchDocs: false`).
 */
async function write(tx: Tx, kind: ReadModelKind, ids: readonly string[], docs: BuiltDoc[], options: WriteOptions) {
  const developmentRefs = new Map<string, string>();
  for (const d of docs) if (d.developmentId && d.developmentRef) developmentRefs.set(d.developmentId, d.developmentRef);
  const dropped = await repo.deleteOthers(tx, ids, docs);
  const deleted = dropped.map((r) => r.targetId);
  const written = await repo.upsertDocs(tx, docs);
  // S5-06: the listings whose read models changed, for the saved searches' alerts (matching)
  if (kind === 'LISTING') await emit(tx, listingsChangedEvents(written, dropped, docs));
  // Public targets get their public code (S7-02) once; a target that got one now is pushed again with it. Their
  // developments get one in the same statement (S7-F6: sites name developments `<prefix>-<code>`); a development is
  // not a target, so its new code changes nothing here.
  const publicDocs = docs.filter((d) => d.public);
  const targets = new Set(publicDocs.map((d) => d.targetId));
  const coded = (
    await ensurePublicCodes(tx, [
      ...targets,
      ...publicDocs.flatMap((d) => (d.developmentId === null ? [] : [d.developmentId])),
    ])
  ).filter((id) => targets.has(id));
  // Commission (S7-F4) is read from the listing or unit itself, so an edit of only the commission leaves the read
  // model alone: its rows are compared here and a target whose commission changed is pushed like a changed document.
  const wanted = await commissionOf(
    tx,
    docs.filter((d) => d.public),
  );
  const moved = await repo.syncCommissions(tx, ids, wanted);
  const changed = [...new Set([...deleted, ...written, ...coded, ...moved])];
  if (changed.length > 0) {
    await logPublicChanges(tx, changed, docs);
    await repo.queueIndexSync(tx, changed);
    if (options.refreshSearchDocs !== false) await refreshSearchDocs(tx, changed, developmentRefs);
  }
  return { written: written.length, deleted: deleted.length, developmentRefs };
}

/**
 * S5-06: `search.listings.changed` for the listings whose read models were written or dropped — per owner agency, in
 * chunks of `PUBLIC_DOCS_EVENT_TARGETS`. No event when none changed (an unchanged rebuild).
 */
function listingsChangedEvents(
  written: readonly string[],
  dropped: readonly { targetId: string; agencyId: string }[],
  docs: readonly BuiltDoc[],
): OutboxMessage[] {
  const ownerOf = new Map<string, string>(dropped.map((r) => [r.targetId, r.agencyId]));
  for (const d of docs) ownerOf.set(d.targetId, d.agencyId);
  const byOwner = new Map<string, Set<string>>();
  for (const id of [...written, ...dropped.map((r) => r.targetId)]) {
    const owner = ownerOf.get(id);
    if (!owner) continue;
    const set = byOwner.get(owner) ?? new Set<string>();
    set.add(id);
    byOwner.set(owner, set);
  }
  const events: OutboxMessage[] = [];
  for (const [agencyId, set] of byOwner) {
    const listingIds = [...set];
    for (let i = 0; i < listingIds.length; i += PUBLIC_DOCS_EVENT_TARGETS) {
      events.push(
        searchEvents.listingsChanged({ agencyId, listingIds: listingIds.slice(i, i + PUBLIC_DOCS_EVENT_TARGETS) }),
      );
    }
  }
  return events;
}

/**
 * The website change log (S7-03, `/v2/changes`): of these changed targets, the PUBLIC ones now (their new document,
 * sharing or commission may change what a site shows) and those that were PUBLIC (a fallback row: they leave every
 * site), each with who could have seen it before or after (shared with all, or the owner's preferred agencies — a
 * network site's feed reads only those). Targets public neither before nor after concern no website. S7-06: the same
 * targets go out as `search.publicDocs.changed` (per owner agency, ≤ 100 per event) for the website edge cache purge.
 * Three statements.
 */
async function logPublicChanges(tx: Tx, changed: readonly string[], docs: readonly BuiltDoc[]): Promise<void> {
  if (changed.length === 0) return;
  const before = new Map((await repo.publicRowsOf(tx, changed)).map((r) => [r.targetId, r]));
  const after = new Map<string, BuiltDoc>();
  for (const d of docs) if (d.public && !after.has(d.targetId)) after.set(d.targetId, d);
  const rows: repo.PublicChangeRow[] = [];
  for (const id of new Set(changed)) {
    const was = before.get(id);
    const now = after.get(id);
    if (!was && !now) continue;
    const preferred = [...new Set([...(was?.preferredAgencyIds ?? []), ...(now?.preferredAgencyIds ?? [])])].sort();
    rows.push({
      targetId: id,
      kind: (now?.kind ?? was?.kind) as BuiltDoc['kind'],
      ownerAgencyId: (now?.agencyId ?? was?.ownerAgencyId) as string,
      ref: now ? now.card.ref : (was?.ref as string),
      // Units and listings shared with ALL (null: a unit, or a row from before the sharing columns).
      sharedAll:
        (now !== undefined && now.shareScope !== 'PREFERRED') || (was !== undefined && was.shareScope !== 'PREFERRED'),
      preferredAgencyIds: preferred.length > 0 ? preferred : null,
    });
  }
  await repo.logPublicChanges(tx, rows);
  await emit(tx, publicDocsEvents(rows, before, after));
}

/** `search.publicDocs.changed` for these change-log rows: per owner agency, in chunks; the units' developments too. */
function publicDocsEvents(
  rows: readonly repo.PublicChangeRow[],
  before: ReadonlyMap<string, repo.PublicRowBefore>,
  after: ReadonlyMap<string, BuiltDoc>,
): OutboxMessage[] {
  const byOwner = new Map<string, string[]>();
  for (const r of rows) byOwner.set(r.ownerAgencyId, [...(byOwner.get(r.ownerAgencyId) ?? []), r.targetId]);
  const events: OutboxMessage[] = [];
  for (const [agencyId, ids] of byOwner) {
    for (let i = 0; i < ids.length; i += PUBLIC_DOCS_EVENT_TARGETS) {
      const targetIds = ids.slice(i, i + PUBLIC_DOCS_EVENT_TARGETS);
      // A unit's development before and after: a unit leaving the public set changes its development's card too.
      const developmentIds = [
        ...new Set(
          targetIds.flatMap((id) =>
            [after.get(id)?.developmentId, before.get(id)?.developmentId].filter((d): d is string => !!d),
          ),
        ),
      ];
      const networkLost = lostByNetwork(targetIds, before, after);
      events.push(
        searchEvents.publicDocsChanged({
          agencyId,
          targetIds,
          developmentIds,
          ...(networkLost ? { networkLost } : {}),
        }),
      );
    }
  }
  return events;
}

const SHOWN_STATUSES: ReadonlySet<string> = new Set(PUBLIC_SEARCH_STATUSES);

/**
 * Who could see a target on network sites: nobody unless it is public, in a status sites show and not hidden from
 * the network (S6-F2 freshness); then every agency (shared with ALL, or a unit) or the preferred ones.
 */
function networkAudience(
  doc:
    | {
        /** Absent on fallback rows (public by definition). */
        public?: boolean;
        status: string;
        networkHidden: boolean;
        shareScope: string | null;
        preferredAgencyIds: string[] | null;
      }
    | undefined,
): 'ALL' | ReadonlySet<string> {
  if (!doc || doc.public === false || doc.networkHidden || !SHOWN_STATUSES.has(doc.status)) return new Set();
  return doc.shareScope === 'PREFERRED' ? new Set(doc.preferredAgencyIds ?? []) : 'ALL';
}

/**
 * S8-F1: the agencies that may have lost sight of some of these targets on their network sites — no longer public, no
 * longer in a status sites show (sold, withdrawn), hidden from the network, or shared more narrowly (ALL → PREFERRED,
 * fewer preferred agencies). Undefined when none did (a change that keeps or
 * widens who sees a target reaches partner feeds through their periodic refresh).
 */
function lostByNetwork(
  ids: readonly string[],
  before: ReadonlyMap<string, repo.PublicRowBefore>,
  after: ReadonlyMap<string, BuiltDoc>,
): { all: boolean; agencyIds: string[] } | undefined {
  const lost = new Set<string>();
  for (const id of ids) {
    const was = networkAudience(before.get(id));
    const now = networkAudience(after.get(id));
    if (now === 'ALL') continue;
    if (was === 'ALL') return { all: true, agencyIds: [] };
    for (const agency of was) if (!now.has(agency)) lost.add(agency);
  }
  if (lost.size === 0) return undefined;
  if (lost.size > NETWORK_LOST_AGENCIES) return { all: true, agencyIds: [] };
  return { all: false, agencyIds: [...lost].sort() };
}

/** Collisions of fresh random codes are drawn again this many times (40 bits: practically never needed). */
const PUBLIC_CODE_ATTEMPTS = 5;

/** Gives public targets without a public code one (S7-02); answers those that got one now. */
async function ensurePublicCodes(tx: Tx, ids: readonly string[]): Promise<string[]> {
  const created: string[] = [];
  let pending = [...new Set(ids)];
  for (let attempt = 0; pending.length > 0; attempt++) {
    if (attempt === PUBLIC_CODE_ATTEMPTS) throw new Error('search: no free public code after retries');
    const result = await repo.insertPublicCodes(tx, pending);
    created.push(...result.created);
    pending = result.collided;
  }
  return created;
}

/** Public codes of these targets (S7-02): websites show another agency's document as `<prefix>-<code>`. */
export function publicCodes(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  return repo.publicCodes(tx, ids);
}

/** Whether a public code is taken by a real target (S7-04: honeytoken hits are confirmed against it). */
export function publicCodeInUse(tx: Tx, code: string): Promise<boolean> {
  return repo.publicCodeInUse(tx, code);
}

/**
 * Makes these targets' fallback rows (S5-04) match their read models: the PUBLIC index document's filter fields, no
 * row otherwise — and the development rows of the units among them (S7-F6, `listing_search_developments`: one more
 * statement when units are). Three statements per `READ_MODEL_BATCH` targets; unchanged rows are not rewritten.
 */
async function refreshSearchDocs(
  tx: Tx,
  ids: readonly string[],
  developmentRefs: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  // The fallback matches no text (references only): documents without text, no owner identities read (S7-F5).
  const { docs, missing } = await indexDocsFor(tx, ids, { text: false });
  await repo.upsertSearchDocs(
    tx,
    docs.filter((d) => d.visibility === 'PUBLIC'),
  );
  const dropped = await repo.deleteSearchDocs(tx, [
    ...missing,
    ...docs.filter((d) => d.visibility !== 'PUBLIC').map((d) => d.id),
  ]);
  const developments = [
    ...dropped,
    ...docs.flatMap((d) => (d.kind === 'UNIT' && d.developmentId ? [d.developmentId] : [])),
  ];
  await repo.refreshDevelopments(tx, developments, developmentRefs);
}

export const rebuildReadModels = (tx: Tx, kind: ReadModelKind, ids: readonly string[], options: WriteOptions = {}) =>
  kind === 'LISTING' ? rebuildListingReadModels(tx, ids, options) : rebuildUnitReadModels(tx, ids, options);

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

export interface DrainOptions {
  /** Images still processing: rebuild again this much later, at most `maxRechecks` times. */
  recheckMs: number;
  maxRechecks: number;
  /** A claimed row is held this long; a rebuild that died is retried after it. */
  leaseMs: number;
  /** Stop claiming after this long (the job's time box); what is left stays queued. */
  budgetMs: number;
  /** Wait in-process for targets due within this long (the tail of a burst) rather than queue a later run. */
  waitMs: number;
  batch?: number;
  signal?: AbortSignal;
  /** After each committed batch (outside its transaction): the index push for what it changed. */
  onBatch?: (r: Omit<RebuildResult, 'pendingMedia'>) => Promise<void>;
}

export interface DrainResult extends Omit<RebuildResult, 'pendingMedia'> {
  /** Rebuild transactions run. */
  batches: number;
  /** Targets queued again for their images. */
  rechecked: number;
  /** Milliseconds until the agency's next queued target is due, or null when the queue holds none of it. */
  nextDueMs: number | null;
}

/**
 * Drains an agency's due read-model rebuilds (S5-F4): claims up to `batch` targets, rebuilds them in one transaction
 * per claim (about ten statements per kind, however many targets), queues image rechecks and deletes the rows it
 * built — in that same transaction, so a crash leaves them queued. Repeats until nothing is due or the budget is
 * spent. Idempotent: a rebuild reads current state.
 */
export async function drainReadModelQueue(agencyId: string, options: DrainOptions): Promise<DrainResult> {
  const batch = options.batch ?? READ_MODEL_BATCH;
  const deadline = Date.now() + options.budgetMs;
  const total: DrainResult = { built: 0, written: 0, deleted: 0, batches: 0, rechecked: 0, nextDueMs: null };
  const reason = 'search.buildReadModels';
  for (;;) {
    if (options.signal?.aborted || Date.now() >= deadline) break;
    const claim = await withSystem(reason, (tx) => repo.claimReadModels(tx, agencyId, batch, options.leaseMs));
    if (claim.rows.length === 0) {
      const next = await withSystem(reason, (tx) => repo.nextReadModelDue(tx, agencyId));
      if (next === null || next > options.waitMs || Date.now() + next >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.max(next, 0) + 10));
      continue;
    }
    const done = { built: 0, written: 0, deleted: 0 };
    try {
      await withSystem(reason, async (tx) => {
        for (const kind of ['LISTING', 'UNIT'] as const) {
          const ids = claim.rows.filter((r) => r.kind === kind).map((r) => r.targetId);
          if (ids.length === 0) continue;
          const r = await rebuildReadModels(tx, kind, ids);
          add(done, r);
          total.rechecked += await repo.rescheduleReadModels(
            tx,
            claim,
            r.pendingMedia,
            options.maxRechecks,
            options.recheckMs,
          );
        }
        await repo.finishReadModels(tx, claim);
      });
    } catch (err) {
      await withSystem(reason, (tx) => repo.releaseReadModels(tx, claim));
      throw err;
    }
    total.batches += 1;
    total.built += done.built;
    total.written += done.written;
    total.deleted += done.deleted;
    await options.onBatch?.(done);
  }
  total.nextDueMs = await withSystem(reason, (tx) => repo.nextReadModelDue(tx, agencyId));
  return total;
}

/** Queues rebuilds (debounced by `delayMs`), outside any caller transaction. */
export function queueReadModelChanges(changes: readonly repo.ReadModelChange[], delayMs: number): Promise<void> {
  return withSystem('search.queueReadModels', (tx) => repo.queueReadModels(tx, changes, delayMs));
}

/** Targets queued per statement when a whole agency is queued (S6-F1). */
export const AGENCY_QUEUE_PAGE = 5_000;

/**
 * Queues a rebuild of all of an agency's read-model targets (S6-F1: its status changed, which decides whether they are
 * public) — or, `preferredOnly`, of its listings shared to PREFERRED (S6-F2: its preferred list changed, which their
 * documents name) — outside any caller transaction: `AGENCY_QUEUE_PAGE` per transaction, so a large agency never
 * makes one long statement. Answers how many were queued.
 */
export async function queueAgencyReadModelChanges(
  agencyId: string,
  delayMs: number,
  options: { pageSize?: number; preferredOnly?: boolean } = {},
): Promise<number> {
  const pageSize = options.pageSize ?? AGENCY_QUEUE_PAGE;
  const preferredOnly = options.preferredOnly === true;
  let queued = 0;
  for (const kind of preferredOnly ? (['LISTING'] as const) : (['LISTING', 'UNIT'] as const)) {
    let after: string | null = null;
    for (;;) {
      const from: string | null = after;
      const page: { queued: number; last: string | null } = await withSystem('search.queueAgencyReadModels', (tx) =>
        repo.queueAgencyReadModels(tx, { agencyId, kind, after: from, limit: pageSize, preferredOnly }, delayMs),
      );
      queued += page.queued;
      if (page.last === null) break;
      after = page.last;
    }
  }
  return queued;
}

/**
 * Queues the index push of all of an agency's targets (S7-F5: its name, contacts or website — removed from their
 * indexed text — may have changed; read models do not change, so no rebuild would push them), `AGENCY_QUEUE_PAGE`
 * per transaction, outside any caller transaction. Answers how many were queued.
 */
export async function queueAgencyIndexPushes(agencyId: string, options: { pageSize?: number } = {}): Promise<number> {
  const limit = options.pageSize ?? AGENCY_QUEUE_PAGE;
  let queued = 0;
  // One kind at a time: the keyset follows the (agency, kind, target) index.
  for (const kind of ['LISTING', 'UNIT'] as const) {
    let after: string | null = null;
    for (;;) {
      const from: string | null = after;
      const page: { queued: number; last: string | null } = await withSystem('search.queueAgencyIndexSync', (tx) =>
        repo.queueAgencyIndexSync(tx, { agencyId, kind, after: from, limit }),
      );
      queued += page.queued;
      if (page.last === null) break;
      after = page.last;
    }
  }
  return queued;
}

/** Agencies whose queued rebuilds are overdue and unclaimed (their job was lost). */
export function overdueReadModelAgencies(overdueMs: number, limit: number): Promise<string[]> {
  return withSystem('search.sweepReadModelQueue', (tx) => repo.overdueReadModelAgencies(tx, overdueMs, limit));
}

function add(total: Omit<RebuildResult, 'pendingMedia'> & { pendingMedia?: string[] }, r: RebuildResult): void {
  total.built += r.built;
  total.written += r.written;
  total.deleted += r.deleted;
  total.pendingMedia?.push(...r.pendingMedia);
}

/** Targets per rebuild transaction: ~10 statements and ≤ this many advisory locks each. */
export const READ_MODEL_BATCH = 250;
/** Most stale read-model rows the full rebuild's sweep deletes in one statement (and one transaction). */
export const READ_MODEL_SWEEP_MAX = 5_000;

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
  /** Stale rows the sweep deletes per statement (default: ≤ `READ_MODEL_SWEEP_MAX`, within the lock budget). */
  sweepBatch?: number;
  onProgress?: (p: FullRebuildProgress) => void;
  /** System reason for the audit trail. */
  reason?: string;
}

/**
 * Rebuilds every read model (or one agency's): walks live listings and units in id order, a page per transaction,
 * and deletes the documents of targets that no longer have one — those between two live ids of a page that are
 * not live, in bounded chunks after the page commits. Idempotent and restartable; unchanged documents are not
 * rewritten.
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
  // The sweep's chunk: ≤ 5,000 rows per statement, and within the run's share of the lock table across its lanes.
  const sweepBatch =
    options.sweepBatch ?? Math.min(READ_MODEL_SWEEP_MAX, Math.floor(MAX_LOCKS_IN_FLIGHT / concurrency));
  if (sweepBatch < 1 || sweepBatch > READ_MODEL_SWEEP_MAX || sweepBatch * concurrency > MAX_LOCKS_IN_FLIGHT) {
    throw new RangeError(
      `sweepBatch must be 1…${READ_MODEL_SWEEP_MAX} and sweepBatch × concurrency ≤ ${MAX_LOCKS_IN_FLIGHT}`,
    );
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
        const res = await withSystem(reason, async (tx) => {
          // The page's fallback rows are refreshed once below, not also for its changed targets (S6-F3).
          const built = await rebuildReadModels(tx, kind, ids, { refreshSearchDocs: false });
          // Every live target of the page, changed or not: the full rebuild also fills and repairs the fallback.
          await refreshSearchDocs(tx, ids, built.developmentRefs);
          return built;
        });
        const r = { ...res, deleted: res.deleted + (await sweep(from, until, ids)) };
        progress.done += ids.length;
        progress.built += r.built;
        progress.written += r.written;
        progress.deleted += r.deleted;
        progress.elapsedMs = Date.now() - started;
        options.onProgress?.({ ...progress });
      }
    };
    /**
     * Deletes the documents of targets gone between two live ones of a page, `sweepBatch` rows per transaction
     * (keyset on the primary key): each candidate holds an advisory lock until commit, so one statement over a range
     * of ~100k stale rows exhausted the shared lock table (53200). Answers how many targets went.
     */
    const sweep = async (from: string | null, until: string | null, live: readonly string[]) => {
      let deleted = 0;
      let at: repo.SweepPosition | null = null;
      do {
        const start: repo.SweepPosition | null = at;
        const chunk = await withSystem(reason, async (tx) => {
          const c = await repo.deleteBetween(tx, {
            kind,
            after: from,
            until,
            live,
            since,
            agencyId: options.agencyId,
            from: start,
            limit: sweepBatch,
          });
          if (c.deleted.length > 0) {
            await repo.queueIndexSync(tx, c.deleted);
            await logPublicChanges(tx, c.deleted, []);
            await refreshSearchDocs(tx, c.deleted);
          }
          return c;
        });
        deleted += chunk.deleted.length;
        at = chunk.next;
      } while (at);
      return deleted;
    };
    // Every lane settles before the run answers (or fails): none outlives the caller's connection pool.
    const lanes = await Promise.allSettled(Array.from({ length: concurrency }, lane));
    const failed = lanes.find((l): l is PromiseRejectedResult => l.status === 'rejected');
    if (failed) throw failed.reason;
    out[kind] = progress;
  }
  return out;
}

/** An own listing's detail document in one content locale (portal feeds). */
export interface OwnListingDetail {
  targetId: string;
  locale: string;
  doc: ListingDetailDoc;
  updatedAt: Date;
}

/**
 * The agency's own PUBLIC listings' detail documents in these locales (S9-02, raw `tx`, `withSystem`, no
 * authorization — PATTERNS §12). One statement. A target without a public read model in a locale is absent there;
 * a stored document that no longer parses is left out too (the caller reports the listing as having no document).
 */
export async function ownListingDetails(
  tx: Tx,
  agencyId: string,
  ids: readonly string[],
  locales: readonly string[],
): Promise<OwnListingDetail[]> {
  const rows = await repo.ownListingDetails(tx, agencyId, ids, locales);
  return rows.flatMap((r) => {
    const doc = ListingDetailDoc.safeParse(r.detail);
    return doc.success ? [{ targetId: r.targetId, locale: r.locale, doc: doc.data, updatedAt: r.updatedAt }] : [];
  });
}

/**
 * Reference and title of these listings for a list page (S12-F21): from the read models, as far as the caller's RLS
 * shows them (their own, or a network listing), in `locale` else English else any built locale. One statement.
 */
export async function listingLabels(
  tx: Tx,
  ids: readonly string[],
  locale: string,
): Promise<Map<string, { reference: string; title: string | null }>> {
  const rows = await repo.cardLabels(tx, [...new Set(ids)]);
  const rank = (l: string) => (l === locale ? 0 : l === 'en' ? 1 : 2);
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = best.get(r.targetId);
    if (!cur || rank(r.locale) < rank(cur.locale)) best.set(r.targetId, r);
  }
  return new Map([...best].map(([id, r]) => [id, { reference: r.reference, title: r.title || null }]));
}

/**
 * These targets' stored documents, every locale (or one), with their audience flags (`public`, `status`,
 * `networkHidden`) and the development's own reference: workers (raw `tx` under `withSystem`, e.g. the S12-03
 * white-label model pass), tests and ops checks. Never a request path (public paths read `publicDocs`).
 */
export function readModelDocs(tx: Tx, ids: readonly string[], locale?: string) {
  return repo.readDocs(tx, ids, locale);
}

/**
 * The total commission of these targets in basis points of their price (S7-F4), read from the listings and units
 * themselves — read models never carry it. Two statements at most; a target without a commission or with an unknown
 * share (a fixed amount of an on-request price) has none.
 */
async function commissionOf(
  tx: Tx,
  rows: readonly { targetId: string; kind: 'LISTING' | 'UNIT' }[],
): Promise<Map<string, number>> {
  const ids = (kind: 'LISTING' | 'UNIT') => [...new Set(rows.filter((r) => r.kind === kind).map((r) => r.targetId))];
  // One after the other: the same transaction runs one statement at a time.
  const listingTerms = await properties.listingCommissionTerms(tx, ids('LISTING'));
  const unitTerms = await developments.unitCommissionTerms(tx, ids('UNIT'));
  const out = new Map<string, number>();
  for (const t of [...listingTerms, ...unitTerms]) {
    const bp = commissionShareBp(t);
    if (bp !== null) out.set(t.id, bp);
  }
  return out;
}

/**
 * Index documents of these targets, built from their read models (S5-02); `missing` have no read model any more
 * (their index documents must go). One statement per `READ_MODEL_BATCH` targets, plus the owners' identities for the
 * white-labelled text (S7-F5; `text: false`: documents without text). Worker-facing: raw `tx` under `withSystem`.
 */
export async function indexDocsFor(
  tx: Tx,
  ids: readonly string[],
  options: { text?: boolean } = {},
): Promise<{ docs: ListingIndexDoc[]; missing: string[] }> {
  const unique = [...new Set(ids)];
  const rows: Awaited<ReturnType<typeof repo.readIndexRows>> = [];
  // Bounded statements: one per READ_MODEL_BATCH targets.
  for (let i = 0; i < unique.length; i += READ_MODEL_BATCH) {
    rows.push(...(await repo.readIndexRows(tx, unique.slice(i, i + READ_MODEL_BATCH))));
  }
  const commission = await commissionOf(tx, rows);
  const byTarget = new Map<string, IndexSourceRow[]>();
  for (const { features, ...r } of rows) {
    const list = byTarget.get(r.targetId) ?? [];
    list.push({
      ...r,
      featureIds: (features ?? []).map((f) => f.id),
      commissionBp: commission.get(r.targetId) ?? null,
    });
    byTarget.set(r.targetId, list);
  }
  // Owners' identities, removed from the indexed text (S7-F5): two statements for the batch's owners, each owner's
  // patterns compiled once. Without text (the fallback rows), none.
  let matchers: Map<string, OwnerMatcher> | null = null;
  if (options.text !== false) {
    const owners = await ownerIdentitiesForIndex(tx, [...new Set(rows.map((r) => r.agencyId))]);
    matchers = new Map([...owners].map(([id, o]) => [id, compileOwner(o)]));
  }
  const unknown = compileOwner(NO_IDENTITY);
  const docs = [...byTarget.values()].flatMap(
    (r) => buildIndexDoc(r, matchers ? (matchers.get(r[0]?.agencyId ?? '') ?? unknown) : null) ?? [],
  );
  return { docs, missing: unique.filter((id) => !byTarget.has(id)) };
}

/**
 * Owners' identities as the index removes them from their documents' text (S7-F5): the agency's own
 * (`agencies.indexOwnerIdentities`) and its team's e-mails and full names (`identity.teamContacts`; a single-word
 * member name — "Ana" — is too common a word to remove). Two statements. Worker-facing: raw `tx` under `withSystem`.
 */
export async function ownerIdentitiesForIndex(tx: Tx, ids: readonly string[]): Promise<Map<string, OwnerIdentity>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  // One after the other: the same transaction runs one statement at a time.
  const own = await agencies.indexOwnerIdentities(tx, unique);
  const team = await identity.teamContacts(tx, unique);
  return new Map(
    unique.map((id) => {
      const o = own.get(id) ?? NO_IDENTITY;
      const t = team.get(id);
      const fullNames = (t?.names ?? []).filter((n) => n.trim().split(/\s+/).length >= 2);
      return [
        id,
        {
          ...o,
          names: [...new Set([...o.names, ...fullNames])],
          emails: [...new Set([...o.emails, ...(t?.emails ?? [])])],
        },
      ];
    }),
  );
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
