import {
  CreateCalendarEventBody,
  type CreateCalendarEventInput,
  CreateContactBody,
  type ListCalendarEventsInput,
  ListCalendarEventsQuery,
  UpdateCalendarEventBody,
  type UpdateCalendarEventInput,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem, withTenant } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { formatter } from '@inmolink/i18n';
import { configureHmacRotation } from '@inmolink/platform/crypto';
import {
  closeEmail,
  configureEmail,
  createMemoryMailer,
  EmailSendError,
  type MemoryMailer,
} from '@inmolink/platform/email';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import { validateIcs } from '../../../testing/ics-validator';
import * as calendarRepo from '../calendar-repo';
import * as crm from '../index';

/**
 * Calendar (S10-06): viewings, meetings and calls with member and contact attendees; reminders to member attendees at
 * most once (sweep + outbox + claimed send); the member's ICS feed — RFC 5545 valid, only the member's own events,
 * contacts by name only, SEQUENCE bumps, cancelled events, revocation and rotation.
 */

const RUN = newId().slice(-8).toLowerCase();
const KEY = 'test-hmac-key-0123456789abcdef0123456789';
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.calendar.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let a: Founder;
let b: Founder;
let agent: Founder;
let mail: MemoryMailer;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const hours = (n: number) => new Date(Date.now() + n * 3_600_000);
const slot = (startH: number, lengthMin = 60) => ({
  startsAt: hours(startH).toISOString(),
  endsAt: new Date(hours(startH).getTime() + lengthMin * 60_000).toISOString(),
});
const create = (m: Founder, body: CreateCalendarEventInput, opts: { idempotencyKey?: string } = {}) =>
  as(m, (ctx) => crm.createCalendarEvent(ctx, CreateCalendarEventBody.parse(body), opts));
const update = (m: Founder, id: string, body: UpdateCalendarEventInput) =>
  as(m, (ctx) => crm.updateCalendarEvent(ctx, id, UpdateCalendarEventBody.parse(body)));
const list = (m: Founder, q: Omit<ListCalendarEventsInput, 'from' | 'to'> & { from?: string; to?: string } = {}) =>
  as(m, (ctx) =>
    crm.listCalendarEvents(
      ctx,
      ListCalendarEventsQuery.parse({ from: hours(-1).toISOString(), to: hours(24 * 60).toISOString(), ...q }),
    ),
  );
const title = (name: string) => `${name} ${RUN}`;
const sentTo = (to: string, needle: string) => mail.sent.filter((m) => m.to === to && m.subject.includes(needle));

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

async function contact(m: Founder, firstName: string, extra: Record<string, unknown> = {}) {
  return (await as(m, (ctx) => crm.createContact(ctx, CreateContactBody.parse({ firstName, ...extra })))).contact;
}

beforeAll(async () => {
  await setupTestDb('worker');
  mail = createMemoryMailer();
  await configureEmail(mail);
  crm.configureCalendarFeeds({ tokenKey: KEY });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  const userId = newId();
  const agentEmail = `crm-cal-agent-${userId}@example.com`;
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${userId}, ${agentEmail}, 'x', 'Agent Calendario', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${a.agencyId}, ${userId}, 'AGENT', 'Agent Calendario', ${agentEmail})`);
  });
  agent = { userId, agencyId: a.agencyId, email: agentEmail, password: 'x' };
});

afterAll(async () => {
  await closeEmail();
  await closeDb();
});

describe('events', () => {
  it('[S10-06] viewings, meetings and calls with member and contact attendees; my calendar lists what I attend', async () => {
    const buyer = await contact(a, 'Lucía', { lastName: 'Pérez' });
    const tag = title('mine');
    const viewing = await create(a, {
      type: 'VIEWING',
      title: `${tag} viewing`,
      location: 'Calle Mayor 3, Marbella',
      ...slot(5),
      userIds: [agent.userId],
      contactIds: [buyer.id],
    });
    const meeting = await create(a, { type: 'MEETING', title: `${tag} meeting`, ...slot(3) });
    const call = await create(agent, { type: 'CALL', title: `${tag} call`, ...slot(4, 15) });
    expect(viewing.replayed).toBe(false);
    expect(viewing.event.attendees).toEqual([
      { kind: 'USER', id: a.userId, name: expect.any(String) },
      { kind: 'USER', id: agent.userId, name: 'Agent Calendario' },
      { kind: 'CONTACT', id: buyer.id, name: 'Lucía Pérez' },
    ]);
    expect(viewing.event).toMatchObject({ type: 'VIEWING', status: 'SCHEDULED', remindMinutes: 30, version: 1 });

    const mine = (await list(a)).items.filter((e) => e.title.startsWith(tag));
    expect(mine.map((e) => e.id)).toEqual([meeting.event.id, viewing.event.id]);
    const agents = (await list(agent)).items.filter((e) => e.title.startsWith(tag));
    expect(agents.map((e) => e.id)).toEqual([call.event.id, viewing.event.id]);
    const everyone = (await list(a, { attendee: 'any' })).items.filter((e) => e.title.startsWith(tag));
    expect(everyone.map((e) => e.id)).toEqual([meeting.event.id, call.event.id, viewing.event.id]);
    expect((await list(a, { attendee: agent.userId })).items.map((e) => e.id)).toContain(call.event.id);
    // another agency sees nothing of it
    expect(await refusal(as(b, (ctx) => crm.getCalendarEvent(ctx, viewing.event.id)))).toBe('CALENDAR_EVENT_NOT_FOUND');
    expect((await list(b, { attendee: 'any' })).items.filter((e) => e.title.startsWith(tag))).toEqual([]);
  });

  it('[S10-06] lists page by keyset in three statements; create and update stay within ten', async () => {
    const tag = title('page');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await create(b, { type: 'CALL', title: `${tag} ${i}`, ...slot(30 + i) })).event.id);
    const range = { from: hours(29).toISOString(), to: hours(40).toISOString() };
    const first = await list(b, { ...range, limit: 3 });
    const second = await list(b, { ...range, limit: 3, cursor: first.nextCursor ?? '' });
    expect([...first.items, ...second.items].map((e) => e.id)).toEqual(ids);
    expect(second.nextCursor).toBeNull();
    const setup = await countQueries(() => as(b, async () => null));
    expect((await countQueries(() => list(b, { ...range, limit: 100 }))) - setup).toBe(3);
    expect((await countQueries(() => list(b, { ...range, attendee: 'any' }))) - setup).toBe(3);
    const buyer = await contact(b, 'Count');
    const createN = await countQueries(() =>
      create(
        b,
        { type: 'VIEWING', title: `${tag} n`, ...slot(41), contactIds: [buyer.id] },
        { idempotencyKey: `cal-count-${RUN}` },
      ),
    );
    expect(createN - setup).toBeLessThanOrEqual(10);
    const e = (await list(b, { from: hours(40).toISOString(), to: hours(42).toISOString() })).items[0];
    const other = await contact(b, 'Other');
    const updateN = await countQueries(() =>
      update(b, e?.id ?? '', { version: e?.version ?? 1, ...slot(43), contactIds: [other.id], title: 'moved' }),
    );
    expect(updateN - setup).toBeLessThanOrEqual(10);
  });

  it('[S10-06] attendees must be active members and open contacts of the agency; an Idempotency-Key replays', async () => {
    expect(await refusal(create(a, { type: 'MEETING', title: title('x'), ...slot(6), userIds: [b.userId] }))).toBe(
      'VALIDATION_FAILED',
    );
    const theirs = await contact(b, 'Theirs');
    expect(await refusal(create(a, { type: 'MEETING', title: title('x'), ...slot(6), contactIds: [theirs.id] }))).toBe(
      'CONTACT_NOT_FOUND',
    );
    expect(CreateCalendarEventBody.safeParse({ type: 'CALL', title: 't', ...slot(6, 8 * 24 * 60) }).success).toBe(
      false,
    );
    expect(
      CreateCalendarEventBody.safeParse({
        type: 'CALL',
        title: 't',
        startsAt: slot(6).endsAt,
        endsAt: slot(6).startsAt,
      }).success,
    ).toBe(false);
    const key = `cal-${RUN}`;
    const at = slot(7); // the same body on the retry
    const first = await create(a, { type: 'CALL', title: title('idem'), ...at }, { idempotencyKey: key });
    const again = await create(a, { type: 'CALL', title: title('idem'), ...at }, { idempotencyKey: key });
    expect(again).toMatchObject({ replayed: true, event: { id: first.event.id } });
    expect(await refusal(create(a, { type: 'CALL', title: title('other'), ...at }, { idempotencyKey: key }))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    const asClient = as(a, (ctx) =>
      crm.listCalendarEvents(
        { ...ctx, clientMode: true },
        ListCalendarEventsQuery.parse({ from: hours(0).toISOString(), to: hours(1).toISOString() }),
      ),
    );
    expect(await refusal(asClient)).toBe('FORBIDDEN');
  });

  it('[S10-06] attendee lists replace the current ones (the organizer stays); every change is a new version', async () => {
    const c1 = await contact(a, 'Uno');
    const c2 = await contact(a, 'Dos');
    const e = (
      await create(a, {
        type: 'MEETING',
        title: title('edit'),
        ...slot(8),
        userIds: [agent.userId],
        contactIds: [c1.id],
      })
    ).event;
    const changed = await update(a, e.id, { version: e.version, userIds: [], contactIds: [c2.id] });
    expect(changed.version).toBe(2);
    expect(changed.attendees.map((x) => x.id)).toEqual([a.userId, c2.id]);
    expect((await as(a, (ctx) => crm.getCalendarEvent(ctx, e.id))).attendees.map((x) => x.id)).toEqual([
      a.userId,
      c2.id,
    ]);
    expect((await list(agent)).items.map((x) => x.id)).not.toContain(e.id);
    expect(await refusal(update(a, e.id, { version: 1, title: 'stale' }))).toBe('VERSION_CONFLICT');
    const moved = await update(a, e.id, { version: changed.version, ...slot(9) });
    const stored = await rows<{ starts_at: Date }>(
      sql`select starts_at from calendar_event_attendees where event_id = ${e.id}`,
    );
    expect(stored.map((r) => new Date(r.starts_at).toISOString())).toEqual([moved.startsAt, moved.startsAt]);
  });

  it('[S10-06] a contact merge moves its attendances; a purged listing leaves the events; members cannot write worker columns', async () => {
    const keep = await contact(a, 'Keep');
    const dup = await contact(a, 'Dup');
    const e = (await create(a, { type: 'VIEWING', title: title('merge'), ...slot(10), contactIds: [keep.id, dup.id] }))
      .event;
    await as(a, (ctx) => crm.mergeContacts(ctx, keep.id, { version: keep.version, duplicateId: dup.id }));
    const after = await as(a, (ctx) => crm.getCalendarEvent(ctx, e.id));
    expect(after.attendees.filter((x) => x.kind === 'CONTACT').map((x) => x.id)).toEqual([keep.id]);

    const listingId = newId();
    await system((tx) => tx.execute(sql`update calendar_events set listing_id = ${listingId} where id = ${e.id}`));
    expect((await crm.forgetListingEvents({ agencyId: a.agencyId, listingId })).rows).toBe(1);
    expect((await as(a, (ctx) => crm.getCalendarEvent(ctx, e.id))).listingId).toBeNull();
    await expect(
      withTenant({ agencyId: a.agencyId }, (tx) =>
        tx.execute(sql`update calendar_event_attendees set reminder_sent_for = now() where event_id = ${e.id}`),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant({ agencyId: a.agencyId }, (tx) => tx.execute(sql`select token_hash from calendar_feeds limit 1`)),
    ).rejects.toThrow();
  });
});

describe('event rules', () => {
  it('[S10-06] an event crossing the range start is listed: Sunday 22:00 – Monday 02:00 shows in Monday’s week', async () => {
    // a Monday 00:00 UTC some weeks ahead, and the night before it
    const base = new Date(Date.now() + 35 * 86_400_000);
    const monday = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - ((base.getUTCDay() + 6) % 7)),
    );
    const sunday22 = new Date(monday.getTime() - 2 * 3_600_000);
    const night = (
      await create(agent, {
        type: 'MEETING',
        title: title('overnight'),
        startsAt: sunday22.toISOString(),
        endsAt: new Date(monday.getTime() + 2 * 3_600_000).toISOString(),
      })
    ).event;
    const earlier = (
      await create(agent, {
        type: 'CALL',
        title: title('sunday'),
        startsAt: new Date(sunday22.getTime() - 3_600_000).toISOString(),
        endsAt: new Date(sunday22.getTime() - 1_800_000).toISOString(),
      })
    ).event;
    const week = { from: monday.toISOString(), to: new Date(monday.getTime() + 7 * 86_400_000).toISOString() };
    for (const attendee of ['me', 'any'] as const) {
      const ids = (await list(agent, { ...week, attendee })).items.map((e) => e.id);
      expect(ids).toContain(night.id);
      expect(ids).not.toContain(earlier.id); // ended before Monday
    }
  });

  it('[S10-06] only the organizer or an agency admin changes or cancels an event', async () => {
    const theirs = (await create(a, { type: 'MEETING', title: title('admin-owned'), ...slot(12) })).event;
    expect(await refusal(update(agent, theirs.id, { version: theirs.version, status: 'CANCELLED' }))).toBe('FORBIDDEN');
    expect(await refusal(update(agent, theirs.id, { version: theirs.version, userIds: [agent.userId] }))).toBe(
      'FORBIDDEN',
    );
    const agents = (await create(agent, { type: 'CALL', title: title('agent-owned'), ...slot(13) })).event;
    // a is the agency's admin
    expect((await update(a, agents.id, { version: agents.version, status: 'CANCELLED' })).status).toBe('CANCELLED');
  });
});

describe('reminders', () => {
  const sweepAt = async (now: Date, eventIds: readonly string[], passes = 1) => {
    const results = await Promise.all(Array.from({ length: passes }, () => crm.sweepEventReminders({ now })));
    return results.map((r) => r.claimed.filter((c) => eventIds.includes(c.eventId)));
  };

  it('[S10-06] reminders go to each member attendee once at the remind time — never to contacts', async () => {
    const buyer = await contact(a, 'NoMail', { emails: [`nomail-${RUN}@example.com`] });
    const e = (
      await create(a, {
        type: 'VIEWING',
        title: title('remind'),
        ...slot(2),
        remindMinutes: 15,
        userIds: [agent.userId],
        contactIds: [buyer.id],
      })
    ).event;
    const remindMs = new Date(e.startsAt).getTime() - 15 * 60_000;
    expect((await sweepAt(new Date(remindMs - 1_000), [e.id], 2)).flat()).toEqual([]);
    const claims = (await sweepAt(new Date(remindMs + 1_000), [e.id], 2)).flat();
    expect(claims.map((c) => c.userId).sort()).toEqual([a.userId, agent.userId].sort());
    expect(claims.every((c) => c.remindMs === remindMs && c.agencyId === a.agencyId)).toBe(true);
    const events = await rows<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where type = 'crm.calendarEvent.reminderDue'
          and agency_id = ${a.agencyId} and payload->>'eventId' = ${e.id}`,
    );
    expect(events[0]?.n).toBe(2);
    expect((await sweepAt(new Date(remindMs + 60_000), [e.id])).flat()).toEqual([]);
    for (const c of claims) {
      const sends = await Promise.all([crm.sendEventReminder(c), crm.sendEventReminder(c)]);
      expect(sends.filter((s) => s.sent)).toHaveLength(1);
    }
    expect(sentTo(a.email, e.title)).toHaveLength(1);
    const agents = sentTo(agent.email, e.title);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.subject).toContain('Visita'); // the member's language
    expect(agents[0]?.idempotencyKey).toBe(`event-reminder:${e.id}:${remindMs}:${agent.userId}`);
    expect(mail.sent.filter((m) => m.to === `nomail-${RUN}@example.com`)).toEqual([]);
  });

  it('[S11-F11] the event reminder shows the start in the agency’s zone: a Canary-Islands agency, an hour behind Madrid', async () => {
    const canary = await createFounder();
    await rows(sql`update agency_settings set time_zone = 'Atlantic/Canary' where agency_id = ${canary.agencyId}`);
    const e = (await create(canary, { type: 'MEETING', title: title('canary'), ...slot(5), remindMinutes: 0 })).event;
    const [claim] = (await sweepAt(new Date(new Date(e.startsAt).getTime() + 1_000), [e.id])).flat();
    expect((await crm.sendEventReminder(claim as NonNullable<typeof claim>)).sent).toBe(true);
    const text = sentTo(canary.email, e.title)[0]?.text ?? '';
    const shown = (zone: string) => ['en', 'es'].map((l) => formatter(l, zone).dateTime(new Date(e.startsAt)));
    expect(shown('Atlantic/Canary').some((s) => text.includes(s))).toBe(true);
    expect(shown('Europe/Madrid').some((s) => text.includes(s))).toBe(false);
  });

  it('[S10-06] a send known not to have gone out gives the claim back; a cancelled or moved event sends nothing', async () => {
    const e = (await create(a, { type: 'CALL', title: title('flaky'), ...slot(3), remindMinutes: 0 })).event;
    const [claim] = (await sweepAt(new Date(new Date(e.startsAt).getTime() + 1_000), [e.id])).flat();
    expect(claim).toBeDefined();
    const c = claim as NonNullable<typeof claim>;
    const fail = vi.spyOn(mail, 'send').mockRejectedValueOnce(new EmailSendError('refused', { notSent: true }));
    await expect(crm.sendEventReminder(c)).rejects.toThrow('refused');
    fail.mockRestore();
    expect((await crm.sendEventReminder(c)).sent).toBe(true);
    expect((await crm.sendEventReminder(c)).sent).toBe(false);

    const cancelled = (await create(a, { type: 'CALL', title: title('cxl'), ...slot(4), remindMinutes: 0 })).event;
    const moved = (await create(a, { type: 'CALL', title: title('mv'), ...slot(4), remindMinutes: 0 })).event;
    const at = new Date(new Date(cancelled.startsAt).getTime() + 1_000);
    const claims = (await sweepAt(at, [cancelled.id, moved.id])).flat();
    expect(claims).toHaveLength(2);
    await update(a, cancelled.id, { version: cancelled.version, status: 'CANCELLED' });
    await update(a, moved.id, { version: moved.version, ...slot(30) });
    for (const x of claims) expect((await crm.sendEventReminder(x)).sent).toBe(false);
    // the moved one is re-armed for its new time
    const later = (await sweepAt(new Date(hours(30).getTime() + 2_000), [moved.id])).flat();
    expect(later).toHaveLength(1);
  });

  it('[S10-06] the sweep takes at most 50 events of one agency per batch', async () => {
    const at = slot(24 * 20);
    for (let i = 0; i < 52; i++) await create(b, { type: 'CALL', title: title(`crowd ${i}`), ...at, remindMinutes: 0 });
    const mine = (await create(a, { type: 'CALL', title: title('crowd mine'), ...at, remindMinutes: 0 })).event;
    const batch = await system((tx) =>
      calendarRepo.claimDueReminders(tx, new Date(new Date(at.startsAt).getTime() + 1_000), 3_600_000, 200, 50),
    );
    expect(new Set(batch.filter((c) => c.agencyId === b.agencyId).map((c) => c.eventId)).size).toBe(50);
    expect(batch.map((c) => c.eventId)).toContain(mine.id);
  });
});

describe('ICS feed', () => {
  it('[S10-06] the feed validates (RFC 5545) and holds only the member’s own events, contacts by name only', async () => {
    const buyer = await contact(a, 'Marta, "La"', {
      lastName: 'Ruiz; Gómez',
      emails: [`marta-${RUN}@example.com`],
      phones: ['+34 600 111 222'],
    });
    const tag = title('ics');
    const mineEvent = (
      await create(a, {
        type: 'VIEWING',
        title: `${tag}, mine; with \\ backslash`,
        description: 'Line one\nLine two',
        location: 'Avenida del Mar 12, Marbella',
        ...slot(26),
        userIds: [agent.userId],
        contactIds: [buyer.id],
      })
    ).event;
    const colleagues = (await create(agent, { type: 'CALL', title: `${tag} agent only`, ...slot(27) })).event;
    const otherAgency = (await create(b, { type: 'CALL', title: `${tag} other agency`, ...slot(27) })).event;
    const secret = await as(a, (ctx) => crm.rotateCalendarFeed(ctx));
    expect(secret.path).toBe(`/v2/calendars/${secret.token}/calendar.ics`);
    expect(secret.feed).toMatchObject({ enabled: true, tokenHint: secret.token.slice(-4) });
    expect(await as(a, (ctx) => crm.getCalendarFeed(ctx))).toMatchObject({ enabled: true });

    const n = await countQueries(() => crm.calendarFeed(secret.token));
    expect(n).toBe(1);
    const feed = await crm.calendarFeed(secret.token, { locale: 'es' });
    const { problems, events } = validateIcs(feed.body);
    expect(problems).toEqual([]);
    const uids = events.map((e) => e.raw('UID'));
    expect(uids).toContain(`${mineEvent.id}@calendar.inmolink`);
    expect(uids).not.toContain(`${colleagues.id}@calendar.inmolink`);
    expect(uids).not.toContain(`${otherAgency.id}@calendar.inmolink`);
    const ev = events.find((e) => e.raw('UID') === `${mineEvent.id}@calendar.inmolink`);
    expect(ev?.text('SUMMARY')).toBe(mineEvent.title);
    expect(ev?.text('CATEGORIES')).toBe('Visita');
    expect(ev?.text('DESCRIPTION')).toContain('Line one\nLine two');
    expect(ev?.text('DESCRIPTION')).toContain('Marta, "La" Ruiz; Gómez');
    expect(ev?.text('DESCRIPTION')).toContain('Agent Calendario');
    expect(ev?.raw('SEQUENCE')).toBe('0');
    expect(feed.body).not.toContain(`marta-${RUN}`);
    expect(feed.body).not.toContain('600');
    expect(feed.body).not.toContain(agent.email);
    // the agent attends it too, so it is in the agent's feed; the agent's own call as well
    const agentFeed = await crm.calendarFeed((await as(agent, (ctx) => crm.rotateCalendarFeed(ctx))).token);
    const agentUids = validateIcs(agentFeed.body).events.map((e) => e.raw('UID'));
    expect(agentUids).toEqual(
      expect.arrayContaining([`${mineEvent.id}@calendar.inmolink`, `${colleagues.id}@calendar.inmolink`]),
    );
  });

  it('[S10-06] a change shows in the feed (SEQUENCE bumps, a new ETag); a cancelled event is STATUS:CANCELLED', async () => {
    const e = (await create(a, { type: 'MEETING', title: title('change'), ...slot(28) })).event;
    const { token } = await as(a, (ctx) => crm.rotateCalendarFeed(ctx));
    const uid = `${e.id}@calendar.inmolink`;
    const pick = async () => {
      const f = await crm.calendarFeed(token);
      return { etag: f.etag, ev: validateIcs(f.body).events.find((x) => x.raw('UID') === uid) };
    };
    const before = await pick();
    expect(before.ev?.raw('STATUS')).toBe('CONFIRMED');
    expect((await pick()).etag).toBe(before.etag); // stable while nothing changes
    const renamed = await update(a, e.id, { version: e.version, title: title('renamed'), ...slot(29) });
    const after = await pick();
    expect(after.etag).not.toBe(before.etag);
    expect(after.ev?.text('SUMMARY')).toBe(renamed.title);
    expect(after.ev?.raw('SEQUENCE')).toBe('1');
    expect(after.ev?.raw('DTSTART')).toBe(renamed.startsAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'));
    await update(a, e.id, { version: renamed.version, status: 'CANCELLED' });
    const cancelled = await pick();
    expect(cancelled.ev?.raw('STATUS')).toBe('CANCELLED');
    expect(cancelled.ev?.raw('SEQUENCE')).toBe('2');
    expect(cancelled.ev?.raw('UID')).toBe(uid);
  });

  it('[S10-06] revoking or rotating the URL stops the old token at once; a deactivated member’s feed stops', async () => {
    const first = await as(a, (ctx) => crm.rotateCalendarFeed(ctx));
    const second = await as(a, (ctx) => crm.rotateCalendarFeed(ctx));
    expect(await refusal(crm.calendarFeed(first.token))).toBe('CALENDAR_FEED_NOT_FOUND');
    expect((await crm.calendarFeed(second.token)).body).toContain('BEGIN:VCALENDAR');
    expect(await as(a, (ctx) => crm.revokeCalendarFeed(ctx))).toEqual({
      enabled: false,
      tokenHint: null,
      createdAt: null,
    });
    expect(await refusal(crm.calendarFeed(second.token))).toBe('CALENDAR_FEED_NOT_FOUND');
    expect(await refusal(crm.calendarFeed('x'.repeat(43)))).toBe('CALENDAR_FEED_NOT_FOUND');
    const hashes = await rows<{ n: number }>(
      sql`select count(*)::int as n from calendar_feeds where token_hash = ${second.token}`,
    );
    expect(hashes[0]?.n).toBe(0); // stored hashed, never as the token

    const userId = newId();
    const email = `crm-cal-gone-${userId}@example.com`;
    await system(async (tx) => {
      await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
        values (${userId}, ${email}, 'x', 'Gone', 'en', 'ACTIVE')`);
      await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
        values (${a.agencyId}, ${userId}, 'AGENT', 'Gone', ${email})`);
    });
    const gone: Founder = { userId, agencyId: a.agencyId, email, password: 'x' };
    const { token } = await as(gone, (ctx) => crm.rotateCalendarFeed(ctx));
    expect((await crm.calendarFeed(token)).body).toContain('BEGIN:VCALENDAR');
    await system((tx) => tx.execute(sql`update agency_members set deactivated_at = now() where user_id = ${userId}`));
    expect(await refusal(crm.calendarFeed(token))).toBe('CALENDAR_FEED_NOT_FOUND');
  });

  it('[S10-06] a member moved out of the CRM roles, a disabled login or a suspended agency stops the feed', async () => {
    const member = async (agencyId: string): Promise<Founder> => {
      const userId = newId();
      const email = `crm-cal-loss-${userId}@example.com`;
      await system(async (tx) => {
        await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
          values (${userId}, ${email}, 'x', 'Loss', 'en', 'ACTIVE')`);
        await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
          values (${agencyId}, ${userId}, 'AGENT', 'Loss', ${email})`);
      });
      return { userId, agencyId, email, password: 'x' };
    };
    const live = async (m: Founder) => {
      const { token } = await as(m, (ctx) => crm.rotateCalendarFeed(ctx));
      expect((await crm.calendarFeed(token)).body).toContain('BEGIN:VCALENDAR');
      return token;
    };

    const demoted = await member(a.agencyId);
    const demotedToken = await live(demoted);
    await system((tx) => tx.execute(sql`update agency_members set role = 'PARTNER' where user_id = ${demoted.userId}`));
    expect(await refusal(crm.calendarFeed(demotedToken))).toBe('CALENDAR_FEED_NOT_FOUND');

    const disabled = await member(a.agencyId);
    const disabledToken = await live(disabled);
    await system((tx) => tx.execute(sql`update users set status = 'DISABLED' where id = ${disabled.userId}`));
    expect(await refusal(crm.calendarFeed(disabledToken))).toBe('CALENDAR_FEED_NOT_FOUND');

    const c = await createFounder();
    const suspendedToken = await live(c);
    await setAgencyStatus(c.agencyId, 'SUSPENDED');
    expect(await refusal(crm.calendarFeed(suspendedToken))).toBe('CALENDAR_FEED_NOT_FOUND');
  });

  it('[S10-06] reused Idempotency-Key after 24 h → IDEMPOTENCY_KEY_REUSED', async () => {
    const key = `cal-old-${RUN}`;
    const first = await create(a, { type: 'CALL', title: title('stale'), ...slot(9) }, { idempotencyKey: key });
    await system((tx) =>
      tx.execute(sql`update calendar_events set created_at = now() - interval '48 hours' where id = ${first.event.id}`),
    );
    // the 24 h replay window has passed but the key's unique index has not: a refusal, not a 500
    expect(await refusal(create(a, { type: 'CALL', title: title('stale'), ...slot(9) }, { idempotencyKey: key }))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('[S11-F1] an event naming an unknown listing → LEAD_TARGET_NOT_FOUND', async () => {
    expect(
      await refusal(create(a, { type: 'VIEWING', title: title('nolisting'), ...slot(8), listingId: newId() })),
    ).toBe('LEAD_TARGET_NOT_FOUND');
  });

  it('[S11-F13] a calendar feed URL issued under the previous key resolves until the window ends', async () => {
    const NEW = 'test-hmac-key-rotated-0123456789abcdef01';
    const { token } = await as(a, (ctx) => crm.rotateCalendarFeed(ctx));
    const get = () => refusal(crm.calendarFeed(token));
    try {
      crm.configureCalendarFeeds({ tokenKey: NEW });
      expect(await get()).toBe('CALENDAR_FEED_NOT_FOUND'); // no window: the old URL's hash is not the new key's
      configureHmacRotation({ current: NEW, previous: KEY, previousUntil: new Date(Date.now() + 3_600_000) });
      expect((await crm.calendarFeed(token)).body).toContain('BEGIN:VCALENDAR');
      configureHmacRotation({ current: NEW, previous: KEY, previousUntil: new Date(Date.now() - 1) });
      expect(await get()).toBe('CALENDAR_FEED_NOT_FOUND');
      configureHmacRotation({ current: NEW, previous: KEY });
      expect((await crm.calendarFeed(token)).body).toContain('BEGIN:VCALENDAR');
      configureHmacRotation({ current: NEW });
      expect(await get()).toBe('CALENDAR_FEED_NOT_FOUND');
    } finally {
      configureHmacRotation({ current: NEW });
      crm.configureCalendarFeeds({ tokenKey: KEY });
    }
    expect((await crm.calendarFeed(token)).body).toContain('BEGIN:VCALENDAR');
  });
});
