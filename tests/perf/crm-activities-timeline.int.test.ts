import { performance } from 'node:perf_hooks';
import { CreateContactBody, type ListActivitiesInput, ListActivitiesQuery } from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * S10-04 budget, timed here (S12-F19: wall-clock budgets run in the perf project, not the int run, which keeps the
 * keyset walk and query counts in packages/core/src/modules/crm/__tests__/activities.int.test.ts): a contact with
 * 5,000 activities loads its first timeline page, and the pages 40 deep, at p95 < 300 ms (the dashboard budget: p95 of 10
 * first-page loads, p95 of the 40 deeper pages; one page's outlier on a busy machine is not the budget).
 */

const SEEDED = 5_000;
const RUN = newId().slice(-8).toLowerCase();
let a: Founder;

const timeline = (q: ListActivitiesInput) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, (ctx) =>
    crm.listActivities(ctx, ListActivitiesQuery.parse(q)),
  );

beforeAll(async () => {
  await setupTestDb('worker');
  a = await createFounder();
}, 180_000);

afterAll(async () => {
  await closeDb();
});

it('[S10-04] timeline for a contact with 5,000 activities loads first page in < 300 ms (keyset)', async () => {
  const { contact } = await withMemberCtx(
    { userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' },
    (ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Busy', emails: [`busy-${RUN}@example.com`] })),
  );
  // 5,000 activities over the last 25 days (two monthly partitions at most), every type a member logs
  await withSystem('perf.crm-activities.seed', async (tx) => {
    await tx.execute(sql`
      insert into activities (id, agency_id, occurred_at, type, contact_id, body)
      select gen_random_uuid(), ${a.agencyId},
             date_trunc('milliseconds', now() - g * interval '7 minutes', 'UTC'),
             (array['CALL', 'EMAIL', 'MEETING', 'VIEWING', 'OTHER'])[1 + g % 5], ${contact.id}, 'seeded'
      from generate_series(1, ${SEEDED}) g`);
    await tx.execute(sql`analyze activities`);
  });

  // warm the connection and the plan cache once, then time the first page (p95 of 10) and 40 pages down
  await timeline({ subject: 'CONTACT', subjectId: contact.id, limit: 50 });
  const firstTimes: number[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const first = await timeline({ subject: 'CONTACT', subjectId: contact.id, limit: 50 });
    firstTimes.push(performance.now() - t0);
    cursor = first.nextCursor;
  }
  firstTimes.sort((x, y) => x - y);
  const pageTimes: number[] = [];
  for (let p = 0; p < 40 && cursor; p++) {
    const t0 = performance.now();
    const page = await timeline({ subject: 'CONTACT', subjectId: contact.id, limit: 50, cursor });
    pageTimes.push(performance.now() - t0);
    cursor = page.nextCursor;
  }
  const sorted = [...pageTimes].sort((x, y) => x - y);
  const deepP95 = sorted[Math.ceil(0.95 * sorted.length) - 1] as number;
  console.info(
    `[S10-04] timeline, ${SEEDED} activities: first page p95 ${firstTimes[9]?.toFixed(1)} ms; ` +
      `${pageTimes.length} deeper pages p95 ${deepP95.toFixed(1)} ms, max ${sorted.at(-1)?.toFixed(1)} ms`,
  );
  expect(pageTimes).toHaveLength(40);
  expect(firstTimes[9]).toBeLessThan(300);
  expect(deepP95).toBeLessThan(300);
});
