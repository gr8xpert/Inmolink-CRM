import * as crm from '@inmolink/core/modules/crm';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withTenant } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeReportParts } from '../../packages/core/src/modules/crm/report-rollups';
import {
  pipelineReportParts,
  pipelineReportQuery,
  responseKpiQuery,
} from '../../packages/core/src/modules/crm/report-rollups-repo';

/**
 * CRM reports at scale (S10-09, S10-03; rollups S11-F10): the statements behind `GET /v1/crm/kpis/response-time` and
 * `GET /v1/crm/pipeline/report` on 60,000 leads of one agency received over 90 days (6 stages, one move each within two days of receipt), read
 * from the worker's rollups (`crm_response_rollups`, `crm_stage_counts`) — the repo's own statements, explained as
 * `app_user` under RLS (`serialize`: the rollup's second arrays are detoasted and sent as they would be). The rows are
 * committed (the visibility map needs a VACUUM, which cannot run in a rolled-back transaction) and deleted afterwards.
 * Four other agencies' leads and rollup rows (`NOISE_AGENCIES`) make the agency a fifth of each table, as on a shared
 * production table: on a fresh CI database the agency alone was 90 % of `leads`, so the 92-day range rightly planned a
 * Seq Scan (CI 0aa81c3).
 */

const LEADS = 60_000;
const DAY = 86_400_000;
const NOISE_AGENCIES = [1, 2, 3, 4].map((i) => `00000000-0000-7000-8000-0000005109f${i}`);
const STAGES = ['NEW', 'IN_PROGRESS', 'IN_PROGRESS', 'WON', 'LOST', 'SPAM'];
let founder: Founder;
let stageIds: string[];

/** The rollups of the noise agencies, straight from their leads (no `agencies` rows: replica role skips the FKs). */
const NOISE_ROLLUPS = `
  insert into crm_response_rollups (agency_id, day, responder_user_id, leads, responded, seconds_sum, seconds)
  select agency_id, (created_ms at time zone 'UTC')::date, first_responder_user_id, count(*)::int,
         count(response_seconds)::int, coalesce(sum(response_seconds), 0)::bigint,
         coalesce(array_agg(response_seconds order by response_seconds) filter (where response_seconds is not null), '{}')
    from leads where agency_id in ('${NOISE_AGENCIES.join("','")}') and source <> 'MANUAL'
   group by 1, 2, 3;
  insert into crm_stage_counts (agency_id, stage_id, leads, entered_epoch_sum)
  select agency_id, stage_id, count(*)::int, sum(extract(epoch from stage_entered_at))
    from leads where agency_id in ('${NOISE_AGENCIES.join("','")}') group by 1, 2;
  insert into crm_stage_move_rollups (agency_id, day, stage_id, entered, exited, stay_sum, stays)
  select agency_id, (changed_at at time zone 'UTC')::date, stage_id, sum(entered)::int, sum(exited)::int,
         coalesce(sum(stay), 0), coalesce(array_agg(stay order by stay) filter (where stay is not null), '{}')
    from (select agency_id, changed_at, to_stage_id as stage_id, 1 as entered, 0 as exited, null::float8 as stay
            from lead_stage_history where agency_id in ('${NOISE_AGENCIES.join("','")}')
          union all
          select agency_id, changed_at, from_stage_id, 0, 1, extract(epoch from changed_at - from_entered_at)::float8
            from lead_stage_history where agency_id in ('${NOISE_AGENCIES.join("','")}') and from_stage_id is not null) m
   group by 1, 2, 3;`;

beforeAll(async () => {
  await setupTestDb('worker');
  founder = await createFounder();
  stageIds = STAGES.map((_, i) => `00000000-0000-7000-8000-0000005109e${i}`);
  // 90 days of leads in 6 stages, 80% answered by one of 8 members within 0-3 h; a tenth hand-entered (not measured);
  // one move each (into its stage). The noise agencies' leads are answered too (their rollups carry seconds). One
  // multi-statement simple query = one transaction; replica role skips the FK / stage triggers for the bulk insert.
  await adminQuery(`begin;
    set local session_replication_role = replica;
    insert into pipeline_stages (id, agency_id, name, status, position)
    select (array['${stageIds.join("','")}'])[i]::uuid, '${founder.agencyId}', 'Perf ' || i,
           (array['${STAGES.join("','")}'])[i], i
      from generate_series(1, ${STAGES.length}) i;
    insert into leads (id, agency_id, contact_id, source, status, stage_id, stage_rank, stage_entered_at, created_at,
                       first_human_response_at, response_seconds, first_responder_user_id)
    select gen_random_uuid(), '${founder.agencyId}', gen_random_uuid(), case when g % 10 = 0 then 'MANUAL' else 'WEBSITE' end,
           'NEW', (array['${stageIds.join("','")}'])[1 + g % ${STAGES.length}]::uuid, 'i',
           least(now(), now() - (g * 90.0 / ${LEADS}) * interval '1 day' + (g % 48) * interval '1 hour'),
           now() - (g * 90.0 / ${LEADS}) * interval '1 day',
           case when g % 5 <> 0 then now() end, case when g % 5 <> 0 then (g * 7919) % 10800 end,
           case when g % 5 <> 0 then ('00000000-0000-7000-8000-00000000000' || (g % 8))::uuid end
      from generate_series(1, ${LEADS}) g;
    insert into lead_stage_history (id, agency_id, lead_id, from_stage_id, from_entered_at, to_stage_id, changed_at)
    select gen_random_uuid(), agency_id, id, '${stageIds[0]}', created_at, stage_id,
           date_trunc('milliseconds', stage_entered_at, 'UTC')
      from leads where agency_id = '${founder.agencyId}';
    insert into lead_stage_history (id, agency_id, lead_id, from_stage_id, from_entered_at, to_stage_id, changed_at)
    select gen_random_uuid(), (array['${NOISE_AGENCIES.join("','")}'])[1 + g % 4]::uuid, gen_random_uuid(),
           gen_random_uuid(), now() - (g * 90.0 / ${4 * LEADS}) * interval '1 day' - interval '1 day', gen_random_uuid(),
           date_trunc('milliseconds', now() - (g * 90.0 / ${4 * LEADS}) * interval '1 day', 'UTC')
      from generate_series(1, ${4 * LEADS}) g;
    insert into leads (id, agency_id, contact_id, source, status, stage_id, stage_rank, stage_entered_at, created_at,
                       first_human_response_at, response_seconds, first_responder_user_id)
    select gen_random_uuid(), (array['${NOISE_AGENCIES.join("','")}'])[1 + g % 4]::uuid, gen_random_uuid(), 'WEBSITE',
           'NEW', gen_random_uuid(), 'i', now(), now() - (g * 90.0 / ${4 * LEADS}) * interval '1 day',
           case when g % 5 <> 0 then now() end, case when g % 5 <> 0 then (g * 7919) % 10800 end,
           case when g % 5 <> 0 then ('00000000-0000-7000-8000-00000000000' || (g % 8))::uuid end
      from generate_series(1, ${4 * LEADS}) g;
    ${NOISE_ROLLUPS}
    commit;`);
  // the agency's own rollups through the worker's code path
  const rebuilt = await crm.rebuildReportRollups({ agencyId: founder.agencyId });
  expect(rebuilt.days).toBeGreaterThanOrEqual(90);
  await adminQuery('vacuum analyze leads');
  await adminQuery('vacuum analyze crm_response_rollups');
  await adminQuery('vacuum analyze crm_stage_counts');
  await adminQuery('vacuum analyze crm_stage_move_rollups');
  await adminQuery('vacuum analyze lead_stage_history');
}, 300_000);

afterAll(async () => {
  // The rows have no dependents (inserted with triggers off): skip the FK cascade probes of every activities
  // partition, which made a 300k-row delete outlast the hook.
  const all = `'${founder.agencyId}', '${NOISE_AGENCIES.join("','")}'`;
  await adminQuery(`begin;
    set local session_replication_role = replica;
    delete from lead_stage_history where agency_id in (${all});
    delete from leads where agency_id in (${all});
    delete from crm_response_rollups where agency_id in (${all});
    delete from crm_stage_counts where agency_id in (${all});
    delete from crm_stage_move_rollups where agency_id in (${all});
    delete from pipeline_stages where agency_id = '${founder.agencyId}';
    commit;`);
  await adminQuery('vacuum analyze leads');
  await closeDb();
}, 180_000);

type Run = { plan: string; ms: number };

async function explain(query: SQL): Promise<Run> {
  const run = () =>
    withTenant({ agencyId: founder.agencyId }, async (tx) => {
      const res = await tx.execute(sql`explain (analyze, buffers, serialize text) ${query}`);
      const plan = (res.rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0])).join('\n');
      return { plan, ms: Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1]) };
    });
  await run(); // warm
  const out: Run[] = [];
  for (let i = 0; i < 5; i++) out.push(await run());
  return out.reduce((a, b) => (a.ms <= b.ms ? a : b));
}

/** `[now - days, now)`: whole days from the rollup, today and the first day's tail from `leads`. */
const range = (days: number) => {
  const to = new Date();
  return { from: new Date(to.getTime() - days * DAY), to };
};

describe('CRM reports at scale', () => {
  it('[S11-F10] response KPI reads the rollup: < 20 ms for 30 and 92 days at 60k leads, exact against the leads', async () => {
    const results: Record<string, Run> = {};
    for (const days of [30, 92]) {
      const { from, to } = range(days);
      const q = responseKpiQuery(founder.agencyId, from, to);
      if (!q) throw new Error('empty range');
      results[days] = await explain(q);
    }
    console.info(
      `response KPI, ${LEADS} leads over 90 days — 30 days: ${results[30]?.ms} ms; 92 days: ${results[92]?.ms} ms\n${results[92]?.plan}`,
    );
    for (const r of Object.values(results)) {
      expect(r.plan).toMatch(/crm_response_rollups/);
      expect(r.plan).toContain('Index Only Scan using leads_agency_response_idx');
      expect(r.plan).not.toMatch(/Seq Scan on (leads|crm_response_rollups)/);
      expect(r.ms).toBeLessThan(20);
    }
    // the rollup's numbers are the leads' (the S10-09 statement over the same range, computed here)
    const { from, to } = range(30);
    const direct = await adminQuery<{ leads: number; responded: number; median: string }>(
      `select count(*)::int as leads, count(response_seconds)::int as responded,
              percentile_cont(0.5) within group (order by response_seconds) as median
         from leads where agency_id = $1 and source <> 'MANUAL' and created_ms >= $2 and created_ms < $3`,
      [founder.agencyId, from.toISOString(), to.toISOString()],
    );
    const parts = await withTenant({ agencyId: founder.agencyId }, async (tx) => {
      const res = await tx.execute(responseKpiQuery(founder.agencyId, from, to) as SQL);
      return res.rows as { leads: number; responded: number; seconds: number[] }[];
    });
    const pooled = parts.flatMap((p) => p.seconds).sort((x, y) => x - y);
    const mid = pooled.length >> 1;
    const median = pooled.length % 2 ? pooled[mid] : ((pooled[mid - 1] ?? 0) + (pooled[mid] ?? 0)) / 2;
    expect(parts.reduce((n, p) => n + Number(p.leads), 0)).toBe(direct[0]?.leads);
    expect(pooled.length).toBe(direct[0]?.responded);
    expect(median).toBe(Number(direct[0]?.median));
  }, 180_000);

  it('[S11-F10] pipeline report reads rollups: < 20 ms for 30 and 92 days at 60k leads / 60k moves, exact against the history', async () => {
    const results: Record<string, Run> = {};
    for (const days of [30, 92]) {
      const { from, to } = range(days);
      results[days] = await explain(pipelineReportQuery(founder.agencyId, from, to));
    }
    console.info(
      `pipeline report, ${LEADS} leads / ${LEADS} moves — 30 days: ${results[30]?.ms} ms; 92 days: ${results[92]?.ms} ms\n${results[30]?.plan}`,
    );
    for (const r of Object.values(results)) {
      expect(r.plan).toMatch(/crm_stage_counts/);
      expect(r.plan).toMatch(/crm_stage_move_rollups/);
      // the current leads are no longer aggregated from `leads`
      expect(r.plan).not.toMatch(/ on leads\b|leads_agency_stage_rank_idx/);
      expect(r.plan).not.toMatch(/Seq Scan on (lead_stage_history|crm_stage_counts|crm_stage_move_rollups)/);
      expect(r.ms).toBeLessThan(20);
    }
    // the merged parts are the S10-03 aggregates over the raw history and leads
    const { from, to } = range(30);
    const merged = await withTenant({ agencyId: founder.agencyId }, async (tx) =>
      mergeReportParts(await pipelineReportParts(tx, founder.agencyId, from, to)),
    );
    const direct = await adminQuery<{ stage_id: string; entered: number; exited: number; median: number | null }>(
      `with moves as (
         select from_stage_id, to_stage_id, extract(epoch from changed_at - from_entered_at) as stay
           from lead_stage_history where agency_id = $1 and changed_at >= $2 and changed_at < $3)
       select s.id as stage_id, (select count(*)::int from moves where to_stage_id = s.id) as entered,
              (select count(*)::int from moves where from_stage_id = s.id) as exited,
              (select percentile_cont(0.5) within group (order by stay) from moves where from_stage_id = s.id) as median
         from pipeline_stages s where s.agency_id = $1`,
      [founder.agencyId, from.toISOString(), to.toISOString()],
    );
    for (const d of direct) {
      const m = merged.find((x) => x.stageId === d.stage_id);
      expect({ entered: m?.entered ?? 0, exited: m?.exited ?? 0, median: m?.medianSeconds ?? null }).toEqual({
        entered: d.entered,
        exited: d.exited,
        median: d.median === null ? null : Math.round(Number(d.median)),
      });
    }
    expect(merged.reduce((n, x) => n + x.current, 0)).toBe(LEADS);
  }, 180_000);
});
