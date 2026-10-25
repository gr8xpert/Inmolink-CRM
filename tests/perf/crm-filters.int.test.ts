import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withTenant } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { type SQLWrapper, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activitiesPageQuery } from '../../packages/core/src/modules/crm/activities-repo';
import { leadsPageQuery } from '../../packages/core/src/modules/crm/leads-repo';

/**
 * CRM list filters at scale (S11-F6): the agency's activity feed filtered by a rare type (one type and several) and the
 * lead inbox's filters (S12-F7: every one on the remaining 10 indexes) on 60,000 rows of one agency
 * among four other agencies' (NOISE_AGENCIES: the agency is a fifth of each table, as on a shared production table).
 * The statements are the repos' own (`activitiesPageQuery`, `leadsPageQuery`), explained as the request role under RLS.
 * The rows are committed (VACUUM needs it), inserted with FK checks off and deleted afterwards the same way.
 */

const ROWS = 60_000;
const NOISE_AGENCIES = [1, 2, 3, 4].map((i) => `00000000-0000-7000-8000-0000005111f${i}`);
const STAGES = [1, 2, 3, 4, 5].map((i) => `00000000-0000-7000-8000-0000005111a${i}`);
const MEMBERS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `00000000-0000-7000-8000-0000005111b${i}`);
let founder: Founder;

/** S12-F7: each stage's lead status (a lead's status is its stage's; the stage filter reads the status index). */
const STAGE_STATUSES = ['NEW', 'IN_PROGRESS', 'IN_PROGRESS', 'WON', 'LOST'] as const;
const list = (a: readonly string[]) => `'${a.join("','")}'`;

beforeAll(async () => {
  await setupTestDb('worker');
  founder = await createFounder();
  // activities of the last 25 days; CALL/EMAIL common, VIEWING ~0.3 %, MEETING ~0.4 %
  const typeCase = (seed: string) => `case
      when abs(hashtext(g::text || '${seed}')) % 1000 < 3 then 'VIEWING'
      when abs(hashtext(g::text || '${seed}')) % 1000 < 7 then 'MEETING'
      when abs(hashtext(g::text || '${seed}')) % 2 = 0 then 'CALL' else 'EMAIL' end`;
  const status = `case when abs(hashtext(g::text || 's')) % 1000 < 5 then 'LOST'
                       when abs(hashtext(g::text || 's')) % 1000 < 50 then 'WON'
                       when abs(hashtext(g::text || 's')) % 2 = 0 then 'NEW' else 'IN_PROGRESS' end`;
  // S12-F7: most leads from the website, CHATBOT rare (~0.5 %)
  const source = `case when abs(hashtext(g::text || 'o')) % 1000 < 5 then 'CHATBOT'
                       when abs(hashtext(g::text || 'o')) % 10 < 2 then 'PORTAL' else 'WEBSITE' end`;
  // S12-F17: what a crashed earlier run left (its rows are committed): the noise agencies' rows, leads assigned to the
  // seed's members, the seed's stages and member rows — so no orphan assignee stays behind for the member FK
  await purge();
  await adminQuery(`begin;
    set local session_replication_role = replica;
    -- S12-F17: the seed's assignees are members of the agency (\`leads_assignee_member_fk\` holds for every row)
    insert into agency_members (agency_id, user_id, role, name, email)
    select '${founder.agencyId}', m::uuid, 'AGENT', 'Perf ' || m, 'perf-' || m || '@example.com'
      from unnest(array[${list(MEMBERS)}]) m;
    insert into activities (id, agency_id, occurred_at, type, contact_id)
    select gen_random_uuid(), '${founder.agencyId}',
           date_trunc('milliseconds', now() - g * interval '25 days' / ${ROWS}, 'UTC'), ${typeCase('t')}, gen_random_uuid()
      from generate_series(1, ${ROWS}) g;
    insert into activities (id, agency_id, occurred_at, type, contact_id)
    select gen_random_uuid(), (array[${list(NOISE_AGENCIES)}])[1 + g % 4]::uuid,
           date_trunc('milliseconds', now() - g * interval '25 days' / ${4 * ROWS}, 'UTC'), ${typeCase('n')}, gen_random_uuid()
      from generate_series(1, ${4 * ROWS}) g;
    insert into contacts (id, agency_id, first_name, last_name)
    select md5('${founder.agencyId}' || g)::uuid, '${founder.agencyId}', 'C' || g, 'Perf'
      from generate_series(1, 2000) g;
    insert into pipeline_stages (id, agency_id, name, status, position)
    select s.id::uuid, '${founder.agencyId}', 'Stage ' || s.n, s.status, s.n
      from (values ${STAGES.map((id, i) => `('${id}', ${i}, '${STAGE_STATUSES[i]}')`).join(', ')}) s(id, n, status);
    insert into leads (id, agency_id, contact_id, source, status, stage_id, stage_rank, stage_entered_at, created_at,
                       assigned_user_id, assigned_at)
    select gen_random_uuid(), '${founder.agencyId}', md5('${founder.agencyId}' || (1 + g % 2000))::uuid,
           ${source}, x.status,
           (case x.status when 'NEW' then '${STAGES[0]}' when 'WON' then '${STAGES[3]}' when 'LOST' then '${STAGES[4]}'
                 else (array['${STAGES[1]}', '${STAGES[2]}'])[1 + abs(hashtext(g::text || 'g')) % 2] end)::uuid, 'i', now(),
           now() - (g * 90.0 / ${ROWS}) * interval '1 day',
           (array[${list(MEMBERS)}])[1 + abs(hashtext(g::text || 'a')) % 8]::uuid, now()
      from generate_series(1, ${ROWS}) g, lateral (select ${status} as status) x;
    insert into leads (id, agency_id, contact_id, source, status, stage_id, stage_rank, stage_entered_at, created_at)
    select gen_random_uuid(), (array[${list(NOISE_AGENCIES)}])[1 + g % 4]::uuid, gen_random_uuid(), 'WEBSITE',
           'NEW', gen_random_uuid(), 'i', now(), now() - (g * 90.0 / ${4 * ROWS}) * interval '1 day'
      from generate_series(1, ${4 * ROWS}) g;
    commit;`);
  await adminQuery('vacuum analyze activities');
  await adminQuery('vacuum analyze leads');
  await adminQuery('analyze contacts');
}, 300_000);

/** S12-F17: deletes this suite's rows — its own agency's, the noise agencies', and any earlier run's (fixed ids). */
async function purge(): Promise<void> {
  const agencies = founder ? `'${founder.agencyId}', ${list(NOISE_AGENCIES)}` : list(NOISE_AGENCIES);
  await adminQuery(`begin;
    set local session_replication_role = replica;
    delete from activities where agency_id in (${agencies});
    delete from leads where agency_id in (${agencies}) or assigned_user_id in (${list(MEMBERS)});
    delete from pipeline_stages where id in (${list(STAGES)})${founder ? ` or agency_id = '${founder.agencyId}'` : ''};
    delete from agency_members where user_id in (${list(MEMBERS)});
    ${founder ? `delete from contacts where agency_id = '${founder.agencyId}';` : ''}
    commit;`);
}

afterAll(async () => {
  await purge();
  await adminQuery('vacuum analyze activities');
  await adminQuery('vacuum analyze leads');
  await closeDb();
}, 180_000);

type Plan = { plan: string; ms: number };

/** EXPLAIN (ANALYZE, BUFFERS) of the repo's statement as the request role; the best of five warm runs. */
async function explain(build: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => SQLWrapper): Promise<Plan> {
  const run = () =>
    withTenant({ agencyId: founder.agencyId }, async (tx) => {
      const res = await tx.execute(sql`explain (analyze, buffers) ${build(tx)}`);
      const plan = (res.rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0])).join('\n');
      return { plan, ms: Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1]) };
    });
  await run(); // warm
  const out: Plan[] = [];
  for (let i = 0; i < 5; i++) out.push(await run());
  return out.reduce((a, b) => (a.ms <= b.ms ? a : b));
}

const first = { limit: 50 };
const deep = () => ({
  limit: 50,
  cursor: { at: new Date(Date.now() - 12 * 86_400_000), id: 'ffffffff-ffff-7fff-bfff-ffffffffffff' },
});

describe('activity feed filtered by type at 60k activities', () => {
  it.each([
    ['one rare type', ['VIEWING'], first],
    ['one rare type, deep cursor', ['VIEWING'], deep()],
    ['two rare types', ['VIEWING', 'MEETING'], first],
    ['two rare types, deep cursor', ['VIEWING', 'MEETING'], deep()],
  ] as const)(
    '[S11-F6] %s: index-driven, under 20 ms',
    async (name, types, p) => {
      const r = await explain((tx) => activitiesPageQuery(tx, founder.agencyId, { types }, p));
      console.info(`activities feed, ${name}: ${r.ms} ms\n${r.plan}`);
      expect(r.plan).toMatch(/activities_p\w+_agency_id_type_occurred_at_id_idx/);
      expect(r.plan).not.toMatch(/Seq Scan/);
      expect(r.plan).not.toMatch(/Filter: .*\(type = ANY/);
      expect(r.ms).toBeLessThan(20);
    },
    60_000,
  );
});

/**
 * S12-F7: the inbox's filters on the index set that remains (10 secondary indexes). A combined filter is served by one
 * index and a filter on the other column — the planner takes the more selective one (a rare status, a member's leads, a
 * rare source), so a page reads about `limit` ÷ (the other filter's share) entries, never all the agency's leads. A
 * stage reads the status index (its status, then the stage). "My open leads" (S11-F6's own index) folds into the
 * assignee or status index; source + status into the source or status index.
 */
describe('lead inbox filters at 60k leads (S11-F6, S12-F7)', () => {
  const member = MEMBERS[3] as string;
  const inProgress = STAGES[1] as string;
  const wonStage = STAGES[3] as string;
  it.each([
    ['inbox', {}, first, /leads_agency_created_idx/],
    [
      'rare status + assignee',
      { status: 'LOST', assignedUserId: member },
      first,
      /leads_agency_(status|assigned)_created_idx/,
    ],
    [
      'rare status + assignee, cursor',
      { status: 'LOST', assignedUserId: member },
      deep(),
      /leads_agency_(status|assigned)_created_idx/,
    ],
    [
      'open status + assignee',
      { status: 'NEW', assignedUserId: member },
      first,
      /leads_agency_(status|assigned)_created_idx/,
    ],
    ['assignee', { assignedUserId: member }, first, /leads_agency_assigned_created_idx/],
    ['stage', { stageId: wonStage }, first, /leads_agency_status_created_idx/],
    ['stage, cursor', { stageId: wonStage }, deep(), /leads_agency_status_created_idx/],
    [
      'stage + assignee, cursor',
      { stageId: inProgress, assignedUserId: member },
      deep(),
      /leads_agency_(status|assigned)_created_idx/,
    ],
    ['rare source', { source: 'CHATBOT' }, first, /leads_agency_source_created_idx/],
    [
      'rare source + status',
      { source: 'CHATBOT', status: 'IN_PROGRESS' },
      first,
      /leads_agency_(source|status)_created_idx/,
    ],
    ['source + rare status', { source: 'WEBSITE', status: 'LOST' }, deep(), /leads_agency_(source|status)_created_idx/],
  ] as const)(
    '[S12-F7] %s: index-driven, under 20 ms',
    async (name, filter, p, index) => {
      const r = await explain((tx) => leadsPageQuery(tx, founder.agencyId, filter, p));
      console.info(`listLeads, ${name}: ${r.ms} ms\n${r.plan}`);
      expect(r.plan).not.toMatch(/Seq Scan on leads/);
      expect(r.plan).toMatch(index);
      expect(r.ms).toBeLessThan(20);
    },
    60_000,
  );

  it('[S12-F7] a stage page reads the status index: the stage filter adds its status (one init plan)', async () => {
    const r = await explain((tx) => leadsPageQuery(tx, founder.agencyId, { stageId: wonStage }, first));
    expect(r.plan).toMatch(/InitPlan/);
    expect(r.plan).toMatch(/Index Cond: .*status = \(InitPlan/);
  });

  it('[S12-F7] leads keeps 10 secondary indexes, each with a consumer', async () => {
    const rows = await adminQuery<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'leads'
         and indexname not in ('leads_pkey', 'leads_agency_id_uq') order by indexname`,
    );
    // the inbox filters above; the board and its counts (S10-03, pipeline int); the response KPI (S10-09, response-kpi
    // perf); a contact merge and the contact FK, website promotion, POST replay (below)
    expect(rows.map((r) => r.indexname)).toEqual([
      'leads_agency_assigned_created_idx',
      'leads_agency_created_idx',
      'leads_agency_response_idx',
      'leads_agency_source_created_idx',
      'leads_agency_stage_assigned_rank_idx',
      'leads_agency_stage_rank_idx',
      'leads_agency_status_created_idx',
      'leads_contact_idx',
      'leads_idempotency_uq',
      'leads_inbound_uq',
    ]);
  });

  it.each([
    [
      'a contact merge re-points its leads',
      sql`contact_id = ${'00000000-0000-7000-8000-0000005111ee'}::uuid`,
      /leads_contact_idx/,
    ],
    [
      'website promotion: one lead per inbound lead',
      sql`inbound_lead_id = ${'00000000-0000-7000-8000-0000005111ef'}::uuid`,
      /leads_inbound_uq/,
    ],
    [
      'POST replay',
      sql`idempotency_hash = ${'h'} and created_at > now() - interval '24 hours'`,
      /leads_idempotency_uq/,
    ],
  ] as const)('[S12-F7] %s: its own index', async (_name, where, index) => {
    const plan = await withTenant({ agencyId: founder.agencyId }, async (tx) => {
      const res = await tx.execute(
        sql`explain select id from leads where agency_id = ${founder.agencyId}::uuid and ${where}`,
      );
      return (res.rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0])).join('\n');
    });
    expect(plan).toMatch(index);
  });
});
