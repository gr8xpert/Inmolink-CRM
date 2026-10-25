import { CreateContactBody, CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, type Tx, withSystem, withTenant } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import type { UserEvent } from '@inmolink/platform/cache';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue } from '@inmolink/platform/queue';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as crm from '../../crm';
import * as mls from '../../mls';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as chat from '../index';

/**
 * Chat (S11-03): DIRECT threads between colleagues and VIEWING threads between the two agencies of a viewing request.
 * Only participants read a thread (service: not found; RLS: no rows; the database refuses joining or writing into a
 * thread one is not part of); the other agency gets its own copy of each message; delivery publishes to every
 * participant of both agencies; one `CHAT_MESSAGE` notification per run of unread messages, read with the thread.
 */

const RUN = newId().slice(-8).toLowerCase();
const keyring = createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' });
const log = createLogger({ service: 'chat-test', level: 'silent' });
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('chat.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** `a` introduces, `b` owns the listing, `c` is a stranger; `a2`, `a3` are agents of `a`. */
let a: Founder;
let b: Founder;
let c: Founder;
let a2: Founder;
let a3: Founder;
let viewingId: string;
let registrationId: string;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
      if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    }
    return `no sqlstate: ${String(err)}`;
  }
  return undefined;
}

/** Raw SQL as `m` (app_user, RLS on). */
const asUser = <T>(m: Founder, q: ReturnType<typeof sql>) =>
  withTenant({ agencyId: m.agencyId, userId: m.userId }, async (tx) => (await tx.execute(q)).rows as T[]);

async function agent(agencyId: string, name: string): Promise<Founder> {
  const userId = newId();
  const email = `chat-${name.toLowerCase()}-${userId}@example.com`;
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${userId}, ${email}, 'x', ${name}, 'en', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${agencyId}, ${userId}, 'AGENT', ${name}, ${email})`);
  });
  return { userId, agencyId, email, password: 'x' };
}

/** A viewing request of `a`'s client for one of `b`'s listings: its id and the registration's. */
async function viewing(): Promise<{ id: string; registrationId: string }> {
  const ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `chat-${RUN}`,
      translations: name('Chatcountry'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `chat-g-${RUN}`,
      sort: 0,
      translations: name('Chathomes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `chat-v-${RUN}`,
      sort: 0,
      translations: name('Chatvilla'),
    });
    return { city, villa };
  });
  const { id: listingId } = await as(b, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 60_000_000,
        energyRating: 'B',
        commission: { type: 'PCT', basisPoints: 400, includesVat: true },
        splitBp: 5000,
      }),
    ),
  );
  await as(b, async (ctx) =>
    properties.updateListing(
      ctx,
      listingId,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, listingId)).version,
      }),
    ),
  );
  const contact = (
    await as(a, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({ firstName: 'Mara', lastName: 'Clientela', emails: [`mara-${RUN}@example.com`] }),
      ),
    )
  ).contact;
  const reg = await mls.registerClient((fn) => as(a, fn), {
    contactId: contact.id,
    target: { kind: 'LISTING', id: listingId },
  });
  const created = await as(a, (ctx) =>
    mls.requestViewing(ctx, {
      registrationId: reg.registration.id,
      proposedStartAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    }),
  );
  return { id: created.request.id, registrationId: reg.registration.id };
}

/** The outbox events of `type` for a thread, oldest first, with what a job needs. */
const events = (type: string, threadId: string) =>
  rows<{ id: string; agency_id: string; payload: Record<string, unknown>; created_at: Date }>(sql`
    select id, agency_id, payload, created_at from outbox_events
     where type = ${type} and payload ->> 'threadId' = ${threadId} order by created_at, id`);

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureQueue({ prefix: `test-chat-${RUN}`, logger: log });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  mls.configureMls({ keyring, fingerprintKey: `test-fingerprint-key-${RUN}-0123456789abcdef` });
  [a, b, c] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  for (const m of [a, b, c]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  a2 = await agent(a.agencyId, 'Bea');
  a3 = await agent(a.agencyId, 'Carla');
  ({ id: viewingId, registrationId } = await viewing());
}, 180_000);

afterAll(async () => {
  await closeRateLimit();
  await closeQueues();
  await closeDb();
});

describe('who reads a thread', () => {
  it('[S11-03] users cannot read threads they are not part of — service, RLS and the database guards', async () => {
    const thread = await as(a, (ctx) => chat.createDirectThread(ctx, { userIds: [a2.userId], title: 'Deal' }));
    expect(thread.participants.map((p) => p.userId).sort()).toEqual([a.userId, a2.userId].sort());
    await as(a, (ctx) => chat.sendMessage(ctx, thread.id, { body: 'Solo para nosotros' }));

    // the colleague in it reads it; a colleague outside it and another agency do not even see it exists
    expect((await as(a2, (ctx) => chat.listMessages(ctx, thread.id, { limit: 25 }))).items).toHaveLength(1);
    expect(await refusal(as(a3, (ctx) => chat.getThread(ctx, thread.id)))).toBe('CHAT_THREAD_NOT_FOUND');
    expect(await refusal(as(a3, (ctx) => chat.listMessages(ctx, thread.id, { limit: 25 })))).toBe(
      'CHAT_THREAD_NOT_FOUND',
    );
    expect(await refusal(as(a3, (ctx) => chat.sendMessage(ctx, thread.id, { body: 'hola' })))).toBe(
      'CHAT_THREAD_NOT_FOUND',
    );
    expect(await refusal(as(b, (ctx) => chat.getThread(ctx, thread.id)))).toBe('CHAT_THREAD_NOT_FOUND');
    expect((await as(a3, (ctx) => chat.listThreads(ctx, { limit: 100 }))).items.map((t) => t.id)).not.toContain(
      thread.id,
    );

    // staff impersonating a participant see the thread, not the colleagues' private messages
    expect(
      await refusal(
        as(a2, async (ctx) => chat.listMessages(await impersonatedCtx(ctx, newId()), thread.id, { limit: 25 })),
      ),
    ).toBe('FORBIDDEN');

    // RLS: the messages are rows only for participants (and their sender)
    const count = sql`select count(*)::int as n from chat_messages where thread_id = ${thread.id}`;
    expect((await asUser<{ n: number }>(a2, count))[0]?.n).toBe(1);
    expect((await asUser<{ n: number }>(a3, count))[0]?.n).toBe(0);
    expect((await asUser<{ n: number }>(b, count))[0]?.n).toBe(0);

    // nobody joins a colleague's thread on their own, nor writes into it
    expect(
      await sqlState(
        asUser(
          a3,
          sql`insert into chat_participants (agency_id, thread_id, user_id)
          values (${a.agencyId}, ${thread.id}, ${a3.userId})`,
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        asUser(
          a3,
          sql`insert into chat_messages (agency_id, id, thread_id, sender_agency_id, sender_user_id,
          sender_name, body) values (${a.agencyId}, ${newId()}, ${thread.id}, ${a.agencyId}, ${a3.userId}, 'C', 'x')`,
        ),
      ),
    ).toBe('42501');
    // nor rewrites or deletes a message (no updatable column; the guard refuses deletes)
    expect(
      await sqlState(asUser(a, sql`update chat_messages set body = 'edited' where thread_id = ${thread.id}`)),
    ).toBe('42501');
    expect(await sqlState(asUser(a, sql`delete from chat_messages where thread_id = ${thread.id}`))).toBe('42501');
    // nor removes anyone or the thread, changes a colleague's read state, or renames a thread they did not start
    expect(
      await sqlState(
        asUser(
          a2,
          sql`update chat_participants set last_read_at = now()
          where agency_id = ${a.agencyId} and thread_id = ${thread.id} and user_id = ${a.userId}`,
        ),
      ),
    ).toBe('42501');
    expect(await sqlState(asUser(a2, sql`delete from chat_participants where thread_id = ${thread.id}`))).toBe('42501');
    expect(await sqlState(asUser(a, sql`delete from chat_threads where id = ${thread.id}`))).toBe('42501');
    expect(await sqlState(asUser(a2, sql`update chat_threads set title = 'Mine' where id = ${thread.id}`))).toBe(
      '42501',
    );
    expect(await sqlState(asUser(a, sql`update chat_threads set title = 'Renamed' where id = ${thread.id}`))).toBe(
      undefined,
    );

    // the socket join check (apps/realtime) asks the same question
    expect(await as(a2, (ctx) => chat.canJoinThread(ctx, thread.id))).toBe(true);
    expect(await as(a3, (ctx) => chat.canJoinThread(ctx, thread.id))).toBe(false);
    expect(await as(b, (ctx) => chat.canJoinThread(ctx, thread.id))).toBe(false);
  });

  it('[S11-03] a DIRECT thread is with active colleagues only', async () => {
    expect(await refusal(as(a, (ctx) => chat.createDirectThread(ctx, { userIds: [b.userId] })))).toBe(
      'CHAT_PARTICIPANTS_INVALID',
    );
    expect(await refusal(as(a, (ctx) => chat.createDirectThread(ctx, { userIds: [a.userId] })))).toBe(
      'CHAT_PARTICIPANTS_INVALID',
    );
  });
});

describe('viewing threads', () => {
  it('[S11-03] a viewing thread is between the two agencies of the request only, and never names the client', async () => {
    const opened = await as(a, (ctx) => chat.openViewingThread(ctx, { viewingRequestId: viewingId }));
    expect(opened).toMatchObject({ id: viewingId, kind: 'VIEWING', viewingRequestId: viewingId });
    expect(opened.peerAgency?.id).toBe(b.agencyId);
    // the other agency got its copy in the same statement; the worker seats its default members (the listing's agent)
    const [opening] = await events('chat.viewingThread.opened', viewingId);
    expect(opening).toBeDefined();
    await chat.seatViewingThread({ agencyId: a.agencyId, threadId: viewingId });
    await chat.seatViewingThread({ agencyId: a.agencyId, threadId: viewingId }); // idempotent
    const seated = await rows<{ agency_id: string; user_id: string }>(
      sql`select agency_id, user_id from chat_participants where thread_id = ${viewingId}`,
    );
    expect(seated).toEqual(expect.arrayContaining([{ agency_id: b.agencyId, user_id: b.userId }]));
    expect(seated.filter((s) => s.agency_id === a.agencyId).map((s) => s.user_id)).toEqual([a.userId]);

    const sent = await as(a, (ctx) => chat.sendMessage(ctx, viewingId, { body: 'Can we do Tuesday?' }));
    const seen = await as(b, (ctx) => chat.listMessages(ctx, viewingId, { limit: 25 }));
    expect(seen.items).toEqual([expect.objectContaining({ id: sent.message.id, body: 'Can we do Tuesday?' })]);
    expect(seen.items[0]?.sender).toMatchObject({ agencyId: a.agencyId, userId: a.userId, ownAgency: false });
    const theirs = await as(b, (ctx) => chat.getThread(ctx, viewingId));
    expect(theirs.peerAgency?.id).toBe(a.agencyId);
    expect(theirs.participants.map((p) => p.userId)).toEqual([b.userId]);
    expect(theirs.handoff.whatsappUrl).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(theirs.handoff.emailUrl).toMatch(/^mailto:\?subject=/);
    // white label: the owner never sees the introducer's client
    for (const dto of [theirs, seen]) expect(JSON.stringify(dto)).not.toMatch(/Mara|Clientela|example\.com/);

    // the owner answers; a stranger agency cannot open it, nor forge a copy of it
    await as(b, (ctx) => chat.sendMessage(ctx, viewingId, { body: 'Tuesday 11:00 works' }));
    expect((await as(a, (ctx) => chat.listMessages(ctx, viewingId, { limit: 25 }))).items).toHaveLength(2);
    expect(await refusal(as(c, (ctx) => chat.openViewingThread(ctx, { viewingRequestId: viewingId })))).toBe(
      'VIEWING_REQUEST_NOT_FOUND',
    );
    expect(
      await sqlState(
        asUser(
          c,
          sql`insert into chat_threads (agency_id, id, kind, peer_agency_id)
          values (${c.agencyId}, ${viewingId}, 'VIEWING', ${a.agencyId})`,
        ),
      ),
    ).toBe('42501');
    expect(await refusal(as(c, (ctx) => chat.getThread(ctx, viewingId)))).toBe('CHAT_THREAD_NOT_FOUND');
  });
});

describe('delivery, read state and the digest', () => {
  it('[S11-03] a message reaches every participant of both agencies; one notification per unread run, read with the thread', async () => {
    const thread = await as(a, (ctx) => chat.openViewingThread(ctx, { viewingRequestId: viewingId }));
    await as(a2, (ctx) => chat.openViewingThread(ctx, { viewingRequestId: viewingId }));
    const published: UserEvent[] = [];
    const publish = async (e: readonly UserEvent[]) => void published.push(...e);

    const first = await as(a, (ctx) => chat.sendMessage(ctx, thread.id, { body: 'First' }));
    const [event] = (await events('chat.message.sent', thread.id)).filter(
      (e) => e.payload.messageId === first.message.id,
    );
    if (!event) throw new Error('no chat.message.sent event');
    const p = { agencyId: event.agency_id, threadId: thread.id, messageId: first.message.id };
    const meta = { eventId: event.id, createdAt: new Date(event.created_at) };
    // a2 and b are notified, not the sender
    expect(await chat.deliverMessage(p, meta, publish)).toEqual({ pushed: 3, notified: 2 });
    expect(published.map((e) => `${e.agencyId}:${e.userId}`).sort()).toEqual(
      [`${a.agencyId}:${a.userId}`, `${a.agencyId}:${a2.userId}`, `${b.agencyId}:${b.userId}`].sort(),
    );
    const toB = published.find((e) => e.userId === b.userId);
    expect(toB).toMatchObject({ namespace: '/chat', event: 'message' });
    expect(toB?.data).toMatchObject({ message: { sender: { ownAgency: false } } });
    expect(published.some((e) => e.userId === a3.userId || e.agencyId === c.agencyId)).toBe(false);

    // a retried job pushes again (clients drop known ids) but raises nothing twice
    expect(await chat.deliverMessage(p, meta, async () => {})).toEqual({ pushed: 3, notified: 0 });
    const chatNotes = (m: Founder) =>
      rows<{ read_at: Date | null; link: string }>(sql`select read_at, link from notifications
        where agency_id = ${m.agencyId} and user_id = ${m.userId} and type = 'CHAT_MESSAGE'
          and link = ${chat.threadLink(thread.id)}`);
    expect(await chatNotes(b)).toHaveLength(1);

    // a second unread message joins the first notification
    const second = await as(a, (ctx) => chat.sendMessage(ctx, thread.id, { body: 'Second' }));
    const [event2] = (await events('chat.message.sent', thread.id)).filter(
      (e) => e.payload.messageId === second.message.id,
    );
    if (!event2) throw new Error('no second event');
    const p2 = { ...p, messageId: second.message.id };
    expect(
      (await chat.deliverMessage(p2, { eventId: event2.id, createdAt: new Date(event2.created_at) }, publish)).notified,
    ).toBe(0);

    // reading the thread reads its notification (the digest leaves it out) and sends a read receipt to both agencies
    const unreadBefore = (await as(b, (ctx) => chat.listThreads(ctx, { limit: 100 }))).items.find(
      (t) => t.id === thread.id,
    );
    expect(unreadBefore?.unread).toBe(true);
    const read = await as(b, (ctx) => chat.markThreadRead(ctx, thread.id));
    expect(read.lastReadAt).toBe(second.message.createdAt);
    expect((await chatNotes(b)).every((n) => n.read_at !== null)).toBe(true);
    const after = (await as(b, (ctx) => chat.listThreads(ctx, { limit: 100 }))).items.find((t) => t.id === thread.id);
    expect(after?.unread).toBe(false);
    const [readEvent] = await events('chat.thread.read', thread.id);
    expect(readEvent?.agency_id).toBe(b.agencyId);
    published.length = 0;
    expect(
      (
        await chat.pushRead(
          { agencyId: b.agencyId, threadId: thread.id, userId: b.userId, at: Date.parse(read.lastReadAt ?? '') },
          publish,
        )
      ).pushed,
    ).toBe(3);
    expect(published.every((e) => e.event === 'read')).toBe(true);

    // a later message, after the read, is a new run: notified again
    const third = await as(a, (ctx) => chat.sendMessage(ctx, thread.id, { body: 'Third' }));
    const [event3] = (await events('chat.message.sent', thread.id)).filter(
      (e) => e.payload.messageId === third.message.id,
    );
    if (!event3) throw new Error('no third event');
    const n3 = await chat.deliverMessage(
      { ...p, messageId: third.message.id },
      { eventId: event3.id, createdAt: new Date(event3.created_at) },
      publish,
    );
    expect(n3.notified).toBe(1); // b again (a2 still has the first one unread)
  });

  it('[S12-F10] a deactivated participant gets no push, no read receipt and no notification', async () => {
    const leaver = await agent(a.agencyId, 'Elena');
    const thread = await as(a, (ctx) => chat.createDirectThread(ctx, { userIds: [a2.userId, leaver.userId] }));
    await system((tx) =>
      tx.execute(sql`update agency_members set deactivated_at = now()
        where agency_id = ${leaver.agencyId} and user_id = ${leaver.userId}`),
    );
    const published: UserEvent[] = [];
    const publish = async (e: readonly UserEvent[]) => void published.push(...e);
    const sent = await as(a, (ctx) => chat.sendMessage(ctx, thread.id, { body: 'Still there?' }));
    const [event] = (await events('chat.message.sent', thread.id)).filter(
      (e) => e.payload.messageId === sent.message.id,
    );
    if (!event) throw new Error('no chat.message.sent event');
    const res = await chat.deliverMessage(
      { agencyId: event.agency_id, threadId: thread.id, messageId: sent.message.id },
      { eventId: event.id, createdAt: new Date(event.created_at) },
      publish,
    );
    expect(res).toEqual({ pushed: 2, notified: 1 });
    expect(published.map((e) => e.userId).sort()).toEqual([a.userId, a2.userId].sort());
    const notes = await rows<{ n: number }>(sql`select count(*)::int as n from notifications
      where agency_id = ${leaver.agencyId} and user_id = ${leaver.userId} and type = 'CHAT_MESSAGE'`);
    expect(notes[0]?.n).toBe(0);

    published.length = 0;
    await chat.pushRead({ agencyId: a.agencyId, threadId: thread.id, userId: a2.userId, at: Date.now() }, publish);
    expect(published.some((e) => e.userId === leaver.userId)).toBe(false);
    expect(published).toHaveLength(2);
  });

  it('[S11-03] a retried send with the same clientKey answers the first message; lists stay within their query budgets', async () => {
    const thread = await as(a, (ctx) => chat.createDirectThread(ctx, { userIds: [a2.userId] }));
    const clientKey = newId();
    const first = await as(a, (ctx) => chat.sendMessage(ctx, thread.id, { body: 'Once', clientKey }));
    const again = await as(a, (ctx) => chat.sendMessage(ctx, thread.id, { body: 'Once', clientKey }));
    expect(first.replayed).toBe(false);
    expect(again).toEqual({ message: first.message, replayed: true });
    expect((await as(a, (ctx) => chat.listMessages(ctx, thread.id, { limit: 25 }))).items).toHaveLength(1);

    for (let i = 0; i < 3; i++) await as(a, (ctx) => chat.sendMessage(ctx, thread.id, { body: `m${i}` }));
    const page1 = await as(a2, (ctx) => chat.listMessages(ctx, thread.id, { limit: 2 }));
    const page2 = await as(a2, (ctx) =>
      chat.listMessages(ctx, thread.id, { limit: 2, cursor: page1.nextCursor ?? '' }),
    );
    expect([...page1.items, ...page2.items].map((m) => m.body)).toEqual(['m2', 'm1', 'm0', 'Once']);
    expect(page2.nextCursor).toBeNull();

    const setup = await countQueries(() => as(a, async () => null));
    expect(
      (await countQueries(() => as(a, (ctx) => chat.listThreads(ctx, { limit: 25 })))) - setup,
    ).toBeLessThanOrEqual(2);
    expect(
      (await countQueries(() => as(a, (ctx) => chat.listMessages(ctx, thread.id, { limit: 25 })))) - setup,
    ).toBeLessThanOrEqual(2);
    expect(
      (await countQueries(() => as(a, (ctx) => chat.sendMessage(ctx, thread.id, { body: 'budget' })))) - setup,
    ).toBeLessThanOrEqual(4);
    expect((await countQueries(() => as(a, (ctx) => chat.getThread(ctx, thread.id)))) - setup).toBeLessThanOrEqual(4);
    expect(
      (await countQueries(() => as(a2, (ctx) => chat.markThreadRead(ctx, thread.id)))) - setup,
    ).toBeLessThanOrEqual(4);
    expect(
      (await countQueries(() => as(a, (ctx) => chat.createDirectThread(ctx, { userIds: [a2.userId, a3.userId] })))) -
        setup,
    ).toBeLessThanOrEqual(7);
    // a first join of a viewing thread (the owner's side, by a member not seated yet)
    const b2 = await agent(b.agencyId, 'Dora');
    const opened = await countQueries(() =>
      as(b2, (ctx) => chat.openViewingThread(ctx, { viewingRequestId: viewingId })),
    );
    expect(opened - setup).toBeLessThanOrEqual(10);
    expect((await as(b2, (ctx) => chat.getThread(ctx, viewingId))).participants.map((x) => x.userId)).toContain(
      b2.userId,
    );
  });
});

describe('closed viewing threads', () => {
  it('[S11-03] a declined, cancelled or expired viewing request makes its thread read-only; a closed one opens no thread', async () => {
    await as(a, (ctx) => mls.cancelViewing(ctx, viewingId));
    expect(await chat.closeViewingThread({ agencyId: c.agencyId, requestId: viewingId })).toEqual({ closed: 0 });
    expect(await chat.closeViewingThread({ agencyId: a.agencyId, requestId: viewingId })).toEqual({ closed: 2 });
    expect(await refusal(as(a, (ctx) => chat.sendMessage(ctx, viewingId, { body: 'still there?' })))).toBe(
      'CHAT_THREAD_CLOSED',
    );
    expect(await refusal(as(b, (ctx) => chat.sendMessage(ctx, viewingId, { body: 'still there?' })))).toBe(
      'CHAT_THREAD_CLOSED',
    );
    // the database refuses it too
    expect(
      await sqlState(
        asUser(
          a,
          sql`insert into chat_messages (agency_id, id, thread_id, sender_agency_id, sender_user_id,
          sender_name, body) values (${a.agencyId}, ${newId()}, ${viewingId}, ${a.agencyId}, ${a.userId}, 'A', 'x')`,
        ),
      ),
    ).toBe('42501');
    // still readable, and joinable to read
    expect((await as(a, (ctx) => chat.getThread(ctx, viewingId))).closed).toBe(true);
    expect((await as(a3, (ctx) => chat.openViewingThread(ctx, { viewingRequestId: viewingId }))).closed).toBe(true);
    expect((await as(b, (ctx) => chat.listMessages(ctx, viewingId, { limit: 100 }))).items.length).toBeGreaterThan(0);

    // a request closed before anyone opened its thread opens none
    const again = await as(a, (ctx) =>
      mls.requestViewing(ctx, {
        registrationId,
        proposedStartAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      }),
    );
    await as(a, (ctx) => mls.cancelViewing(ctx, again.request.id));
    expect(await refusal(as(a, (ctx) => chat.openViewingThread(ctx, { viewingRequestId: again.request.id })))).toBe(
      'VIEWING_REQUEST_STATE',
    );
  });
});

describe('staff reads (S12-F9)', () => {
  it('[S12-F9] an impersonated read of VIEWING or NETWORK messages writes one chat.clientData.read row, a member’s own read none', async () => {
    const staffUserId = newId();
    // A NETWORK thread of its own: a's reply to an open board post of b's (written directly: posts are the network
    // module's).
    const postId = newId();
    await system((tx) =>
      tx.execute(sql`insert into network_posts (agency_id, id, kind, title, body, expires_at)
        values (${b.agencyId}, ${postId}, 'BUYER_REQUEST', ${`F9 ${RUN}`}, 'Looking', now() + interval '1 day')`),
    );
    const network = await as(a, (ctx) =>
      chat.replyInNetworkThread(ctx, {
        postId,
        posterAgencyId: b.agencyId,
        message: { body: 'Is the client still looking?' },
      }),
    );
    const threads: [string, Founder, string][] = [
      ['VIEWING', b, viewingId],
      ['NETWORK', a, network.thread.id],
    ];
    for (const [kind, m, threadId] of threads) {
      const read = async (impersonated: boolean) => {
        const requestId = newId();
        const page = await withMemberCtx(
          { userId: m.userId, agencyId: m.agencyId, requestId, locale: 'en' },
          async (ctx) =>
            chat.listMessages(impersonated ? await impersonatedCtx(ctx, staffUserId) : ctx, threadId, { limit: 25 }),
        );
        const audit = await rows<{ type: string; impersonated_by: string | null; metadata: Record<string, unknown> }>(
          sql`select type, impersonated_by, metadata from audit_logs where agency_id = ${m.agencyId} and request_id = ${requestId}`,
        );
        return { page, audit };
      };
      const staff = await read(true);
      expect(staff.page.items.length, kind).toBeGreaterThan(0);
      expect(staff.audit, kind).toEqual([
        {
          type: 'chat.clientData.read',
          impersonated_by: staffUserId,
          metadata: { resource: 'messages', view: 'list', count: staff.page.items.length, parentId: threadId, kind },
        },
      ]);
      expect((await read(false)).audit, `${kind} (own)`).toEqual([]);
    }
  });
});
