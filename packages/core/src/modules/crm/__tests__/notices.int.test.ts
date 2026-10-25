import {
  CreateContactBody,
  CreateLeadBody,
  type CreateLeadInput,
  CreateTaskBody,
  UpdateLeadBody,
} from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import {
  closeEmail,
  configureEmail,
  createMemoryMailer,
  EmailSendError,
  type MemoryMailer,
} from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../index';

/**
 * S12-F2: the declared CRM notification types are raised — `LEAD_ASSIGNED` when a lead is assigned (a new lead, a
 * reassignment; from the outbox event, by `crm.notifyLeadAssigned`) and `TASK_DUE` when a task falls due (in the
 * reminder's send claim, in-app only).
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'crm-notices-test', level: 'silent' });
const job = () => ({ log, jobId: 'test', attempt: 1, progress: async () => {}, signal: new AbortController().signal });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.notices.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let a: Founder;
let agent: Founder;
let contactId: string;
let mail: MemoryMailer;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const createLead = (m: Founder, body: Omit<CreateLeadInput, 'contactId'>) =>
  as(m, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId, ...body })));

/** The notifications of `type` raised for this lead / task (`link`), per recipient. */
const raised = (type: string, link: string) =>
  rows<{
    user_id: string;
    actor_user_id: string | null;
    params: { subject: string };
    in_app: boolean;
    email_pending: boolean;
  }>(
    sql`select user_id, actor_user_id, params, in_app, email_pending from notifications
         where agency_id = ${a.agencyId} and type = ${type} and link = ${link}`,
  );

/** Delivers the lead's `type` outbox event to crm's subscriptions and returns the notify jobs they queued. */
async function deliver(type: 'crm.lead.created' | 'crm.lead.updated', leadId: string) {
  const events = await rows<{ id: string; payload: unknown; created_at: Date }>(sql`
    select id, payload, created_at from outbox_events
     where agency_id = ${a.agencyId} and type = ${type} and payload->>'leadId' = ${leadId}
     order by created_at desc, id limit 1`);
  const event = events[0];
  if (!event) throw new Error(`no ${type} event`);
  const meta = {
    eventId: event.id,
    agencyId: a.agencyId,
    type,
    version: 1,
    createdAt: new Date(event.created_at),
    attempt: 1,
  };
  crm.registerCrmSubscriptions();
  const enqueue = vi.spyOn(crm.crmJobs.notifyLeadAssigned, 'enqueue').mockResolvedValue({ id: 'x' });
  try {
    for (const sub of defaultSubscribers.get(type, 1)) {
      // only the notify subscription runs for real here; the others' jobs are not under test
      if (!sub.name?.startsWith('crm.notify.')) continue;
      await sub.handler(sub.def.schema.parse(event.payload), meta);
    }
    return enqueue.mock.calls.map((c) => c[0]);
  } finally {
    enqueue.mockRestore();
    crm.unregisterCrmSubscriptions();
  }
}
const runNotify = (payload: unknown) => {
  const spec = crm.crmJobs.notifyLeadAssigned.spec;
  return spec.run(spec.payload.parse(payload), job());
};

beforeAll(async () => {
  await setupTestDb('worker');
  mail = createMemoryMailer();
  await configureEmail(mail);
  a = await createFounder();
  const userId = newId();
  const email = `crm-notice-agent-${userId}@example.com`;
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${userId}, ${email}, 'x', 'Agent', 'en', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${a.agencyId}, ${userId}, 'AGENT', 'Agent', ${email})`);
  });
  agent = { userId, agencyId: a.agencyId, email, password: 'x' };
  contactId = (
    await as(a, (ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Nora', lastName: `Notice ${RUN}` })),
    )
  ).contact.id;
});

afterAll(async () => {
  await closeEmail();
  await closeDb();
});

describe('CRM notifications', () => {
  it('[S12-F2] assigning a lead raises one LEAD_ASSIGNED notification to the assignee (new lead, reassignment)', async () => {
    // a new lead entered by an admin for the agent
    const { lead } = await createLead(a, { assignedUserId: agent.userId });
    const jobs = await deliver('crm.lead.created', lead.id);
    expect(jobs).toEqual([
      expect.objectContaining({ leadId: lead.id, userId: agent.userId, assignedBy: a.userId, inbound: false }),
    ]);
    // the job runs twice (a redelivered event, a retry): one notification
    expect(await runNotify(jobs[0])).toEqual({ notified: 1 });
    expect(await runNotify(jobs[0])).toEqual({ notified: 0 });
    expect(await raised('LEAD_ASSIGNED', `/inbox/${lead.id}`)).toEqual([
      {
        user_id: agent.userId,
        actor_user_id: a.userId,
        params: { subject: `Nora Notice ${RUN}` },
        in_app: true,
        email_pending: true,
      },
    ]);

    // a lead the admin keeps: no event job; reassigned to the agent later: one notification
    const { lead: second } = await createLead(a, {});
    expect(second.assignedUserId).toBeNull();
    expect(await deliver('crm.lead.created', second.id)).toEqual([]);
    await as(a, (ctx) =>
      crm.updateLead(ctx, second.id, UpdateLeadBody.parse({ version: second.version, assignedUserId: agent.userId })),
    );
    const reassigned = await deliver('crm.lead.updated', second.id);
    expect(reassigned).toEqual([expect.objectContaining({ userId: agent.userId, assignedBy: a.userId })]);
    expect(await runNotify(reassigned[0])).toEqual({ notified: 1 });
    expect(await raised('LEAD_ASSIGNED', `/inbox/${second.id}`)).toHaveLength(1);
  });

  it('[S12-F2] assigning a lead to yourself, or a lead reassigned before the job ran, notifies no one', async () => {
    const { lead } = await createLead(a, { assignedUserId: a.userId });
    const jobs = await deliver('crm.lead.created', lead.id);
    expect(await runNotify(jobs[0])).toEqual({ notified: 0 });

    const { lead: moved } = await createLead(a, { assignedUserId: agent.userId });
    const first = await deliver('crm.lead.created', moved.id);
    await as(a, (ctx) =>
      crm.updateLead(ctx, moved.id, UpdateLeadBody.parse({ version: moved.version, assignedUserId: a.userId })),
    );
    // the agent no longer holds it when the job runs
    expect(await runNotify(first[0])).toEqual({ notified: 0 });
    expect(await raised('LEAD_ASSIGNED', `/inbox/${moved.id}`)).toEqual([]);

    // agent → admin → agent before any job ran: the agent hears of it once, from the latest event
    const { lead: back } = await createLead(a, { assignedUserId: agent.userId });
    const created = await deliver('crm.lead.created', back.id);
    const away = await as(a, (ctx) =>
      crm.updateLead(ctx, back.id, UpdateLeadBody.parse({ version: back.version, assignedUserId: a.userId })),
    );
    await as(a, (ctx) =>
      crm.updateLead(ctx, back.id, UpdateLeadBody.parse({ version: away.version, assignedUserId: agent.userId })),
    );
    const latest = await deliver('crm.lead.updated', back.id);
    expect(await runNotify(created[0])).toEqual({ notified: 0 });
    expect(await runNotify(latest[0])).toEqual({ notified: 1 });
    expect(await raised('LEAD_ASSIGNED', `/inbox/${back.id}`)).toHaveLength(1);
  });

  it('[S12-F2] a task falling due raises one TASK_DUE notification to its assignee, in-app only (the reminder is the e-mail)', async () => {
    const title = `Call the notary ${RUN}`;
    const { task } = await as(a, (ctx) =>
      crm.createTask(
        ctx,
        CreateTaskBody.parse({
          title,
          dueAt: new Date(Date.now() + 60_000).toISOString(),
          assignedUserId: agent.userId,
        }),
      ),
    );
    const due = new Date(task.dueAt ?? '').getTime();
    const { claimed } = await crm.sweepTaskReminders({ now: new Date(due + 1_000) });
    const claim = claimed.find((c) => c.taskId === task.id);
    expect(claim).toBeDefined();
    if (!claim) return;
    // run twice (redelivered / retried): one reminder, one notification
    const sends = [await crm.sendTaskReminder(claim), await crm.sendTaskReminder(claim)];
    expect(sends.filter((s) => s.sent)).toHaveLength(1);
    expect(mail.sent.filter((m) => m.to === agent.email && m.subject.includes(title))).toHaveLength(1);
    const notes = await raised('TASK_DUE', '/tasks');
    expect(notes.filter((n) => n.params.subject === title)).toEqual([
      { user_id: agent.userId, actor_user_id: null, params: { subject: title }, in_app: true, email_pending: false },
    ]);
  });

  it('[S12-F2] a reminder whose send failed and was claimed again leaves one TASK_DUE notification', async () => {
    const title = `Sign the deeds ${RUN}`;
    const { task } = await as(a, (ctx) =>
      crm.createTask(
        ctx,
        CreateTaskBody.parse({
          title,
          dueAt: new Date(Date.now() + 120_000).toISOString(),
          assignedUserId: agent.userId,
        }),
      ),
    );
    const due = new Date(task.dueAt ?? '').getTime();
    const claim = (await crm.sweepTaskReminders({ now: new Date(due + 1_000) })).claimed.find(
      (c) => c.taskId === task.id,
    );
    expect(claim).toBeDefined();
    if (!claim) return;
    // the provider refuses once (known not sent): the claim is given back, the retry claims and sends
    const fail = vi.spyOn(mail, 'send').mockRejectedValueOnce(new EmailSendError('refused', { notSent: true }));
    try {
      await expect(crm.sendTaskReminder(claim)).rejects.toThrow('refused');
    } finally {
      fail.mockRestore();
    }
    expect((await crm.sendTaskReminder(claim)).sent).toBe(true);
    const notes = (await raised('TASK_DUE', '/tasks')).filter((n) => n.params.subject === title);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.user_id).toBe(agent.userId);
  });
});
