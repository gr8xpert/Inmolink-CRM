import { closeDb, type Tx, withSystem } from '@inmolink/db';
import { setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import { captureSql, describePlan, explainNodes, indexScans, seqScans } from '../../../testing/query-plan';
import { INTERACTION_RETENTION, presentationsJobs, pruneSelectionInteractions } from '../index';
import * as repo from '../repo';

/**
 * Selection interaction retention (S13-F9) on the real test database: what clients did on a selection's page is
 * deleted 12 months after the selection ended (revoked or expired, whichever first); a live selection, or one ended
 * more recently, keeps its history; the selections and their items stay. Both statements are index-backed: the ended
 * selections walk `selections_ended_idx` (keyset), their interactions `selection_interactions_selection_idx`.
 */

let f: Founder;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('presentations.retention.test', fn);
const DAY = 86_400_000;

beforeAll(async () => {
  await setupTestDb('worker');
  f = await createFounder();
}, 120_000);
afterAll(closeDb);

const monthsAgo = (nowMs: number, months: number, plusMs = 0) => {
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() - months);
  return new Date(d.getTime() + plusMs);
};
const ts = (d: Date | null) => (d ? d.toISOString() : null);

/** A selection with `views` page views; answers its id. */
async function selection(ends: { expiresAt?: Date | null; revokedAt?: Date | null }, views = 3): Promise<string> {
  const id = newId();
  await system(async (tx) => {
    await tx.execute(sql`
      insert into selections (id, agency_id, created_by, title, locale, token_hash, token_hint, expires_at, revoked_at,
                              created_at)
      values (${id}, ${f.agencyId}, ${f.userId}, 'Retention', 'en', ${`retention-${id}`}, 'abcd',
              ${ts(ends.expiresAt ?? null)}::timestamptz, ${ts(ends.revokedAt ?? null)}::timestamptz,
              now() - interval '3 years')`);
    await tx.execute(sql`
      insert into selection_interactions (id, agency_id, selection_id, kind, created_at)
      select gen_random_uuid(), ${f.agencyId}, ${id}, 'VIEW', now() - interval '2 years' + (g || ' minutes')::interval
        from generate_series(1, ${views}) g`);
  });
  return id;
}

const interactionsOf = async (id: string) =>
  Number(
    (
      await system((tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from selection_interactions where selection_id = ${id}`,
        ),
      )
    ).rows[0]?.n,
  );
const selectionExists = async (id: string) =>
  (await system((tx) => tx.execute(sql`select 1 from selections where id = ${id}`))).rows.length === 1;

describe('selection interaction retention', () => {
  it('[S13-F9] selection_interactions: deleted 12 months after expiry or revoke; live and recently ended keep theirs', async () => {
    const now = Date.now();
    const expiredLongAgo = await selection({ expiresAt: monthsAgo(now, INTERACTION_RETENTION.MONTHS, -DAY) });
    const revokedLongAgo = await selection({ revokedAt: monthsAgo(now, 20), expiresAt: new Date(now + 30 * DAY) });
    // revoked recently but expired long ago: it ended at the earlier of the two
    const expiredThenRevoked = await selection({ expiresAt: monthsAgo(now, 15), revokedAt: new Date(now - DAY) });
    const recentlyEnded = await selection({ expiresAt: monthsAgo(now, INTERACTION_RETENTION.MONTHS, DAY) });
    const live = await selection({ expiresAt: null, revokedAt: null });
    const liveUntilLater = await selection({ expiresAt: new Date(now + 60 * DAY) });

    const res = await pruneSelectionInteractions(now);
    expect(res.deleted).toBeGreaterThanOrEqual(9);
    expect(await interactionsOf(expiredLongAgo)).toBe(0);
    expect(await interactionsOf(revokedLongAgo)).toBe(0);
    expect(await interactionsOf(expiredThenRevoked)).toBe(0);
    expect(await interactionsOf(recentlyEnded)).toBe(3);
    expect(await interactionsOf(live)).toBe(3);
    expect(await interactionsOf(liveUntilLater)).toBe(3);
    // the selections themselves stay (the dashboard list)
    expect(await selectionExists(expiredLongAgo)).toBe(true);
    // idempotent
    await pruneSelectionInteractions(now);
    expect(await interactionsOf(recentlyEnded)).toBe(3);
  });

  it('[S13-F9] selection_interactions: an ended selection with more than a batch of interactions is emptied', async () => {
    const now = Date.now();
    const busy = await selection({ revokedAt: monthsAgo(now, 14) }, 7);
    // pages of 2 selections, 2 interactions per statement: several statements and pages, the same outcome
    const res = await pruneSelectionInteractions(now, undefined, { PRUNE_BATCH: 2, SELECTION_PAGE: 2 });
    expect(res.deleted).toBeGreaterThanOrEqual(7);
    expect(await interactionsOf(busy)).toBe(0);
  });

  it('[S13-F9] selection_interactions: the prune runs daily in the maintenance pool, ≤ 5,000 rows per statement', () => {
    expect(presentationsJobs.pruneInteractions.pool).toBe('maintenance');
    expect(presentationsJobs.pruneInteractions.spec.every).toBe(24 * 60 * 60_000);
    expect(INTERACTION_RETENTION.PRUNE_BATCH).toBeLessThanOrEqual(5_000);
  });

  it('[S13-F9] selection_interactions: both statements EXPLAIN as index scans (20k selections, 20k interactions)', async () => {
    const before = monthsAgo(Date.now(), 12);
    const [page] = await captureSql((tx) =>
      repo.endedSelectionsPage(tx, before, { id: newId(), endedAt: '2020-01-01T00:00:00.000000Z' }, 500),
    );
    const [del] = await captureSql((tx) => repo.pruneInteractionsOf(tx, [newId(), newId(), newId()], 5_000));
    const plans = await withAdminRollback(['selections', 'selection_interactions'], async (q) => {
      await q('set local session_replication_role = replica');
      // mostly live selections (no expiry, or one ahead), a few hundred ended long ago
      await q(
        `insert into selections (id, agency_id, created_by, title, locale, token_hash, token_hint, expires_at, revoked_at)
         select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'Plan', 'en', 'plan-' || g, 'abcd',
                case when g <= 200 then now() - interval '14 months' when g % 3 = 0 then now() + interval '30 days' end,
                case when g between 201 and 300 then now() - interval '13 months' end
           from generate_series(1, 20000) g`,
      );
      await q(
        `insert into selection_interactions (id, agency_id, selection_id, kind)
         select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'VIEW' from generate_series(1, 20000) g`,
      );
      await q('analyze selections');
      await q('analyze selection_interactions');
      await q('set local role app_system');
      return {
        page: await explainNodes(q, page as NonNullable<typeof page>),
        del: await explainNodes(q, del as NonNullable<typeof del>),
      };
    });
    expect(seqScans(plans.page, 'selections'), describePlan(plans.page)).toBe(false);
    expect(indexScans(plans.page, 'selections_ended_idx'), describePlan(plans.page)).not.toHaveLength(0);
    expect(seqScans(plans.del, 'selection_interactions'), describePlan(plans.del)).toBe(false);
    expect(indexScans(plans.del, 'selection_interactions_selection_idx'), describePlan(plans.del)).not.toHaveLength(0);
  });
});
