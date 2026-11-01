import { pruneExpiredRegistrations } from '@inmolink/core/modules/mls';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, type Tx, withSystem, withTenant } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENCY_TEXT_BATCH } from '../../packages/core/src/modules/crm/erasure';
import * as crmRepo from '../../packages/core/src/modules/crm/repo';
import { type PruneCursor, pruneBatch } from '../../packages/core/src/modules/mls/gdpr';

/**
 * S17-F3 (S16 perf review), the GDPR sweeps at scale — each page a bounded, index-ordered read:
 * - the daily retention scan (`crm.inactiveContactsPage`): one agency with 100,000 contacts, 40,000 untouched for three
 *   years, among the other agencies' contacts; pages of 100 candidates on `contacts_retention_idx`;
 * - agency erasure's text sweep (`crm.clearAgencyText`, from a key half-way through each walk): 50,000 activities (half without a body, over months of
 *   monthly partitions) and 20,000 tasks of the agency (half already cleared, half
 *   deleted) walked on `tasks_agency_idx` / `tasks_agency_deleted_idx`;
 * - the MLS registration prune (`mls.pruneExpiredRegistrations`): 20,000 live registrations, 5,000 past retention kept
 *   for an open viewing (the oldest) and 2,000 past retention to delete.
 * Statements are the repos' own, explained as `app_user` under RLS (the prune as `app_system`); rows committed and
 * VACUUM ANALYZEd, deleted afterwards. Budget: < 20 ms a page, no Seq Scan.
 */

const CONTACTS = 100_000;
const IDLE = 40_000;
const TASKS = 20_000;
const ACTIVITIES = 50_000;
const LIVE_REGISTRATIONS = 20_000;
const KEPT = 5_000;
const EXPIRED = 2_000;
const PAGE = 100;
let big: Founder;
let owner: Founder;

/** Runs `fn` on a transaction whose statements are explained (analyze, buffers) instead of answered; the plans. */
async function explained(agencyId: string | null, fn: (tx: Tx) => Promise<unknown>): Promise<string[]> {
  const plans: string[] = [];
  const rollback = new Error('rollback');
  // a tenant's statements as app_user under RLS; null: the worker's (app_system), as the prune runs
  const run = <T>(body: (tx: Tx) => Promise<T>) =>
    agencyId ? withTenant({ agencyId }, body) : withSystem('mls.pruneRegistrations: perf test', body);
  try {
    await run(async (tx) => {
      const spy = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop !== 'execute') return Reflect.get(target, prop, receiver);
          return async (q: SQL) => {
            const res = await target.execute(sql`explain (analyze, buffers) ${q}`);
            plans.push((res.rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0])).join('\n'));
            return { rows: [] };
          };
        },
      });
      await fn(spy as Tx).catch(() => undefined);
      throw rollback; // the explained updates are undone
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
  return plans;
}

const msOf = (plan: string) => Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1]);

/** The fastest of five explained runs after a warm-up (a quiet machine's number, not a background spike). */
async function best(agencyId: string | null, fn: (tx: Tx) => Promise<unknown>): Promise<{ plan: string; ms: number }> {
  await explained(agencyId, fn);
  const runs: { plan: string; ms: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const [plan = ''] = await explained(agencyId, fn);
    runs.push({ plan, ms: msOf(plan) });
  }
  return runs.reduce((x, y) => (x.ms <= y.ms ? x : y));
}

beforeAll(async () => {
  await setupTestDb('worker');
  [big, owner] = await Promise.all([createFounder(), createFounder()]);
  const A = big.agencyId;
  const B = owner.agencyId;
  await adminQuery(`begin;
    set local session_replication_role = replica;
    insert into contacts (id, agency_id, first_name, last_name, updated_at, created_at)
      select gen_random_uuid(), '${A}', 'Scale', 'Contact ' || g,
             case when g <= ${IDLE} then now() - interval '36 months' - g * interval '1 second' else now() - g * interval '1 minute' end,
             now() - interval '40 months'
        from generate_series(1, ${CONTACTS}) g;
    insert into activities (id, agency_id, contact_id, type, body, occurred_at)
      select gen_random_uuid(), '${A}', c.id, 'CALL',
             case when g % 2 = 0 then null else 'call ' || g end,
             date_trunc('milliseconds', now() - g * interval '4 minutes', 'UTC')
        from generate_series(1, ${ACTIVITIES}) g
        -- the agency's active contacts (logged on recently, as in real data), one call each
        join (select id, row_number() over (order by id) as n from contacts
               where agency_id = '${A}' and updated_at > now() - interval '1 year') c on c.n = g;
    insert into tasks (id, agency_id, title, description, assigned_user_id, status, completed_at, deleted_at)
      select gen_random_uuid(), '${A}', case when g % 2 = 0 then '—' else 'Task ' || g end,
             case when g % 2 = 0 then null else 'secret' end, '${big.userId}',
             case when g % 3 = 0 then 'DONE' else 'OPEN' end, case when g % 3 = 0 then now() end,
             case when g % 4 = 0 then now() end
        from generate_series(1, ${TASKS}) g;
    insert into client_registrations (id, agency_id, target_agency_id, target_kind, target_id, contact_id, details_enc,
                                      registered_at, expires_at)
      select gen_random_uuid(), '${A}', '${B}', 'LISTING', gen_random_uuid(), gen_random_uuid(), 'x',
             now() - interval '30 days', now() + interval '30 days'
        from generate_series(1, ${LIVE_REGISTRATIONS}) g;
    insert into client_registrations (id, agency_id, target_agency_id, target_kind, target_id, contact_id, details_enc,
                                      registered_at, expires_at)
      select gen_random_uuid(), '${A}', '${B}', 'LISTING', gen_random_uuid(), gen_random_uuid(), 'kept',
             now() - interval '9 years' - g * interval '1 minute', now() - interval '8 years' - g * interval '1 minute'
        from generate_series(1, ${KEPT}) g;
    insert into viewing_requests (id, agency_id, owner_agency_id, registration_id, contact_id, target_kind, target_id,
                                  status, awaiting, expires_at, proposed_start_at, split_bp, commission_bp,
                                  commission_includes_vat, terms_valid_until)
      select gen_random_uuid(), agency_id, target_agency_id, id, contact_id, target_kind, target_id,
             'REQUESTED', 'OWNER', now() + interval '1 day', now() + interval '2 days', 5000, 300, true,
             now() + interval '30 days'
        from client_registrations where agency_id = '${A}' and details_enc = 'kept';
    insert into client_registrations (id, agency_id, target_agency_id, target_kind, target_id, contact_id, details_enc,
                                      registered_at, expires_at)
      select gen_random_uuid(), '${A}', '${B}', 'LISTING', gen_random_uuid(), gen_random_uuid(), 'gone',
             now() - interval '7 years' - g * interval '1 minute', now() - interval '6 years' - g * interval '1 minute'
        from generate_series(1, ${EXPIRED}) g;
    commit;`);
  for (const t of ['contacts', 'activities', 'tasks', 'client_registrations', 'viewing_requests']) {
    await adminQuery(`vacuum analyze ${t}`);
  }
}, 600_000);

afterAll(async () => {
  const A = big.agencyId;
  await adminQuery(`begin; set local session_replication_role = replica;
    delete from viewing_requests where agency_id = '${A}';
    delete from client_registrations where agency_id = '${A}';
    delete from tasks where agency_id = '${A}';
    delete from activities where agency_id = '${A}';
    delete from contacts where agency_id = '${A}'; commit;`);
  await closeDb();
}, 300_000);

describe('GDPR sweeps at scale (S17-F3)', () => {
  it('[S17-F3] a retention scan page is < 20 ms on contacts_retention_idx (no Seq Scan), deep in the candidates too', async () => {
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 24);
    // a cursor half-way through the candidates (a run deep into a big agency)
    const mid = await withTenant({ agencyId: big.agencyId }, async (tx) => {
      const res = await tx.execute(sql`select updated_at::text as at, id from contacts
        where agency_id = ${big.agencyId} and deleted_at is null and updated_at < ${cutoff.toISOString()}::timestamptz
        order by updated_at, id offset ${IDLE / 2} limit 1`);
      return res.rows[0] as unknown as crmRepo.RetentionCursor;
    });
    for (const after of [null, mid]) {
      const { plan, ms } = await best(big.agencyId, (tx) =>
        crmRepo.inactiveContactsPage(tx, big.agencyId, cutoff, after, PAGE),
      );
      console.log(`[S17-F3] retention page (${after ? 'mid' : 'first'}): ${ms.toFixed(2)} ms`);
      expect(plan).toContain('contacts_retention_idx');
      expect(plan).not.toMatch(/Seq Scan on contacts/);
      expect(ms).toBeLessThan(20);
    }
  });

  it('[S17-F3] an agency text sweep statement reads one keyset page (< 20 ms, no Seq Scan), deep in the walk too', async () => {
    // a key half-way through each walk: activities (activities_agency_idx per partition), live tasks
    // (tasks_agency_idx), deleted tasks (tasks_agency_deleted_idx)
    const A = big.agencyId;
    const deep = (q: SQL) =>
      withTenant({ agencyId: A }, async (tx) => ((await tx.execute(q)).rows[0] as { key: string[] }).key);
    for (const [step, index, key] of [
      [
        0,
        'activities_',
        sql`select array[occurred_at::text, id::text] as key from activities where agency_id = ${A}
              order by occurred_at, id offset ${ACTIVITIES / 2} limit 1`,
      ],
      [
        1,
        'tasks_agency_idx',
        sql`select array[status, due_sort_ms::text, id::text] as key from tasks
              where agency_id = ${A} and deleted_at is null order by status, due_sort_ms, id offset ${Math.floor(TASKS / 3)} limit 1`,
      ],
      [
        2,
        'tasks_agency_deleted_idx',
        sql`select array[id::text] as key from tasks where agency_id = ${A} and deleted_at is not null
              order by id offset ${Math.floor(TASKS / 8)} limit 1`,
      ],
    ] as const) {
      const cursor: crmRepo.AgencyTextCursor = { step, key: await deep(key) };
      const { plan, ms } = await best(A, (tx) => crmRepo.clearAgencyText(tx, A, cursor, AGENCY_TEXT_BATCH));
      console.log(`[S17-F3] agency text sweep page (step ${step}, mid-walk): ${ms.toFixed(2)} ms`);
      expect(plan).toContain(index);
      // the empty future partitions are read as such (cost 0): any other Seq Scan fails
      const seq = plan
        .split('\n')
        .filter((l) => /Seq Scan on (tasks|activities)/.test(l) && !/cost=0\.0\d\.\.0\.0\d /.test(l));
      expect(seq).toEqual([]);
      expect(ms).toBeLessThan(20);
    }
  });

  it('[S17-F3] a prune batch is < 20 ms (first batch past 5,000 kept registrations included) and nothing due is one walk', async () => {
    const cutoff = new Date(Date.now() - 5 * 365 * 86_400_000);
    // the first batch of a run: it walks past the 5,000 kept registrations (the oldest) and deletes 100 — explained and
    // rolled back, best of five
    const firstBatch = await best(null, (tx) => pruneBatch(tx, cutoff, null, 100));
    console.log(`[S17-F3] prune batch (first, past 5,000 kept): ${firstBatch.ms.toFixed(2)} ms`);
    expect(firstBatch.plan).toContain('client_registrations_expires_idx');
    expect(firstBatch.plan).not.toMatch(/Seq Scan on client_registrations /);
    expect(firstBatch.ms).toBeLessThan(20);
    // a later batch, after the last deleted row: the kept ones are behind its cursor
    const after = await withSystem('mls.pruneRegistrations: perf test', async (tx) => {
      const res = await tx.execute(sql`select expires_at::text as at, id::text as id from client_registrations
        where agency_id = ${big.agencyId} and details_enc = 'gone' order by expires_at, id offset ${EXPIRED / 2} limit 1`);
      return res.rows[0] as unknown as PruneCursor;
    });
    const later = await best(null, (tx) => pruneBatch(tx, cutoff, after, 100));
    console.log(`[S17-F3] prune batch (mid-run): ${later.ms.toFixed(2)} ms`);
    expect(later.ms).toBeLessThan(20);

    // the run itself, then the next day: only the kept registrations are past retention — one statement walks them
    const first = await pruneExpiredRegistrations();
    expect(first.registrations).toBeGreaterThanOrEqual(EXPIRED);
    const idle = await best(null, (tx) => pruneBatch(tx, cutoff, null, 100));
    console.log(`[S17-F3] prune with nothing due (5,000 kept): ${idle.ms.toFixed(2)} ms`);
    expect(idle.ms).toBeLessThan(20);
    expect((await pruneExpiredRegistrations()).registrations).toBe(0);
  }, 180_000);
});
