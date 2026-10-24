import {
  CreateContactBody,
  CreateLeadBody,
  CreateTaskBody,
  type CreateTaskInput,
  ListActivitiesQuery,
  type ListTasksInput,
  ListTasksQuery,
  UpdateTaskBody,
  type UpdateTaskInput,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem, withTenant } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import {
  closeEmail,
  configureEmail,
  createMemoryMailer,
  EmailSendError,
  type MemoryMailer,
} from '@inmolink/platform/email';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../index';
import * as tasksRepo from '../tasks-repo';

/**
 * Tasks and reminders (S10-05): tasks about a contact / lead / listing with a due date and an assignee; one e-mail at
 * the due time (sweep claims with FOR UPDATE SKIP LOCKED + outbox event, the send job claims before it sends); completed,
 * deleted and rescheduled tasks; my-tasks list.
 */

const RUN = newId().slice(-8).toLowerCase();
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.tasks.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let a: Founder;
let b: Founder;
let agent: Founder;
let mail: MemoryMailer;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const create = (m: Founder, body: CreateTaskInput, opts: { idempotencyKey?: string } = {}) =>
  as(m, (ctx) => crm.createTask(ctx, CreateTaskBody.parse(body), opts));
const update = (m: Founder, id: string, body: UpdateTaskInput) =>
  as(m, (ctx) => crm.updateTask(ctx, id, UpdateTaskBody.parse(body)));
const list = (m: Founder, q: ListTasksInput = {}) => as(m, (ctx) => crm.listTasks(ctx, ListTasksQuery.parse(q)));
const title = (name: string) => `${name} ${RUN}`;
const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const ms = (iso: string | null) => new Date(iso ?? '').getTime();
/** The mails sent to `to` about tasks of this run whose subject carries `needle`. */
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

/** A claim of `taskIds` through concurrent sweeps at `now`: what each one took of them. */
async function sweepAt(now: Date, taskIds: readonly string[], passes = 1) {
  const results = await Promise.all(Array.from({ length: passes }, () => crm.sweepTaskReminders({ now })));
  return results.map((r) => r.claimed.filter((c) => taskIds.includes(c.taskId)));
}

beforeAll(async () => {
  await setupTestDb('worker');
  mail = createMemoryMailer();
  await configureEmail(mail);
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  const userId = newId();
  const agentEmail = `crm-task-agent-${userId}@example.com`;
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${userId}, ${agentEmail}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${a.agencyId}, ${userId}, 'AGENT', 'Agent', ${agentEmail})`);
  });
  agent = { userId, agencyId: a.agencyId, email: agentEmail, password: 'x' };
});

afterAll(async () => {
  await closeEmail();
  await closeDb();
});

describe('tasks', () => {
  it('[S10-05] a task about a contact or lead has a due date and an assignee, and lists in my tasks soonest first', async () => {
    const contact = (await as(a, (ctx) => crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Tess' }))))
      .contact;
    const lead = await as(a, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id })));
    const tag = title('mine');
    const late = await create(a, { title: `${tag} late`, dueAt: minutes(120).toISOString(), contactId: contact.id });
    const soon = await create(a, { title: `${tag} soon`, dueAt: minutes(30).toISOString(), leadId: lead.lead.id });
    const undated = await create(a, { title: `${tag} undated` });
    const theirs = await create(a, {
      title: `${tag} agent`,
      dueAt: minutes(10).toISOString(),
      assignedUserId: agent.userId,
    });
    expect(soon.task.contactId).toBe(contact.id); // a lead's task names the lead's contact
    expect(soon.task.assignedUserId).toBe(a.userId);

    const mine = (await list(a)).items.filter((t) => t.title.startsWith(tag));
    expect(mine.map((t) => t.id)).toEqual([soon.task.id, late.task.id, undated.task.id]);
    const everyones = (await list(a, { assignee: 'any' })).items.filter((t) => t.title.startsWith(tag));
    expect(everyones.map((t) => t.id)).toEqual([theirs.task.id, soon.task.id, late.task.id, undated.task.id]);
    const agents = (await list(a, { assignee: agent.userId })).items.filter((t) => t.title.startsWith(tag));
    expect(agents.map((t) => t.id)).toEqual([theirs.task.id]);
    const ofContact = await list(a, { assignee: 'any', contactId: contact.id });
    expect(ofContact.items.map((t) => t.id)).toEqual(expect.arrayContaining([soon.task.id, late.task.id]));
    const noDate = (await list(a, { noDue: 'true' })).items.filter((t) => t.title.startsWith(tag));
    expect(noDate.map((t) => t.id)).toEqual([undated.task.id]);
    const range = (
      await list(a, { dueFrom: minutes(60).toISOString(), dueTo: minutes(180).toISOString() })
    ).items.filter((t) => t.title.startsWith(tag));
    expect(range.map((t) => t.id)).toEqual([late.task.id]);
  });

  it('[S10-05] my tasks pages by keyset in one query', async () => {
    const tag = title('page');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await create(b, { title: `${tag} ${i}`, dueAt: minutes(500 + i).toISOString() })).task.id);
    ids.push((await create(b, { title: `${tag} none` })).task.id);
    const first = await list(b, { limit: 4 });
    const second = await list(b, { limit: 4, cursor: first.nextCursor ?? '' });
    expect([...first.items, ...second.items].map((t) => t.id)).toEqual(ids);
    expect(second.nextCursor).toBeNull();
    const setup = await countQueries(() => as(b, async () => null));
    const n = await countQueries(() => list(b, { limit: 100 }));
    expect(n - setup).toBe(1);
  });

  it('[S10-05] assignees must be active members of the agency; another agency neither sees nor changes a task', async () => {
    expect(await refusal(create(a, { title: title('x'), assignedUserId: b.userId }))).toBe('VALIDATION_FAILED');
    const mine = (await create(a, { title: title('private') })).task;
    expect(await refusal(as(b, (ctx) => crm.getTask(ctx, mine.id)))).toBe('TASK_NOT_FOUND');
    expect(await refusal(update(b, mine.id, { version: mine.version, title: 'x' }))).toBe('TASK_NOT_FOUND');
    expect(await refusal(as(b, (ctx) => crm.deleteTask(ctx, mine.id)))).toBe('TASK_NOT_FOUND');
    expect(await refusal(update(a, mine.id, { version: mine.version, assignedUserId: b.userId }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await refusal(create(a, { title: title('y'), contactId: newId() }))).toBe('CONTACT_NOT_FOUND');
    expect(await refusal(update(a, mine.id, { version: mine.version + 3, title: 'z' }))).toBe('VERSION_CONFLICT');
    const asClient = as(a, (ctx) => crm.listTasks({ ...ctx, clientMode: true }, ListTasksQuery.parse({})));
    expect(await refusal(asClient)).toBe('FORBIDDEN');
  });

  it('[S10-05] an Idempotency-Key replays the first task and refuses another body', async () => {
    const key = `task-${RUN}`;
    const first = await create(a, { title: title('idem') }, { idempotencyKey: key });
    const again = await create(a, { title: title('idem') }, { idempotencyKey: key });
    expect(again.replayed).toBe(true);
    expect(again.task.id).toBe(first.task.id);
    expect(await refusal(create(a, { title: title('other') }, { idempotencyKey: key }))).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('[S10-05] completing a task records TASK_COMPLETED on its contact’s timeline; reopening clears it', async () => {
    const contact = (await as(a, (ctx) => crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Done' }))))
      .contact;
    const t = (await create(a, { title: title('finish'), contactId: contact.id })).task;
    const done = await update(a, t.id, { version: t.version, status: 'DONE' });
    expect(done.status).toBe('DONE');
    expect(done.completedAt).not.toBeNull();
    const timeline = await as(a, (ctx) =>
      crm.listActivities(ctx, ListActivitiesQuery.parse({ subject: 'CONTACT', subjectId: contact.id })),
    );
    expect(timeline.items.filter((i) => i.type === 'TASK_COMPLETED')).toHaveLength(1);
    expect((await list(a, { status: 'DONE' })).items.map((x) => x.id)).toContain(t.id);
    expect((await list(a)).items.map((x) => x.id)).not.toContain(t.id);
    const reopened = await update(a, t.id, { version: done.version, status: 'OPEN' });
    expect(reopened).toMatchObject({ status: 'OPEN', completedAt: null });
  });

  it('[S10-05] a deleted task disappears from every list', async () => {
    const t = (await create(a, { title: title('gone') })).task;
    await as(a, (ctx) => crm.deleteTask(ctx, t.id));
    expect(await refusal(as(a, (ctx) => crm.getTask(ctx, t.id)))).toBe('TASK_NOT_FOUND');
    expect((await list(a, { assignee: 'any' })).items.map((x) => x.id)).not.toContain(t.id);
  });
});

describe('task rules', () => {
  it('[S10-05] a lead’s task cannot name another listing than the lead’s own', async () => {
    const contact = (await as(a, (ctx) => crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Lia' }))))
      .contact;
    const lead = await as(a, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id })));
    expect(await refusal(create(a, { title: title('lst'), leadId: lead.lead.id, listingId: newId() }))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('[S10-05] titles with control characters are refused; a range from a date leaves out undated tasks', async () => {
    expect(CreateTaskBody.safeParse({ title: 'Call\u0000me' }).success).toBe(false);
    expect(CreateTaskBody.safeParse({ title: 'Line\nbreak' }).success).toBe(false);
    expect(CreateTaskBody.safeParse({ title: 'ok', description: 'two\nlines' }).success).toBe(true);
    expect(CreateTaskBody.safeParse({ title: 'far', dueAt: '9500-01-01T00:00:00.000Z' }).success).toBe(false);
    const tag = title('from');
    const undated = (await create(a, { title: `${tag} none` })).task;
    const dated = (await create(a, { title: `${tag} dated`, dueAt: minutes(900).toISOString() })).task;
    const from = (await list(a, { dueFrom: minutes(800).toISOString() })).items.map((t) => t.id);
    expect(from).toContain(dated.id);
    expect(from).not.toContain(undated.id);
  });

  it('[S10-05] a purged listing leaves the tasks, at a new version; members cannot write the reminder marker', async () => {
    const t = (await create(a, { title: title('purge') })).task;
    const listingId = newId();
    await system((tx) => tx.execute(sql`update tasks set listing_id = ${listingId} where id = ${t.id}`));
    expect((await crm.forgetListingTasks({ agencyId: a.agencyId, listingId })).rows).toBe(1);
    const after = await as(a, (ctx) => crm.getTask(ctx, t.id));
    expect(after).toMatchObject({ listingId: null });
    expect(after.version).toBe(t.version + 1);
    for (const column of ['reminder_sent_for', 'idempotency_hash', 'request_hash']) {
      const value = column === 'reminder_sent_for' ? sql`now()` : sql`'x'`;
      await expect(
        withTenant({ agencyId: a.agencyId }, (tx) =>
          tx.execute(sql`update tasks set ${sql.raw(column)} = ${value} where id = ${t.id}`),
        ),
      ).rejects.toThrow();
    }
  });
});

describe('reminders', () => {
  it('[S10-05] a reminder fires once at the due time: two concurrent sweeps and a retried job send one e-mail', async () => {
    const t = (await create(a, { title: title('once'), dueAt: minutes(10).toISOString() })).task;
    const due = ms(t.dueAt);
    // before the due time: nothing
    expect((await sweepAt(new Date(due - 1_000), [t.id], 2)).flat()).toEqual([]);
    // at the due time, two sweeps race: exactly one claims the task
    const claims = (await sweepAt(new Date(due + 1_000), [t.id], 2)).flat();
    expect(claims).toEqual([{ taskId: t.id, agencyId: a.agencyId, dueMs: due, remindedMs: expect.any(Number) }]);
    const events = await rows<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where type = 'crm.task.reminderDue'
          and agency_id = ${a.agencyId} and payload->>'taskId' = ${t.id}`,
    );
    expect(events[0]?.n).toBe(1);
    // a later sweep finds it claimed
    expect((await sweepAt(new Date(due + 60_000), [t.id])).flat()).toEqual([]);

    // the job runs concurrently, again (redelivered / retried): one e-mail
    const claim = claims[0] as (typeof claims)[number];
    const sends = await Promise.all([crm.sendTaskReminder(claim), crm.sendTaskReminder(claim)]);
    await crm.sendTaskReminder(claim);
    expect(sends.filter((s) => s.sent)).toHaveLength(1);
    const sent = sentTo(a.email, t.title);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.tag).toBe('crm.task-reminder');
    expect(sent[0]?.text).toContain(t.title);
    expect((await as(a, (ctx) => crm.getTask(ctx, t.id))).reminderSent).toBe(true);
    expect(sent[0]?.idempotencyKey).toBe(`task-reminder:${t.id}:${due}`);
  });

  it('[S10-05] a send known not to have gone out gives the claim back: the retry sends, once', async () => {
    const t = (await create(a, { title: title('flaky'), dueAt: minutes(11).toISOString() })).task;
    const [claim] = (await sweepAt(new Date(ms(t.dueAt) + 1_000), [t.id])).flat();
    expect(claim).toBeDefined();
    const fail = vi.spyOn(mail, 'send').mockRejectedValueOnce(new EmailSendError('refused', { notSent: true }));
    await expect(crm.sendTaskReminder(claim as NonNullable<typeof claim>)).rejects.toThrow('refused');
    fail.mockRestore();
    expect(sentTo(a.email, t.title)).toHaveLength(0);
    expect((await crm.sendTaskReminder(claim as NonNullable<typeof claim>)).sent).toBe(true);
    expect((await crm.sendTaskReminder(claim as NonNullable<typeof claim>)).sent).toBe(false);
    expect(sentTo(a.email, t.title)).toHaveLength(1);
  });

  it('[S10-05] after an ambiguous failure (timeout, 5xx) the claim stays: the retry sends nothing, never a second mail', async () => {
    const t = (await create(a, { title: title('unsure'), dueAt: minutes(17).toISOString() })).task;
    const [claim] = (await sweepAt(new Date(ms(t.dueAt) + 1_000), [t.id])).flat();
    const fail = vi.spyOn(mail, 'send').mockRejectedValueOnce(new EmailSendError('resend send failed (503)'));
    await expect(crm.sendTaskReminder(claim as NonNullable<typeof claim>)).rejects.toThrow('503');
    fail.mockRestore();
    expect((await crm.sendTaskReminder(claim as NonNullable<typeof claim>)).sent).toBe(false);
    expect(sentTo(a.email, t.title)).toHaveLength(0);
  });

  it('[S10-05] reopening a done task re-arms its reminder (once per due time)', async () => {
    const t = (await create(a, { title: title('reopen'), dueAt: minutes(18).toISOString() })).task;
    const done = await update(a, t.id, { version: t.version, status: 'DONE' });
    const reopened = await update(a, t.id, { version: done.version, status: 'OPEN' });
    const [claim] = (await sweepAt(new Date(ms(t.dueAt) + 1_000), [t.id])).flat();
    expect(claim).toBeDefined();
    expect((await crm.sendTaskReminder(claim as NonNullable<typeof claim>)).sent).toBe(true);
    // done and reopened after the reminder went: re-armed, but the same due time is not mailed again
    const cur = await as(a, (ctx) => crm.getTask(ctx, t.id));
    const done2 = await update(a, t.id, { version: cur.version, status: 'DONE' });
    const again = await update(a, t.id, { version: done2.version, status: 'OPEN' });
    expect(again.reminderSent).toBe(true);
    const [second] = (await sweepAt(new Date(ms(t.dueAt) + 120_000), [t.id])).flat();
    expect(second).toBeDefined();
    expect((await crm.sendTaskReminder(second as NonNullable<typeof second>)).sent).toBe(false);
    expect(sentTo(a.email, t.title)).toHaveLength(1);
    expect(reopened.status).toBe('OPEN');
  });

  it('[S10-05] the sweep takes at most 50 reminders of one agency per batch, leaving room for the others', async () => {
    const due = new Date(Date.now() + 20 * 86_400_000).toISOString();
    for (let i = 0; i < 55; i++) await create(b, { title: title(`crowd ${i}`), dueAt: due });
    const mine = (await create(a, { title: title('crowd mine'), dueAt: due })).task;
    const batch = await system((tx) =>
      tasksRepo.claimDueReminders(tx, new Date(ms(due) + 1_000), crm.REMINDER_GRACE_MS, 200, 50),
    );
    expect(batch.filter((c) => c.agencyId === b.agencyId)).toHaveLength(50);
    expect(batch.map((c) => c.id)).toContain(mine.id);
  });

  it('[S10-05] reminders for completed or deleted tasks do not fire (nor those turned off or assigned to a gone member)', async () => {
    const dueAt = minutes(12).toISOString();
    const open = (await create(a, { title: title('r-open'), dueAt, assignedUserId: agent.userId })).task;
    const completed = (await create(a, { title: title('r-done'), dueAt })).task;
    const deleted = (await create(a, { title: title('r-del'), dueAt })).task;
    const off = (await create(a, { title: title('r-off'), dueAt, remind: false })).task;
    await update(a, completed.id, { version: completed.version, status: 'DONE' });
    await as(a, (ctx) => crm.deleteTask(ctx, deleted.id));
    const all = [open.id, completed.id, deleted.id, off.id];
    const claims = (await sweepAt(new Date(ms(dueAt) + 1_000), all)).flat();
    expect(claims.map((c) => c.taskId)).toEqual([open.id]);
    expect((await crm.sendTaskReminder(claims[0] as (typeof claims)[number])).sent).toBe(true);
    // the assignee's language: the agent's locale is `es`
    expect(sentTo(agent.email, open.title)[0]?.subject).toMatch(/^Tarea pendiente/);

    // completed or deleted after the sweep claimed it, before the job ran: nothing is sent
    const late = (await create(a, { title: title('r-late'), dueAt: minutes(13).toISOString() })).task;
    const [claim] = (await sweepAt(new Date(ms(late.dueAt) + 1_000), [late.id])).flat();
    await update(a, late.id, { version: late.version, status: 'DONE' });
    expect((await crm.sendTaskReminder(claim as NonNullable<typeof claim>)).sent).toBe(false);
    expect(sentTo(a.email, late.title)).toHaveLength(0);
  });

  it('[S10-05] a rescheduled due date re-arms the reminder; a job for the old time sends nothing', async () => {
    const t = (await create(a, { title: title('move'), dueAt: minutes(14).toISOString() })).task;
    const [first] = (await sweepAt(new Date(ms(t.dueAt) + 1_000), [t.id])).flat();
    expect((await crm.sendTaskReminder(first as NonNullable<typeof first>)).sent).toBe(true);
    const moved = await update(a, t.id, { version: t.version, dueAt: minutes(200).toISOString() });
    expect(moved.reminderSent).toBe(false);
    // the old claim's job (a redelivery) finds another due time
    expect((await crm.sendTaskReminder(first as NonNullable<typeof first>)).sent).toBe(false);
    // not yet due
    expect((await sweepAt(new Date(ms(moved.dueAt) - 1_000), [t.id])).flat()).toEqual([]);
    const [second] = (await sweepAt(new Date(ms(moved.dueAt) + 1_000), [t.id])).flat();
    expect(second?.dueMs).toBe(ms(moved.dueAt));
    expect((await crm.sendTaskReminder(second as NonNullable<typeof second>)).sent).toBe(true);
    expect(sentTo(a.email, t.title)).toHaveLength(2); // one per due time

    // moved after the sweep claimed, before the job: the claim is void and the new time reminds
    const t2 = (await create(a, { title: title('move2'), dueAt: minutes(15).toISOString() })).task;
    const [stale] = (await sweepAt(new Date(ms(t2.dueAt) + 1_000), [t2.id])).flat();
    const moved2 = await update(a, t2.id, { version: t2.version, dueAt: minutes(300).toISOString() });
    expect((await crm.sendTaskReminder(stale as NonNullable<typeof stale>)).sent).toBe(false);
    const [fresh] = (await sweepAt(new Date(ms(moved2.dueAt) + 1_000), [t2.id])).flat();
    expect((await crm.sendTaskReminder(fresh as NonNullable<typeof fresh>)).sent).toBe(true);
    expect(sentTo(a.email, t2.title)).toHaveLength(1);
  });

  it('[S10-05] a task created already overdue sends no reminder', async () => {
    const t = (await create(a, { title: title('overdue'), dueAt: minutes(-30).toISOString() })).task;
    expect((await sweepAt(new Date(), [t.id])).flat()).toEqual([]);
    expect((await list(a, { dueTo: new Date().toISOString() })).items.map((x) => x.id)).toContain(t.id);
  });

  it('[S10-05] the reminder event becomes one send job', async () => {
    const t = (await create(a, { title: title('wired'), dueAt: minutes(16).toISOString() })).task;
    await sweepAt(new Date(ms(t.dueAt) + 1_000), [t.id]);
    const enqueue = vi.spyOn(crm.crmJobs.sendTaskReminder, 'enqueue').mockResolvedValue({
      id: 'x',
      added: true,
    } as unknown as Awaited<ReturnType<typeof crm.crmJobs.sendTaskReminder.enqueue>>);
    crm.registerCrmSubscriptions();
    try {
      const [event] = await rows<{
        id: string;
        agency_id: string;
        version: number;
        payload: unknown;
        created_at: string;
      }>(
        sql`select id, agency_id, version, payload, created_at from outbox_events
            where type = 'crm.task.reminderDue' and agency_id = ${a.agencyId} and payload->>'taskId' = ${t.id}`,
      );
      const subs = defaultSubscribers.get('crm.task.reminderDue', event?.version ?? 1);
      expect(subs.map((s) => s.name)).toContain('crm.task.sendReminder');
      for (const sub of subs.filter((s) => s.name === 'crm.task.sendReminder')) {
        await sub.handler(sub.def.schema.parse(event?.payload), {
          eventId: event?.id ?? '',
          agencyId: event?.agency_id ?? '',
          type: 'crm.task.reminderDue',
          version: event?.version ?? 1,
          createdAt: new Date(event?.created_at ?? ''),
          attempt: 1,
        });
      }
      expect(enqueue).toHaveBeenCalledWith({
        agencyId: a.agencyId,
        taskId: t.id,
        dueMs: ms(t.dueAt),
        remindedMs: expect.any(Number),
      });
    } finally {
      crm.unregisterCrmSubscriptions();
      enqueue.mockRestore();
    }
  });

  it('[S10-05] reused Idempotency-Key after 24 h → IDEMPOTENCY_KEY_REUSED', async () => {
    const key = `task-old-${RUN}`;
    const first = await create(a, { title: title('stale') }, { idempotencyKey: key });
    await system((tx) =>
      tx.execute(sql`update tasks set created_at = now() - interval '48 hours' where id = ${first.task.id}`),
    );
    // the 24 h replay window has passed but the key's unique index has not: a refusal, not a 500
    expect(await refusal(create(a, { title: title('stale') }, { idempotencyKey: key }))).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
