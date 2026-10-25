import { closeDb, withSystem } from '@inmolink/db';
import { adminQuery, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import { captureSql, describePlan, explainNodes, indexScans, seqScans } from '../../../testing/query-plan';
import { POST_RETENTION, pruneFinishedPosts, socialJobs } from '../index';
import * as repo from '../repo';

/**
 * Social post retention (S13-F9) on the real test database: PUBLISHED and FAILED posts last changed more than 12
 * months ago are deleted; recent ones, and drafts, scheduled and cancelled posts of any age, stay. The delete reads
 * `social_posts_finished_idx`, never the whole table. The posts are planted without their listing and account (FK
 * triggers off on a superuser connection) and removed after the file.
 */

let f: Founder;
const planted: string[] = [];
const DAY = 86_400_000;

beforeAll(async () => {
  await setupTestDb('worker');
  f = await createFounder();
}, 120_000);
afterAll(async () => {
  if (planted.length) await adminQuery('delete from social_posts where id = any($1::uuid[])', [planted]);
  await closeDb();
});

const monthsAgo = (nowMs: number, months: number, plusMs = 0) => {
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() - months);
  return new Date(d.getTime() + plusMs);
};

async function post(status: string, updatedAt: Date): Promise<string> {
  const id = newId();
  planted.push(id);
  const at = updatedAt.toISOString();
  // a scheduled post is not due (the publish sweep of other suites must not claim it)
  const scheduled = status === 'SCHEDULED' ? `now() + interval '30 days'` : 'null';
  await adminQuery(`begin;
    set local session_replication_role = replica;
    insert into social_posts (id, agency_id, account_id, listing_id, status, locale, media_ids, scheduled_at,
                              created_by, created_at, updated_at)
    values ('${id}', '${f.agencyId}', '${newId()}', '${newId()}', '${status}', 'en', '{${newId()}}', ${scheduled},
            '${f.userId}', '${at}'::timestamptz, '${at}'::timestamptz);
    commit;`);
  return id;
}

const present = async (ids: string[]) =>
  (
    await withSystem('social.retention.test', (tx) =>
      tx.execute<{ id: string }>(sql`select id from social_posts where id = any(${`{${ids.join(',')}}`}::uuid[])`),
    )
  ).rows
    .map((r) => r.id)
    .sort();

describe('social post retention', () => {
  it('[S13-F9] social_posts: PUBLISHED and FAILED posts past 12 months are deleted; recent and unfinished stay', async () => {
    const now = Date.now();
    const oldPublished = await post('PUBLISHED', monthsAgo(now, POST_RETENTION.MONTHS, -DAY));
    const oldFailed = await post('FAILED', monthsAgo(now, 18));
    const oldDraft = await post('DRAFT', monthsAgo(now, 18));
    const oldScheduled = await post('SCHEDULED', monthsAgo(now, 18));
    const oldCancelled = await post('CANCELLED', monthsAgo(now, 18));
    const recentPublished = await post('PUBLISHED', monthsAgo(now, POST_RETENTION.MONTHS, DAY));
    const recentFailed = await post('FAILED', new Date(now - 7 * DAY));

    const res = await pruneFinishedPosts(now);
    expect(res.deleted).toBeGreaterThanOrEqual(2);
    expect(
      await present([oldPublished, oldFailed, oldDraft, oldScheduled, oldCancelled, recentPublished, recentFailed]),
    ).toEqual([oldDraft, oldScheduled, oldCancelled, recentPublished, recentFailed].sort());
    // idempotent
    expect((await pruneFinishedPosts(now)).deleted).toBe(0);
  });

  it('[S13-F9] social_posts: the prune runs daily in the maintenance pool, ≤ 5,000 rows per statement', () => {
    expect(socialJobs.pruneFinishedPosts.pool).toBe('maintenance');
    expect(socialJobs.pruneFinishedPosts.spec.every).toBe(24 * 60 * 60_000);
    expect(POST_RETENTION.PRUNE_BATCH).toBeLessThanOrEqual(5_000);
  });

  it('[S13-F9] social_posts: the delete EXPLAINs as an index scan of social_posts_finished_idx (20k posts)', async () => {
    const [statement] = await captureSql((tx) =>
      repo.pruneFinishedPosts(tx, monthsAgo(Date.now(), 12), POST_RETENTION.PRUNE_BATCH),
    );
    const nodes = await withAdminRollback(['social_posts'], async (q) => {
      await q('set local session_replication_role = replica');
      await q(
        `insert into social_posts (id, agency_id, account_id, listing_id, status, locale, media_ids, scheduled_at,
                                   created_by, created_at, updated_at)
         select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), s.status, 'en',
                array[gen_random_uuid()], case when s.status = 'SCHEDULED' then now() + interval '1 day' end,
                gen_random_uuid(), s.at, s.at
           from (select (array['PUBLISHED', 'PUBLISHED', 'FAILED', 'DRAFT', 'SCHEDULED'])[1 + g % 5]::social_post_status
                          as status,
                        case when g <= 200 then now() - interval '13 months' - (g || ' hours')::interval
                             else now() - ((g % 360) || ' days')::interval end as at
                   from generate_series(1, 20000) g) s`,
      );
      await q('analyze social_posts');
      await q('set local role app_system');
      return explainNodes(q, statement as NonNullable<typeof statement>);
    });
    expect(seqScans(nodes, 'social_posts'), describePlan(nodes)).toBe(false);
    expect(indexScans(nodes, 'social_posts_finished_idx'), describePlan(nodes)).not.toHaveLength(0);
  });
});
