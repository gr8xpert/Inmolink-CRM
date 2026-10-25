import {
  CreateContactBody,
  CreateLeadBody,
  MoveLeadBody,
  type MoveLeadInput,
  PipelineBoardQuery,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { adminQuery, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../index';
import { timeRank } from '../rank';

/**
 * Pipeline (S10-03): agency stages (defaults seeded, admins customize), the board and its columns, drags with a
 * version and a rank, the stage history the database writes, `STAGE_CHANGED` on the timeline and the report.
 */

const RUN = newId().slice(-8).toLowerCase();
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.pipeline.test', fn);

let a: Founder;
let b: Founder;
let agentId: string;

const as = <T>(m: Founder | { userId: string; agencyId: string }, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const contact = async (m: Founder, name: string) =>
  (
    await as(m, (ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: name, emails: [`${name}-${RUN}@example.com`] })),
    )
  ).contact;
const newLead = async (m: Founder, name: string) =>
  (await as(m, async (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: (await contact(m, name)).id }))))
    .lead;
const move = (m: Founder | { userId: string; agencyId: string }, id: string, body: MoveLeadInput) =>
  as(m, (ctx) => crm.moveLead(ctx, id, MoveLeadBody.parse(body)));
const stages = (m: Founder) => as(m, (ctx) => crm.listPipelineStages(ctx, {}));
const byKey = async (m: Founder, key: string) => {
  const s = (await stages(m)).items.find((x) => x.key === key);
  if (!s) throw new Error(`no ${key} stage`);
  return s;
};
const column = async (m: Founder, stageId: string) =>
  (await as(m, (ctx) => crm.listStageLeads(ctx, stageId, { limit: 100 }))).items.map((l) => l.id);

/** The SQLSTATE a statement failed with (drizzle wraps the driver's error as `cause`). */
async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: unknown; cause?: { code?: unknown } };
    return String(e.cause?.code ?? e.code);
  }
  return 'accepted';
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

/** S12-F6: stage counts brought up to now (the pass's cutoff is `STAGE_COUNTS_LAG_MS` behind its `now`). */
const upToNow = () => ({ now: new Date(Date.now() + crm.STAGE_COUNTS_LAG_MS) });

beforeAll(async () => {
  await setupTestDb('worker');
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  agentId = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`pipe-agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${a.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`pipe-agent-${agentId}@example.com`})`);
  });
}, 120_000);

afterAll(async () => {
  await closeDb();
});

describe('stages', () => {
  it('[S10-03] every agency gets the default stages; a new lead enters the entry stage, newest first, with its first history row', async () => {
    // b never read its pipeline: its first lead seeds the defaults in the database (leads_stage_sync)
    const lead = await newLead(b, 'first');
    const list = await stages(b);
    expect(list.items.map((s) => [s.key, s.name, s.status, s.kind, s.entry])).toEqual([
      ['NEW', null, 'NEW', 'OPEN', true],
      ['IN_PROGRESS', null, 'IN_PROGRESS', 'OPEN', false],
      ['WON', null, 'WON', 'WON', false],
      ['LOST', null, 'LOST', 'LOST', false],
      ['SPAM', null, 'SPAM', 'LOST', false],
    ]);
    const entry = list.items[0];
    expect(lead).toMatchObject({ status: 'NEW', stageId: entry?.id });
    // the SQL time rank is the TypeScript one; a newer lead sorts above
    const [row] = await adminQuery<{ stage_rank: string; stage_entered_at: Date }>(
      'select stage_rank, stage_entered_at from leads where id = $1',
      [lead.id],
    );
    expect(row?.stage_rank).toBe(timeRank(new Date(row?.stage_entered_at ?? 0), lead.id));
    const second = await newLead(b, 'second');
    expect(await column(b, entry?.id ?? '')).toEqual([second.id, lead.id]);
    const history = await as(b, (ctx) => crm.listLeadStageHistory(ctx, lead.id, { limit: 10 }));
    expect(history.items).toMatchObject([
      { fromStageId: null, toStageId: entry?.id, secondsInFromStage: null, actorUserId: b.userId },
    ]);
    // reads never write: an agency with no lead yet has no stages until a write path seeds them
    const fresh = await createFounder();
    expect((await stages(fresh)).items).toHaveLength(0);
    expect((await as(fresh, (ctx) => crm.getPipelineBoard(ctx, PipelineBoardQuery.parse({})))).columns).toEqual([]);
    await as(fresh, (ctx) => crm.createPipelineStage(ctx, { name: 'Visit', kind: 'OPEN' }));
    expect((await stages(fresh)).items.map((s) => s.key)).toEqual(['NEW', 'IN_PROGRESS', 'WON', 'LOST', 'SPAM', null]);
  });

  it('[S10-03] admins add, rename, reorder, archive and restore stages; agents and other agencies cannot', async () => {
    await newLead(a, 'seeds'); // a's first lead seeds its default stages
    const before = await stages(a);
    const viewing = await as(a, (ctx) =>
      crm.createPipelineStage(ctx, { name: `Viewing ${RUN}`, kind: 'OPEN', position: 1 }, { idempotencyKey: 'v1' }),
    );
    expect(viewing).toMatchObject({ replayed: false, stage: { status: 'IN_PROGRESS', kind: 'OPEN', key: null } });
    // a retry answers the first stage; the key with another body is refused; a name is unique among active stages
    const replay = await as(a, (ctx) =>
      crm.createPipelineStage(ctx, { name: `Viewing ${RUN}`, kind: 'OPEN', position: 1 }, { idempotencyKey: 'v1' }),
    );
    expect(replay).toEqual({ replayed: true, stage: viewing.stage });
    expect(
      await refusal(
        as(a, (ctx) => crm.createPipelineStage(ctx, { name: 'Other', kind: 'WON' }, { idempotencyKey: 'v1' })),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await refusal(as(a, (ctx) => crm.createPipelineStage(ctx, { name: `viewing ${RUN}`, kind: 'LOST' })))).toBe(
      'PIPELINE_STAGE_DUPLICATE',
    );
    const after = (await stages(a)).items;
    expect(after.map((s) => s.id)).toEqual([
      before.items[0]?.id,
      viewing.stage.id,
      ...before.items.slice(1).map((s) => s.id),
    ]);

    // rename a default stage, then back to its translated name
    const won = await byKey(a, 'WON');
    const renamed = await as(a, (ctx) => crm.updatePipelineStage(ctx, won.id, { version: won.version, name: 'Sold' }));
    expect(renamed).toMatchObject({ name: 'Sold', key: 'WON', version: won.version + 1 });
    expect(
      await refusal(as(a, (ctx) => crm.updatePipelineStage(ctx, won.id, { version: won.version, name: 'X' }))),
    ).toBe('VERSION_CONFLICT');
    const reset = await as(a, (ctx) => crm.updatePipelineStage(ctx, won.id, { version: renamed.version, name: null }));
    expect(reset.name).toBeNull();
    expect(
      await refusal(
        as(a, (ctx) => crm.updatePipelineStage(ctx, viewing.stage.id, { version: viewing.stage.version, name: null })),
      ),
    ).toBe('VALIDATION_FAILED');

    // reorder: every active stage once, or refused
    const ids = (await stages(a)).items.map((s) => s.id);
    const reversed = [...ids].reverse();
    const reordered = await as(a, (ctx) => crm.reorderPipelineStages(ctx, { stageIds: reversed }));
    expect(reordered.items.map((s) => s.id)).toEqual(reversed);
    expect(reordered.items.map((s) => s.position)).toEqual(reversed.map((_, i) => i));
    expect(await refusal(as(a, (ctx) => crm.reorderPipelineStages(ctx, { stageIds: reversed.slice(1) })))).toBe(
      'PIPELINE_ORDER_INVALID',
    );
    expect(
      await refusal(as(a, (ctx) => crm.reorderPipelineStages(ctx, { stageIds: [...reversed.slice(1), ids[1] ?? ''] }))),
    ).toBe('PIPELINE_ORDER_INVALID');
    await as(a, (ctx) => crm.reorderPipelineStages(ctx, { stageIds: ids }));

    // archive: never the entry stage, never a stage with leads, never the last open one; restore goes last
    const entry = await byKey(a, 'NEW');
    expect(
      await refusal(as(a, (ctx) => crm.updatePipelineStage(ctx, entry.id, { version: entry.version, archived: true }))),
    ).toBe('PIPELINE_STAGE_LOCKED');
    const lead = await newLead(a, 'archiver');
    const current = (await stages(a)).items.find((s) => s.id === viewing.stage.id);
    await move(a, lead.id, { version: lead.version, stageId: viewing.stage.id });
    const locked = as(a, (ctx) =>
      crm.updatePipelineStage(ctx, viewing.stage.id, { version: current?.version ?? 0, archived: true }),
    );
    await expect(locked).rejects.toMatchObject({ code: 'PIPELINE_STAGE_LOCKED', details: { reason: 'not_empty' } });
    const progress = await byKey(a, 'IN_PROGRESS');
    const archived = await as(a, (ctx) =>
      crm.updatePipelineStage(ctx, progress.id, { version: progress.version, archived: true }),
    );
    expect(archived.archived).toBe(true);
    expect((await stages(a)).items.map((s) => s.id)).not.toContain(progress.id);
    expect((await as(a, (ctx) => crm.listPipelineStages(ctx, { includeArchived: true }))).items.at(-1)?.id).toBe(
      progress.id,
    );
    // an archived stage takes no drops
    expect(await refusal(move(a, lead.id, { version: lead.version + 1, stageId: progress.id }))).toBe(
      'PIPELINE_STAGE_NOT_FOUND',
    );
    const restored = await as(a, (ctx) =>
      crm.updatePipelineStage(ctx, progress.id, { version: archived.version, archived: false }),
    );
    expect(restored.archived).toBe(false);
    expect((await stages(a)).items.at(-1)?.id).toBe(progress.id);

    // agents work the board but do not change the pipeline; another agency does not see the stage
    const agent = { userId: agentId, agencyId: a.agencyId };
    expect(await refusal(as(agent, (ctx) => crm.createPipelineStage(ctx, { name: 'Mine', kind: 'OPEN' })))).toBe(
      'FORBIDDEN',
    );
    expect((await as(agent, (ctx) => crm.listPipelineStages(ctx, {}))).items.length).toBeGreaterThan(0);
    expect(
      await refusal(as(b, (ctx) => crm.updatePipelineStage(ctx, viewing.stage.id, { version: 1, name: 'Theirs' }))),
    ).toBe('PIPELINE_STAGE_NOT_FOUND');
  });
});

describe('the board', () => {
  it('[S10-03] drag to change stage: rank between neighbours, versions, status from the stage, the old PATCH moves too', async () => {
    const [l1, l2, l3] = [await newLead(a, 'drag1'), await newLead(a, 'drag2'), await newLead(a, 'drag3')];
    const entry = await byKey(a, 'NEW');
    const won = await byKey(a, 'WON');
    expect((await column(a, entry.id)).slice(0, 3)).toEqual([l3.id, l2.id, l1.id]);

    // into WON at the top, then l2 right after l1, then l3 between them
    const m1 = await move(a, l1.id, { version: l1.version, stageId: won.id, afterLeadId: null });
    expect(m1).toMatchObject({ stageId: won.id, status: 'WON', version: l1.version + 1 });
    expect(m1.firstRespondedAt).not.toBeNull();
    const m2 = await move(a, l2.id, { version: l2.version, stageId: won.id, afterLeadId: l1.id });
    await move(a, l3.id, { version: l3.version, stageId: won.id, afterLeadId: l1.id });
    expect((await column(a, won.id)).slice(0, 3)).toEqual([l1.id, l3.id, l2.id]);
    // reorder inside the column: l2 to the top (no stage change)
    const m2b = await move(a, l2.id, { version: m2.version, stageId: won.id, afterLeadId: null });
    expect((await column(a, won.id)).slice(0, 3)).toEqual([l2.id, l1.id, l3.id]);
    expect(m2b.stageEnteredAt).toBe(m2.stageEnteredAt);

    // a stale version, a neighbour that left the column, the lead itself as neighbour, another agency
    expect(await refusal(move(a, l1.id, { version: l1.version, stageId: entry.id }))).toBe('VERSION_CONFLICT');
    expect(await refusal(move(a, l1.id, { version: m1.version, stageId: entry.id, afterLeadId: l3.id }))).toBe(
      'VERSION_CONFLICT',
    );
    expect(await refusal(move(a, l1.id, { version: m1.version, stageId: won.id, afterLeadId: l1.id }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await refusal(move(b, l1.id, { version: m1.version, stageId: won.id }))).toBe('LEAD_NOT_FOUND');
    expect(await refusal(move(a, l1.id, { version: m1.version, stageId: (await byKey(b, 'NEW')).id }))).toBe(
      'PIPELINE_STAGE_NOT_FOUND',
    );

    // two members drag the same card at once: one wins, the other is told to reload
    const results = await Promise.allSettled([
      move(a, l1.id, { version: m1.version, stageId: entry.id }),
      move({ userId: agentId, agencyId: a.agencyId }, l1.id, {
        version: m1.version,
        stageId: (await byKey(a, 'LOST')).id,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    expect(rejected?.reason).toMatchObject({ code: 'VERSION_CONFLICT' });

    // PATCH status (S10-02) is a move to the first active stage standing for it, history included
    const l4 = await newLead(a, 'patch');
    const lost = await as(a, (ctx) => crm.updateLead(ctx, l4.id, { version: l4.version, status: 'LOST' }));
    const lostStage = (await byKey(a, 'LOST')).id;
    expect(lost).toMatchObject({ status: 'LOST', stageId: lostStage });
    const inbox = await as(a, (ctx) => crm.listLeads(ctx, { limit: 100, stageId: lostStage }));
    expect(inbox.items.map((l) => l.id)).toContain(l4.id);
  });

  it('[S10-03] equal ranks and exhausted gaps re-rank the column instead of refusing the drop', async () => {
    const r = await createFounder();
    const cards = [await newLead(r, 'eq1'), await newLead(r, 'eq2'), await newLead(r, 'eq3'), await newLead(r, 'eq4')];
    const entry = await byKey(r, 'NEW');
    // two cards share a rank (as a bulk write could leave them): nothing fits between them
    await adminQuery(`update leads set stage_rank = 'k' where id = any($1::uuid[])`, [
      [cards[0]?.id, cards[1]?.id, cards[2]?.id],
    ]);
    const order = await column(r, entry.id);
    const [first, second] = order;
    const mover = cards[3];
    if (!first || !second || !mover) throw new Error('setup');
    const moved = await move(r, mover.id, { version: mover.version, stageId: entry.id, afterLeadId: first });
    expect((await column(r, entry.id)).slice(0, 3)).toEqual([first, mover.id, second]);
    expect(moved.version).toBe(mover.version + 1);
    const ranks = await adminQuery<{ stage_rank: string }>(
      `select stage_rank from leads where stage_id = $1 order by stage_rank, id`,
      [entry.id],
    );
    expect(new Set(ranks.map((x) => x.stage_rank)).size).toBe(ranks.length);
  });

  it('[S10-03] a move and an archive of its target stage never both win (the stage is locked FOR SHARE)', async () => {
    const r = await createFounder();
    const lead = await newLead(r, 'race');
    const target = (await as(r, (ctx) => crm.createPipelineStage(ctx, { name: 'Racing', kind: 'OPEN' }))).stage;
    const results = await Promise.allSettled([
      move(r, lead.id, { version: lead.version, stageId: target.id }),
      as(r, (ctx) => crm.updatePipelineStage(ctx, target.id, { version: target.version, archived: true })),
    ]);
    const [moved, archived] = results;
    // exactly one wins; a lead is never left in an archived stage
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    if (moved?.status === 'fulfilled') {
      expect(archived).toMatchObject({ status: 'rejected', reason: { code: 'PIPELINE_STAGE_LOCKED' } });
    } else {
      expect(moved).toMatchObject({ status: 'rejected', reason: { code: 'PIPELINE_STAGE_NOT_FOUND' } });
    }
    const [row] = await adminQuery<{ archived: boolean; n: number }>(
      `select s.archived_at is not null as archived, (select count(*)::int from leads l where l.stage_id = s.id) as n
         from pipeline_stages s where s.id = $1`,
      [target.id],
    );
    expect(row?.archived && (row?.n ?? 0) > 0).toBe(false);
  });

  it("[S10-03] the database guards: a status that is not its stage's, stage keys and deletes are refused", async () => {
    const lead = await newLead(a, 'guarded');
    const won = await byKey(a, 'WON');
    expect(
      await sqlState(as(a, (ctx) => ctx.tx.execute(sql`update leads set status = 'WON' where id = ${lead.id}`))),
    ).toBe('23514');
    expect(
      await sqlState(as(a, (ctx) => ctx.tx.execute(sql`update leads set stage_id = ${won.id} where id = ${lead.id}`))),
    ).toBe('23514');
    expect(
      await sqlState(
        as(a, (ctx) => ctx.tx.execute(sql`update pipeline_stages set status = 'LOST' where id = ${won.id}`)),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        as(a, (ctx) => ctx.tx.execute(sql`update pipeline_stages set seed_key = null where id = ${won.id}`)),
      ),
    ).toBe('42501');
    expect(await sqlState(as(a, (ctx) => ctx.tx.execute(sql`delete from pipeline_stages where id = ${won.id}`)))).toBe(
      '42501',
    );
  });

  it('[S10-03] board and list views: every active stage, counts, the assignee filter, column pages — in ≤ 3 queries', async () => {
    for (const n of ['col1', 'col2', 'col3']) await newLead(a, n);
    const mine = await newLead(a, 'mine');
    await as(a, (ctx) => crm.updateLead(ctx, mine.id, { version: mine.version, assignedUserId: agentId }));
    const setup = await countQueries(() => as(a, async () => null));
    let board: Awaited<ReturnType<typeof crm.getPipelineBoard>> = { columns: [] };
    const boardQueries = await countQueries(async () => {
      board = await as(a, (ctx) => crm.getPipelineBoard(ctx, PipelineBoardQuery.parse({ limit: 2 })));
    });
    expect(boardQueries - setup).toBeLessThanOrEqual(3);
    const active = (await stages(a)).items;
    expect(board.columns.map((c) => c.stage.id)).toEqual(active.map((s) => s.id));
    const entry = board.columns.find((c) => c.stage.entry);
    expect(entry?.items.length).toBeLessThanOrEqual(2);
    expect(entry?.count).toBeGreaterThan(2);
    expect(entry?.nextCursor).not.toBeNull();
    // the column's next page continues where the board stopped
    const next = await as(a, (ctx) =>
      crm.listStageLeads(ctx, entry?.stage.id ?? '', { limit: 100, cursor: entry?.nextCursor ?? undefined }),
    );
    const all = await column(a, entry?.stage.id ?? '');
    expect([...(entry?.items.map((l) => l.id) ?? []), ...next.items.map((l) => l.id)]).toEqual(all);
    // the agent's own board
    const agents = await as({ userId: agentId, agencyId: a.agencyId }, (ctx) =>
      crm.getPipelineBoard(ctx, PipelineBoardQuery.parse({ assigned: 'me' })),
    );
    expect(agents.columns.flatMap((c) => c.items.map((l) => l.id))).toEqual([mine.id]);
    expect(agents.columns.reduce((n, c) => n + c.count, 0)).toBe(1);
  });
});

describe('query plans', () => {
  it('[S10-03] board columns, column pages, a drop and the counts are index scans under RLS at scale', async () => {
    // A 20,000-lead agency (4,000 per default stage) among 200 others (20k leads); FK checks and triggers off in this
    // rolled-back seed (rows name their stage and rank); analysed, EXPLAINed as app_user (RLS on).
    const big = await createFounder();
    await newLead(big, 'big'); // its default stages
    const ids = (await stages(big)).items.map((s) => s.id);
    const plans = await withAdminRollback(['leads'], async (q) => {
      await q('set local session_replication_role = replica');
      await q(
        `insert into leads (id, agency_id, contact_id, source, status, stage_id, stage_rank, stage_entered_at,
                            assigned_user_id, assigned_at)
         select gen_random_uuid(), $1, gen_random_uuid(), 'WEBSITE', 'NEW', ($2::uuid[])[1 + g % 5],
                lpad(to_hex(g), 8, '0') || 'i', now() - g * interval '1 minute', case when g % 7 = 0 then $3::uuid end, case when g % 7 = 0 then now() end
         from generate_series(1, 20000) g`,
        [big.agencyId, ids, big.userId],
      );
      await q(
        `insert into leads (id, agency_id, contact_id, source, stage_id, stage_rank, stage_entered_at)
         select gen_random_uuid(), ag.id, gen_random_uuid(), 'MANUAL', gen_random_uuid(), 'i', now()
         from (select gen_random_uuid() as id from generate_series(1, 200)) ag, generate_series(1, 100) g`,
      );
      await q('analyze leads');
      await q('set local role app_user');
      await q(`select set_config('app.agency_id', $1, true)`, [big.agencyId]);
      const explain = async (text: string, values: unknown[]) =>
        (await q(`explain ${text}`, values)).map((r) => String(Object.values(r)[0])).join('\n');
      const page = (extra: string) =>
        `select id from leads where agency_id = $1 and stage_id = $2 ${extra}
           and (stage_rank, id) > ('00002000i', '00000000-0000-7000-8000-000000000000'::uuid)
         order by stage_rank, id limit 26`;
      return {
        board: await explain(
          `select p.id from pipeline_stages s cross join lateral (
             select l.id from leads l where l.agency_id = $1 and l.stage_id = s.id
             order by l.stage_rank, l.id limit 21) p
           where s.agency_id = $1 and s.archived_at is null`,
          [big.agencyId],
        ),
        column: await explain(page(''), [big.agencyId, ids[0]]),
        mine: await explain(page('and assigned_user_id = $3'), [big.agencyId, ids[0], big.userId]),
        drop: await explain(
          `select stage_rank from leads where agency_id = $1 and stage_id = $2 and id <> $3::uuid
             and (stage_rank, id) > ('00001000i', '00000000-0000-7000-8000-000000000000'::uuid)
           order by stage_rank, id limit 1`,
          [big.agencyId, ids[0], newId()],
        ),
        counts: await explain(
          `select s.id, (select count(*) from (select 1 from leads l where l.agency_id = $1 and l.stage_id = s.id
             limit 1000) x) from pipeline_stages s where s.agency_id = $1 and s.archived_at is null`,
          [big.agencyId],
        ),
      };
    });
    expect(plans.board).toContain('leads_agency_stage_rank_idx');
    expect(plans.column).toContain('leads_agency_stage_rank_idx');
    expect(plans.mine).toContain('leads_agency_stage_assigned_rank_idx');
    expect(plans.drop).toContain('leads_agency_stage_rank_idx');
    expect(plans.counts).toMatch(/Index Only Scan using leads_agency_stage_(assigned_)?rank_idx/);
    // the column cursor is an index condition (text_lt is leakproof), never a Filter
    for (const name of ['column', 'mine'] as const) {
      const cond = plans[name].split('\n').filter((l) => l.includes('Index Cond'));
      expect(cond.join(' '), name).toMatch(/ROW\(stage_rank, id\) >/);
    }
    for (const [name, text] of Object.entries(plans)) expect(text, name).not.toMatch(/Seq Scan on leads/);
  }, 120_000);
});

/** The worker's delivery of this agency's `crm.lead.stageChanged` events to the activity writer (the job inline). */
async function deliverStageChanges(agencyId: string): Promise<void> {
  const job = crm.crmJobs.recordActivity;
  const spy = vi.spyOn(job, 'enqueue').mockImplementation(async (payload) => {
    await crm.recordActivity(job.spec.payload.parse(payload));
    return { id: 'inline', added: true } as unknown as Awaited<ReturnType<typeof job.enqueue>>;
  });
  crm.registerCrmSubscriptions();
  try {
    const events = await adminQuery<{
      id: string;
      agency_id: string;
      type: string;
      version: number;
      payload: unknown;
      created_at: string;
    }>(
      `select id, agency_id, type, version, payload, created_at from outbox_events
        where agency_id = $1 and type = 'crm.lead.stageChanged' order by created_at, id`,
      [agencyId],
    );
    for (const row of events) {
      for (const sub of defaultSubscribers.get(row.type, row.version)) {
        if (!sub.name.startsWith('crm.activity.')) continue;
        await sub.handler(sub.def.schema.parse(row.payload), {
          eventId: row.id,
          agencyId: row.agency_id,
          type: row.type,
          version: row.version,
          createdAt: new Date(row.created_at),
          attempt: 1,
        });
      }
    }
  } finally {
    crm.unregisterCrmSubscriptions();
    spy.mockRestore();
  }
}

describe('history and reports', () => {
  it('[S10-03] stage changes are recorded in activity (STAGE_CHANGED) and in the stage history, with time in stage', async () => {
    const lead = await newLead(a, 'history');
    const entry = await byKey(a, 'NEW');
    const lost = await byKey(a, 'LOST');
    // the lead has waited two hours in its first stage
    await adminQuery(
      `update leads set stage_entered_at = date_trunc('milliseconds', now() - interval '2 hours', 'UTC') where id = $1`,
      [lead.id],
    );
    const moved = await move({ userId: agentId, agencyId: a.agencyId }, lead.id, {
      version: lead.version,
      stageId: lost.id,
    });
    await deliverStageChanges(a.agencyId);
    await deliverStageChanges(a.agencyId); // a redelivery records nothing more

    const timeline = await as(a, (ctx) => crm.listActivities(ctx, { limit: 100, subject: 'LEAD', subjectId: lead.id }));
    const changed = timeline.items.filter((i) => i.type === 'STAGE_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      leadId: lead.id,
      contactId: lead.contact.id,
      data: { fromStageId: entry.id, toStageId: lost.id, status: 'LOST', version: moved.version },
    });

    const history = await as(a, (ctx) => crm.listLeadStageHistory(ctx, lead.id, { limit: 10 }));
    expect(history.items).toHaveLength(2);
    expect(history.items[0]).toMatchObject({ fromStageId: entry.id, toStageId: lost.id, actorUserId: agentId });
    expect(history.items[0]?.secondsInFromStage).toBeGreaterThanOrEqual(7_200);
    expect(history.items[0]?.secondsInFromStage).toBeLessThan(7_300);
    expect(history.items[1]).toMatchObject({ fromStageId: null, toStageId: entry.id });
    // the history is the database's: app_user can neither forge, rewrite nor remove a move (no grant: 42501)
    expect(
      await sqlState(
        as(a, (ctx) =>
          ctx.tx.execute(sql`insert into lead_stage_history (id, agency_id, lead_id, to_stage_id, changed_at)
            values (${newId()}, ${a.agencyId}, ${lead.id}, ${lost.id}, date_trunc('milliseconds', now(), 'UTC'))`),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(as(a, (ctx) => ctx.tx.execute(sql`update lead_stage_history set changed_at = changed_at`))),
    ).toBe('42501');
    expect(await sqlState(as(a, (ctx) => ctx.tx.execute(sql`delete from lead_stage_history`)))).toBe('42501');
  });

  it('[S10-03] the report reads the stage history: counts per stage, entered / exited in a range, time in stage, won and lost', async () => {
    const r = await createFounder();
    const leads = [await newLead(r, 'rep1'), await newLead(r, 'rep2'), await newLead(r, 'rep3')];
    const entry = await byKey(r, 'NEW');
    const won = await byKey(r, 'WON');
    const lost = await byKey(r, 'LOST');
    await adminQuery(
      `update leads set stage_entered_at = date_trunc('milliseconds', now() - interval '1 hour', 'UTC') where id = $1`,
      [leads[0]?.id],
    );
    await adminQuery(
      `update leads set stage_entered_at = date_trunc('milliseconds', now() - interval '3 hours', 'UTC') where id = $1`,
      [leads[1]?.id],
    );
    await move(r, leads[0]?.id ?? '', { version: leads[0]?.version ?? 0, stageId: won.id });
    await move(r, leads[1]?.id ?? '', { version: leads[1]?.version ?? 0, stageId: lost.id });
    // S11-F10: the leads per stage now come from the worker's rollup (queued by the moves' events)
    await crm.refreshStageCounts({ agencyId: r.agencyId }, upToNow());

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const got: { report?: Awaited<ReturnType<typeof crm.getPipelineReport>> } = {};
    const queries = await countQueries(async () => {
      got.report = await as(r, (ctx) => crm.getPipelineReport(ctx, { from, to }));
    });
    const report = got.report;
    if (!report) throw new Error('no report');
    const setup = await countQueries(() => as(r, async () => null));
    expect(queries - setup).toBeLessThanOrEqual(2);
    const row = (id: string) => report.stages.find((s) => s.stage.id === id);
    // three leads received (entered NEW), two left it after 1 h and 3 h: mean 2 h, median 2 h
    expect(row(entry.id)).toMatchObject({ current: 1, entered: 3, exited: 2 });
    expect(row(entry.id)?.avgSecondsInStage).toBeGreaterThanOrEqual(7_200);
    expect(row(entry.id)?.avgSecondsInStage).toBeLessThan(7_300);
    expect(row(entry.id)?.medianSecondsInStage).toBeGreaterThanOrEqual(7_200);
    expect(row(entry.id)?.currentAvgSeconds).toBeGreaterThanOrEqual(0);
    expect(row(won.id)).toMatchObject({ current: 1, entered: 1, exited: 0, avgSecondsInStage: null });
    expect(row(lost.id)).toMatchObject({ current: 1, entered: 1, exited: 0 });
    expect(report).toMatchObject({ won: 1, lost: 1 });
    // a range before the moves holds none of them
    const before = await as(r, (ctx) =>
      crm.getPipelineReport(ctx, {
        from: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        to: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    );
    expect(before.stages.every((s) => s.entered === 0 && s.exited === 0)).toBe(true);
    expect(before.stages.find((s) => s.stage.id === entry.id)?.current).toBe(1);
    // another agency's report is its own
    const other = await as(b, (ctx) => crm.getPipelineReport(ctx, { from, to }));
    expect(other.stages.map((s) => s.stage.id)).not.toContain(entry.id);
  });
});

describe('Idempotency-Key window', () => {
  it('[S11-F1] reused Idempotency-Key after 24 h → IDEMPOTENCY_KEY_REUSED', async () => {
    const key = `stage-old-${RUN}`;
    const first = await as(a, (ctx) =>
      crm.createPipelineStage(ctx, { name: `Stale ${RUN}`, kind: 'OPEN' }, { idempotencyKey: key }),
    );
    await system((tx) =>
      tx.execute(sql`update pipeline_stages set created_at = now() - interval '48 hours' where id = ${first.stage.id}`),
    );
    // another name: the same one would hit the name index first (PIPELINE_STAGE_DUPLICATE)
    expect(
      await refusal(
        as(a, (ctx) =>
          crm.createPipelineStage(ctx, { name: `Stale again ${RUN}`, kind: 'OPEN' }, { idempotencyKey: key }),
        ),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
