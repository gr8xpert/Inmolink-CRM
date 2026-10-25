import type { Tx } from '@inmolink/db';
import {
  crmResponseRollups,
  crmStageCounts,
  crmStageMoveRollups,
  leadStageHistory,
  leads,
} from '@inmolink/db/schema/crm';
import { type AnyColumn, type SQL, sql } from 'drizzle-orm';

/**
 * Report rollups (S11-F10): the statements that rebuild `crm_stage_counts` and `crm_response_rollups` from `leads`,
 * and the KPI's read over them. Rebuilt from the source each time, so a rerun, a redelivered event or two refreshes in
 * a row leave the same rows — S12-F6: `crm_stage_counts` follows the stage history by deltas between rebuilds, from a
 * watermark (a rerun finds its window applied). Queries only `@inmolink/db/schema/crm`.
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

/** S12-F6: the advisory lock key of an agency's stage counts (`agencyId`: a uuid expression). */
const stageKey = (agencyId: SQL) => sql`hashtextextended('crm_stage_counts:' || (${agencyId})::text, 0)`;

/**
 * S12-F6: the writers' side of the stage-count lock — a transaction that moves a lead into or out of a stage (a new
 * lead, a move, a status set) takes the agency's lock SHARED before it reads the clock for `stage_entered_at`, in its
 * first statement (a column of it: no extra round trip). Writers never wait for each other; the pass's exclusive lock
 * waits for every writer of the agency still open and holds new ones back for its few milliseconds — so no move it
 * could not see yet ever sits below its cutoff (commit-ordered, whatever a writer's duration).
 */
export const stageWriteLock = (agencyId: SQL | AnyColumn) =>
  sql<null>`pg_advisory_xact_lock_shared(${stageKey(sql`${agencyId}`)})`;

/**
 * S12-F6: the pass's side — the agency's stage-count lock EXCLUSIVE (waits for its open writers: their moves are then
 * committed and visible to the pass's next statement; serializes passes and rebuilds too), then the database clock,
 * which the cutoff is taken from. One statement.
 */
export async function lockStageCounts(tx: Tx, agencyId: string): Promise<Date> {
  const res = await tx.execute<{ now: Date | string }>(sql`
    select clock_timestamp() as now from (select pg_advisory_xact_lock(${stageKey(sql`${agencyId}::uuid`)})) l`);
  return new Date(res.rows[0]?.now ?? Date.now());
}

/**
 * The full rebuild (S11-F10; S12-F6: as of `cutoff`): the agency's leads per stage now — count and Σ entry times,
 * index-only on `leads_agency_stage_rank_idx` (agency, stage, …, stage_entered_at) — with every stage move after
 * `cutoff` undone from `lead_stage_history` (`lead_stage_history_agency_changed_idx`, index-only), so the rows are
 * the counts as of `cutoff` and `refreshed_at = cutoff` is where the next delta pass starts. A stage left empty loses
 * its row. One statement (the upsert and the delete in data-modifying CTEs, disjoint rows).
 */
export function stageCountsRebuild(agencyId: string, cutoff: Date): SQL {
  const at = sql`${cutoff.toISOString()}::timestamptz`;
  return sql`
    with parts as (
      select stage_id, count(*)::int as n, sum(extract(epoch from stage_entered_at))::float8 as s
        from ${leads} where agency_id = ${agencyId} group by stage_id
      union all
      select h.to_stage_id, -count(*)::int, -sum(extract(epoch from h.changed_at))::float8
        from ${leadStageHistory} h where h.agency_id = ${agencyId} and h.changed_at > ${at} group by h.to_stage_id
      union all
      select h.from_stage_id, count(*)::int, sum(extract(epoch from h.from_entered_at))::float8
        from ${leadStageHistory} h
       where h.agency_id = ${agencyId} and h.changed_at > ${at} and h.from_stage_id is not null
       group by h.from_stage_id
    ),
    agg as (
      select stage_id, sum(n)::int as n, sum(s)::float8 as s from parts group by stage_id having sum(n) > 0
    ),
    prior as (select stage_id, leads from ${crmStageCounts} where agency_id = ${agencyId}),
    gone as (
      delete from ${crmStageCounts} c
       where c.agency_id = ${agencyId} and not exists (select 1 from agg where agg.stage_id = c.stage_id)
    ),
    up as (
      insert into ${crmStageCounts} (agency_id, stage_id, leads, entered_epoch_sum, refreshed_at)
      select ${agencyId}::uuid, stage_id, n, s, ${at} from agg
      on conflict (agency_id, stage_id) do update
         set leads = excluded.leads, entered_epoch_sum = excluded.entered_epoch_sum, refreshed_at = excluded.refreshed_at
    )
    select coalesce(sum(abs(coalesce(agg.n, 0) - coalesce(prior.leads, 0))), 0)::int as drift,
           (select count(*) from prior)::int as prior_rows
      from agg full join prior on prior.stage_id = agg.stage_id`;
}

/**
 * Rebuilds as of `cutoff`. `drift`: Σ |leads before − leads rebuilt| over the stages — after a delta pass up to the same
 * cutoff, what the deltas had wrong (0 when they were exact); `priorRows`: 0 when the agency had no rows.
 */
export async function rebuildStageCounts(
  tx: Tx,
  agencyId: string,
  cutoff: Date,
): Promise<{ drift: number; priorRows: number }> {
  const res = await tx.execute<{ drift: number; prior_rows: number }>(stageCountsRebuild(agencyId, cutoff));
  return { drift: Number(res.rows[0]?.drift ?? 0), priorRows: Number(res.rows[0]?.prior_rows ?? 0) };
}

/**
 * S12-F6, the delta pass: the stage moves (`lead_stage_history`: a lead's entry — `from_stage_id` null — or a move)
 * after the agency's watermark (the latest `refreshed_at` of its rows) up to `cutoff`, applied as ±1 and ± entry time
 * to the stages they touch — one history row read per event (one range on `lead_stage_history_agency_changed_idx`,
 * index-only, each row giving its entry and its exit), one rollup row written per stage touched (`refreshed_at = cutoff`: the new watermark); `leads` is never
 * read. A stage brought to 0 loses its row. Nothing is written when a stage would go below 0 (the rollup drifted: a
 * direct or backdated write — `negative`: the caller rebuilds). One statement; it also says whether the agency has rows
 * at all (`watermark`) and whether moves after `cutoff` wait for a later pass (`pending`).
 */
export function stageCountsDelta(agencyId: string, cutoff: Date): SQL {
  const at = sql`${cutoff.toISOString()}::timestamptz`;
  // the window's rows read once (index-only), each giving its entry (+1) and, for a move, its exit (−1)
  const window = sql`h.agency_id = ${agencyId} and h.changed_at > (select w from wm) and h.changed_at <= ${at}`;
  return sql`
    with wm as (select max(refreshed_at) as w from ${crmStageCounts} where agency_id = ${agencyId}),
    raw as (
      select v.stage_id, v.n, v.s
        from ${leadStageHistory} h
        cross join lateral (values (h.to_stage_id, 1, extract(epoch from h.changed_at)::float8),
                                   (h.from_stage_id, -1, -extract(epoch from h.from_entered_at)::float8)) v(stage_id, n, s)
       where ${window} and v.stage_id is not null
    ),
    d as (
      select stage_id, sum(n)::int as n, sum(s)::float8 as s, (count(*) filter (where n = 1))::int as moves
        from raw group by stage_id
    ),
    nxt as (
      select d.stage_id, coalesce(c.leads, 0) + d.n as n, coalesce(c.entered_epoch_sum, 0) + d.s as s
        from d left join ${crmStageCounts} c on c.agency_id = ${agencyId} and c.stage_id = d.stage_id
    ),
    ok as (select not exists (select 1 from nxt where n < 0) as ok),
    gone as (
      delete from ${crmStageCounts} c using nxt
       where c.agency_id = ${agencyId} and c.stage_id = nxt.stage_id and nxt.n = 0 and (select ok from ok)
      returning 1
    ),
    up as (
      insert into ${crmStageCounts} (agency_id, stage_id, leads, entered_epoch_sum, refreshed_at)
      select ${agencyId}::uuid, stage_id, n, s, ${at} from nxt where n > 0 and (select ok from ok)
      on conflict (agency_id, stage_id) do update
         set leads = excluded.leads, entered_epoch_sum = excluded.entered_epoch_sum, refreshed_at = excluded.refreshed_at
      returning 1
    )
    select (select w from wm) is not null as watermark,
           not (select ok from ok) as negative,
           coalesce((select sum(moves) from d), 0)::int as moves,
           ((select count(*) from up) + (select count(*) from gone))::int as written,
           exists (select 1 from ${leadStageHistory} h
                    where h.agency_id = ${agencyId} and h.changed_at > ${at}) as pending`;
}

export interface StageCountsDelta {
  /** The agency has rollup rows (false: never built — the caller rebuilds). */
  watermark: boolean;
  /** A stage would go below 0: nothing was written (the caller rebuilds). */
  negative: boolean;
  /** Stage moves (history rows) applied. */
  moves: number;
  /** Rollup rows written or removed. */
  written: number;
  /** Moves after the cutoff, for a later pass. */
  pending: boolean;
}

export async function applyStageCountsDelta(tx: Tx, agencyId: string, cutoff: Date): Promise<StageCountsDelta> {
  const res = await tx.execute<{
    watermark: boolean;
    negative: boolean;
    moves: number;
    written: number;
    pending: boolean;
  }>(stageCountsDelta(agencyId, cutoff));
  const r = res.rows[0];
  return {
    watermark: Boolean(r?.watermark),
    negative: Boolean(r?.negative),
    moves: Number(r?.moves ?? 0),
    written: Number(r?.written ?? 0),
    pending: Boolean(r?.pending),
  };
}

/** S12-F6: whether the agency has stage moves after `cutoff` (after a rebuild: a later delta pass applies them). */
export async function movesAfter(tx: Tx, agencyId: string, cutoff: Date): Promise<boolean> {
  const res = await tx.execute<{ pending: boolean }>(sql`
    select exists (select 1 from ${leadStageHistory} h
                    where h.agency_id = ${agencyId} and h.changed_at > ${cutoff.toISOString()}::timestamptz) as pending`);
  return Boolean(res.rows[0]?.pending);
}

/** S12-F6: the agencies with stage-count rows after `after` in id order (the nightly rebuild's keyset pages). */
export async function stageCountAgencies(tx: Tx, after: string | null, limit: number): Promise<string[]> {
  const res = await tx.execute<{ agency_id: string }>(sql`
    select distinct agency_id from ${crmStageCounts}
     where ${after ? sql`agency_id > ${after}::uuid` : sql`true`}
     order by agency_id limit ${limit}`);
  return res.rows.map((r) => String(r.agency_id));
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
