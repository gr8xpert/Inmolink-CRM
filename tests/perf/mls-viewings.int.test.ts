import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withTenant } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { introducerPageQuery, ownerPageQuery } from '../../packages/core/src/modules/mls/viewings-repo';

/**
 * Viewing request lists at scale (S11-02): the introducer's requests and the owner's copies, 10,000 rows each for one
 * agency among 10,000 more of another agency. Each list reads one table under one RLS policy, so page 2 (a keyset
 * cursor) is an index-ordered scan that stops after limit + 1 rows. The statements are the repo's own
 * (`introducerPageQuery`, `ownerPageQuery`), explained as `app_user` under RLS. Rows are seeded with triggers off
 * (replica role: both copies explicitly), committed (the visibility map needs a VACUUM) and deleted afterwards.
 */

const ROWS = 10_000;
const LIMIT = 25;
let introducer: Founder;
let owner: Founder;
let other: Founder;

/** `n` requests of `from` for `to`'s listings, and `to`'s copies of them, created over the last 90 days. */
const seed = (from: string, to: string, n: number) => `
  insert into viewing_requests (id, agency_id, owner_agency_id, registration_id, contact_id, target_kind, target_id,
                                status, awaiting, proposed_start_at, expires_at, commission_bp, split_bp,
                                commission_includes_vat, terms_valid_until, created_at, updated_at)
  select gen_random_uuid(), '${from}', '${to}', gen_random_uuid(), gen_random_uuid(), 'LISTING', gen_random_uuid(),
         'REQUESTED', 'OWNER', now() + interval '5 days', now() + interval '2 days', 500, 5000, false,
         now() + interval '90 days', now() - (g * 90.0 / ${n}) * interval '1 day', now()
    from generate_series(1, ${n}) g;
  insert into viewing_request_receipts (request_id, agency_id, introducer_agency_id, target_kind, target_id, status,
                                        awaiting, proposed_start_at, expires_at, commission_bp, split_bp,
                                        commission_includes_vat, terms_valid_until, terms_at, introducer_accepted_at,
                                        created_at, updated_at)
  select id, owner_agency_id, agency_id, target_kind, target_id, status, awaiting, proposed_start_at, expires_at,
         commission_bp, split_bp, commission_includes_vat, terms_valid_until, terms_at, introducer_accepted_at,
         created_at, updated_at
    from viewing_requests where agency_id = '${from}';`;

beforeAll(async () => {
  await setupTestDb('worker');
  [introducer, owner, other] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  await adminQuery(`begin;
    set local session_replication_role = replica;
    ${seed(introducer.agencyId, owner.agencyId, ROWS)}
    ${seed(other.agencyId, introducer.agencyId, ROWS)}
    commit;`);
  await adminQuery('vacuum analyze viewing_requests');
  await adminQuery('vacuum analyze viewing_request_receipts');
}, 180_000);

afterAll(async () => {
  for (const m of [introducer, other]) {
    await adminQuery(`begin; set local session_replication_role = replica;
      delete from viewing_request_receipts where introducer_agency_id = '${m.agencyId}';
      delete from viewing_requests where agency_id = '${m.agencyId}'; commit;`);
  }
  await closeDb();
}, 120_000);

type Page = typeof introducerPageQuery | typeof ownerPageQuery;

/** Page 2 of a list (the cursor of page 1's last row), explained five times after a warm-up; the fastest run. */
async function explainPage2(agencyId: string, page: Page) {
  const first = await withTenant({ agencyId }, async (tx) => page(tx, agencyId, { limit: LIMIT }));
  expect(first).toHaveLength(LIMIT + 1);
  const last = first[LIMIT - 1] as { createdMs: Date; id: string };
  const cursor = { at: last.createdMs, id: last.id };
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

describe('viewing request lists at scale', () => {
  it('[S11-02] page 2 of the introducer’s viewing requests: index-ordered, < 20 ms at 10k rows', async () => {
    const best = await explainPage2(introducer.agencyId, introducerPageQuery);
    console.info(`viewing requests page 2 (${ROWS} rows): ${best.ms} ms\n${best.plan}`);
    expect(best.plan).toMatch(/Index Scan Backward using viewing_requests_agency_created_idx/);
    expect(best.plan).not.toMatch(/Sort|Seq Scan/);
    expect(best.plan).toMatch(/Index Scan Backward.*rows=26(\.00)? loops=1\)/);
    expect(best.ms).toBeLessThan(20);
  }, 120_000);

  it('[S11-02] page 2 of the owner’s received viewing requests: index-ordered, < 20 ms at 10k rows', async () => {
    const best = await explainPage2(owner.agencyId, ownerPageQuery);
    console.info(`received viewing requests page 2 (${ROWS} rows): ${best.ms} ms\n${best.plan}`);
    expect(best.plan).toMatch(/Index Scan Backward using viewing_request_receipts_agency_created_idx/);
    expect(best.plan).not.toMatch(/Sort|Seq Scan/);
    expect(best.plan).toMatch(/Index Scan Backward.*rows=26(\.00)? loops=1\)/);
    expect(best.ms).toBeLessThan(20);
  }, 120_000);
});
