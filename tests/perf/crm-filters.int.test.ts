import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withTenant } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { type SQLWrapper, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activitiesPageQuery } from '../../packages/core/src/modules/crm/activities-repo';
import { leadsPageQuery } from '../../packages/core/src/modules/crm/leads-repo';

/**
 * CRM list filters at scale (S11-F6): the agency's activity feed filtered by a rare type (one type and several) and the
 * lead inbox's combined filters ("my open leads": status + assignee; a stage + cursor page) on 60,000 rows of one agency
 * among four other agencies' (NOISE_AGENCIES: the agency is a fifth of each table, as on a shared production table).
 * The statements are the repos' own (`activitiesPageQuery`, `leadsPageQuery`), explained as the request role under RLS.
 * The rows are committed (VACUUM needs it), inserted with FK checks off and deleted afterwards the same way.
 */

const ROWS = 60_000;
const NOISE_AGENCIES = [1, 2, 3, 4].map((i) => `00000000-0000-7000-8000-0000005111f${i}`);
const STAGES = [1, 2, 3, 4, 5].map((i) => `00000000-0000-7000-8000-0000005111a${i}`);
const MEMBERS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `00000000-0000-7000-8000-0000005111b${i}`);
let founder: Founder;

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
  await adminQuery(`begin;
    set local session_replication_role = replica;
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
    insert into leads (id, agency_id, contact_id, source, status, stage_id, stage_rank, stage_entered_at, created_at,
                       assigned_user_id, assigned_at)
    select gen_random_uuid(), '${founder.agencyId}', md5('${founder.agencyId}' || (1 + g % 2000))::uuid,
           'WEBSITE', ${status},
           (array[${list(STAGES)}])[1 + abs(hashtext(g::text || 'g')) % 5]::uuid, 'i', now(),
           now() - (g * 90.0 / ${ROWS}) * interval '1 day',
           (array[${list(MEMBERS)}])[1 + abs(hashtext(g::text || 'a')) % 8]::uuid, now()
      from generate_series(1, ${ROWS}) g;
    insert into leads (id, agency_id, contact_id, source, status, stage_id, stage_rank, stage_entered_at, created_at)
    select gen_random_uuid(), (array[${list(NOISE_AGENCIES)}])[1 + g % 4]::uuid, gen_random_uuid(), 'WEBSITE',
           'NEW', gen_random_uuid(), 'i', now(), now() - (g * 90.0 / ${4 * ROWS}) * interval '1 day'
      from generate_series(1, ${4 * ROWS}) g;
    commit;`);
  await adminQuery('vacuum analyze activities');
  await adminQuery('vacuum analyze leads');
  await adminQuery('analyze contacts');
}, 300_000);

afterAll(async () => {
  await adminQuery(`begin;
    set local session_replication_role = replica;
    delete from activities where agency_id in ('${founder.agencyId}', ${list(NOISE_AGENCIES)});
    delete from leads where agency_id in ('${founder.agencyId}', ${list(NOISE_AGENCIES)});
    delete from contacts where agency_id = '${founder.agencyId}';
    commit;`);
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
 * Not separately indexed (recorded S11-F6, a follow-up): stage + assignee with a cursor (the stage's rank index orders by
 * rank, so a member's leads in one stage are sorted: 22 ms at 60k leads, ~1.3k matches) and source + status (the status
 * index filters on source).
 */
describe('lead inbox combined filters at 60k leads', () => {
  it.each([
    ['rare status + assignee', { status: 'LOST', assignedUserId: MEMBERS[3] as string }, first],
    ['rare status + assignee, cursor', { status: 'LOST', assignedUserId: MEMBERS[3] as string }, deep()],
    ['stage', { stageId: STAGES[2] as string }, first],
    ['stage, cursor', { stageId: STAGES[2] as string }, deep()],
  ] as const)(
    '[S11-F6] %s: index-driven, under 20 ms',
    async (name, filter, p) => {
      const r = await explain((tx) => leadsPageQuery(tx, founder.agencyId, filter, p));
      console.info(`listLeads, ${name}: ${r.ms} ms\n${r.plan}`);
      expect(r.plan).not.toMatch(/Seq Scan on leads/);
      if ('status' in filter) expect(r.plan).toMatch(/leads_agency_assigned_status_created_idx/);
      if ('stageId' in filter) expect(r.plan).toMatch(/leads_agency_stage_\w*idx/);
      expect(r.ms).toBeLessThan(20);
    },
    60_000,
  );
});
