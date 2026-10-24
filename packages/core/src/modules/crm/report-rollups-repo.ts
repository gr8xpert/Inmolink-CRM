import type { Tx } from '@inmolink/db';
import {
  crmResponseRollups,
  crmStageCounts,
  crmStageMoveRollups,
  leadStageHistory,
  leads,
} from '@inmolink/db/schema/crm';
import { type SQL, sql } from 'drizzle-orm';

/**
 * Report rollups (S11-F10): the statements that rebuild `crm_stage_counts` and `crm_response_rollups` from `leads`,
 * and the KPI's read over them. Rebuilt from the source each time (never incremented), so a rerun, a redelivered
 * event or two refreshes in a row leave the same rows. Queries only `@inmolink/db/schema/crm`.
 */

/** A UTC day (`YYYY-MM-DD`) of an instant. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

const DAY_MS = 86_400_000;

/** The UTC days `[from, to]`, both included (`YYYY-MM-DD`). */
export function utcDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(utcDay(new Date(t)));
  }
  return out;
}

/**
 * The agency's leads per stage now — count and Σ entry times — as its `crm_stage_counts` rows, a stage that emptied
 * losing its row. One statement: the aggregate index-only on `leads_agency_stage_rank_idx` (agency, stage, …,
 * stage_entered_at), the upsert and the delete in data-modifying CTEs (disjoint rows).
 */
export function stageCountsRefresh(agencyId: string): SQL {
  return sql`
    with agg as (
      select stage_id, count(*)::int as n, sum(extract(epoch from stage_entered_at))::float8 as s
        from ${leads} where agency_id = ${agencyId} group by stage_id
    ),
    gone as (
      delete from ${crmStageCounts} c
       where c.agency_id = ${agencyId} and not exists (select 1 from agg where agg.stage_id = c.stage_id)
    )
    insert into ${crmStageCounts} (agency_id, stage_id, leads, entered_epoch_sum, refreshed_at)
    select ${agencyId}::uuid, stage_id, n, s, now() from agg
    on conflict (agency_id, stage_id) do update
       set leads = excluded.leads, entered_epoch_sum = excluded.entered_epoch_sum, refreshed_at = excluded.refreshed_at`;
}

export async function refreshStageCounts(tx: Tx, agencyId: string): Promise<void> {
  await tx.execute(stageCountsRefresh(agencyId));
}

/**
 * The agency's `crm_response_rollups` rows of the UTC `days` rebuilt from its measured leads (`source <> 'MANUAL'`)
 * received on them: per first responder, the count, the answered count, Σ and every one of the seconds (ascending).
 * One statement: per day a range on `leads_agency_response_idx` (index-only), the upsert and the delete of rows no
 * longer backed by a lead in data-modifying CTEs.
 */
export function responseDaysRefresh(agencyId: string, days: readonly string[]): SQL {
  const dayList = sql`${sql.param(days)}::date[]`;
  return sql`
    with d as (select unnest(${dayList}) as day),
    agg as (
      select d.day, l.first_responder_user_id as uid, count(*)::int as n, count(l.response_seconds)::int as r,
             coalesce(sum(l.response_seconds), 0)::bigint as ss,
             coalesce(array_agg(l.response_seconds order by l.response_seconds)
                        filter (where l.response_seconds is not null), '{}'::int[]) as secs
        from d
        join ${leads} l
          on l.agency_id = ${agencyId} and l.source <> 'MANUAL'
         and l.created_ms >= (d.day::timestamp at time zone 'UTC')
         and l.created_ms < ((d.day + 1)::timestamp at time zone 'UTC')
       group by d.day, l.first_responder_user_id
    ),
    gone as (
      delete from ${crmResponseRollups} c
       where c.agency_id = ${agencyId} and c.day = any(${dayList})
         and not exists (
           select 1 from agg where agg.day = c.day and agg.uid is not distinct from c.responder_user_id
         )
    )
    insert into ${crmResponseRollups}
           (agency_id, day, responder_user_id, leads, responded, seconds_sum, seconds, refreshed_at)
    select ${agencyId}::uuid, day, uid, n, r, ss, secs, now() from agg
    on conflict on constraint crm_response_rollups_uq do update
       set leads = excluded.leads, responded = excluded.responded, seconds_sum = excluded.seconds_sum,
           seconds = excluded.seconds, refreshed_at = excluded.refreshed_at`;
}

export async function refreshResponseDays(tx: Tx, agencyId: string, days: readonly string[]): Promise<void> {
  if (days.length === 0) return;
  await tx.execute(responseDaysRefresh(agencyId, days));
}

/**
 * The moves of `[from, to)` as rows of (`stage_id`, entered, exited, stay): a move counts as an entry of its
 * `to_stage_id` and, unless it put the lead in its first stage, an exit of its `from_stage_id` with the stay it ended.
 * `lead_stage_history_agency_changed_idx`, index-only.
 */
function movesOf(agencyId: string, from: SQL, to: SQL): SQL {
  const range = sql`h.agency_id = ${agencyId} and h.changed_at >= ${from} and h.changed_at < ${to}`;
  return sql`
    select h.to_stage_id as stage_id, 1 as entered, 0 as exited, null::float8 as stay
      from ${leadStageHistory} h where ${range}
    union all
    select h.from_stage_id, 0, 1, extract(epoch from h.changed_at - h.from_entered_at)::float8
      from ${leadStageHistory} h where ${range} and h.from_stage_id is not null`;
}

/**
 * The agency's `crm_stage_move_rollups` rows of the UTC `days` rebuilt from its stage history: per day of the move and
 * stage, entries, exits, the sum and every one of the stays that ended (ascending). One statement (a lateral range per
 * day, the upsert and the delete of rows no longer backed by a move).
 */
export function moveDaysRefresh(agencyId: string, days: readonly string[]): SQL {
  const dayList = sql`${sql.param(days)}::date[]`;
  const start = sql`(d.day::timestamp at time zone 'UTC')`;
  const end = sql`((d.day + 1)::timestamp at time zone 'UTC')`;
  return sql`
    with d as (select unnest(${dayList}) as day),
    agg as (
      select d.day, m.stage_id, sum(m.entered)::int as entered, sum(m.exited)::int as exited,
             coalesce(sum(m.stay), 0)::float8 as stay_sum,
             coalesce(array_agg(m.stay order by m.stay) filter (where m.stay is not null), '{}'::float8[]) as stays
        from d cross join lateral (${movesOf(agencyId, start, end)}) m
       group by d.day, m.stage_id
    ),
    gone as (
      delete from ${crmStageMoveRollups} c
       where c.agency_id = ${agencyId} and c.day = any(${dayList})
         and not exists (select 1 from agg where agg.day = c.day and agg.stage_id = c.stage_id)
    )
    insert into ${crmStageMoveRollups} (agency_id, day, stage_id, entered, exited, stay_sum, stays, refreshed_at)
    select ${agencyId}::uuid, day, stage_id, entered, exited, stay_sum, stays, now() from agg
    on conflict (agency_id, day, stage_id) do update
       set entered = excluded.entered, exited = excluded.exited, stay_sum = excluded.stay_sum, stays = excluded.stays,
           refreshed_at = excluded.refreshed_at`;
}

/** Rebuilds both per-day rollups of the `days`: the response KPI's (by day of receipt) and the moves' (by day moved). */
export async function refreshReportDays(tx: Tx, agencyId: string, days: readonly string[]): Promise<void> {
  if (days.length === 0) return;
  await tx.execute(responseDaysRefresh(agencyId, days));
  await tx.execute(moveDaysRefresh(agencyId, days));
}

/** The first and last UTC day the agency received a measured lead on or moved one (null: none). Index probes. */
export async function measuredDayRange(tx: Tx, agencyId: string): Promise<{ from: string; to: string } | null> {
  const res = await tx.execute<{ lo: string | null; hi: string | null }>(sql`
    select to_char((min(t) at time zone 'UTC')::date, 'YYYY-MM-DD') as lo,
           to_char((max(t) at time zone 'UTC')::date, 'YYYY-MM-DD') as hi
      from (
        select min(created_ms) as t from ${leads} where agency_id = ${agencyId} and source <> 'MANUAL'
        union all select max(created_ms) from ${leads} where agency_id = ${agencyId} and source <> 'MANUAL'
        union all select min(changed_at) from ${leadStageHistory} where agency_id = ${agencyId}
        union all select max(changed_at) from ${leadStageHistory} where agency_id = ${agencyId}
      ) x`);
  const row = res.rows[0];
  return row?.lo && row.hi ? { from: row.lo, to: row.hi } : null;
}

/** A part of the KPI's range: full UTC days from the rollup, or an instant range from `leads`. */
export type KpiSegment = { kind: 'days'; from: string; to: string } | { kind: 'raw'; from: Date; to: Date };

/**
 * `[from, to)` split into the UTC days it covers whole (from the rollup) and the partial days at either end (read from
 * `leads`, at most two days' worth): exact for any range, and today — never whole while it lasts — always live.
 */
export function kpiSegments(from: Date, to: Date): KpiSegment[] {
  const firstWhole = Math.ceil(from.getTime() / DAY_MS) * DAY_MS;
  const lastWholeEnd = Math.floor(to.getTime() / DAY_MS) * DAY_MS;
  if (firstWhole >= lastWholeEnd) return from < to ? [{ kind: 'raw', from, to }] : [];
  const out: KpiSegment[] = [];
  if (from.getTime() < firstWhole) out.push({ kind: 'raw', from, to: new Date(firstWhole) });
  out.push({ kind: 'days', from: utcDay(new Date(firstWhole)), to: utcDay(new Date(lastWholeEnd)) });
  if (lastWholeEnd < to.getTime()) out.push({ kind: 'raw', from: new Date(lastWholeEnd), to });
  return out;
}

export interface KpiPart {
  userId: string | null;
  leads: number;
  responded: number;
  secondsSum: number;
  /** Every answered lead's seconds (ascending within the part). */
  seconds: number[];
}

/**
 * One statement for the KPI's range: the rollup rows of its whole days (`crm_response_rollups_uq`, a range of the
 * agency's days) and, for the partial days at its ends, the same aggregate straight from `leads`
 * (`leads_agency_response_idx`, index-only). Rows per part and responder; the caller merges them.
 */
export function responseKpiQuery(agencyId: string, from: Date, to: Date): SQL | null {
  const parts = kpiSegments(from, to).map((s) =>
    s.kind === 'days'
      ? sql`select responder_user_id as user_id, leads, responded, seconds_sum, seconds
              from ${crmResponseRollups}
             where agency_id = ${agencyId} and day >= ${s.from}::date and day < ${s.to}::date`
      : sql`select first_responder_user_id as user_id, count(*)::int as leads, count(response_seconds)::int as responded,
                   coalesce(sum(response_seconds), 0)::bigint as seconds_sum,
                   coalesce(array_agg(response_seconds) filter (where response_seconds is not null), '{}'::int[]) as seconds
              from ${leads}
             where agency_id = ${agencyId} and source <> 'MANUAL' and created_ms >= ${s.from.toISOString()}::timestamptz
               and created_ms < ${s.to.toISOString()}::timestamptz
             group by first_responder_user_id`,
  );
  if (parts.length === 0) return null;
  return sql.join(
    parts.map((p) => sql`(${p})`),
    sql` union all `,
  );
}

export async function responseKpiParts(tx: Tx, agencyId: string, from: Date, to: Date): Promise<KpiPart[]> {
  const query = responseKpiQuery(agencyId, from, to);
  if (!query) return [];
  const res = await tx.execute<{
    user_id: string | null;
    leads: number;
    responded: number;
    seconds_sum: string | number;
    seconds: number[] | string;
  }>(query);
  return res.rows.map((r) => ({
    userId: r.user_id,
    leads: Number(r.leads),
    responded: Number(r.responded),
    secondsSum: Number(r.seconds_sum),
    seconds: parseNumberArray(r.seconds),
  }));
}

/** node-postgres parses `int[]` / `float8[]` into numbers; a raw `{1,2}` text (another driver path) is parsed here. */
function parseNumberArray(v: number[] | string): number[] {
  if (Array.isArray(v)) return v.map(Number);
  const inner = v.slice(1, -1);
  return inner === '' ? [] : inner.split(',').map(Number);
}

/** A stage's part of the pipeline report: its leads now (`cur`) or the moves of some days (`moves`). */
export interface ReportPart {
  stageId: string;
  part: 'cur' | 'moves';
  /** `cur`: the leads in the stage now; `moves`: the entries. */
  a: number;
  /** `moves`: the exits. */
  b: number;
  /** `cur`: the mean age of the stays in progress (seconds); `moves`: the sum of the stays that ended. */
  s: number | null;
  /** `moves`: every stay that ended (seconds). */
  stays: number[];
}

/**
 * One statement for the pipeline report: the leads per stage now from `crm_stage_counts` (mean age `now - sum / n`),
 * the moves of the range's whole UTC days from `crm_stage_move_rollups` and those of its partial days at either end
 * straight from `lead_stage_history` (index-only, at most two days). Rows per part and stage; the caller merges them.
 */
export function pipelineReportQuery(agencyId: string, from: Date, to: Date): SQL {
  const parts: SQL[] = [
    sql`select stage_id, 'cur' as part, leads as a, 0 as b,
               extract(epoch from now())::float8 - entered_epoch_sum / leads as s, '{}'::float8[] as stays
          from ${crmStageCounts} where agency_id = ${agencyId}`,
  ];
  for (const seg of kpiSegments(from, to)) {
    if (seg.kind === 'days') {
      parts.push(sql`select stage_id, 'moves', entered, exited, stay_sum, stays from ${crmStageMoveRollups}
                      where agency_id = ${agencyId} and day >= ${seg.from}::date and day < ${seg.to}::date`);
    } else {
      const lo = sql`${seg.from.toISOString()}::timestamptz`;
      const hi = sql`${seg.to.toISOString()}::timestamptz`;
      parts.push(sql`select stage_id, 'moves', sum(entered)::int, sum(exited)::int, coalesce(sum(stay), 0)::float8,
                            coalesce(array_agg(stay) filter (where stay is not null), '{}'::float8[])
                       from (${movesOf(agencyId, lo, hi)}) m
                      group by stage_id`);
    }
  }
  return sql.join(
    parts.map((p) => sql`(${p})`),
    sql` union all `,
  );
}

export async function pipelineReportParts(tx: Tx, agencyId: string, from: Date, to: Date): Promise<ReportPart[]> {
  const res = await tx.execute<{
    stage_id: string;
    part: 'cur' | 'moves';
    a: number;
    b: number;
    s: number | string | null;
    stays: number[] | string;
  }>(pipelineReportQuery(agencyId, from, to));
  return res.rows.map((r) => ({
    stageId: String(r.stage_id),
    part: r.part,
    a: Number(r.a),
    b: Number(r.b),
    s: r.s === null ? null : Number(r.s),
    stays: parseNumberArray(r.stays),
  }));
}
