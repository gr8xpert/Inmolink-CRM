import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import * as repo from './report-rollups-repo';

/**
 * CRM report rollups (S11-F10). The pipeline report's leads per stage now and the response-time KPI read rollups the
 * worker keeps from `leads` instead of aggregating the agency's leads per request (O(agency leads): 26.8 ms and
 * 22–150 ms at 60k leads, over the 20 ms SQL budget):
 *
 * - `crm_stage_counts` — per stage, the leads in it and Σ of their entry times; kept by `crm.refreshStageCounts` from
 *   `crm.lead.created` and `crm.lead.stageChanged` (throttled per agency) — S12-F6: by deltas from the stage history
 *   (`refreshStageCounts`), rebuilt from `leads` nightly (`crm.sweepStageCounts`).
 * - `crm_stage_move_rollups` — per UTC day of the move and stage, entries, exits and every stay that ended (the exact
 *   histogram of the median time in stage); the report reads its range's whole days from it, the partial days at the
 *   ends from `lead_stage_history`.
 * - `crm_response_rollups` — per UTC day of receipt and first responder, the measured leads, the answered ones and
 *   every response second (the exact histogram); the day (both per-day rollups) is rebuilt by `crm.refreshReportDay` from
 *   `crm.lead.created`, `crm.lead.stageChanged` (a status / stage change can be the first response) and
 *   `crm.lead.responded` (a logged e-mail / call / meeting that became the first response), throttled per agency and
 *   day. The KPI reads the whole days of its range from it and the partial days at the ends from `leads`, so any
 *   range is exact and today stays live.
 *
 * Both rebuild from the source (idempotent: a redelivery or a rerun writes the same rows) as `app_system` — the tables
 * are worker-written (`userReadOnly`), so no request can plant numbers in a report. Eventually consistent: the counts
 * follow a change within the throttle window (S12-F6: the stage counts within `STAGE_COUNTS_LAG_MS` + the window).
 */

/**
 * S12-F6: how far behind the clock the stage counts are brought up to date (the cutoff): a transaction that wrote a
 * stage move (its `changed_at`, the writer's clock) has committed by then, so a pass never steps over a move it cannot
 * see yet. Covers commit delay and clock skew between app nodes.
 */
export const STAGE_COUNTS_LAG_MS = 30_000;

export interface StageCountsResult {
  /** `delta`: the moves since the watermark applied; `rebuild`: rebuilt from `leads` (first time, drift, nightly). */
  mode: 'delta' | 'rebuild';
  /** Stage moves applied (delta). */
  moves: number;
  /** Rollup rows written or removed (delta). */
  written: number;
  /** Moves after the cutoff wait for a later pass (the job queues one). */
  pending: boolean;
}

/**
 * Brings the agency's leads-per-stage rollup up to `now − STAGE_COUNTS_LAG_MS` (S12-F6). By default a delta pass: the
 * stage moves since the last pass, ±1 per stage touched (O(events), not O(agency leads) — S11 review: the full
 * re-aggregate was 30–80 ms for a 200k-lead agency every throttle window, in the pool search indexing shares). A full
 * rebuild from `leads` when asked (`full`: the nightly pass, a repair), the first time (no rows) or when the deltas
 * drifted (a stage would go below 0: a direct or backdated write). One system transaction, serialized per agency
 * (advisory lock); 2 statements for a delta (lock, pass), 3–4 with a rebuild.
 *
 * Writers that backdate `stage_entered_at` (a seed, a legacy import) or write `leads` around the history trigger
 * (replica mode) rebuild afterwards (`rebuildReportRollups`); the nightly rebuild repairs any drift left.
 */
export function refreshStageCounts(
  p: { agencyId: string; full?: boolean },
  opts: { now?: Date } = {},
): Promise<StageCountsResult> {
  const cutoff = new Date((opts.now ?? clock.now()).getTime() - STAGE_COUNTS_LAG_MS);
  return withSystem('crm.refreshStageCounts', async (tx) => {
    await repo.lockStageCounts(tx, p.agencyId);
    if (!p.full) {
      const delta = await repo.applyStageCountsDelta(tx, p.agencyId, cutoff);
      if (delta.watermark && !delta.negative) {
        return { mode: 'delta', moves: delta.moves, written: delta.written, pending: delta.pending };
      }
    }
    await repo.rebuildStageCounts(tx, p.agencyId, cutoff);
    return { mode: 'rebuild', moves: 0, written: 0, pending: await repo.movesAfter(tx, p.agencyId, cutoff) };
  });
}

/** S12-F6: agencies per page of the nightly rebuild's sweep. */
export const STAGE_COUNTS_SWEEP_PAGE = 500;

/** S12-F6: the agencies with stage counts, a keyset page at a time (the nightly sweep queues a rebuild for each). */
export function stageCountAgencies(after: string | null): Promise<string[]> {
  return withSystem('crm.sweepStageCounts', (tx) => repo.stageCountAgencies(tx, after, STAGE_COUNTS_SWEEP_PAGE));
}

/** Rebuilds the agency's per-day rollup rows (response KPI, moves) of one UTC day (`YYYY-MM-DD`, two statements). */
export function refreshReportDay(p: { agencyId: string; day: string }): Promise<void> {
  return withSystem('crm.refreshReportDay', (tx) => repo.refreshReportDays(tx, p.agencyId, [p.day]));
}

/** Days per rebuild statement: a rebuild of a long history commits per chunk. */
const REBUILD_DAYS_PER_CHUNK = 31;

/**
 * Rebuilds both rollups of an agency from its whole history (a backfill, a repair, a test that wrote `leads`
 * directly): the stage counts, then every UTC day from its first to its last measured lead, 31 days per transaction.
 */
export async function rebuildReportRollups(
  p: { agencyId: string },
  opts: { now?: Date } = {},
): Promise<{ days: number }> {
  await refreshStageCounts({ ...p, full: true }, opts);
  const range = await withSystem('crm.rebuildReportRollups', (tx) => repo.measuredDayRange(tx, p.agencyId));
  if (!range) return { days: 0 };
  const days = repo.utcDays(range.from, range.to);
  for (let i = 0; i < days.length; i += REBUILD_DAYS_PER_CHUNK) {
    const chunk = days.slice(i, i + REBUILD_DAYS_PER_CHUNK);
    await withSystem('crm.rebuildReportRollups', (tx) => repo.refreshReportDays(tx, p.agencyId, chunk));
  }
  return { days: days.length };
}

export interface ResponseStats {
  /** Null: the whole agency. */
  userId: string | null;
  leads: number;
  responded: number;
  medianSeconds: number | null;
  avgSeconds: number | null;
}

/** The exact median of `values` (the mean of the two middle ones for an even count, as `percentile_cont(0.5)`). */
export function median(values: ArrayLike<number>): number | null {
  const n = values.length;
  if (n === 0) return null;
  const sorted = Float64Array.from(values).sort();
  const mid = n >> 1;
  return n % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The agency's and each first responder's numbers from the KPI's parts (rollup days and raw partial days): counts
 * and sums add up, the seconds are pooled for the exact medians. Seconds rounded like the SQL they replace.
 */
export function mergeResponseParts(parts: readonly repo.KpiPart[]): ResponseStats[] {
  const groups = new Map<string | null, { leads: number; responded: number; sum: number; seconds: number[][] }>();
  const add = (key: string | null, p: repo.KpiPart) => {
    const g = groups.get(key) ?? { leads: 0, responded: 0, sum: 0, seconds: [] };
    g.leads += p.leads;
    g.responded += p.responded;
    g.sum += p.secondsSum;
    g.seconds.push(p.seconds);
    groups.set(key, g);
  };
  const agency = { leads: 0, responded: 0, sum: 0, seconds: [] as number[][] };
  for (const p of parts) {
    agency.leads += p.leads;
    agency.responded += p.responded;
    agency.sum += p.secondsSum;
    agency.seconds.push(p.seconds);
    if (p.userId !== null) add(p.userId, p);
  }
  const stats = (userId: string | null, g: typeof agency): ResponseStats => {
    const pooled = g.seconds.flat();
    const m = median(pooled);
    return {
      userId,
      leads: g.leads,
      responded: g.responded,
      medianSeconds: m === null ? null : Math.round(m),
      avgSeconds: g.responded === 0 ? null : Math.round(g.sum / g.responded),
    };
  };
  return [stats(null, agency), ...[...groups].map(([userId, g]) => stats(userId, g))];
}

export interface StageReport {
  stageId: string;
  current: number;
  currentAvgSeconds: number | null;
  entered: number;
  exited: number;
  avgSeconds: number | null;
  medianSeconds: number | null;
}

/** The pipeline report per stage from its parts (the rollups and the raw partial days); seconds rounded as before. */
export function mergeReportParts(parts: readonly repo.ReportPart[]): StageReport[] {
  const by = new Map<string, { r: StageReport; sum: number; stays: number[][] }>();
  for (const p of parts) {
    let g = by.get(p.stageId);
    if (!g) {
      g = {
        r: {
          stageId: p.stageId,
          current: 0,
          currentAvgSeconds: null,
          entered: 0,
          exited: 0,
          avgSeconds: null,
          medianSeconds: null,
        },
        sum: 0,
        stays: [],
      };
      by.set(p.stageId, g);
    }
    if (p.part === 'cur') {
      g.r.current = p.a;
      g.r.currentAvgSeconds = p.s === null ? null : Math.round(p.s);
    } else {
      g.r.entered += p.a;
      g.r.exited += p.b;
      g.sum += p.s ?? 0;
      g.stays.push(p.stays);
    }
  }
  return [...by.values()].map((g) => {
    const m = median(g.stays.flat());
    return {
      ...g.r,
      avgSeconds: g.r.exited === 0 ? null : Math.round(g.sum / g.r.exited),
      medianSeconds: m === null ? null : Math.round(m),
    };
  });
}
