/**
 * Delta sync (S14-04, PLAN §14 Path A step 5): during the parallel run, every hour, what changed in a legacy agency since
 * the last delta reaches v2 through the same load paths as the full load (S14-02 `migrateLegacyAgency`).
 *
 * - **Change detection.** The legacy reader (`LegacyDeltaSource`; the read-only legacy database, H1) answers the rows
 *   changed since a watermark — by the legacy `updated_at` where the table has one, else every row of the agency (the
 *   full-compare fallback: an unchanged listing writes nothing, its import hash is the same; a migrated contact or lead
 *   is kept as v2 has it). Developments and units are always read whole (units must meet their development). The
 *   watermark is the legacy clock when the read snapshot began, minus `DELTA.OVERLAP_MS` on the next read (a legacy
 *   transaction that committed late is read again: every load is idempotent). It moves only when the load completed.
 * - **Deletions.** A migrated listing whose legacy row is gone is withdrawn (never deleted; it comes back when the row
 *   does). A legacy agency that suddenly lacks more than `DELTA.WITHDRAW_MAX_SHARE` of its listings withdraws nothing
 *   (a broken read is far likelier than an agency deleting its stock): the run reports the guard for staff.
 * - **v2 edits win.** Fields an agent locked keep their value (the listing MERGE, PLAN §3 #18); a migrated contact or
 *   lead is never rewritten (v2 is authoritative once loaded). From the agency's cutover (`markLegacyAgencyCutOver`,
 *   agents work in v2 and legacy becomes read-only) the delta stops for it.
 *
 * Checkpoints: the delta's batches are recorded under `delta:<entity>` (never replacing the full load's); its state —
 * watermark (seq 0) and cutover (seq 1) — lives in `migration_batches` under `delta:state` (operator data,
 * `withSystem()`).
 */
import { createHash } from 'node:crypto';
import { withSystem } from '@inmolink/db';
import * as properties from '../properties';
import {
  LEGACY_STAGING,
  type LegacyStagingEntity,
  type MigrateLegacyAgencyResult,
  migrateLegacyAgency,
  type StagedSource,
} from './legacy-agency';
import * as repo from './repo';

export const DELTA = {
  /** The schedule: a legacy change reaches v2 within one interval plus one run (< 70 minutes). */
  INTERVAL_MS: 3_600_000,
  /** Each read starts this much before the watermark (late commits, clock skew between legacy and v2). */
  OVERLAP_MS: 10 * 60_000,
  /** Checkpoint keys of the delta's batches and state. */
  CHECKPOINT_PREFIX: 'delta:',
  STATE_ENTITY: 'delta:state',
  /** Missing listings withdrawn in one run without the guard: this share of the migrated ones … */
  WITHDRAW_MAX_SHARE: 0.2,
  /** … or this many, whichever is larger. */
  WITHDRAW_MIN_ALLOWED: 10,
  /** Migrated listings read, and withdrawn, per statement / transaction. */
  PAGE: 1_000,
  /** Legacy agencies read per statement by the scheduler. */
  AGENCY_PAGE: 500,
} as const;

/** Read whole on every delta (one batch of a few hundred rows per agency, S14-02). */
const WHOLE: ReadonlySet<LegacyStagingEntity> = new Set(['developments', 'units']);
const SEQ = { watermark: 0, cutover: 1 } as const;

/**
 * The legacy side of one delta (one read-only snapshot of the legacy database): the script's and the worker's reader
 * (`scripts/legacy-migration/delta-lib.ts`), fixtures in tests.
 */
export interface LegacyDeltaSource {
  /** The legacy database's clock when the read snapshot began (the next watermark). */
  readonly snapshotAt: Date;
  /** Rows of the entity changed after `since` (every row when null or when the table has no timestamp). */
  changed(entity: LegacyStagingEntity, since: Date | null): StagedSource | undefined;
  /** Every listing id the legacy agency holds now (deletion check), in batches. */
  listingIds(): AsyncIterable<readonly string[]>;
}

export interface OpenedLegacyDeltaSource extends LegacyDeltaSource {
  close(): Promise<void>;
}

/** Opens the reader of one legacy agency (its snapshot) for the worker job. */
export type LegacyDeltaSourceFactory = (legacyAgencyId: string) => Promise<OpenedLegacyDeltaSource>;

let sourceFactory: LegacyDeltaSourceFactory | null = null;

/**
 * Registers the legacy reader the hourly job uses (at worker start, once the legacy connection is configured — H1).
 * Without one the job queues nothing.
 */
export function registerLegacyDeltaSource(factory: LegacyDeltaSourceFactory | null): void {
  sourceFactory = factory;
}

export function legacyDeltaSourceFactory(): LegacyDeltaSourceFactory | null {
  return sourceFactory;
}

export interface LegacyDeltaState {
  /** The legacy clock the last completed delta read from; null before the first. */
  watermark: Date | null;
  /** When the agency was cut over (the delta stops); null while the parallel run lasts. */
  cutOverAt: Date | null;
}

type StateRow = { seq: number; counts: Record<string, Record<string, number>> };

function stateOf(rows: readonly StateRow[]): LegacyDeltaState {
  const at = (seq: number, key: string) => rows.find((r) => r.seq === seq)?.counts?.[key];
  const watermark = at(SEQ.watermark, 'delta')?.since;
  const cutover = at(SEQ.cutover, 'cutover');
  return {
    watermark: typeof watermark === 'number' && watermark > 0 ? new Date(watermark) : null,
    cutOverAt: cutover?.active === 1 && typeof cutover.at === 'number' ? new Date(cutover.at) : null,
  };
}

const reason = (dryRun: boolean) => `legacy-migration.delta${dryRun ? '.dry-run' : ''}`;

export async function legacyDeltaState(legacyAgencyId: string): Promise<LegacyDeltaState> {
  return stateOf(await withSystem(reason(false), (tx) => repo.checkpointsOf(tx, [legacyAgencyId], DELTA.STATE_ENTITY)));
}

async function saveState(
  legacyAgencyId: string,
  agencyId: string,
  seq: number,
  counts: Record<string, Record<string, number>>,
): Promise<void> {
  await withSystem(reason(false), (tx) =>
    repo.saveCheckpoint(tx, {
      legacyAgencyId,
      targetAgencyId: agencyId,
      entity: DELTA.STATE_ENTITY,
      seq,
      inputHash: createHash('sha256').update(JSON.stringify(counts)).digest('hex'),
      status: 'DONE',
      rows: 0,
      counts,
      issues: [],
      error: null,
    }),
  );
}

/**
 * Cutover of a legacy agency (PLAN §14 step 7): from now on its delta does nothing — agents work in v2, nothing from
 * legacy may overwrite their edits. `cutOver: false` re-opens the delta (a rollback within the cutover window).
 */
export async function markLegacyAgencyCutOver(input: {
  legacyAgencyId: string;
  agencyId: string;
  cutOver: boolean;
  at?: Date;
}): Promise<void> {
  const at = (input.at ?? new Date()).getTime();
  await saveState(input.legacyAgencyId, input.agencyId, SEQ.cutover, {
    cutover: { at, active: input.cutOver ? 1 : 0 },
  });
}

export interface SyncLegacyDeltaInput {
  legacyAgencyId: string;
  /** The v2 agency the legacy agency became (its `agency` map). */
  agencyId: string;
  source: LegacyDeltaSource;
  dryRun?: boolean;
  /** Starts the agency's image downloads (default: the media queue). */
  requestMedia?: (agencyId: string) => Promise<void>;
}

export interface SyncLegacyDeltaResult {
  /** Why nothing ran: the agency is cut over. */
  skipped: 'CUT_OVER' | null;
  /** The legacy changes read: after this time (null: everything). */
  since: Date | null;
  /** The watermark now stored (unchanged when the load stopped or on a dry run). */
  watermark: Date | null;
  load: MigrateLegacyAgencyResult | null;
  /** Migrated listings withdrawn because their legacy row is gone. */
  withdrawn: number;
  /** Set when the deletion guard held the withdrawals back (missing of migrated listings). */
  withdrawGuard: { missing: number; migrated: number } | null;
}

/**
 * One delta of one legacy agency: the changed rows through the load (`delta:` checkpoints, every batch run — a delta's
 * batches are new data), then the legacy deletions, then the watermark. Idempotent: a repeated or overlapping delta
 * writes nothing new.
 */
export async function syncLegacyDelta(input: SyncLegacyDeltaInput): Promise<SyncLegacyDeltaResult> {
  const dryRun = input.dryRun ?? false;
  const state = await legacyDeltaState(input.legacyAgencyId);
  const since = state.watermark ? new Date(state.watermark.getTime() - DELTA.OVERLAP_MS) : null;
  const result: SyncLegacyDeltaResult = {
    skipped: null,
    since,
    watermark: state.watermark,
    load: null,
    withdrawn: 0,
    withdrawGuard: null,
  };
  if (state.cutOverAt) return { ...result, skipped: 'CUT_OVER' };

  const staged: Partial<Record<LegacyStagingEntity, StagedSource>> = {};
  for (const key of Object.keys(LEGACY_STAGING) as LegacyStagingEntity[]) {
    const changed = input.source.changed(key, WHOLE.has(key) ? null : since);
    if (changed) staged[key] = changed;
  }
  result.load = await migrateLegacyAgency({
    legacyAgencyId: input.legacyAgencyId,
    agencyId: input.agencyId,
    staged,
    dryRun,
    restart: true,
    checkpointPrefix: DELTA.CHECKPOINT_PREFIX,
    requestMedia: input.requestMedia,
  });
  if (result.load.stoppedAt || dryRun) return result;

  // A cutover marked while this delta ran: no withdrawal, no watermark (the next run is skipped anyway).
  if ((await legacyDeltaState(input.legacyAgencyId)).cutOverAt) return { ...result, skipped: 'CUT_OVER' };
  const removed = await withdrawDeleted(input);
  result.withdrawn = removed.withdrawn;
  result.withdrawGuard = removed.guard;

  await saveState(input.legacyAgencyId, input.agencyId, SEQ.watermark, {
    delta: { since: input.source.snapshotAt.getTime() },
  });
  result.watermark = input.source.snapshotAt;
  return result;
}

/** Withdraws the migrated listings whose legacy row is gone (guarded). Legacy ids are agency-sized: held in a set. */
async function withdrawDeleted(
  input: SyncLegacyDeltaInput,
): Promise<{ withdrawn: number; guard: SyncLegacyDeltaResult['withdrawGuard'] }> {
  const present = new Set<string>();
  for await (const batch of input.source.listingIds()) for (const id of batch) present.add(id);
  const missing: string[] = [];
  let migrated = 0;
  let after: string | null = null;
  for (;;) {
    const page: { id: string; legacyId: string }[] = await withSystem(reason(false), (tx) =>
      properties.migratedListingsPage(tx, input.agencyId, after, DELTA.PAGE),
    );
    migrated += page.length;
    for (const l of page) if (!present.has(l.legacyId)) missing.push(l.id);
    if (page.length < DELTA.PAGE) break;
    after = (page[page.length - 1] as { legacyId: string }).legacyId;
  }
  if (missing.length === 0) return { withdrawn: 0, guard: null };
  const allowed = Math.max(DELTA.WITHDRAW_MIN_ALLOWED, Math.floor(migrated * DELTA.WITHDRAW_MAX_SHARE));
  if (present.size === 0 || missing.length > allowed) {
    return { withdrawn: 0, guard: { missing: missing.length, migrated } };
  }
  let withdrawn = 0;
  for (let i = 0; i < missing.length; i += DELTA.PAGE) {
    const ids = missing.slice(i, i + DELTA.PAGE);
    withdrawn += await withSystem(reason(false), (tx) => properties.withdrawLegacyListings(tx, input.agencyId, ids));
  }
  return { withdrawn, guard: null };
}

/**
 * The legacy agencies whose delta is due: every migrated legacy agency (its `agency` map) not cut over, a page of
 * `DELTA.AGENCY_PAGE` per two statements.
 */
export async function* deltaAgencies(): AsyncIterable<{ legacyAgencyId: string; agencyId: string }[]> {
  let after: string | null = null;
  for (;;) {
    const from = after;
    const { maps, states } = await withSystem(reason(false), async (tx) => {
      const maps = await repo.legacyAgencyMaps(tx, from, DELTA.AGENCY_PAGE);
      const ids = maps.map((m) => m.legacyAgencyId);
      return { maps, states: await repo.checkpointsOf(tx, ids, DELTA.STATE_ENTITY) };
    });
    const byAgency = new Map<string, StateRow[]>();
    for (const s of states) byAgency.set(s.legacyAgencyId, [...(byAgency.get(s.legacyAgencyId) ?? []), s]);
    const due = maps.filter((m) => !stateOf(byAgency.get(m.legacyAgencyId) ?? []).cutOverAt);
    if (due.length > 0) yield due;
    if (maps.length < DELTA.AGENCY_PAGE) return;
    after = (maps[maps.length - 1] as { legacyAgencyId: string }).legacyAgencyId;
  }
}
