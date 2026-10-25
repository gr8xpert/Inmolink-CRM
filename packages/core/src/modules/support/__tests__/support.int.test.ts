import {
  CreateSupportTicketBody,
  StaffPostSupportMessageBody,
  type StaffSupportTicketSummaryDto,
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_THREAD_LIMIT,
} from '@inmolink/contracts';
import { closeDb, getPgClient } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { closeEmail, configureEmail, createMemoryMailer, type MemoryMailer } from '@inmolink/platform/email';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { emit } from '@inmolink/platform/outbox';
import { configureStorage, createS3Store, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, CtxRunner, StaffCtx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as support from '../index';

/** Support tickets end to end on the test database and MinIO (S13-05). */

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const log = createLogger({ service: 'support-int', level: 'silent' });
let admin: Awaited<ReturnType<typeof getPgClient>>;
let mail: MemoryMailer;
let agent: string;
let dataOps: string;

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  admin = await getPgClient('app_system');
  mail = createMemoryMailer();
  await configureEmail(mail);
  support.configureSupport({ webUrl: 'http://web.test', staffInbox: 'support@inmolink.test' });
  agent = (await createStaffUser('STAFF_SUPPORT')).userId;
  dataOps = (await createStaffUser('STAFF_DATA_OPS')).userId;
}, 120_000);

afterAll(async () => {
  admin?.release();
  await closeEmail();
  await closeDb();
});

const as = <T>(f: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId() }, fn);
const runner =
  (f: Founder): CtxRunner =>
  (fn) =>
    as(f, fn);
const asStaff = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'support int test' }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    const cause = (err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message;
    return /row-level security|permission denied/.test(cause) ? 'RLS' : `unexpected: ${cause}`;
  }
  return 'accepted';
}

const founder = () => createFounder({ companyName: `Support ${newId().slice(-6)} S.L.` });
const open = (f: Founder, subject = 'Feed import stopped') =>
  as(f, (c) =>
    support.createTicket(
      c,
      CreateSupportTicketBody.parse({
        subject,
        category: 'IMPORTS',
        priority: 'HIGH',
        body: 'Since Monday.\nPlease help.',
      }),
    ),
  );
const staffPost = (id: string, body: string, internal: boolean, userId = agent) =>
  asStaff(userId, (c) => support.postStaffMessage(c, { id, ...StaffPostSupportMessageBody.parse({ body, internal }) }));
const jobCtx = () => ({
  log,
  jobId: newId(),
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

describe('support tickets', () => {
  it("[S13-05] agency users see only their agency's tickets", async () => {
    const a = await founder();
    const b = await founder();
    const ticket = await open(a);
    expect(ticket).toMatchObject({ status: 'OPEN', priority: 'HIGH', category: 'IMPORTS' });
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0]).toMatchObject({
      author: 'AGENCY',
      authorName: 'Ana',
      body: 'Since Monday.\nPlease help.',
    });

    const mine = await as(a, (c) => support.listTickets(c, { limit: 25 }));
    expect(mine.items.map((t) => t.id)).toContain(ticket.id);
    const theirs = await as(b, (c) => support.listTickets(c, { limit: 25 }));
    expect(theirs.items.map((t) => t.id)).not.toContain(ticket.id);

    // Every path of another agency answers as if the ticket did not exist.
    expect(await refusal(as(b, (c) => support.getTicket(c, { id: ticket.id })))).toBe('NOT_FOUND');
    expect(await refusal(as(b, (c) => support.postMessage(c, { id: ticket.id, body: 'hi' })))).toBe('NOT_FOUND');
    expect(await refusal(as(b, (c) => support.resolveTicket(c, { id: ticket.id })))).toBe('NOT_FOUND');
    expect(await refusal(support.uploadAttachment(runner(b), { id: ticket.id, fileName: 'x.pdf', body: PDF }))).toBe(
      'NOT_FOUND',
    );
    // And RLS itself: raw reads of the other agency's rows return nothing.
    const raw = await as(b, async (c) => {
      const t = await c.tx.execute(sql`select id from support_tickets where id = ${ticket.id}::uuid`);
      const m = await c.tx.execute(sql`select id from support_ticket_messages where ticket_id = ${ticket.id}::uuid`);
      return t.rows.length + m.rows.length;
    });
    expect(raw).toBe(0);
  });

  it('[S13-05] internal notes are never visible to agencies', async () => {
    const f = await founder();
    const ticket = await open(f);
    await staffPost(ticket.id, 'Customer on the legacy feed parser; escalate to data ops.', true);
    const afterReply = await staffPost(ticket.id, 'We are looking into it.', false);
    // Staff see both, the note marked internal.
    expect(afterReply.messages.map((m) => [m.author, m.internal])).toEqual([
      ['AGENCY', false],
      ['STAFF', true],
      ['STAFF', false],
    ]);

    // The service: no note, no internal field, no staff member's name.
    const view = await as(f, (c) => support.getTicket(c, { id: ticket.id }));
    expect(view.messages.map((m) => m.body)).toEqual(['Since Monday.\nPlease help.', 'We are looking into it.']);
    expect(JSON.stringify(view)).not.toContain('legacy feed parser');
    expect(view.messages[1]).toEqual(expect.objectContaining({ author: 'STAFF', authorName: null }));
    expect(view.messages[1]).not.toHaveProperty('internal');
    expect(view.status).toBe('PENDING');

    // The database: a raw query as the member sees only the two messages, and the notes table is out of reach
    // altogether (no grant for any tenant role) — reading, writing or changing a note is refused.
    const rows = await as(f, async (c) => {
      const r = await c.tx.execute<{ body: string }>(
        sql`select body from support_ticket_messages where ticket_id = ${ticket.id}::uuid`,
      );
      return r.rows.map((x) => x.body);
    });
    expect(rows).toEqual(['Since Monday.\nPlease help.', 'We are looking into it.']);
    for (const statement of [
      sql`select body from support_ticket_notes where ticket_id = ${ticket.id}::uuid`,
      sql`select count(*) from support_ticket_notes`,
      sql`insert into support_ticket_notes (id, ticket_id, author_user_id, author_name, body)
        values (${newId()}::uuid, ${ticket.id}::uuid, ${f.userId}::uuid, 'x', 'forged note')`,
      sql`update support_ticket_notes set body = 'x' where ticket_id = ${ticket.id}::uuid`,
    ]) {
      expect(await refusal(as(f, (c) => c.tx.execute(statement)))).toBe('RLS');
    }
    // Nor may a member post as staff.
    expect(
      await refusal(
        as(f, (c) =>
          c.tx.execute(sql`insert into support_ticket_messages
            (id, agency_id, ticket_id, author_kind, author_user_id, author_name, body)
            values (${newId()}::uuid, ${f.agencyId}::uuid, ${ticket.id}::uuid, 'STAFF', ${f.userId}::uuid, 'x', 'forged reply')`),
        ),
      ),
    ).toBe('RLS');

    // A note emits no event (so no e-mail can carry one); the reply does.
    const events = await admin.query<{ author: string }>(
      `select payload->>'author' as author from outbox_events
        where agency_id = $1 and type = 'support.message.posted' and payload->>'ticketId' = $2 order by created_at`,
      [f.agencyId, ticket.id],
    );
    expect(events.rows.map((r) => r.author)).toEqual(['AGENCY', 'STAFF']);
  });

  it('[S13-05] attachments: magic bytes, 10 MB and 5 per ticket, private signed links', async () => {
    const f = await founder();
    const ticket = await open(f);
    const up = (body: Uint8Array, fileName = 'scan') =>
      support.uploadAttachment(runner(f), { id: ticket.id, fileName, body });

    const first = await up(PDF);
    expect(first).toMatchObject({ fileName: 'scan.pdf', contentType: 'application/pdf', sizeBytes: PDF.byteLength });
    // Retried upload of the same file: the same attachment.
    expect((await up(PDF)).id).toBe(first.id);
    expect(await refusal(up(new TextEncoder().encode('MZ not a pdf'), 'evil.pdf'))).toBe('DOCUMENT_TYPE_NOT_ALLOWED');
    expect(await refusal(up(new Uint8Array(SUPPORT_ATTACHMENT_MAX_BYTES + 1)))).toBe('PAYLOAD_TOO_LARGE');
    for (let i = 0; i < 4; i += 1) await up(new TextEncoder().encode(`%PDF-1.7\n% file ${i}\n%%EOF\n`), `f${i}`);
    expect(await refusal(up(new TextEncoder().encode('%PDF-1.7\n% sixth\n%%EOF\n')))).toBe('DOCUMENT_LIMIT_REACHED');
    const view = await as(f, (c) => support.getTicket(c, { id: ticket.id }));
    expect(view.attachments).toHaveLength(5);

    const own = await as(f, (c) => support.getAttachmentUrl(c, { id: ticket.id, attachmentId: first.id }));
    const staff = await asStaff(agent, (c) =>
      support.getStaffAttachmentUrl(c, { id: ticket.id, attachmentId: first.id }),
    );
    for (const link of [own, staff]) {
      const res = await fetch(link.url);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    }
    // A member cannot re-point an attachment at another object (no UPDATE of storage_key).
    expect(
      await refusal(
        as(f, (c) =>
          c.tx.execute(
            sql`update support_ticket_attachments set storage_key = 'verification/x' where id = ${first.id}::uuid`,
          ),
        ),
      ),
    ).toBe('RLS');
  });

  it('[S13-05] staff queue and triage; data ops read but never reply', async () => {
    const f = await founder();
    const ticket = await open(f, `Queue check ${newId().slice(-6)}`);
    let found: StaffSupportTicketSummaryDto | undefined;
    let cursor: string | undefined;
    do {
      const page = await asStaff(dataOps, (c) => support.listQueue(c, { status: 'OPEN', limit: 100, cursor }));
      found = page.items.find((i) => i.id === ticket.id);
      cursor = page.nextCursor ?? undefined;
    } while (!found && cursor);
    expect(found?.agency.id).toBe(f.agencyId);
    expect(found?.agency.name).toMatch(/^Support /);

    expect(await refusal(staffPost(ticket.id, 'note', true, dataOps))).toBe('FORBIDDEN');
    expect(
      await refusal(asStaff(dataOps, (c) => support.updateStaffTicket(c, { id: ticket.id, status: 'RESOLVED' }))),
    ).toBe('FORBIDDEN');

    const triaged = await asStaff(agent, (c) =>
      support.updateStaffTicket(c, { id: ticket.id, priority: 'URGENT', assignee: 'ME', status: 'RESOLVED' }),
    );
    expect(triaged).toMatchObject({ priority: 'URGENT', assigneeUserId: agent, status: 'RESOLVED' });
    expect(triaged.resolvedAt).not.toBeNull();
    // A member's reply reopens it for staff.
    const reopened = await as(f, (c) => support.postMessage(c, { id: ticket.id, body: 'Still broken.' }));
    expect(reopened).toMatchObject({ status: 'OPEN', resolvedAt: null });
    // Members never change who is assigned (column grant).
    expect(
      await refusal(
        as(f, (c) =>
          c.tx.execute(sql`update support_tickets set assignee_user_id = null where id = ${ticket.id}::uuid`),
        ),
      ),
    ).toBe('RLS');
  });

  it('[S13-05] e-mail notifications are sent by the worker job: inbox for new tickets, the member for staff replies, never a note', async () => {
    const f = await founder();
    const ticket = await open(f, 'Website down');
    const firstMessage = ticket.messages[0]?.id as string;
    const withNote = await staffPost(ticket.id, 'Internal: check the DNS first.', true);
    const noteId = withNote.messages.find((m) => m.internal)?.id as string;
    const withReply = await staffPost(ticket.id, 'Your DNS points elsewhere.', false);
    const replyId = withReply.messages.at(-1)?.id as string;

    const before = mail.sent.length;
    const run = (messageId: string, isNew: boolean) =>
      support.supportJobs.sendMessageEmail.spec.run(
        { eventId: newId(), agencyId: f.agencyId, messageId, isNew },
        jobCtx(),
      );
    await run(firstMessage, true);
    await run(replyId, false);
    await run(noteId, false);
    const sent = mail.sent.slice(before);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ to: 'support@inmolink.test', tag: 'support.ticket-new' });
    expect(sent[0]?.subject).toContain('Website down');
    expect(sent[0]?.text).toContain(`http://web.test/en/staff/support/${ticket.id}`);
    // The founder's locale is Spanish: a Spanish e-mail linking to the ticket, without the message text.
    expect(sent[1]).toMatchObject({ to: f.email, tag: 'support.staff-reply' });
    expect(sent[1]?.subject).toContain('Website down');
    expect(sent[1]?.text).toContain(`http://web.test/es/support/${ticket.id}`);
    for (const m of sent) {
      expect(m.text).not.toContain('DNS');
      expect(m.html).not.toContain('DNS');
    }
  });
  it('[S13-05] members cannot remove tickets, messages or attachments, nor rewrite what staff or the thread own', async () => {
    const f = await founder();
    const ticket = await open(f);
    const file = await support.uploadAttachment(runner(f), { id: ticket.id, fileName: 'scan', body: PDF });
    for (const statement of [
      sql`delete from support_tickets where id = ${ticket.id}::uuid`,
      sql`delete from support_ticket_messages where ticket_id = ${ticket.id}::uuid`,
      sql`delete from support_ticket_attachments where id = ${file.id}::uuid`,
      sql`update support_ticket_messages set body = 'rewritten' where ticket_id = ${ticket.id}::uuid`,
      sql`update support_ticket_attachments set file_name = 'x.pdf' where id = ${file.id}::uuid`,
      sql`update support_tickets set subject = 'renamed' where id = ${ticket.id}::uuid`,
      sql`update support_tickets set priority = 'URGENT' where id = ${ticket.id}::uuid`,
      sql`update support_tickets set category = 'BUG' where id = ${ticket.id}::uuid`,
    ]) {
      expect(await refusal(as(f, (c) => c.tx.execute(statement)))).toBe('RLS');
    }
    // A message can only name a ticket of its own agency (composite FK), whatever the statement.
    const other = await founder();
    const fk = await refusal(
      as(other, (c) =>
        c.tx.execute(sql`insert into support_ticket_messages (id, agency_id, ticket_id, author_kind, author_user_id, author_name, body)
          values (${newId()}::uuid, ${other.agencyId}::uuid, ${ticket.id}::uuid, 'AGENCY', ${other.userId}::uuid, 'x', 'hi')`),
      ),
    );
    expect(fk).toMatch(/foreign key|unexpected/);
  });

  it('[S13-05] only support agents may announce a staff reply: a read-only staff role cannot append support.message.posted', async () => {
    const f = await founder();
    const ticket = await open(f);
    const event = () =>
      support.supportEvents.messagePosted({ ticketId: ticket.id, messageId: newId(), author: 'STAFF', isNew: false });
    const err = await asStaff(dataOps, (c) => emit(c.tx, event(), { agencyId: f.agencyId })).then(
      () => null,
      (e: unknown) => e as { cause?: { message?: string }; message?: string },
    );
    expect(err?.cause?.message ?? err?.message).toMatch(/row-level security/);
    // A support agent may (the staff reply path).
    await asStaff(agent, (c) => emit(c.tx, event(), { agencyId: f.agencyId }));
  });

  it('[S13-05] long threads page with a keyset cursor; staff see the notes of the same span', async () => {
    const f = await founder();
    const ticket = await open(f, 'Long thread');
    // SUPPORT_THREAD_LIMIT + 4 more member messages, one millisecond apart (app_system: a fixture, not a request).
    await admin.query(
      `insert into support_ticket_messages (id, agency_id, ticket_id, author_kind, author_user_id, author_name, body, created_at)
       select gen_random_uuid(), $1, $2, 'AGENCY', $3, 'Ana', 'message ' || n, now() + n * interval '1 millisecond'
       from generate_series(1, $4::int) n`,
      [f.agencyId, ticket.id, f.userId, SUPPORT_THREAD_LIMIT + 4],
    );
    await staffPost(ticket.id, 'Note on the latest page.', true);
    const latest = await as(f, (c) => support.getTicket(c, { id: ticket.id }));
    expect(latest.messages).toHaveLength(SUPPORT_THREAD_LIMIT);
    expect(latest.messages.at(-1)?.body).toBe(`message ${SUPPORT_THREAD_LIMIT + 4}`);
    expect(latest.olderMessagesCursor).not.toBeNull();
    const older = await as(f, (c) =>
      support.getTicket(c, { id: ticket.id, before: latest.olderMessagesCursor ?? undefined }),
    );
    // The first message and messages 1…4: the conversation's start, no further page.
    expect(older.messages.map((m) => m.body)).toEqual([
      'Since Monday.\nPlease help.',
      'message 1',
      'message 2',
      'message 3',
      'message 4',
    ]);
    expect(older.olderMessagesCursor).toBeNull();

    const staffLatest = await asStaff(agent, (c) => support.getStaffTicket(c, { id: ticket.id }));
    expect(staffLatest.messages.filter((m) => m.internal).map((m) => m.body)).toEqual(['Note on the latest page.']);
    const staffOlder = await asStaff(agent, (c) =>
      support.getStaffTicket(c, { id: ticket.id, before: staffLatest.olderMessagesCursor ?? undefined }),
    );
    expect(staffOlder.messages.some((m) => m.internal)).toBe(false);
    expect(staffOlder.messages).toHaveLength(5);
  });

  it('[S13-05] staff replies, notes and triage are audited (ids and enums only, never the text)', async () => {
    const f = await founder();
    const ticket = await open(f);
    await staffPost(ticket.id, 'Secret note text', true);
    await staffPost(ticket.id, 'Reply text', false);
    await asStaff(agent, (c) => support.updateStaffTicket(c, { id: ticket.id, status: 'RESOLVED', assignee: 'ME' }));
    const rows = await admin.query<{ type: string; actor_user_id: string; metadata: Record<string, unknown> }>(
      `select type, actor_user_id, metadata from audit_logs
        where agency_id = $1 and target_type = 'supportTicket' and target_id = $2 order by occurred_at`,
      [f.agencyId, ticket.id],
    );
    expect(rows.rows.map((r) => r.type)).toEqual([
      'staff.support.noted',
      'staff.support.replied',
      'staff.support.triaged',
    ]);
    expect(rows.rows.every((r) => r.actor_user_id === agent)).toBe(true);
    expect(rows.rows[2]?.metadata).toMatchObject({ from: 'PENDING', status: 'RESOLVED', assignee: 'ME' });
    expect(JSON.stringify(rows.rows)).not.toMatch(/Secret note text|Reply text/);
  });
});
