import {
  CreateActivityBody,
  CreateContactBody,
  CreateLeadBody,
  MoveLeadBody,
  ResponseTimeQuery,
} from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../index';
import { REPORT_DAY_THROTTLE_MS, reportDaysOf, STAGE_COUNTS_THROTTLE_MS } from '../jobs';

/**
 * CRM report rollups (S11-F10): the pipeline report's leads per stage now and the response-time KPI read rollups
 * (`crm_stage_counts`, `crm_response_rollups`) the worker rebuilds from `leads` on lead events. The rebuilds are
 * called directly here; the subscriptions are checked to queue them.
 */

const RUN = newId().slice(-8).toLowerCase();
const DAY = 86_400_000;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.rollups.test', fn);

let f: Founder;
let agent2: string;
const as = <T>(userId: string, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId, agencyId: f.agencyId, requestId: newId(), locale: 'en' }, fn);

async function newLead(source: 'PORTAL' | 'MANUAL' = 'PORTAL') {
  const { contact } = await as(f.userId, (ctx) =>
    crm.createContact(
      ctx,
      CreateContactBody.parse({ firstName: 'Roll', emails: [`roll-${newId()}-${RUN}@example.com`] }),
    ),
  );
  const { lead } = await as(f.userId, (ctx) =>
    crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, source, assignedUserId: null })),
  );
  return lead;
}

/** A lead received at `createdAt`, answered after `seconds` by `by` (null: unanswered). */
async function seeded(createdAt: Date, answer: [number, string] | null) {
  const lead = await newLead();
  await system((tx) =>
    tx.execute(sql`update leads set created_at = ${createdAt.toISOString()},
      first_human_response_at = ${answer ? new Date(createdAt.getTime() + answer[0] * 1000).toISOString() : null},
      response_seconds = ${answer ? answer[0] : null}, first_responder_user_id = ${answer ? answer[1] : null}
      where id = ${lead.id}`),
  );
  return lead;
}

const rollupRows = (day: string) =>
  adminQuery<{
    responder_user_id: string | null;
    leads: number;
    responded: number;
    seconds_sum: string;
    seconds: number[];
  }>(
    `select responder_user_id, leads, responded, seconds_sum, seconds from crm_response_rollups
      where agency_id = $1 and day = $2 order by responder_user_id nulls first`,
    [f.agencyId, day],
  );

/** S12-F6: stage counts brought up to now (the pass's cutoff is `STAGE_COUNTS_LAG_MS` behind its `now`). */
const upToNow = () => ({ now: new Date(Date.now() + crm.STAGE_COUNTS_LAG_MS) });

beforeAll(async () => {
  await setupTestDb('worker');
  f = await createFounder();
  agent2 = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agent2}, ${`roll-${agent2}@example.com`}, 'x', 'Agent two', 'en', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${f.agencyId}, ${agent2}, 'AGENT', 'Agent two', ${`roll-${agent2}@example.com`})`);
  });
});

afterAll(async () => {
  await closeDb();
});

describe('response-time KPI rollup', () => {
  /** Two whole UTC days 40 days back. */
  const d0 = Math.floor((Date.now() - 40 * DAY) / DAY) * DAY;
  const day0 = new Date(d0).toISOString().slice(0, 10);
  const day1 = new Date(d0 + DAY).toISOString().slice(0, 10);
  const kpi = (from: number, to: number) =>
    as(f.userId, (ctx) =>
      crm.getResponseTimeKpi(
        ctx,
        ResponseTimeQuery.parse({ from: new Date(from).toISOString(), to: new Date(to).toISOString() }),
      ),
    );
  let changed = '';

  beforeAll(async () => {
    const at = (day: number, minute: number) => new Date(d0 + day * DAY + minute * 60_000);
    // day 0: 90 / 10 / 20 s by the founder, one unanswered; day 1: 10 / 20 s by the founder, 90 / 100 s by agent two
    await seeded(at(0, 1), [90, f.userId]);
    changed = (await seeded(at(0, 2), [10, f.userId])).id;
    await seeded(at(0, 3), [20, f.userId]);
    await seeded(at(0, 4), null);
    await seeded(at(1, 1), [10, f.userId]);
    await seeded(at(1, 2), [20, f.userId]);
    await seeded(at(1, 3), [90, agent2]);
    await seeded(at(1, 4), [100, agent2]);
    await crm.rebuildReportRollups({ agencyId: f.agencyId });
  });

  it('[S11-F10] whole days come from the rollup with every second kept: exact medians, same as a partial-day read', async () => {
    expect(await rollupRows(day0)).toEqual([
      { responder_user_id: null, leads: 1, responded: 0, seconds_sum: '0', seconds: [] },
      { responder_user_id: f.userId, leads: 3, responded: 3, seconds_sum: '120', seconds: [10, 20, 90] },
    ]);
    const whole = await kpi(d0, d0 + 2 * DAY);
    // 10 10 20 20 90 90 100: median 20, mean 340 / 7
    expect(whole).toMatchObject({ leads: 8, responded: 7, medianSeconds: 20, avgSeconds: 49 });
    expect(whole.agents.map((x) => [x.userId, x.responded, x.medianSeconds, x.avgSeconds])).toEqual([
      [f.userId, 5, 20, 30],
      [agent2, 2, 95, 95],
    ]);
    // the same leads through a raw partial first day + a rollup day, and through raw partial days only
    expect(await kpi(d0 + 30_000, d0 + 2 * DAY)).toEqual({ ...whole, from: new Date(d0 + 30_000).toISOString() });
    const raw = await kpi(d0 + 30_000, d0 + 2 * DAY - 1);
    expect(raw).toMatchObject({ leads: 8, responded: 7, medianSeconds: 20, avgSeconds: 49 });
    expect(raw.agents).toEqual(whole.agents);
    // an even pooled count across parts: day 1 alone (10 20 90 100) → 55
    expect(await kpi(d0 + DAY, d0 + 2 * DAY)).toMatchObject({ leads: 4, medianSeconds: 55 });
  });

  it('[S11-F10] a change reaches whole days with its day’s rebuild; rebuilds are idempotent; a day left with no measured lead loses its rows', async () => {
    await system((tx) => tx.execute(sql`update leads set response_seconds = 1000 where id = ${changed}`));
    // not rebuilt yet: the whole days still read the rollup
    expect((await kpi(d0, d0 + DAY)).medianSeconds).toBe(20);
    await crm.refreshReportDay({ agencyId: f.agencyId, day: day0 });
    const once = await rollupRows(day0);
    await crm.refreshReportDay({ agencyId: f.agencyId, day: day0 });
    expect(await rollupRows(day0)).toEqual(once);
    // 20 90 1000
    expect(await kpi(d0, d0 + DAY)).toMatchObject({ leads: 4, responded: 3, medianSeconds: 90, avgSeconds: 370 });
    // every lead of day 1 hand-entered (not measured): the day's rows go
    const d1From = new Date(d0 + DAY).toISOString();
    const d1To = new Date(d0 + 2 * DAY).toISOString();
    await system((tx) =>
      tx.execute(sql`update leads set source = 'MANUAL' where agency_id = ${f.agencyId}
        and created_ms >= ${d1From}::timestamptz and created_ms < ${d1To}::timestamptz`),
    );
    await crm.refreshReportDay({ agencyId: f.agencyId, day: day1 });
    expect(await rollupRows(day1)).toEqual([]);
    expect(await kpi(d0 + DAY, d0 + 2 * DAY)).toMatchObject({
      leads: 0,
      responded: 0,
      medianSeconds: null,
      agents: [],
    });
  });

  it('[S11-F10] the rollup is worker-written: a member reads its own agency’s rows and cannot write them', async () => {
    const own = await as(f.userId, (ctx) =>
      ctx.tx.execute(sql`select count(*)::int as n from crm_response_rollups where day = ${day0}::date`),
    );
    expect((own.rows[0] as { n: number }).n).toBeGreaterThan(0);
    const code = await as(f.userId, (ctx) =>
      ctx.tx.execute(sql`update crm_response_rollups set leads = leads where day = ${day0}::date`),
    ).then(
      () => 'ok',
      (e: unknown) => (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code,
    );
    expect(code).toBe('42501');
  });
});

describe('leads-per-stage rollup', () => {
  it('[S11-F10] the report’s leads per stage follow a rebuild; a stage that empties loses its row; a rerun changes nothing', async () => {
    const r = await createFounder();
    const asR = <T>(fn: (ctx: Ctx) => Promise<T>) =>
      withMemberCtx({ userId: r.userId, agencyId: r.agencyId, requestId: newId(), locale: 'en' }, fn);
    const mk = async () => {
      const { contact } = await asR((ctx) =>
        crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Stage', emails: [`st-${newId()}@example.com`] })),
      );
      return (
        await asR((ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, source: 'PORTAL' })))
      ).lead;
    };
    const leads = [await mk(), await mk()];
    const stages = (await asR((ctx) => crm.listPipelineStages(ctx, {}))).items;
    const entry = stages.find((s) => s.key === 'NEW');
    const won = stages.find((s) => s.key === 'WON');
    if (!entry || !won) throw new Error('stages');
    await adminQuery(`update leads set stage_entered_at = now() - interval '1 hour' where agency_id = $1`, [
      r.agencyId,
    ]);
    await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow());
    const range = { from: new Date(Date.now() - DAY).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    const report = () => asR((ctx) => crm.getPipelineReport(ctx, range));
    const row = async (id: string) => (await report()).stages.find((s) => s.stage.id === id);
    expect(await row(entry.id)).toMatchObject({ current: 2 });
    expect((await row(entry.id))?.currentAvgSeconds).toBeGreaterThanOrEqual(3_600);
    expect((await row(entry.id))?.currentAvgSeconds).toBeLessThan(3_700);

    for (const l of leads)
      await asR((ctx) => crm.moveLead(ctx, l.id, MoveLeadBody.parse({ version: l.version, stageId: won.id })));
    // not rebuilt yet: the rollup's numbers stand
    expect(await row(won.id)).toMatchObject({ current: 0 });
    await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow());
    const rows = () =>
      adminQuery<{ stage_id: string; leads: number }>(
        'select stage_id, leads from crm_stage_counts where agency_id = $1 order by stage_id',
        [r.agencyId],
      );
    const once = await rows();
    expect(once).toEqual([{ stage_id: won.id, leads: 2 }]);
    await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow());
    expect(await rows()).toEqual(once);
    expect(await row(won.id)).toMatchObject({ current: 2, entered: 2 });
    expect(await row(entry.id)).toMatchObject({ current: 0, currentAvgSeconds: null, exited: 2 });
  });
});

describe('stage moves rollup', () => {
  it('[S11-F10] the report’s whole days of moves come from the rollup: exact median time in stage; a day’s rebuild picks up a change', async () => {
    const r = await createFounder();
    const asR = <T>(fn: (ctx: Ctx) => Promise<T>) =>
      withMemberCtx({ userId: r.userId, agencyId: r.agencyId, requestId: newId(), locale: 'en' }, fn);
    // the stages exist once the agency writes a lead
    const { contact } = await asR((ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Mv', emails: [`mv-${newId()}@example.com`] })),
    );
    await asR((ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, source: 'PORTAL' })));
    const stages = (await asR((ctx) => crm.listPipelineStages(ctx, {}))).items;
    const entry = stages.find((s) => s.key === 'NEW');
    const won = stages.find((s) => s.key === 'WON');
    if (!entry || !won) throw new Error('stages');
    const d0 = Math.floor((Date.now() - 40 * DAY) / DAY) * DAY;
    const day0 = new Date(d0).toISOString().slice(0, 10);
    /** A move NEW → WON on day 0 after `stay` seconds in NEW (no lead behind it: replica role skips the FKs). */
    const moved = (minute: number, stay: number) => {
      const at = d0 + minute * 60_000;
      return `insert into lead_stage_history (id, agency_id, lead_id, from_stage_id, from_entered_at, to_stage_id, changed_at)
        values ('${newId()}', '${r.agencyId}', '${newId()}', '${entry.id}', '${new Date(at - stay * 1000).toISOString()}',
                '${won.id}', '${new Date(at).toISOString()}');`;
    };
    await adminQuery(`begin; set local session_replication_role = replica;
      ${moved(10, 60)} ${moved(20, 120)} ${moved(30, 600)} commit;`);
    await crm.refreshReportDay({ agencyId: r.agencyId, day: day0 });
    const report = (from: number, to: number) =>
      asR((ctx) => crm.getPipelineReport(ctx, { from: new Date(from).toISOString(), to: new Date(to).toISOString() }));
    const row = (rep: Awaited<ReturnType<typeof report>>, id: string) => rep.stages.find((s) => s.stage.id === id);
    const whole = await report(d0, d0 + DAY);
    expect(row(whole, entry.id)).toMatchObject({
      entered: 0,
      exited: 3,
      avgSecondsInStage: 260,
      medianSecondsInStage: 120,
    });
    expect(row(whole, won.id)).toMatchObject({ entered: 3, exited: 0, medianSecondsInStage: null });
    expect(whole).toMatchObject({ won: 3 });
    // the same moves through a raw partial day
    const partial = await report(d0 + 60_000, d0 + DAY - 1);
    expect(row(partial, entry.id)).toMatchObject({ exited: 3, avgSecondsInStage: 260, medianSecondsInStage: 120 });
    // a fourth move: not in the whole day until the day's rebuild; then an even count → the mean of the middle two
    await adminQuery(`begin; set local session_replication_role = replica; ${moved(40, 900)} commit;`);
    expect(row(await report(d0, d0 + DAY), entry.id)).toMatchObject({ exited: 3 });
    await crm.refreshReportDay({ agencyId: r.agencyId, day: day0 });
    await crm.refreshReportDay({ agencyId: r.agencyId, day: day0 });
    expect(row(await report(d0, d0 + DAY), entry.id)).toMatchObject({ exited: 4, medianSecondsInStage: 360 });
    const rollup = await adminQuery<{ stage_id: string; entered: number; exited: number; stays: number[] }>(
      'select stage_id, entered, exited, stays from crm_stage_move_rollups where agency_id = $1 and day = $2',
      [r.agencyId, day0],
    );
    expect(rollup).toHaveLength(2);
    expect(rollup.find((x) => x.stage_id === entry.id)).toMatchObject({ exited: 4, stays: [60, 120, 600, 900] });
    await adminQuery(`begin; set local session_replication_role = replica;
      delete from lead_stage_history where agency_id = '${r.agencyId}' and changed_at < now() - interval '1 day'; commit;`);
    await crm.refreshReportDay({ agencyId: r.agencyId, day: day0 });
    expect(
      await adminQuery('select 1 from crm_stage_move_rollups where agency_id = $1 and day = $2', [r.agencyId, day0]),
    ).toEqual([]);
  });
});

describe('rollup refresh from lead events', () => {
  it('[S11-F10] lead created / responded / stage changed queue throttled rebuilds of the lead’s day and the stage counts; a later answer emits nothing', async () => {
    const stage = vi.spyOn(crm.crmJobs.refreshStageCounts, 'enqueue').mockResolvedValue({ id: 'x' });
    const day = vi.spyOn(crm.crmJobs.refreshReportDay, 'enqueue').mockResolvedValue({ id: 'x' });
    crm.registerCrmSubscriptions();
    try {
      const lead = await newLead();
      const log = (at: Date) =>
        as(f.userId, (ctx) =>
          crm.logActivity(
            ctx,
            CreateActivityBody.parse({ leadId: lead.id, type: 'CALL', occurredAt: at.toISOString(), body: 'x' }),
          ),
        );
      await log(new Date());
      await log(new Date()); // not earlier: no second event
      const won = (await as(f.userId, (ctx) => crm.listPipelineStages(ctx, {}))).items.find((s) => s.key === 'WON');
      if (!won) throw new Error('stages');
      const current = await as(f.userId, (ctx) => crm.getLead(ctx, lead.id));
      await as(f.userId, (ctx) =>
        crm.moveLead(ctx, lead.id, MoveLeadBody.parse({ version: current.version, stageId: won.id })),
      );
      const events = await adminQuery<{
        id: string;
        type: string;
        version: number;
        payload: { leadId?: string; receivedMs?: number };
        created_at: string;
      }>(
        `select id, type, version, payload, created_at from outbox_events where agency_id = $1
          and type in ('crm.lead.created', 'crm.lead.responded', 'crm.lead.stageChanged')
          and payload->>'leadId' = $2 order by created_at, id`,
        [f.agencyId, lead.id],
      );
      expect(events.map((e) => e.type)).toEqual(['crm.lead.created', 'crm.lead.responded', 'crm.lead.stageChanged']);
      const receivedMs = events[0]?.payload.receivedMs;
      expect(events.every((e) => e.payload.receivedMs === receivedMs)).toBe(true);
      for (const row of events) {
        for (const sub of defaultSubscribers.get(row.type, row.version)) {
          if (!sub.name.startsWith('crm.reports.')) continue;
          await sub.handler(sub.def.schema.parse(row.payload), {
            eventId: row.id,
            agencyId: f.agencyId,
            type: row.type,
            version: row.version,
            createdAt: new Date(row.created_at),
            attempt: 1,
          });
        }
      }
      const movedMs = (events[2]?.payload as { movedMs?: number } | undefined)?.movedMs;
      expect(movedMs).toBeGreaterThanOrEqual(receivedMs ?? Number.POSITIVE_INFINITY);
      const queued = (days: string[]) =>
        days.map((d) => [
          { agencyId: f.agencyId, day: d },
          { throttleMs: REPORT_DAY_THROTTLE_MS, debounceKey: `report-day.${d}` },
        ]);
      // created → the receipt day; responded → the receipt day; stage changed → the move's day and the receipt day
      expect(day.mock.calls).toEqual([
        ...queued(reportDaysOf(receivedMs ?? 0)),
        ...queued(reportDaysOf(receivedMs ?? 0)),
        ...queued(reportDaysOf(movedMs ?? 0, receivedMs ?? 0)),
      ]);
      expect(reportDaysOf(Date.parse('2026-09-01T12:00:00Z'))).toEqual(['2026-09-01']);
      expect(reportDaysOf(Date.parse('2026-09-01T23:59:30Z'))).toEqual(['2026-09-01', '2026-09-02']);
      expect(stage.mock.calls).toEqual(
        Array.from({ length: 2 }, () => [
          { agencyId: f.agencyId },
          { throttleMs: STAGE_COUNTS_THROTTLE_MS, debounceKey: 'stage-counts' },
        ]),
      );
    } finally {
      crm.unregisterCrmSubscriptions();
      stage.mockRestore();
      day.mockRestore();
    }
  });
});
