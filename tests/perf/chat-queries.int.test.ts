import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, type Tx, withSystem, withTenant } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inboxQuery, listMessagesQuery, participantsAcrossQuery } from '../../packages/core/src/modules/chat/repo';
import { markLinkReadStatement } from '../../packages/core/src/modules/notifications/repo';

/**
 * Chat statements at scale (S11-03): one member in 5,000 threads among 50,000 participant rows of the agency, a thread
 * with 50,000 messages among 100,000, and 20,000 notifications of the member (300 unread) among 120,000. Explained as the request role under RLS
 * (the history as a participant: the messages' `exists` policy), the fan-out read as the worker (app_system). Rows are
 * seeded with triggers off (replica role), analysed, and deleted afterwards.
 */

const THREADS = 5_000;
const OTHER_PARTICIPANTS = 45_000;
const MESSAGES = 50_000;
const OTHER_MESSAGES = 50_000;
const NOTIFICATIONS = 20_000;
/** The member's unread ones (the rest read, as a feed is), and other members' notifications in the same months. */
const UNREAD = 300;
const OTHER_NOTIFICATIONS = 100_000;
const LIMIT = 25;
let a: Founder;
let bigThread = '';
const RUN = newId().slice(-8);

beforeAll(async () => {
  await setupTestDb('worker');
  a = await createFounder();
  const A = a.agencyId;
  const U = a.userId;
  await adminQuery(`begin; set local session_replication_role = replica;
    insert into chat_threads (agency_id, id, kind, created_at, last_message_at)
    select '${A}', gen_random_uuid(), 'DIRECT', now() - interval '90 days', now() - (g * interval '1 minute')
      from generate_series(1, ${THREADS}) g;
    insert into chat_participants (agency_id, thread_id, user_id, last_message_at)
    select agency_id, id, '${U}', last_message_at from chat_threads where agency_id = '${A}';
    insert into chat_participants (agency_id, thread_id, user_id, last_message_at)
    select t.agency_id, t.id, gen_random_uuid(), t.last_message_at
      from chat_threads t, generate_series(1, ${OTHER_PARTICIPANTS / THREADS}) g where t.agency_id = '${A}';
    commit;`);
  const [big, other] = await adminQuery<{ id: string }>(
    `select id from chat_threads where agency_id = '${A}' order by last_message_at desc limit 2`,
  );
  bigThread = big?.id as string;
  await adminQuery(`begin; set local session_replication_role = replica;
    insert into chat_messages (agency_id, id, thread_id, sender_agency_id, sender_user_id, sender_name, body, created_at)
    select '${A}', gen_random_uuid(), '${bigThread}', '${A}', '${U}', 'Ana', 'message ' || g,
           now() - (g * interval '1 second') from generate_series(1, ${MESSAGES}) g;
    insert into chat_messages (agency_id, id, thread_id, sender_agency_id, sender_user_id, sender_name, body, created_at)
    select '${A}', gen_random_uuid(), '${other?.id}', '${A}', gen_random_uuid(), 'Bea', 'other ' || g,
           now() - (g * interval '1 second') from generate_series(1, ${OTHER_MESSAGES}) g;
    insert into notifications (id, agency_id, user_id, created_at, type, params, link, in_app, email_pending, read_at)
    select gen_random_uuid(), '${A}', '${U}', date_trunc('milliseconds', now() - (g * interval '1 minute'), 'UTC'),
           'CHAT_MESSAGE', '{}'::jsonb, '/chat/' || '${RUN}-' || (g % 500), true, g <= ${UNREAD} and g % 3 = 0,
           case when g <= ${UNREAD} then null else now() end
      from generate_series(1, ${NOTIFICATIONS}) g;
    insert into notifications (id, agency_id, user_id, created_at, type, params, link, in_app, email_pending)
    select gen_random_uuid(), '${A}', gen_random_uuid(), date_trunc('milliseconds', now() - (g * interval '10 seconds'), 'UTC'),
           'CHAT_MESSAGE', '{}'::jsonb, '/chat/' || '${RUN}-' || (g % 500), true, g % 3 = 0
      from generate_series(1, ${OTHER_NOTIFICATIONS}) g;
    commit;`);
  for (const t of ['chat_threads', 'chat_participants', 'chat_messages', 'notifications']) {
    await adminQuery(`vacuum analyze ${t}`);
  }
}, 300_000);

afterAll(async () => {
  if (a) {
    await adminQuery(`begin; set local session_replication_role = replica;
      delete from chat_messages where agency_id = '${a.agencyId}';
      delete from chat_participants where agency_id = '${a.agencyId}';
      delete from chat_threads where agency_id = '${a.agencyId}';
      delete from notifications where agency_id = '${a.agencyId}';
      commit;`);
  }
  await closeDb();
}, 120_000);

class Rollback extends Error {}

/** EXPLAIN (ANALYZE, BUFFERS) of `q`, five times after a warm-up, in a rolled-back transaction; the fastest run. */
async function explain(
  run: (fn: (tx: Tx) => Promise<string>) => Promise<string>,
  q: (tx: Tx) => SQL | { getSQL(): SQL },
) {
  const once = () =>
    run(async (tx) => {
      const res = await tx.execute(sql`explain (analyze, buffers) ${q(tx)}`);
      return (res.rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0])).join('\n');
    });
  await once();
  const out: { plan: string; ms: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const plan = await once();
    out.push({ plan, ms: Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1]) });
  }
  return out.reduce((x, y) => (x.ms <= y.ms ? x : y));
}

/** As the member (app_user, RLS), rolled back. */
const asMember = (fn: (tx: Tx) => Promise<string>) =>
  withTenant({ agencyId: a.agencyId, userId: a.userId }, async (tx) => {
    const plan = await fn(tx);
    throw Object.assign(new Rollback(), { plan });
  }).catch((err: unknown) => {
    if (err instanceof Rollback) return (err as Rollback & { plan: string }).plan;
    throw err;
  });

/** Page 2's cursor: the last row of page 1 (raw time with microseconds). */
async function cursorOf(rows: { atUs: string }[], id: (r: never) => string) {
  const last = rows[LIMIT - 1] as { atUs: string };
  return { at: new Date(last.atUs), id: id(last as never), atUs: last.atUs };
}

describe('chat statements at scale', () => {
  it('[S11-03] the member’s thread list, page 2: index-ordered on chat_participants_inbox_idx, < 20 ms', async () => {
    const first = await withTenant({ agencyId: a.agencyId, userId: a.userId }, async (tx) =>
      inboxQuery(tx, a.agencyId, a.userId, { limit: LIMIT }),
    );
    const cursor = await cursorOf(first, (r: { id: string }) => r.id);
    const best = await explain(asMember, (tx) => inboxQuery(tx, a.agencyId, a.userId, { limit: LIMIT, cursor }));
    console.info(
      `chat inbox page 2 (${THREADS} threads, ${THREADS + OTHER_PARTICIPANTS} participants): ${best.ms} ms\n${best.plan}`,
    );
    expect(best.plan).toMatch(/chat_participants_inbox_idx/);
    expect(best.plan).not.toMatch(/Sort|Seq Scan/);
    expect(best.ms).toBeLessThan(20);
  }, 120_000);

  it('[S11-03] a thread’s history, page 2, as a participant (RLS exists policy): index-ordered, < 20 ms', async () => {
    const first = await withTenant({ agencyId: a.agencyId, userId: a.userId }, async (tx) =>
      listMessagesQuery(tx, a.agencyId, bigThread, { limit: LIMIT }),
    );
    const cursor = await cursorOf(first, (r: { id: string }) => r.id);
    const best = await explain(asMember, (tx) =>
      listMessagesQuery(tx, a.agencyId, bigThread, { limit: LIMIT, cursor }),
    );
    console.info(`chat history page 2 (${MESSAGES + OTHER_MESSAGES} messages): ${best.ms} ms\n${best.plan}`);
    expect(best.plan).toMatch(/chat_messages_thread_created_idx/);
    expect(best.plan).not.toMatch(/Sort|Seq Scan/);
    expect(best.ms).toBeLessThan(20);
  }, 120_000);

  it('[S11-03] the fan-out read of a thread’s participants (worker): chat_participants_thread_idx, < 20 ms', async () => {
    const best = await explain(
      (fn) => withSystem('chat.perf', fn),
      (tx) => participantsAcrossQuery(tx, bigThread, 100),
    );
    console.info(`chat participants across (${THREADS + OTHER_PARTICIPANTS} rows): ${best.ms} ms\n${best.plan}`);
    expect(best.plan).toMatch(/chat_participants_thread_idx|chat_participants_pk/);
    expect(best.plan).not.toMatch(/Seq Scan on chat_participants/);
    expect(best.ms).toBeLessThan(20);
  }, 120_000);

  it('[S11-03] a thread read marks its chat notifications read: the unread / digest indexes, < 20 ms', async () => {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const best = await explain(asMember, () =>
      markLinkReadStatement(a.agencyId, a.userId, 'CHAT_MESSAGE', `/chat/${RUN}-7`, since, 100),
    );
    console.info(
      `chat markLinkRead (${NOTIFICATIONS + OTHER_NOTIFICATIONS} notifications, ${UNREAD} unread): ${best.ms} ms\n${best.plan}`,
    );
    // the populated month is read through the unread / digest partial indexes; only empty partitions (cost < 1) are scanned
    expect(best.plan).toMatch(/Bitmap Index Scan on notifications_p\d+_agency_id_user_id/);
    const seqCosts = [...best.plan.matchAll(/Seq Scan on notifications\S* \S+ +\(cost=[\d.]+\.\.([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(seqCosts.every((c) => c < 1)).toBe(true);
    expect(best.ms).toBeLessThan(20);
  }, 120_000);
});
