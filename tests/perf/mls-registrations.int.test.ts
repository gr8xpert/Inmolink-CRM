import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withTenant } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownPage, receiptsPage } from '../../packages/core/src/modules/mls/repo';

/**
 * Client registration lists at scale (S11-01 perf review): the introducer's registrations and the owner's receipts,
 * 10,000 rows each for one agency among 10,000 more of other agencies. Each list reads one table under one RLS policy,
 * so page 2 (a keyset cursor) is an index-ordered scan that stops after limit + 1 rows. The statements are the repo's
 * own (`ownPage`, `receiptsPage`), explained as `app_user` under RLS. Rows are committed (the visibility map needs a
 * VACUUM) and deleted afterwards.
 */

const ROWS = 10_000;
const LIMIT = 25;
let introducer: Founder;
let owner: Founder;
let other: Founder;

/** `n` registrations of `from` for `to`'s targets, and `to`'s receipts of them, over the last 180 days. */
const seed = (from: string, to: string, n: number) => `
  insert into client_registrations (id, agency_id, target_agency_id, target_kind, target_id, contact_id, details_enc,
                                    registered_at, expires_at)
  select gen_random_uuid(), '${from}', '${to}', 'LISTING', gen_random_uuid(), gen_random_uuid(), 'x',
         now() - (g * 180.0 / ${n}) * interval '1 day', now() + interval '30 days'
    from generate_series(1, ${n}) g;
  insert into client_registration_receipts (registration_id, agency_id, introducer_agency_id, target_kind, target_id,
                                            registered_at, expires_at)
  select id, target_agency_id, agency_id, target_kind, target_id, registered_at, expires_at
    from client_registrations where agency_id = '${from}';`;

beforeAll(async () => {
  await setupTestDb('worker');
  [introducer, owner, other] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  // replica role: the receipt trigger is skipped for the bulk insert (receipts are seeded explicitly)
  await adminQuery(`begin;
    set local session_replication_role = replica;
    ${seed(introducer.agencyId, owner.agencyId, ROWS)}
    ${seed(other.agencyId, introducer.agencyId, ROWS)}
    commit;`);
  await adminQuery('vacuum analyze client_registrations');
  await adminQuery('vacuum analyze client_registration_receipts');
}, 180_000);

afterAll(async () => {
  for (const m of [introducer, other]) {
    await adminQuery(`begin; set local session_replication_role = replica;
      delete from client_registration_receipts where introducer_agency_id = '${m.agencyId}';
      delete from client_registrations where agency_id = '${m.agencyId}'; commit;`);
  }
  await closeDb();
}, 120_000);

type Page = typeof ownPage | typeof receiptsPage;

/** Page 2 of a list (the cursor of page 1's last row), explained five times after a warm-up; the fastest run. */
async function explainPage2(agencyId: string, page: Page, key: 'id' | 'registrationId') {
  const first = await withTenant({ agencyId }, async (tx) => page(tx, agencyId, { limit: LIMIT }));
  expect(first).toHaveLength(LIMIT + 1);
  const last = first[LIMIT - 1] as { registeredMs: Date } & Record<string, unknown>;
  const cursor = { at: last.registeredMs, id: String(last[key]) };
  const run = () =>
    withTenant({ agencyId }, async (tx) => {
      const res = await tx.execute(sql`explain (analyze, buffers) ${page(tx, agencyId, { limit: LIMIT, cursor })}`);
      const plan = (res.rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0])).join('\n');
      return { plan, ms: Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1]) };
    });
  await run();
  const out: { plan: string; ms: number }[] = [];
  for (let i = 0; i < 5; i++) out.push(await run());
  return out.reduce((x, y) => (x.ms <= y.ms ? x : y));
}

describe('client registration lists at scale', () => {
  it('[S11-01] page 2 of the introducer’s registrations: index-ordered, < 20 ms at 10k rows', async () => {
    const best = await explainPage2(introducer.agencyId, ownPage, 'id');
    console.info(`own registrations page 2 (${ROWS} rows): ${best.ms} ms\n${best.plan}`);
    expect(best.plan).toMatch(/Index Scan Backward using client_registrations_agency_registered_idx/);
    expect(best.plan).not.toMatch(/Sort|Seq Scan/);
    expect(best.plan).toMatch(/Index Scan Backward.*rows=26(\.00)? loops=1\)/);
    expect(best.ms).toBeLessThan(20);
  }, 120_000);

  it('[S11-01] page 2 of the owner’s received registrations: index-ordered, < 20 ms at 10k rows', async () => {
    const best = await explainPage2(owner.agencyId, receiptsPage, 'registrationId');
    console.info(`received registrations page 2 (${ROWS} rows): ${best.ms} ms\n${best.plan}`);
    expect(best.plan).toMatch(/Index Scan Backward using client_registration_receipts_agency_registered_idx/);
    expect(best.plan).not.toMatch(/Sort|Seq Scan/);
    expect(best.plan).toMatch(/Index Scan Backward.*rows=26(\.00)? loops=1\)/);
    expect(best.ms).toBeLessThan(20);
  }, 120_000);
});
