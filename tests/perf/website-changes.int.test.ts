import * as search from '@inmolink/core/modules/search';
import { createFounder } from '@inmolink/core/test';
import { closeDb, withPublicRead } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * The change feed behind a long log (S7-08 load test finding): `/v2/changes` read the whole `listing_public_changes`
 * table on every request — the "held" horizon check as a join filter (sequential scan) and the `since` start walking
 * `tx_idx` from the log's beginning — 150–180 ms at 380k rows locally, growing with the 30-day log. With a backlog of
 * old changes and a few recent ones, and with `since` inside that backlog, both statements stay on their indexes when
 * read as feed-api reads (`withPublicRead`): no sequential scan of the log within the transaction
 * (`pg_stat_xact_user_tables`), only the `changed_at` window and one page fetched, under 20 ms.
 */

const OLD = 60_000;
const RECENT = 300;
const space = '0195f0a5-0801-7000-8000-';
const idSql = (n: string) => `('${space}' || lpad(to_hex(${n}), 12, '0'))::uuid`;
let agencyId = '';

beforeAll(async () => {
  await setupTestDb('worker');
  agencyId = (await createFounder()).agencyId;
  await adminQuery(`delete from listing_public_changes where target_id::text like '${space}%'`);
  // A dense backlog from two days to one day ago (one change every 1.4 s), then this agency's latest changes — dated ahead, so the `since` window holds only them
  // (the shared test database has other suites' recent rows, whose transaction ids are older than this backlog's).
  await adminQuery(`insert into listing_public_changes (target_id, kind, owner_agency_id, ref, shared_all, changed_at)
    select ${idSql('g')}, 'LISTING', '${agencyId}'::uuid, 'CF' || g, g % 2 = 0,
           now() - interval '2 days' + make_interval(secs => g * 86400.0 / ${OLD})
      from generate_series(1, ${OLD}) g`);
  await adminQuery(`insert into listing_public_changes (target_id, kind, owner_agency_id, ref, shared_all, changed_at)
    select ${idSql(`${OLD} + g`)}, 'LISTING', '${agencyId}'::uuid, 'CR' || g, true, now() + interval '10 minutes'
      from generate_series(1, ${RECENT}) g`);
  await adminQuery('analyze listing_public_changes');
});

afterAll(async () => {
  await adminQuery(`delete from listing_public_changes where target_id::text like '${space}%'`).catch(() => undefined);
  await closeDb();
});

/** One change page as feed-api reads it (`app_public`, RLS): its scans of the log and its time. */
async function page(since: Date, audience: { ownerAgencyId: string } | { networkOf: string }) {
  return withPublicRead(async (tx) => {
    const started = performance.now();
    const result = await search.siteChanges(
      tx,
      { ownerAgencyIds: [agencyId], requestId: newId() },
      { since, audience, limit: 200 },
    );
    const ms = performance.now() - started;
    const stats = await tx.execute<{ seq_scan: number; fetched: number }>(sql`
      select seq_scan::int, idx_tup_fetch::int as fetched
        from pg_stat_xact_user_tables where relname = 'listing_public_changes'`);
    return { scans: stats.rows[0]?.seq_scan ?? 0, fetched: stats.rows[0]?.fetched ?? 0, rows: result.rows, ms };
  });
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

it('[S7-08] the change feed reads its log by index, not by a sequential scan, behind a long backlog', async () => {
  const since = new Date(Date.now() + 9 * 60_000);
  for (const audience of [{ ownerAgencyId: agencyId }, { networkOf: agencyId }]) {
    const { scans, fetched, rows } = await page(since, audience);
    expect(scans, JSON.stringify(audience)).toBe(0);
    // Rows read through indexes: the `since` window (300) and one page (200), never the backlog (60,000).
    expect(fetched, JSON.stringify(audience)).toBeLessThan(2_000);
    // The page starts at the recent changes: none of the backlog (other suites' recent network rows may come first
    // for the network audience; the agency's own feed is only this test's rows).
    expect(rows).toHaveLength(200);
    expect(rows.some((r) => r.ref.startsWith('CF'))).toBe(false);
    if ('ownerAgencyId' in audience) expect(rows.every((r) => r.ref.startsWith('CR'))).toBe(true);
  }
});

it('[S7-08] a `since` inside a dense backlog older than a day: an index range, no sequential scan, under 20 ms', async () => {
  // Perf audit: with the window's upper bound unknown at plan time an old `since` became a sequential scan (659 ms).
  const since = new Date(Date.now() - 36 * 3_600_000);
  const logRows = Number(
    (await adminQuery<{ n: number }>('select count(*)::int as n from listing_public_changes'))[0]?.n,
  );
  expect(logRows).toBeGreaterThanOrEqual(OLD);
  for (const audience of [{ ownerAgencyId: agencyId }, { networkOf: agencyId }]) {
    await page(since, audience);
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await page(since, audience));
    for (const r of runs) expect(r.scans, JSON.stringify(audience)).toBe(0);
    // The window (10 minutes of the backlog, ~420 rows here plus other suites' rows of that time) and one page: a
    // small share of the log, never a walk over it.
    expect(Math.max(...runs.map((r) => r.fetched)), JSON.stringify(audience)).toBeLessThan(logRows / 10);
    expect(runs[0]?.rows).toHaveLength(200);
    expect(median(runs.map((r) => r.ms)), JSON.stringify(audience)).toBeLessThan(20);
  }
});
