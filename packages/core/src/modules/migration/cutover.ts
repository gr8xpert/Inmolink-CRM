/**
 * Per-agency cutover checklist (S14-06, PLAN §14 Path A step 7, Path B, ADR 0006): the operator's cutover script
 * (`pnpm legacy:cutover`) moves one agency to v2 as an audited, idempotent, resumable sequence of steps, and rolls it
 * back step by step within the cutover window.
 *
 * **Path A — a legacy Inmolink agency** (its legacy API traffic already reaches the v1 shim once the legacy hostname's
 * DNS is flipped — a platform event, runbook `cutover.md`):
 * 1. `FREEZE` — the agency becomes read-only in legacy (the registered `LegacyControl`; without one the operator does
 *    it in legacy and confirms). Reversible: unfrozen.
 * 2. `FINAL_DELTA` — one last delta (S14-04) from the frozen legacy: it must complete (no failed batch, no withdrawal
 *    guard). Not reversible (idempotent data); re-done after a rollback.
 * 3. `VALIDATE` — the gate: the agency's latest validation report (S14-03, `pnpm legacy:validate`) is PASS and newer
 *    than the final delta. Re-done after a rollback.
 * 4. `STOP_DELTA` — the delta stops (`markLegacyAgencyCutOver`): nothing from legacy overwrites the agents' v2 work.
 *    Reversible: re-opened.
 * 5. `ENABLE_ACCESS` — every member the load created gets the password-reset e-mail (their way in, S14-02; the only
 *    place it is sent — the load mails nobody), once per v2 user however many legacy users share it, never an
 *    existing member matched by e-mail; in pages of distinct user ids whose cursor is recorded with them: a resumed
 *    run never mails a member twice. Kept on rollback (the mails are sent).
 * 6. `NOTIFY` — the agency's admins are told (`MIGRATION_CUT_OVER`; idempotent by the run's start). Re-done after a
 *    rollback (the next cutover tells them again).
 *
 * **Path B — an agency coming from Resales Online or another CRM** (its own listings imported by its feed, contacts by
 * CSV; its website shows the old provider's and the v2 inventories side by side — `inventory_mode` PARALLEL — until the
 * v2 network has parity in its area; cutover is scheduled just before the old provider's renewal date):
 * 1. `PARITY` — the gate: v2 network listings in the agency's area ≥ `CUTOVER.PARITY_MIN` × the old provider's count
 *    (or the operator overrides). Re-done after a rollback.
 * 2. `SWITCH_FEED` — the managed website shows the v2 inventory only (`inventory_mode` V2; the operator switches the
 *    site and confirms). Reversible: back to PARALLEL.
 * 3. `NOTIFY` — as in Path A.
 *
 * Every step done or rolled back is recorded in the checklist row and audited (`migration.cutover.*`, actor system)
 * in one transaction. A run holds the agency's lease (`CUTOVER.LEASE_MS`, renewed per step), so two runs never
 * interleave; a crashed run's lease expires. A step that cannot complete stops the run with a reason code
 * (`lastError`); the next run resumes there. Nothing here calls the network inside a transaction.
 */
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { z } from 'zod';
import * as compliance from '../compliance';
import * as identity from '../identity';
import * as notifications from '../notifications';
import * as properties from '../properties';
import * as crepo from './cutover-repo';
import {
  legacyDeltaSourceFactory,
  markLegacyAgencyCutOver,
  type OpenedLegacyDeltaSource,
  syncLegacyDelta,
} from './delta';
import { failureOf } from './load';
import { agencyOfLegacy } from './validate';

export const CUTOVER = {
  /** A run's lease on the agency's checklist, renewed after every step (a crashed run frees it after this). */
  LEASE_MS: 30 * 60_000,
  /** The target of one cutover or rollback (the staging rehearsal's acceptance, H11). */
  TARGET_MS: 30 * 60_000,
  /** Path B: the cutover is scheduled this many days before the old provider's renewal date. */
  RENEWAL_LEAD_DAYS: 7,
  /** Path B: v2 network listings in the area / the old provider's, at least this share for parity. */
  PARITY_MIN: 0.95,
  /** Counting v2 network listings in an area stops here. */
  PARITY_CAP: 1_000_000,
  /** A cut-over agency can be rolled back within this window (later: `force`). */
  ROLLBACK_WINDOW_MS: 7 * 24 * 3_600_000,
  /** Migrated members sent their password reset per transaction. */
  ACCESS_BATCH: 200,
  /** Checklists listed by `dueCutovers`. */
  DUE_LIMIT: 500,
} as const;

export const CUTOVER_STEPS = {
  A: ['FREEZE', 'FINAL_DELTA', 'VALIDATE', 'STOP_DELTA', 'ENABLE_ACCESS', 'NOTIFY'],
  B: ['PARITY', 'SWITCH_FEED', 'NOTIFY'],
} as const;
export type CutoverStep = (typeof CUTOVER_STEPS)[keyof typeof CUTOVER_STEPS][number];

/** Undone by a rollback (in reverse order). */
const REVERSIBLE: ReadonlySet<CutoverStep> = new Set(['FREEZE', 'STOP_DELTA', 'SWITCH_FEED']);
/** Re-opened by a rollback: they run again at the next cutover (legacy / the area changed meanwhile). */
const REDO: ReadonlySet<CutoverStep> = new Set(['FINAL_DELTA', 'VALIDATE', 'PARITY', 'NOTIFY']);
// ENABLE_ACCESS is kept: the members' password-reset e-mails stay sent (a re-cutover does not mail them again).

/**
 * Manual steps the operator confirms (run: done outside v2 — legacy frozen, managed site switched, parity accepted
 * without the count; rollback: undone outside v2 — legacy unfrozen, site switched back).
 */
export type CutoverConfirmation = 'FREEZE' | 'SWITCH_FEED' | 'PARITY';

/** Makes a legacy agency read-only in legacy, or writable again (the legacy admin connection, H1). */
export interface LegacyControl {
  setReadOnly(legacyAgencyId: string, readOnly: boolean): Promise<void>;
}

let legacyControl: LegacyControl | null = null;

/** Registers the legacy freeze control (the cutover script, once legacy write access is configured — H1). */
export function registerLegacyControl(control: LegacyControl | null): void {
  legacyControl = control;
}

export class CutoverError extends Error {
  constructor(
    readonly code:
      | 'NOT_PLANNED'
      | 'BUSY'
      | 'LEGACY_AGENCY_MISMATCH'
      | 'AGENCY_NOT_FOUND'
      | 'NOT_STARTED'
      | 'RUNNING_OR_DONE'
      | 'ROLLBACK_WINDOW_PASSED',
  ) {
    super(`cutover: ${code}`);
    this.name = 'CutoverError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const CutoverPlanInput = z
  .object({
    agencyId: z.uuid(),
    path: z.enum(['A', 'B']),
    legacyAgencyId: z.string().trim().min(1).max(100).optional(),
    provider: z.string().trim().min(1).max(60).optional(),
    renewalDate: z.string().regex(DAY).optional(),
    scheduledFor: z.string().regex(DAY).optional(),
    areaLocationIds: z.array(z.uuid()).max(200).default([]),
    oldAreaListings: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((p) => p.path === 'B' || p.legacyAgencyId !== undefined, { message: 'Path A needs legacyAgencyId' });
export type CutoverPlanInput = z.input<typeof CutoverPlanInput>;

export type CutoverDto = Omit<crepo.CutoverRow, 'leaseOwner'>;
const dto = ({ leaseOwner: _l, ...row }: crepo.CutoverRow): CutoverDto => row;

const reason = (what: string, agencyId: string) => `legacy-migration.cutover.${what} ${agencyId}`;
const target = (id: string) => ({ type: 'cutover' as const, id });

function minusDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Plans (or re-plans) an agency's cutover: path, legacy agency (A, checked against its map), old provider and renewal
 * date (B), the scheduled day (default: `RENEWAL_LEAD_DAYS` before the renewal) and the parity area. Path B starts in
 * PARALLEL inventory mode. A cut-over checklist, one a run holds, or a started one's path is not re-planned
 * (`RUNNING_OR_DONE`). Audited.
 */
export async function planCutover(input: CutoverPlanInput): Promise<CutoverDto> {
  const p = CutoverPlanInput.parse(input);
  const now = clock.now();
  return withSystem(reason('plan', p.agencyId), async (tx) => {
    if (p.path === 'A') {
      if ((await agencyOfLegacy(tx, p.legacyAgencyId as string)) !== p.agencyId) {
        throw new CutoverError('LEGACY_AGENCY_MISMATCH');
      }
    } else if (((await identity.agencyAdminsOf(tx, [p.agencyId])).get(p.agencyId) ?? []).length === 0) {
      throw new CutoverError('AGENCY_NOT_FOUND');
    }
    const scheduledFor = p.scheduledFor ?? (p.renewalDate ? minusDays(p.renewalDate, CUTOVER.RENEWAL_LEAD_DAYS) : null);
    const row = await crepo.upsertPlan(
      tx,
      {
        id: newId(),
        targetAgencyId: p.agencyId,
        path: p.path,
        legacyAgencyId: p.path === 'A' ? (p.legacyAgencyId as string) : null,
        provider: p.provider ?? null,
        renewalDate: p.renewalDate ?? null,
        scheduledFor,
        inventoryMode: p.path === 'B' ? 'PARALLEL' : null,
        areaLocationIds: p.areaLocationIds,
        oldAreaListings: p.oldAreaListings ?? null,
      },
      now,
    );
    if (!row) throw new CutoverError('RUNNING_OR_DONE');
    await compliance.auditSystem(tx, {
      type: 'migration.cutover.planned',
      agencyId: p.agencyId,
      target: target(row.id),
      metadata: { path: row.path, scheduledFor: row.scheduledFor, renewalDate: row.renewalDate },
    });
    return dto(row);
  });
}

export async function getCutover(agencyId: string): Promise<CutoverDto | null> {
  const row = await withSystem(reason('read', agencyId), (tx) => crepo.cutoverOf(tx, agencyId));
  return row ? dto(row) : null;
}

/** Renewal tracking: open checklists scheduled within `days` of `now` (earliest first, ≤ `CUTOVER.DUE_LIMIT`). */
export async function dueCutovers(opts: { days: number; now?: Date }): Promise<CutoverDto[]> {
  const until = new Date((opts.now ?? clock.now()).getTime() + opts.days * 86_400_000).toISOString().slice(0, 10);
  const rows = await withSystem('legacy-migration.cutover.due', (tx) =>
    crepo.dueCutovers(tx, until, CUTOVER.DUE_LIMIT),
  );
  return rows.map(dto);
}

/** Path B parity of an agency's area: v2 network listings there against the old provider's count. */
export async function areaParity(
  agencyId: string,
): Promise<{ v2: number; old: number | null; ratio: number | null; reached: boolean }> {
  return withSystem(reason('parity', agencyId), async (tx) => {
    const row = await crepo.cutoverOf(tx, agencyId);
    if (!row) throw new CutoverError('NOT_PLANNED');
    return parityOf(tx, row);
  });
}

async function parityOf(
  tx: Parameters<typeof crepo.cutoverOf>[0],
  row: crepo.CutoverRow,
): Promise<{ v2: number; old: number | null; ratio: number | null; reached: boolean }> {
  const v2 = await properties.countNetworkListingsInArea(tx, row.areaLocationIds, CUTOVER.PARITY_CAP);
  const old = row.oldAreaListings;
  if (old === null || row.areaLocationIds.length === 0) return { v2, old, ratio: null, reached: false };
  const ratio = old === 0 ? 1 : Math.round((v2 / old) * 1000) / 1000;
  return { v2, old, ratio, reached: ratio >= CUTOVER.PARITY_MIN };
}

/** DNS readiness of the legacy API hostname: migrated legacy agencies without a PASS report (first `limit`). */
export async function legacyDnsReadiness(limit = 100): Promise<{
  agencies: number;
  cutOver: number;
  notReady: { legacyAgencyId: string; agencyId: string; status: 'PASS' | 'FAIL' | null }[];
  ready: boolean;
}> {
  return withSystem('legacy-migration.cutover.dns-check', async (tx) => {
    const totals = await crepo.cutoverTotals(tx);
    const notReady = await crepo.notReadyPage(tx, null, limit);
    return { ...totals, notReady, ready: totals.agencies > 0 && notReady.length === 0 };
  });
}

export interface RunCutoverInput {
  agencyId: string;
  /** Manual steps the operator has done (see `CutoverConfirmation`). */
  confirm?: readonly CutoverConfirmation[];
  /** Opens the frozen legacy snapshot for the final delta (default: the registered delta reader). */
  openSource?: (legacyAgencyId: string) => Promise<OpenedLegacyDeltaSource>;
  /** Starts the agency's image downloads after the final delta (default: the media queue). */
  requestMedia?: (agencyId: string) => Promise<void>;
}

export interface CutoverRunResult {
  state: crepo.CutoverState;
  /** Steps this call completed (or rolled back), in order. */
  steps: CutoverStep[];
  /** The step the call stopped at, with its reason code; null when it finished. */
  stoppedAt: CutoverStep | null;
  reason: string | null;
  elapsedMs: number;
}

type StepOutcome =
  | { ok: true; record?: Record<string, string | number | boolean | null>; inventoryMode?: crepo.InventoryMode }
  | { ok: false; reason: string };

type Run = { row: crepo.CutoverRow; runId: string; confirm: ReadonlySet<CutoverConfirmation> };

async function lease(agencyId: string, runId: string): Promise<crepo.CutoverRow> {
  const now = clock.now();
  const row = await withSystem(reason('lease', agencyId), async (tx) => {
    const claimed = await crepo.claimLease(tx, agencyId, runId, now, new Date(now.getTime() + CUTOVER.LEASE_MS));
    if (claimed) return claimed;
    throw new CutoverError((await crepo.cutoverOf(tx, agencyId)) ? 'BUSY' : 'NOT_PLANNED');
  });
  return row;
}

/** Records a step and its audit row in one transaction (lease held). */
async function record(
  run: Run,
  step: CutoverStep,
  status: 'DONE' | 'ROLLED_BACK',
  extra: Record<string, string | number | boolean | null> = {},
  inventoryMode?: crepo.InventoryMode,
): Promise<void> {
  const at = clock.now().toISOString();
  await withSystem(reason(status === 'DONE' ? 'step' : 'rollback', run.row.targetAgencyId), async (tx) => {
    const ok = await crepo.recordStep(
      tx,
      run.row.id,
      run.runId,
      step,
      { ...extra, status, at },
      inventoryMode ? { inventoryMode } : {},
    );
    if (!ok) throw new CutoverError('BUSY');
    await compliance.auditSystem(tx, {
      type: status === 'DONE' ? 'migration.cutover.stepDone' : 'migration.cutover.stepRolledBack',
      agencyId: run.row.targetAgencyId,
      target: target(run.row.id),
      metadata: { path: run.row.path, step, ...extra },
    });
  });
  run.row.steps[step] = { ...extra, status, at };
}

async function stop(run: Run, code: string): Promise<void> {
  await withSystem(reason('stop', run.row.targetAgencyId), (tx) => crepo.setLastError(tx, run.row.id, code));
}

// ---- the steps ----

async function freeze(run: Run): Promise<StepOutcome> {
  const legacyAgencyId = run.row.legacyAgencyId as string;
  if (legacyControl) {
    await legacyControl.setReadOnly(legacyAgencyId, true);
    return { ok: true, record: { mode: 'AUTOMATIC' } };
  }
  if (run.confirm.has('FREEZE')) return { ok: true, record: { mode: 'MANUAL' } };
  return { ok: false, reason: 'CONFIRM_FREEZE' };
}

async function finalDelta(run: Run, input: RunCutoverInput): Promise<StepOutcome> {
  const legacyAgencyId = run.row.legacyAgencyId as string;
  const open = input.openSource ?? legacyDeltaSourceFactory();
  if (!open) return { ok: false, reason: 'NO_LEGACY_SOURCE' };
  const source = await open(legacyAgencyId);
  try {
    const r = await syncLegacyDelta({
      legacyAgencyId,
      agencyId: run.row.targetAgencyId,
      source,
      requestMedia: input.requestMedia,
    });
    if (r.skipped) return { ok: false, reason: 'DELTA_STOPPED' };
    if (r.load?.stoppedAt) return { ok: false, reason: 'DELTA_INCOMPLETE' };
    if (r.withdrawGuard) return { ok: false, reason: 'DELTA_WITHDRAW_GUARD' };
    return { ok: true, record: { watermark: r.watermark?.toISOString() ?? null, withdrawn: r.withdrawn } };
  } finally {
    await source.close();
  }
}

async function validateGate(run: Run): Promise<StepOutcome> {
  const report = await withSystem(reason('validate', run.row.targetAgencyId), (tx) =>
    crepo.latestReport(tx, run.row.legacyAgencyId as string),
  );
  if (!report) return { ok: false, reason: 'NO_VALIDATION_REPORT' };
  if (report.targetAgencyId !== run.row.targetAgencyId) return { ok: false, reason: 'VALIDATION_AGENCY_MISMATCH' };
  if (report.status !== 'PASS') return { ok: false, reason: 'VALIDATION_FAILED' };
  const deltaAt = run.row.steps.FINAL_DELTA?.at;
  if (!deltaAt || report.createdAt.getTime() < new Date(deltaAt).getTime()) {
    return { ok: false, reason: 'VALIDATION_STALE' };
  }
  return { ok: true, record: { reportId: report.id } };
}

async function stopDelta(run: Run): Promise<StepOutcome> {
  await markLegacyAgencyCutOver({
    legacyAgencyId: run.row.legacyAgencyId as string,
    agencyId: run.row.targetAgencyId,
    cutOver: true,
  });
  return { ok: true };
}

/**
 * Password resets in pages of distinct created users (user id order), each with its cursor in the same transaction: a
 * resumed run mails nobody twice, and two legacy users of one v2 user mail it once.
 */
async function enableAccess(run: Run): Promise<StepOutcome> {
  const agencyId = run.row.targetAgencyId;
  const progress = run.row.steps.ENABLE_ACCESS;
  // `afterUser`: a v2 user id (S14 review; the cursor used to be a legacy id under `after`).
  let after = typeof progress?.afterUser === 'string' ? progress.afterUser : null;
  let sent = typeof progress?.sent === 'number' ? progress.sent : 0;
  for (;;) {
    const from = after;
    const page = await withSystem(reason('access', agencyId), async (tx) => {
      const users = await crepo.createdUsersPage(tx, agencyId, from, CUTOVER.ACCESS_BATCH);
      if (users.length === 0) return null;
      const n = await identity.requestLegacyPasswordResets(tx, agencyId, users);
      const last = users[users.length - 1] as string;
      const progress = { status: 'RUNNING' as const, at: clock.now().toISOString(), afterUser: last, sent: sent + n };
      if (!(await crepo.recordStep(tx, run.row.id, run.runId, 'ENABLE_ACCESS', progress))) {
        throw new CutoverError('BUSY');
      }
      return { n, last, full: users.length === CUTOVER.ACCESS_BATCH };
    });
    if (!page) break;
    sent += page.n;
    after = page.last;
    if (!page.full) break;
  }
  return { ok: true, record: { sent, afterUser: after } };
}

async function notifyAdmins(run: Run): Promise<StepOutcome> {
  const agencyId = run.row.targetAgencyId;
  const at = run.row.startedAt ?? run.row.createdAt;
  const notified = await withSystem(reason('notify', agencyId), async (tx) => {
    const admins = (await identity.agencyAdminsOf(tx, [agencyId])).get(agencyId) ?? [];
    if (admins.length === 0) return 0;
    const res = await notifications.raiseNotifications(tx, {
      agencyId,
      type: 'MIGRATION_CUT_OVER',
      userIds: admins,
      sourceKey: `migration.cutover:${run.row.id}:${at.getTime()}`,
      at,
    });
    return res.notified.length;
  });
  return { ok: true, record: { notified } };
}

async function parityGate(run: Run): Promise<StepOutcome> {
  const p = await withSystem(reason('parity', run.row.targetAgencyId), (tx) => parityOf(tx, run.row));
  const counts = { v2: p.v2, old: p.old, ratio: p.ratio };
  if (p.reached) return { ok: true, record: { ...counts, override: false } };
  if (run.confirm.has('PARITY')) return { ok: true, record: { ...counts, override: true } };
  return { ok: false, reason: p.ratio === null ? 'PARITY_NOT_CONFIGURED' : 'PARITY_NOT_REACHED' };
}

function switchFeed(run: Run): StepOutcome {
  if (!run.confirm.has('SWITCH_FEED')) return { ok: false, reason: 'CONFIRM_SWITCH_FEED' };
  return { ok: true, inventoryMode: 'V2' };
}

function runStep(step: CutoverStep, run: Run, input: RunCutoverInput): Promise<StepOutcome> | StepOutcome {
  switch (step) {
    case 'FREEZE':
      return freeze(run);
    case 'FINAL_DELTA':
      return finalDelta(run, input);
    case 'VALIDATE':
      return validateGate(run);
    case 'STOP_DELTA':
      return stopDelta(run);
    case 'ENABLE_ACCESS':
      return enableAccess(run);
    case 'NOTIFY':
      return notifyAdmins(run);
    case 'PARITY':
      return parityGate(run);
    case 'SWITCH_FEED':
      return switchFeed(run);
  }
}

/**
 * Runs the agency's checklist from its first open step to CUT_OVER, or until a step cannot complete (`stoppedAt`,
 * `reason`; the next run resumes there). A cut-over agency answers at once. Throws `CutoverError` (`NOT_PLANNED`,
 * `BUSY`); a step's unexpected error is recorded (`lastError`, code only) and thrown — the run resumes at that step.
 */
export async function runCutover(input: RunCutoverInput): Promise<CutoverRunResult> {
  const started = Date.now();
  const runId = newId();
  const row = await lease(input.agencyId, runId);
  const run: Run = { row, runId, confirm: new Set(input.confirm ?? []) };
  const done: CutoverStep[] = [];
  const result = (stoppedAt: CutoverStep | null, why: string | null): CutoverRunResult => ({
    state: run.row.state,
    steps: done,
    stoppedAt,
    reason: why,
    elapsedMs: Date.now() - started,
  });
  try {
    if (row.state === 'CUT_OVER') return result(null, null);
    if (row.state !== 'IN_PROGRESS') {
      const startedAt = clock.now();
      await withSystem(reason('start', row.targetAgencyId), (tx) =>
        crepo.setState(tx, row.id, runId, { state: 'IN_PROGRESS', startedAt, rolledBackAt: null }),
      );
      run.row = { ...row, state: 'IN_PROGRESS', startedAt };
    }
    for (const step of CUTOVER_STEPS[row.path] as readonly CutoverStep[]) {
      if (run.row.steps[step]?.status === 'DONE') continue;
      await lease(row.targetAgencyId, runId);
      let outcome: StepOutcome;
      try {
        outcome = await runStep(step, run, input);
      } catch (err) {
        await stop(run, `${step}:${failureOf(err, null)}`);
        throw err;
      }
      if (!outcome.ok) {
        await stop(run, `${step}:${outcome.reason}`);
        return result(step, outcome.reason);
      }
      await record(run, step, 'DONE', outcome.record, outcome.inventoryMode);
      done.push(step);
    }
    const cutOverAt = clock.now();
    await withSystem(reason('complete', row.targetAgencyId), async (tx) => {
      await crepo.setState(tx, row.id, runId, { state: 'CUT_OVER', cutOverAt });
      await compliance.auditSystem(tx, {
        type: 'migration.cutover.completed',
        agencyId: row.targetAgencyId,
        target: target(row.id),
        metadata: { path: row.path, elapsedMs: Date.now() - started },
      });
    });
    run.row = { ...run.row, state: 'CUT_OVER', cutOverAt };
    return result(null, null);
  } finally {
    await withSystem(reason('release', row.targetAgencyId), (tx) => crepo.releaseLease(tx, row.id, runId));
  }
}

export interface RollbackCutoverInput {
  agencyId: string;
  /** Manual steps the operator has undone outside v2 (legacy unfrozen by hand, the managed site switched back). */
  confirm?: readonly CutoverConfirmation[];
  /** Roll back after `CUTOVER.ROLLBACK_WINDOW_MS` (the agents' v2 work since stays in v2; legacy does not get it). */
  force?: boolean;
}

/**
 * Rolls an agency's cutover back (PLAN §14 step 9): the reversible steps done are undone in reverse order (delta
 * re-opened, legacy unfrozen, website back to PARALLEL), the gates and the final delta re-open for the next cutover;
 * the members' password-reset e-mails stay sent. Resumable like a run (a manual step not confirmed stops it). A rolled-back
 * checklist answers at once.
 */
export async function rollbackCutover(input: RollbackCutoverInput): Promise<CutoverRunResult> {
  const started = Date.now();
  const runId = newId();
  const row = await lease(input.agencyId, runId);
  const run: Run = { row, runId, confirm: new Set(input.confirm ?? []) };
  const undone: CutoverStep[] = [];
  const result = (stoppedAt: CutoverStep | null, why: string | null): CutoverRunResult => ({
    state: run.row.state,
    steps: undone,
    stoppedAt,
    reason: why,
    elapsedMs: Date.now() - started,
  });
  try {
    if (row.state === 'ROLLED_BACK') return result(null, null);
    if (row.state === 'PLANNED') throw new CutoverError('NOT_STARTED');
    if (
      row.state === 'CUT_OVER' &&
      !input.force &&
      row.cutOverAt &&
      clock.now().getTime() - row.cutOverAt.getTime() > CUTOVER.ROLLBACK_WINDOW_MS
    ) {
      throw new CutoverError('ROLLBACK_WINDOW_PASSED');
    }
    if (row.state === 'CUT_OVER') {
      await withSystem(reason('rollback', row.targetAgencyId), (tx) =>
        crepo.setState(tx, row.id, runId, { state: 'IN_PROGRESS' }),
      );
      run.row = { ...row, state: 'IN_PROGRESS' };
    }
    const steps = [...(CUTOVER_STEPS[row.path] as readonly CutoverStep[])].reverse();
    for (const step of steps) {
      const rec = run.row.steps[step];
      if (rec?.status !== 'DONE' || !(REVERSIBLE.has(step) || REDO.has(step))) continue;
      await lease(row.targetAgencyId, runId);
      let mode: crepo.InventoryMode | undefined;
      if (step === 'STOP_DELTA') {
        await markLegacyAgencyCutOver({
          legacyAgencyId: row.legacyAgencyId as string,
          agencyId: row.targetAgencyId,
          cutOver: false,
        });
      } else if (step === 'FREEZE') {
        if (legacyControl && rec.mode === 'AUTOMATIC') {
          await legacyControl.setReadOnly(row.legacyAgencyId as string, false);
        } else if (!run.confirm.has('FREEZE')) {
          await stop(run, 'FREEZE:CONFIRM_UNFREEZE');
          return result(step, 'CONFIRM_UNFREEZE');
        }
      } else if (step === 'SWITCH_FEED') {
        if (!run.confirm.has('SWITCH_FEED')) {
          await stop(run, 'SWITCH_FEED:CONFIRM_SWITCH_BACK');
          return result(step, 'CONFIRM_SWITCH_BACK');
        }
        mode = 'PARALLEL';
      }
      await record(run, step, 'ROLLED_BACK', { reverted: REVERSIBLE.has(step) }, mode);
      undone.push(step);
    }
    const rolledBackAt = clock.now();
    await withSystem(reason('rolled-back', row.targetAgencyId), async (tx) => {
      await crepo.setState(tx, row.id, runId, { state: 'ROLLED_BACK', rolledBackAt, cutOverAt: null });
      await compliance.auditSystem(tx, {
        type: 'migration.cutover.rolledBack',
        agencyId: row.targetAgencyId,
        target: target(row.id),
        metadata: { path: row.path, steps: undone, elapsedMs: Date.now() - started },
      });
    });
    run.row = { ...run.row, state: 'ROLLED_BACK', rolledBackAt, cutOverAt: null };
    return result(null, null);
  } finally {
    await withSystem(reason('release', row.targetAgencyId), (tx) => crepo.releaseLease(tx, row.id, runId));
  }
}
