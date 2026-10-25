import { ListNotificationsQuery, type NotificationPush } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import type { UserEvent } from '@inmolink/platform/cache';
import {
  closeEmail,
  configureEmail,
  createMemoryMailer,
  EmailSendError,
  type MemoryMailer,
} from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as notifications from '../index';

/**
 * Notifications (S11-04): raised in the emitter's transaction for colleagues, per-type/channel preferences, the feed
 * and unread count under RLS (recipient only), the live push of unread in-app ones, and the 5-minute e-mail digest
 * of what stays unread.
 */

const RUN = newId().slice(-8).toLowerCase();
let a: Founder;
let b: Founder;
let agent: Founder;
let mail: MemoryMailer;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const feed = (m: Founder, q: { unread?: 'true' } = {}) =>
  as(m, (ctx) => notifications.listNotifications(ctx, ListNotificationsQuery.parse({ limit: 100, ...q })));
const subject = (name: string) => `${name} ${RUN}`;
/** A digest run once the 5-minute delay has passed for everything raised so far. */
const digest = (m: Founder) =>
  notifications.sendDigest(
    { agencyId: m.agencyId, userId: m.userId },
    { now: new Date(Date.now() + notifications.DIGEST_DELAY_MS + 1_000) },
  );
/** The feed's key of each of `ids` (what a client sends back to mark them read). */
async function keysOf(ids: readonly string[]) {
  const rows = await adminQuery<{ id: string; created_at: Date }>(
    'select id, created_at from notifications where id = any($1::uuid[])',
    [ids],
  );
  return rows.map((r) => ({ id: r.id, createdAt: new Date(r.created_at).toISOString() }));
}
/** The digests sent to `to` that mention `needle`. */
const digestsTo = (to: string, needle: string) => mail.sent.filter((m) => m.to === to && m.text.includes(needle));
const mine = (page: Awaited<ReturnType<typeof feed>>, needle: string) =>
  page.items.filter((n) => String(n.params.subject ?? '').includes(needle));

async function addMember(agencyId: string, role: string, name: string): Promise<Founder> {
  const userId = newId();
  const email = `notif-${name.toLowerCase()}-${userId}@example.com`;
  await withSystem('notifications.test', async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${userId}, ${email}, 'x', ${name}, 'en', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${agencyId}, ${userId}, ${role}, ${name}, ${email})`);
  });
  return { userId, agencyId, email, password: 'x' };
}

/** This run's `notifications.notification.created` events of `agencyId`, oldest first. */
async function createdEvents(agencyId: string) {
  return adminQuery<{
    id: string;
    payload: { items: { id: string; userId: string; inApp: boolean; email: boolean }[] };
  }>(
    `select id, payload from outbox_events where agency_id = $1 and type = 'notifications.notification.created'
      order by created_at, id`,
    [agencyId],
  );
}

beforeAll(async () => {
  await setupTestDb('worker');
  mail = createMemoryMailer();
  await configureEmail(mail);
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  agent = await addMember(a.agencyId, 'AGENT', 'Agent');
});

afterAll(async () => {
  await closeEmail();
  await closeDb();
});

describe('notifications', () => {
  it('[S11-04] disabling a notification type stops both in-app and email for that type', async () => {
    const off = await as(agent, (ctx) =>
      notifications.updateNotificationPreference(ctx, 'CHAT_MESSAGE', { enabled: false }),
    );
    expect(off).toEqual({ type: 'CHAT_MESSAGE', enabled: false, inApp: true, email: true });

    const muted = subject('muted chat');
    const kept = subject('kept lead');
    const raised = await as(a, async (ctx) => [
      await notifications.notify(ctx, { type: 'CHAT_MESSAGE', userIds: [agent.userId], params: { subject: muted } }),
      await notifications.notify(ctx, { type: 'LEAD_ASSIGNED', userIds: [agent.userId], params: { subject: kept } }),
    ]);
    // the disabled type raises nothing for the member: no row, so nothing in the feed, nothing pushed, nothing mailed
    expect(raised[0]?.notified).toEqual([]);
    expect(raised[1]?.notified).toHaveLength(1);

    const page = await feed(agent);
    expect(mine(page, muted)).toHaveLength(0);
    expect(mine(page, kept)).toHaveLength(1);

    // no row at all: nothing to push (pushRealtime loads rows) and nothing waiting for the digest
    const rows = await adminQuery<{ n: number }>(
      "select count(*)::int as n from notifications where user_id = $1 and params->>'subject' = $2",
      [agent.userId, muted],
    );
    expect(rows[0]?.n).toBe(0);

    await digest(agent);
    expect(digestsTo(agent.email, muted)).toHaveLength(0);
    expect(digestsTo(agent.email, kept)).toHaveLength(1);

    // turned back on, the type is delivered again
    await as(agent, (ctx) => notifications.updateNotificationPreference(ctx, 'CHAT_MESSAGE', { enabled: true }));
    const back = await as(a, (ctx) =>
      notifications.notify(ctx, { type: 'CHAT_MESSAGE', userIds: [agent.userId], params: { subject: muted } }),
    );
    expect(back.notified).toHaveLength(1);
  });

  it('[S11-04] turning a type off also stops its e-mails still waiting for the digest (in-app ones stay read-able)', async () => {
    const s = subject('waiting viewing');
    await as(a, (ctx) =>
      notifications.notify(ctx, { type: 'VIEWING_REQUESTED', userIds: [agent.userId], params: { subject: s } }),
    );
    await as(agent, (ctx) => notifications.updateNotificationPreference(ctx, 'VIEWING_REQUESTED', { enabled: false }));
    // (the digest may still carry this member's other waiting notifications: only this one must be absent)
    await digest(agent);
    expect(digestsTo(agent.email, s)).toHaveLength(0);
    expect(mine(await feed(agent), s)).toHaveLength(1);
    await as(agent, (ctx) => notifications.updateNotificationPreference(ctx, 'VIEWING_REQUESTED', { enabled: true }));
  });

  it('[S11-04] channels per type: e-mail only never shows in-app; in-app only is never mailed', async () => {
    const emailOnly = subject('email only');
    const appOnly = subject('app only');
    await as(agent, async (ctx) => {
      await notifications.updateNotificationPreference(ctx, 'NETWORK_POST', { inApp: false });
      await notifications.updateNotificationPreference(ctx, 'TASK_DUE', { email: false });
    });
    await as(a, async (ctx) => {
      await notifications.notify(ctx, {
        type: 'NETWORK_POST',
        userIds: [agent.userId],
        params: { subject: emailOnly },
      });
      await notifications.notify(ctx, { type: 'TASK_DUE', userIds: [agent.userId], params: { subject: appOnly } });
    });
    const page = await feed(agent);
    expect(mine(page, emailOnly)).toHaveLength(0);
    expect(mine(page, appOnly)).toHaveLength(1);
    await digest(agent);
    expect(digestsTo(agent.email, emailOnly)).toHaveLength(1);
    expect(digestsTo(agent.email, appOnly)).toHaveLength(0);
    const prefs = await as(agent, (ctx) => notifications.getNotificationPreferences(ctx));
    expect(prefs.items.find((p) => p.type === 'NETWORK_POST')).toEqual({
      type: 'NETWORK_POST',
      enabled: true,
      inApp: false,
      email: true,
    });
    expect(prefs.items.find((p) => p.type === 'LEAD_ASSIGNED')).toEqual({
      type: 'LEAD_ASSIGNED',
      enabled: true,
      inApp: true,
      email: true,
    });
  });

  it('[S12-F2] an in-app-only notification for a member with in-app off and e-mail on writes no row', async () => {
    const s = subject('in-app only, in-app off');
    await as(agent, (ctx) =>
      notifications.updateNotificationPreference(ctx, 'IMPORT_PAUSED', { inApp: false, email: true }),
    );
    const one = await as(a, (ctx) =>
      notifications.notify(ctx, {
        type: 'IMPORT_PAUSED',
        userIds: [agent.userId],
        params: { subject: s },
        inAppOnly: true,
      }),
    );
    const across = await withSystem('notifications.test', (tx) =>
      notifications.raiseNotificationsAcross(tx, 'IMPORT_PAUSED', [
        { agencyId: a.agencyId, userIds: [agent.userId], params: { subject: s }, inAppOnly: true },
      ]),
    );
    expect(one.notified).toEqual([]);
    expect(across.notified).toEqual([]);
    const rows = await adminQuery<{ n: number }>(
      `select count(*)::int as n from notifications where agency_id = $1 and params->>'subject' = $2`,
      [a.agencyId, s],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('[S11-04] unread counts, mark read; what was read in-app is not mailed', async () => {
    const before = await as(agent, (ctx) => notifications.getUnreadCount(ctx));
    const read = subject('read in app');
    const unread = subject('still unread');
    await as(a, async (ctx) => {
      await notifications.notify(ctx, { type: 'LEAD_ASSIGNED', userIds: [agent.userId], params: { subject: read } });
      await notifications.notify(ctx, { type: 'LEAD_ASSIGNED', userIds: [agent.userId], params: { subject: unread } });
    });
    const after = await as(agent, (ctx) => notifications.getUnreadCount(ctx));
    expect(after.count).toBe(Math.min(99, before.count + 2));
    const target = mine(await feed(agent, { unread: 'true' }), read);
    expect(target).toHaveLength(1);
    const marked = await as(agent, (ctx) =>
      notifications.markNotificationsRead(ctx, {
        items: target.map((n) => ({ id: n.id, createdAt: n.createdAt })),
      }),
    );
    expect(marked.updated).toBe(1);
    expect(marked.unread.count).toBe(after.count - 1);
    expect(mine(await feed(agent, { unread: 'true' }), read)).toHaveLength(0);

    await digest(agent);
    expect(digestsTo(agent.email, read)).toHaveLength(0);
    expect(digestsTo(agent.email, unread)).toHaveLength(1);

    let all = await as(agent, (ctx) => notifications.markAllNotificationsRead(ctx));
    while (all.more) all = await as(agent, (ctx) => notifications.markAllNotificationsRead(ctx));
    expect(all.unread).toEqual({ count: 0, capped: false });
  });

  it('[S11-04] a member reads only their own notifications — colleagues and other agencies see and mark none', async () => {
    const s = subject('private to agent');
    const { notified } = await as(a, (ctx) =>
      notifications.notify(ctx, { type: 'LEAD_ASSIGNED', userIds: [agent.userId, a.userId], params: { subject: s } }),
    );
    // the actor is never notified of their own action
    expect(notified.map((n) => n.userId)).toEqual([agent.userId]);
    const id = (notified[0] as { notificationId: string }).notificationId;
    expect(mine(await feed(a), s)).toHaveLength(0);
    expect(mine(await feed(b), s)).toHaveLength(0);
    const items = await keysOf([id]);
    expect((await as(a, (ctx) => notifications.markNotificationsRead(ctx, { items }))).updated).toBe(0);
    expect((await as(b, (ctx) => notifications.markNotificationsRead(ctx, { items }))).updated).toBe(0);
    // RLS too, not only the service's filter: a colleague's statement that names no column changes none of them
    await as(a, async (ctx) => {
      const res = await ctx.tx.execute(sql`update notifications set read_at = now()`);
      expect(res.rowCount).toBe(0);
      const del = await ctx.tx.execute(sql`delete from notifications`);
      expect(del.rowCount).toBe(0);
    });
    expect(mine(await feed(agent, { unread: 'true' }), s)).toHaveLength(1);
    // members of other agencies are not recipients of this agency's notifications
    const cross = await as(a, (ctx) =>
      notifications.notify(ctx, { type: 'LEAD_ASSIGNED', userIds: [b.userId], params: { subject: s } }),
    );
    expect(cross.notified).toEqual([]);
  });

  it('[S11-04] the live push goes to each recipient only, with the notification; read ones are not pushed', async () => {
    const colleague = await addMember(a.agencyId, 'AGENT', 'Colleague');
    const s = subject('pushed');
    const { notified } = await as(a, (ctx) =>
      notifications.notify(ctx, {
        type: 'VIEWING_UPDATED',
        userIds: [agent.userId, colleague.userId],
        params: { subject: s },
        link: '/mls/viewings/1',
      }),
    );
    const [event] = (await createdEvents(a.agencyId)).filter((e) =>
      e.payload.items.some((i) => i.id === notified[0]?.notificationId),
    );
    expect(event?.payload.items.map((i) => [i.userId, i.inApp, i.email]).sort()).toEqual(
      [
        [agent.userId, true, true],
        [colleague.userId, true, true],
      ].sort(),
    );
    const stored = await adminQuery<{ id: string; created_at: Date }>(
      'select id, created_at from notifications where id = any($1::uuid[])',
      [notified.map((n) => n.notificationId)],
    );
    const items = stored.map((r) => ({ id: r.id, at: new Date(r.created_at).getTime() }));
    // the colleague read it already: only the agent's is pushed
    await as(colleague, (ctx) =>
      notifications.markNotificationsRead(ctx, {
        items: items
          .filter((i) => notified.some((n) => n.userId === colleague.userId && n.notificationId === i.id))
          .map((i) => ({ id: i.id, createdAt: new Date(i.at).toISOString() })),
      }),
    );
    const pushed: UserEvent[] = [];
    const result = await notifications.pushNotifications({ agencyId: a.agencyId, items }, async (evs) => {
      pushed.push(...evs);
    });
    expect(result.pushed).toBe(1);
    expect(pushed).toHaveLength(1);
    const push = pushed[0] as UserEvent;
    expect(push.userId).toBe(agent.userId);
    expect(push.agencyId).toBe(a.agencyId);
    expect(push.namespace).toBe('/notifications');
    expect(push.event).toBe('notification');
    const data = push.data as NotificationPush;
    expect(data.agencyId).toBe(a.agencyId);
    expect(data.notification).toMatchObject({
      type: 'VIEWING_UPDATED',
      params: { subject: s },
      link: '/mls/viewings/1',
    });
  });

  it('[S11-04] the outbox event queues the push and one throttled digest per recipient waiting for e-mail', async () => {
    notifications.registerNotificationsSubscriptions();
    const push = vi.spyOn(notifications.notificationsJobs.pushRealtime, 'enqueue').mockResolvedValue({ id: 'x' });
    const digest = vi.spyOn(notifications.notificationsJobs.sendDigest, 'enqueueMany').mockResolvedValue([]);
    try {
      const payload = {
        agencyId: a.agencyId,
        items: [
          { id: newId(), userId: agent.userId, at: Date.now(), inApp: true, email: false },
          { id: newId(), userId: a.userId, at: Date.now(), inApp: false, email: true },
        ],
      };
      const meta = {
        eventId: newId(),
        agencyId: a.agencyId,
        type: 'notifications.notification.created',
        version: 1,
        createdAt: new Date(),
        attempt: 1,
      };
      for (const sub of defaultSubscribers.get('notifications.notification.created', 1)) {
        await sub.handler(sub.def.schema.parse(payload), meta);
      }
      expect(push).toHaveBeenCalledWith({
        eventId: meta.eventId,
        agencyId: a.agencyId,
        items: [{ id: payload.items[0]?.id, at: payload.items[0]?.at }],
      });
      expect(digest).toHaveBeenCalledWith([
        { payload: { agencyId: a.agencyId, userId: a.userId }, options: { throttleMs: notifications.DIGEST_DELAY_MS } },
      ]);
    } finally {
      push.mockRestore();
      digest.mockRestore();
      notifications.unregisterNotificationsSubscriptions();
    }
  });

  it('[S11-04] the digest is sent once when its job runs twice at once; a send known to have failed is retried', async () => {
    const s = subject('digest once');
    await as(a, (ctx) =>
      notifications.notify(ctx, { type: 'LEAD_ASSIGNED', userIds: [agent.userId], params: { subject: s } }),
    );
    const fail = vi.spyOn(mail, 'send').mockRejectedValueOnce(new EmailSendError('refused', { notSent: true }));
    await expect(digest(agent)).rejects.toThrow('refused');
    fail.mockRestore();
    expect(digestsTo(agent.email, s)).toHaveLength(0);
    const runs = await Promise.all([digest(agent), digest(agent)]);
    expect(runs.filter((r) => r.sent)).toHaveLength(1);
    expect(digestsTo(agent.email, s)).toHaveLength(1);
    expect(digestsTo(agent.email, s)[0]?.tag).toBe('notifications.digest');
  });

  it('[S11-04] a worker raising from an event is idempotent (sourceKey + time); recipients in another agency', async () => {
    const eventId = newId();
    const at = new Date();
    const s = subject('cross agency');
    const raise = () =>
      withSystem('notifications.test raise', (tx) =>
        notifications.raiseNotifications(tx, {
          agencyId: b.agencyId,
          actorUserId: agent.userId,
          type: 'VIEWING_REQUESTED',
          userIds: [b.userId],
          params: { subject: s, actor: 'Agent' },
          sourceKey: eventId,
          at,
        }),
      );
    const first = await raise();
    expect(first.notified).toHaveLength(1);
    // the redelivery inserts nothing, so it announces nothing: no second event, no push, no digest
    expect((await raise()).notified).toEqual([]);
    const rows = await adminQuery<{ n: number }>(
      'select count(*)::int as n from notifications where agency_id = $1 and source_key = $2',
      [b.agencyId, eventId],
    );
    expect(rows[0]?.n).toBe(1);
    const [row] = mine(await feed(b), s);
    // the actor is agency A's member: not named in agency B's notification (params.actor is)
    expect(row?.actorUserId).toBeNull();
    const events = (await createdEvents(b.agencyId)).filter((e) =>
      e.payload.items.some((i) => i.id === first.notified[0]?.notificationId),
    );
    expect(events).toHaveLength(1);
    await expect(
      withSystem('notifications.test raise', (tx) =>
        notifications.raiseNotifications(tx, {
          agencyId: b.agencyId,
          type: 'VIEWING_REQUESTED',
          userIds: [b.userId],
          sourceKey: eventId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('[S11-04] the digest waits 5 minutes: a notification younger than that is mailed by a later run', async () => {
    const s = subject('young one');
    await as(a, (ctx) =>
      notifications.notify(ctx, { type: 'LEAD_ASSIGNED', userIds: [agent.userId], params: { subject: s } }),
    );
    const early = await notifications.sendDigest({ agencyId: a.agencyId, userId: agent.userId }, { now: new Date() });
    expect(digestsTo(agent.email, s)).toHaveLength(0);
    expect(early.retryInMs).not.toBeNull();
    expect(early.retryInMs).toBeLessThanOrEqual(notifications.DIGEST_DELAY_MS);
    await digest(agent);
    expect(digestsTo(agent.email, s)).toHaveLength(1);
  });

  it('[S11-04] mark all read takes at most 500 per call and says when more remain', async () => {
    const reader = await addMember(a.agencyId, 'AGENT', 'Reader');
    const at = new Date();
    await withSystem('notifications.test seed', (tx) =>
      tx.execute(sql`insert into notifications (id, agency_id, created_at, user_id, type)
        select gen_random_uuid(), ${a.agencyId}, date_trunc('milliseconds', ${at.toISOString()}::timestamptz - make_interval(secs => g), 'UTC'),
               ${reader.userId}, 'LEAD_ASSIGNED'
          from generate_series(1, 501) g`),
    );
    const first = await as(reader, (ctx) => notifications.markAllNotificationsRead(ctx));
    expect(first).toMatchObject({ updated: 500, more: true, unread: { count: 1, capped: false } });
    const second = await as(reader, (ctx) => notifications.markAllNotificationsRead(ctx));
    expect(second).toMatchObject({ updated: 1, more: false, unread: { count: 0, capped: false } });
  });

  it('[S11-04] a colleague’s preferences are read (to raise for them), and the service writes only the caller’s', async () => {
    await as(agent, (ctx) => notifications.updateNotificationPreference(ctx, 'TASK_DUE', { inApp: true, email: true }));
    await as(a, async (ctx) => {
      const seen = await ctx.tx.execute(
        sql`select 1 from notification_preferences where user_id = ${agent.userId} and type = 'TASK_DUE'`,
      );
      expect(seen.rows).toHaveLength(1);
    });
    await as(a, (ctx) => notifications.updateNotificationPreference(ctx, 'TASK_DUE', { enabled: false }));
    const agents = await as(agent, (ctx) => notifications.getNotificationPreferences(ctx));
    expect(agents.items.find((p) => p.type === 'TASK_DUE')?.enabled).toBe(true);
    await as(a, (ctx) => notifications.updateNotificationPreference(ctx, 'TASK_DUE', { enabled: true }));
  });

  it('[S11-04] partitions: monthly, premade, kept 12 months then dropped', async () => {
    const [cfg] = await adminQuery<{
      partition_interval: string;
      premake: number;
      infinite_time_partitions: boolean;
      retention: string;
      retention_keep_table: boolean;
      inherit_privileges: boolean;
    }>(
      `select partition_interval, premake, infinite_time_partitions, retention, retention_keep_table, inherit_privileges
         from partman.part_config where parent_table = 'public.notifications'`,
    );
    expect(cfg).toMatchObject({
      premake: 4,
      infinite_time_partitions: true,
      retention: '12 months',
      retention_keep_table: false,
      inherit_privileges: false,
    });
    expect(cfg?.partition_interval).toMatch(/^(1 mon|1 month|mon)$/);
  });

  it('[S11-04] budgets: the feed is one statement, the unread count one, a notify four', async () => {
    const setup = await countQueries(() => as(agent, async () => null));
    expect((await countQueries(() => feed(agent))) - setup).toBe(1);
    expect((await countQueries(() => as(agent, (ctx) => notifications.getUnreadCount(ctx)))) - setup).toBe(1);
    const n = await countQueries(() =>
      as(a, (ctx) =>
        notifications.notify(ctx, {
          type: 'LEAD_ASSIGNED',
          userIds: [agent.userId],
          params: { subject: subject('budget') },
        }),
      ),
    );
    // members, preferences, insert, event
    expect(n - setup).toBeLessThanOrEqual(4);
  });

  it('[S11-04] invalid input from an emitter is refused (link outside the app, unknown type, too many params)', async () => {
    const bad = [
      { type: 'LEAD_ASSIGNED', userIds: [agent.userId], link: 'https://evil.example/x' },
      { type: 'LEAD_ASSIGNED', userIds: [agent.userId], link: '//evil.example/x' },
      { type: 'NOT_A_TYPE', userIds: [agent.userId] },
      {
        type: 'LEAD_ASSIGNED',
        userIds: [agent.userId],
        params: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v'])),
      },
      { type: 'LEAD_ASSIGNED', userIds: [agent.userId], params: { subject: 'buyer jane@example.com' } },
      { type: 'LEAD_ASSIGNED', userIds: [agent.userId], params: { subject: 'call +34 600 123 456' } },
    ];
    for (const input of bad) {
      await expect(
        as(a, (ctx) => notifications.notify(ctx, input as Parameters<typeof notifications.notify>[1])),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});
