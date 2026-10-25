import { CreateContactBody, CreateLeadBody, type LeadDto, MoveLeadBody } from '@inmolink/contracts';
import { closeDb } from '@inmolink/db';
import { adminQuery, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../index';
import { STAGE_COUNTS_SWEEP_SPREAD_MS, STAGE_COUNTS_THROTTLE_MS, sweepDelayOf } from '../jobs';
import { stageCountsDelta } from '../report-rollups-repo';

/**
 * S12-F6: the leads-per-stage rollup follows the stage history by deltas — one history row read per event, one rollup
 * row written per stage touched, `leads` never read — with a full rebuild the first time, on drift and nightly.
 * Wall-clock free: the pass's cutoff is given (`now`), the work is checked by plan and by counts.
 */

const log = createLogger({ service: 'crm-stage-counts-test', level: 'silent' });
const jobCtx = () => ({
  log,
  jobId: 'test',
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});
/** A pass whose cutoff is now (its `now` is the lag ahead). */
const upToNow = () => ({ now: new Date(Date.now() + crm.STAGE_COUNTS_LAG_MS) });

let r: Founder;
let entry: string;
let won: string;
let lost: string;
const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: r.userId, agencyId: r.agencyId, requestId: newId(), locale: 'en' }, fn);

async function newLead(): Promise<LeadDto> {
  const { contact } = await as((ctx) =>
    crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Count', emails: [`sc-${newId()}@example.com`] })),
  );
  return (await as((ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, source: 'PORTAL' }))))
    .lead;
}
const move = (lead: LeadDto, stageId: string) =>
  as((ctx) => crm.moveLead(ctx, lead.id, MoveLeadBody.parse({ version: lead.version, stageId })));

type Row = { stage_id: string; leads: number; entered_epoch_sum: number };
const counts = () =>
  adminQuery<Row>(
    'select stage_id, leads, entered_epoch_sum from crm_stage_counts where agency_id = $1 order by stage_id',
    [r.agencyId],
  );
/** What a full rebuild from `leads` gives (the source of truth). */
const truth = () =>
  adminQuery<Row>(
    `select stage_id, count(*)::int as leads, sum(extract(epoch from stage_entered_at))::float8 as entered_epoch_sum
       from leads where agency_id = $1 group by stage_id order by stage_id`,
    [r.agencyId],
  );
const same = (a: Row[], b: Row[]) => {
  expect(a.map((x) => [x.stage_id, x.leads])).toEqual(b.map((x) => [x.stage_id, x.leads]));
  a.forEach((x, i) => {
    expect(Number(x.entered_epoch_sum)).toBeCloseTo(Number(b[i]?.entered_epoch_sum), 3);
  });
};

beforeAll(async () => {
  await setupTestDb('worker');
  r = await createFounder();
  await newLead(); // the agency's stages exist once it writes a lead
  const stages = (await as((ctx) => crm.listPipelineStages(ctx, {}))).items;
  const id = (key: string) => {
    const s = stages.find((x) => x.key === key);
    if (!s) throw new Error(key);
    return s.id;
  };
  [entry, won, lost] = [id('NEW'), id('WON'), id('LOST')];
});

afterAll(async () => {
  await closeDb();
});

describe('stage counts by delta', () => {
  it('[S12-F6] a pass reads one history row per event and writes one rollup row per stage touched; leads are not read', async () => {
    const leads = [await newLead(), await newLead(), await newLead()];
    expect(await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow())).toMatchObject({ mode: 'rebuild' });
    same(await counts(), await truth());

    // three events: two moves out of the entry stage, one new lead in it
    await move(leads[0] as LeadDto, won);
    await move(leads[1] as LeadDto, lost);
    await newLead();
    const at = upToNow();

    // the plan: one index-only range on the history's (agency, changed_at) index, one row per event, no leads
    const cutoff = new Date((at.now as Date).getTime() - crm.STAGE_COUNTS_LAG_MS);
    // the window's pages all-visible (as autovacuum keeps them), so the index-only scan needs no heap
    await adminQuery('vacuum lead_stage_history');
    // at volume: 50,000 older moves of this agency (before its watermark) in a rolled-back seed, analysed, the pass
    // EXPLAIN ANALYZEd as the worker's role (its writes rolled back with the seed)
    const plan = await withAdminRollback(['lead_stage_history'], async (q) => {
      await q('set local session_replication_role = replica');
      await q(
        `insert into lead_stage_history (id, agency_id, lead_id, from_stage_id, from_entered_at, to_stage_id, changed_at)
         select gen_random_uuid(), $1, gen_random_uuid(), $2::uuid,
                date_trunc('milliseconds', now() - interval '20 days', 'UTC'), $3::uuid,
                date_trunc('milliseconds', now() - interval '10 days' - g * interval '1 second', 'UTC')
           from generate_series(1, 50000) g`,
        [r.agencyId, entry, won],
      );
      await q('analyze lead_stage_history');
      await q('set local role app_system');
      const query = new PgDialect().sqlToQuery(stageCountsDelta(r.agencyId, cutoff));
      const out = await q(`explain (analyze, format json) ${query.sql}`, query.params);
      return Object.values(out[0] ?? {})[0];
    });
    const nodes: Record<string, unknown>[] = [];
    const walk = (n: Record<string, unknown>) => {
      nodes.push(n);
      for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c);
    };
    walk((plan as { Plan: Record<string, unknown> }[])[0]?.Plan as Record<string, unknown>);
    const relations = new Set(nodes.map((n) => n['Relation Name']).filter(Boolean));
    expect(relations.has('leads')).toBe(false);
    const scans = nodes.filter((n) => n['Relation Name'] === 'lead_stage_history');
    // the window (read once) and the "pending" probe, both index-only on the (agency, changed_at, …) index
    expect(scans.length).toBeGreaterThanOrEqual(1);
    expect(scans.length).toBeLessThanOrEqual(2);
    for (const n of scans) {
      expect(n['Node Type']).toBe('Index Only Scan');
      expect(n['Index Name']).toBe('lead_stage_history_agency_changed_idx');
    }
    const read = scans.reduce((sum, n) => sum + Number(n['Actual Rows'] ?? 0) * Number(n['Actual Loops'] ?? 1), 0);
    const heap = scans.reduce((sum, n) => sum + Number(n['Heap Fetches'] ?? 0), 0);
    // the 3 events' rows (each giving its entry and its exit), at most one more for the probe; none of the 50k
    expect(read).toBeLessThanOrEqual(3 + 1);
    // 0 once vacuumed; a page left not-all-visible by another suite's open snapshot costs at most its own rows
    expect(heap).toBeLessThanOrEqual(read);
    console.info(
      `[S12-F6] delta pass over 50k older moves: ${read} history rows read, ${heap} heap fetches, ${(plan as { 'Execution Time': number }[])[0]?.['Execution Time']} ms`,
    );

    const pass = await crm.refreshStageCounts({ agencyId: r.agencyId }, at);
    // entry (−2 +1) and the two target stages: 3 rows for 3 events
    expect(pass).toEqual({ mode: 'delta', moves: 3, written: 3, pending: false, drift: 0 });
    same(await counts(), await truth());
  });

  it('[S12-F6] idempotent: a second pass applies nothing; moves inside the lag wait, and the job queues a later pass for them', async () => {
    await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow());
    const before = await counts();
    expect(await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow())).toMatchObject({
      mode: 'delta',
      moves: 0,
      written: 0,
    });
    expect(await counts()).toEqual(before);

    const lead = await newLead();
    // the job's own pass (cutoff = now − lag): the move is too fresh, so it waits and one more pass is queued
    const enqueue = vi.spyOn(crm.crmJobs.refreshStageCounts, 'enqueue').mockResolvedValue({ id: 'x' });
    try {
      const spec = crm.crmJobs.refreshStageCounts.spec;
      expect(await spec.run(spec.payload.parse({ agencyId: r.agencyId }), jobCtx())).toMatchObject({
        mode: 'delta',
        moves: 0,
        pending: true,
      });
      expect(enqueue.mock.calls).toEqual([
        [{ agencyId: r.agencyId }, { throttleMs: STAGE_COUNTS_THROTTLE_MS, debounceKey: 'stage-counts' }],
      ]);
    } finally {
      enqueue.mockRestore();
    }
    expect(await counts()).toEqual(before);
    // the later pass applies it, once
    expect(await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow())).toMatchObject({
      moves: 1,
      pending: false,
    });
    expect(await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow())).toMatchObject({ moves: 0, written: 0 });
    same(await counts(), await truth());
    expect(lead.stageId).toBe(entry);
  });

  it('[S12-F6] no rows or drift (a stage below 0) falls back to a rebuild; the nightly sweep queues a full rebuild per agency', async () => {
    await move(await newLead(), won);
    await move(await newLead(), won);
    await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow());
    same(await counts(), await truth());
    // drift: the rollup undercounts WON (a direct write), then two leads leave it — the delta would take it below 0
    await adminQuery('update crm_stage_counts set leads = 1 where agency_id = $1 and stage_id = $2', [r.agencyId, won]);
    const inWon = await adminQuery<{ id: string; version: number }>(
      'select id, version from leads where agency_id = $1 and stage_id = $2 order by id limit 2',
      [r.agencyId, won],
    );
    expect(inWon).toHaveLength(2);
    for (const l of inWon) {
      await as((ctx) => crm.moveLead(ctx, l.id, MoveLeadBody.parse({ version: l.version, stageId: lost })));
    }
    expect((await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow())).mode).toBe('rebuild');
    same(await counts(), await truth());

    // no rows (never built, or wiped): rebuilt
    await adminQuery('delete from crm_stage_counts where agency_id = $1', [r.agencyId]);
    expect((await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow())).mode).toBe('rebuild');
    same(await counts(), await truth());

    // nightly: every agency with counts gets a full rebuild
    const many = vi.spyOn(crm.crmJobs.refreshStageCounts, 'enqueueMany').mockResolvedValue([]);
    try {
      const spec = crm.crmJobs.sweepStageCounts.spec;
      const out = (await spec.run({}, jobCtx())) as { queued: number };
      expect(out.queued).toBeGreaterThanOrEqual(1);
      const queued = many.mock.calls.flatMap((call) => call[0]);
      expect(queued).toContainEqual({
        payload: { agencyId: r.agencyId, full: true, day: new Date().toISOString().slice(0, 10) },
        options: { delayMs: sweepDelayOf(r.agencyId) },
      });
    } finally {
      many.mockRestore();
    }
  });

  it('[S12-F6] a move still uncommitted when a pass starts is counted exactly once: the pass waits for it', async () => {
    await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow());
    const lead = await newLead();
    await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow());
    // transaction A: the move written, not committed
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let moved: () => void = () => {};
    const inside = new Promise<void>((done) => {
      moved = done;
    });
    const a = as(async (ctx) => {
      const card = await crm.moveLead(ctx, lead.id, MoveLeadBody.parse({ version: lead.version, stageId: won }));
      moved();
      await gate;
      return card;
    });
    await inside;
    // a pass whose cutoff is past A's move starts while A is open: it waits for A (the stage-count lock)
    const pass = crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow());
    for (let i = 0; i < 100; i += 1) {
      const waiting = await adminQuery<{ n: number }>(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
      );
      if ((waiting[0]?.n ?? 0) > 0) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    release();
    await a;
    const first = await pass;
    expect(first).toMatchObject({ mode: 'delta', moves: 1 });
    // the next pass finds it applied: never twice, never lost
    expect(await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow())).toMatchObject({ moves: 0, written: 0 });
    same(await counts(), await truth());
  });

  it('[S12-F6] the nightly rebuild reports the deltas’ drift, once per agency and day, spread over hours', async () => {
    await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow());
    // a write around the services (no history row): the deltas cannot see it
    await adminQuery('update crm_stage_counts set leads = leads + 2 where agency_id = $1 and stage_id = $2', [
      r.agencyId,
      entry,
    ]);
    const full = await crm.refreshStageCounts({ agencyId: r.agencyId, full: true }, upToNow());
    expect(full).toMatchObject({ mode: 'rebuild', drift: 2 });
    same(await counts(), await truth());
    expect((await crm.refreshStageCounts({ agencyId: r.agencyId, full: true }, upToNow())).drift).toBe(0);

    const spec = crm.crmJobs.refreshStageCounts.spec;
    const day = '2026-10-25';
    expect(spec.jobId?.({ agencyId: r.agencyId, full: true, day })).toBe(`crm.stageCounts.full:${r.agencyId}:${day}`);
    const delays = [newId(), newId(), newId(), r.agencyId].map(sweepDelayOf);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(STAGE_COUNTS_SWEEP_SPREAD_MS);
    }
    expect(sweepDelayOf(r.agencyId)).toBe(sweepDelayOf(r.agencyId));
  });
});
