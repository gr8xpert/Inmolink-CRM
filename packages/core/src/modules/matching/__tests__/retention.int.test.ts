import { closeDb, type Tx, withSystem } from '@inmolink/db';
import { setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import { captureSql, describePlan, explainNodes, indexScans, seqScans } from '../../../testing/query-plan';
import { ALERT_DAILY_CAP, ALERT_RETENTION_DAYS, pruneMatching } from '../index';
import * as repo from '../repo';
import { PRUNE_BATCH } from '../service';

/**
 * Saved search alert retention and the per-search daily cap (S13-F9) on the real test database: alerts older than 90
 * days are pruned (recent ones stay); a saved search gets at most its daily cap of alerts in 24 hours, the rest of
 * the day's matches are dropped, and older alerts do not count. The prune reads `saved_search_alerts_created_idx`,
 * the cap's count `saved_search_alerts_search_created_idx`. The saved searches here are `OFF` with a key no listing
 * carries: the matching worker of other suites never picks them.
 */

let f: Founder;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('matching.retention.test', fn);
const DAY = 86_400_000;

beforeAll(async () => {
  await setupTestDb('worker');
  f = await createFounder();
}, 120_000);
afterAll(closeDb);

async function savedSearch(): Promise<string> {
  const id = newId();
  await system((tx) =>
    tx.execute(sql`insert into saved_searches (id, agency_id, user_id, name, frequency, match_keys)
      values (${id}, ${f.agencyId}, ${f.userId}, 'Retention', 'OFF', ${`{retention:${id}}`}::text[])`),
  );
  return id;
}

const alerts = (savedSearchId: string, n: number): repo.NewAlert[] =>
  Array.from({ length: n }, () => ({
    id: newId(),
    agencyId: f.agencyId,
    userId: f.userId,
    savedSearchId,
    listingId: newId(),
    kind: 'NEW',
    dedupeKey: 0,
    ref: 'INL-RET',
    priceCents: 100_000_00,
    previousPriceCents: null,
  }));

const countOf = async (savedSearchId: string) =>
  Number(
    (
      await system((tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from saved_search_alerts where saved_search_id = ${savedSearchId}`,
        ),
      )
    ).rows[0]?.n,
  );

describe('saved search alert retention', () => {
  it('[S13-F9] saved_search_alerts: alerts past 90 days are pruned, recent ones stay', async () => {
    const s = await savedSearch();
    const [old, edge, recent] = alerts(s, 3) as [repo.NewAlert, repo.NewAlert, repo.NewAlert];
    await system((tx) => repo.insertAlerts(tx, [old, edge, recent], ALERT_DAILY_CAP));
    const now = Date.now();
    await system(async (tx) => {
      await tx.execute(sql`update saved_search_alerts set created_at = ${new Date(now - (ALERT_RETENTION_DAYS + 1) * DAY).toISOString()}::timestamptz
        where id = ${old.id}`);
      await tx.execute(sql`update saved_search_alerts set created_at = ${new Date(now - (ALERT_RETENTION_DAYS - 1) * DAY).toISOString()}::timestamptz
        where id = ${edge.id}`);
    });
    const res = await pruneMatching(now);
    expect(res.alerts).toBeGreaterThanOrEqual(1);
    const left = await system((tx) =>
      tx.execute<{ id: string }>(sql`select id from saved_search_alerts where saved_search_id = ${s} order by id`),
    );
    expect(left.rows.map((r) => r.id).sort()).toEqual([edge.id, recent.id].sort());
  });

  it('[S13-F9] saved_search_alerts: a saved search gets at most its daily cap of alerts in 24 hours', async () => {
    const s = await savedSearch();
    const other = await savedSearch();
    // one batch over the cap: the cap is written, the rest dropped; another search in the batch is not affected
    const first = await system((tx) => repo.insertAlerts(tx, [...alerts(s, 5), ...alerts(other, 2)], 3));
    expect(first.written).toBe(5);
    expect(await countOf(s)).toBe(3);
    expect(await countOf(other)).toBe(2);
    // a later batch the same day: nothing more for the capped search
    expect((await system((tx) => repo.insertAlerts(tx, alerts(s, 2), 3))).written).toBe(0);
    // alerts older than 24 hours no longer count
    await system((tx) =>
      tx.execute(
        sql`update saved_search_alerts set created_at = now() - interval '25 hours' where saved_search_id = ${s}`,
      ),
    );
    expect((await system((tx) => repo.insertAlerts(tx, alerts(s, 4), 3))).written).toBe(3);
    expect(await countOf(s)).toBe(6);
    expect(ALERT_DAILY_CAP).toBeGreaterThan(0);
    expect(PRUNE_BATCH).toBeLessThanOrEqual(5_000);
  });

  it('[S13-F9] saved_search_alerts: the prune and the cap EXPLAIN as index scans (20k alerts)', async () => {
    const [prune] = await captureSql((tx) => repo.pruneAlerts(tx, new Date(Date.now() - 90 * DAY), PRUNE_BATCH));
    const [insert] = await captureSql((tx) => repo.insertAlerts(tx, alerts(newId(), 3), ALERT_DAILY_CAP));
    const plans = await withAdminRollback(['saved_search_alerts'], async (q) => {
      await q('set local session_replication_role = replica');
      // 20k alerts of 2,000 saved searches over 90 days, a few hundred past it
      await q(
        `insert into saved_search_alerts (id, agency_id, user_id, saved_search_id, listing_id, kind, dedupe_key, ref,
                                          created_at)
         select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), md5((g % 2000)::text)::uuid, gen_random_uuid(),
                'NEW', 0, 'INL-PLAN',
                case when g <= 200 then now() - interval '100 days' - (g || ' hours')::interval
                     else now() - ((g % 89) || ' days')::interval end
           from generate_series(1, 20000) g`,
      );
      await q('analyze saved_search_alerts');
      await q('set local role app_system');
      return {
        prune: await explainNodes(q, prune as NonNullable<typeof prune>),
        insert: await explainNodes(q, insert as NonNullable<typeof insert>),
      };
    });
    expect(seqScans(plans.prune, 'saved_search_alerts'), describePlan(plans.prune)).toBe(false);
    expect(indexScans(plans.prune, 'saved_search_alerts_created_idx'), describePlan(plans.prune)).not.toHaveLength(0);
    expect(seqScans(plans.insert, 'saved_search_alerts'), describePlan(plans.insert)).toBe(false);
    expect(
      indexScans(plans.insert, 'saved_search_alerts_search_created_idx'),
      describePlan(plans.insert),
    ).not.toHaveLength(0);
  });
});
