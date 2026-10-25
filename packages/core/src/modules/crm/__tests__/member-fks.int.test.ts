import {
  CreateCalendarEventBody,
  CreateContactBody,
  CreateLeadBody,
  CreateProspectBody,
  CreateTaskBody,
} from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../index';

/**
 * CRM member foreign keys (S11-F5): an assignee, organizer, member attendee or feed owner that is not a member of the
 * row's agency (a stranger, or another agency's member) is refused by the database itself, whatever the service checks.
 */

const KEY = 'test-hmac-key-0123456789abcdef0123456789';
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.member-fks.test', fn);

let a: Founder;
let b: Founder;
/** A second member of `a`'s agency: a copy assigned to them is accepted (no unique key of the original's member). */
let agentId: string;
const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

/** The Postgres error code and constraint of a failed statement (drizzle wraps the driver's error in `cause`). */
function pgError(err: unknown): { code?: string; constraint?: string } {
  let e = err as { code?: string; constraint?: string; cause?: unknown } | undefined;
  while (e && !e.code && e.cause) e = e.cause as typeof e;
  return { code: e?.code, constraint: e?.constraint };
}

/**
 * Inserts a copy of `table`'s row `id` with a new id and `overrides` (generated columns are left to the database).
 * Returns the refusal, or 'accepted' (rolled back either way).
 */
async function insertCopy(
  table: string,
  id: string,
  overrides: Record<string, string>,
): Promise<{ code?: string; constraint?: string } | 'accepted'> {
  const ROLLBACK = new Error('rollback');
  try {
    await system(async (tx) => {
      const cols = (
        await tx.execute(sql`select column_name as name from information_schema.columns
          where table_schema = 'public' and table_name = ${table} and is_generated = 'NEVER' and is_identity = 'NO'
          order by ordinal_position`)
      ).rows.map((r) => (r as { name: string }).name);
      const values = cols.map((c) => (c in overrides ? sql`${overrides[c]}::${sql.raw(udt(c))}` : sql.identifier(c)));
      await tx.execute(
        sql`insert into ${sql.identifier(table)} (${sql.join(
          cols.map((c) => sql.identifier(c)),
          sql`, `,
        )}) select ${sql.join(values, sql`, `)} from ${sql.identifier(table)} where id = ${id}`,
      );
      throw ROLLBACK;
    });
  } catch (err) {
    if (err === ROLLBACK) return 'accepted';
    return pgError(err);
  }
  return 'accepted';
}
const udt = (column: string) => (column.endsWith('_hash') ? 'text' : 'uuid');

let rowsOf: { table: string; id: string; column: string; constraint: string; extra?: Record<string, string> }[];

beforeAll(async () => {
  await setupTestDb('worker');
  crm.configureCalendarFeeds({ tokenKey: KEY });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  agentId = newId();
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${agentId}, ${`crm-fk-agent-${agentId}@example.com`}, 'x', 'Agent', 'es', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${a.agencyId}, ${agentId}, 'AGENT', 'Agent', ${`crm-fk-agent-${agentId}@example.com`})`);
  });
  const contact = (await as(a, (ctx) => crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Fk' })))).contact;
  const task = await as(a, (ctx) => crm.createTask(ctx, CreateTaskBody.parse({ title: 'Call back' })));
  const lead = await as(a, (ctx) =>
    crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, assignedUserId: a.userId })),
  );
  const starts = new Date(Date.now() + 3_600_000);
  const event = await as(a, (ctx) =>
    crm.createCalendarEvent(
      ctx,
      CreateCalendarEventBody.parse({
        type: 'MEETING',
        title: 'Office',
        startsAt: starts.toISOString(),
        endsAt: new Date(starts.getTime() + 3_600_000).toISOString(),
      }),
    ),
  );
  await as(a, (ctx) => crm.rotateCalendarFeed(ctx));
  const prospect = await as(a, (ctx) =>
    crm.createProspect(ctx, CreateProspectBody.parse({ title: 'Villa owner', assignedUserId: a.userId })),
  );
  const ids = await system(async (tx) => {
    const r = await tx.execute(sql`select
        (select id from calendar_event_attendees where agency_id = ${a.agencyId} and event_id = ${event.event.id}
          and user_id = ${a.userId}) as attendee,
        (select id from calendar_feeds where agency_id = ${a.agencyId} and user_id = ${a.userId}
          and revoked_at is null) as feed`);
    return r.rows[0] as { attendee: string; feed: string };
  });
  rowsOf = [
    { table: 'tasks', id: task.task.id, column: 'assigned_user_id', constraint: 'tasks_assignee_member_fk' },
    { table: 'leads', id: lead.lead.id, column: 'assigned_user_id', constraint: 'leads_assignee_member_fk' },
    {
      table: 'calendar_events',
      id: event.event.id,
      column: 'organizer_user_id',
      constraint: 'calendar_events_organizer_member_fk',
    },
    {
      table: 'calendar_event_attendees',
      id: ids.attendee,
      column: 'user_id',
      constraint: 'calendar_event_attendees_member_fk',
    },
    {
      table: 'calendar_feeds',
      id: ids.feed,
      column: 'user_id',
      constraint: 'calendar_feeds_member_fk',
      extra: { token_hash: `s11f5-${newId()}` },
    },
    {
      table: 'seller_prospects',
      id: prospect.prospect.id,
      column: 'assigned_user_id',
      constraint: 'seller_prospects_assignee_member_fk',
    },
  ];
});

afterAll(async () => {
  await closeDb();
});

describe('member foreign keys (S11-F5)', () => {
  it('[S11-F5] inserting a non-member assignee fails at the DB (tasks, leads, events, attendees, feeds, prospects)', async () => {
    for (const r of rowsOf) {
      // the copy itself is accepted with the agency's own member: only the member column is what is refused
      expect(await insertCopy(r.table, r.id, { id: newId(), [r.column]: agentId, ...r.extra }), r.table).toBe(
        'accepted',
      );
      for (const outsider of [newId(), b.userId]) {
        expect(await insertCopy(r.table, r.id, { id: newId(), [r.column]: outsider, ...r.extra }), r.table).toEqual({
          code: '23503',
          constraint: r.constraint,
        });
      }
    }
  });

  it('[S12-F17] the six S11-F5 member FKs are validated (the leads one since migration 0150)', async () => {
    const rows = await system(async (tx) => {
      const res = await tx.execute(sql`
        select conname, convalidated from pg_constraint
         where conname in ('leads_assignee_member_fk', 'tasks_assignee_member_fk', 'calendar_events_organizer_member_fk',
                           'calendar_event_attendees_member_fk', 'calendar_feeds_member_fk',
                           'seller_prospects_assignee_member_fk')
         order by conname`);
      return res.rows as { conname: string; convalidated: boolean }[];
    });
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r.convalidated, r.conname).toBe(true);
  });

  it('[S11-F5] re-assigning to a non-member fails at the DB', async () => {
    for (const r of rowsOf) {
      const refused = await system((tx) =>
        tx.execute(sql`update ${sql.identifier(r.table)} set ${sql.identifier(r.column)} = ${b.userId}
          where id = ${r.id}`),
      ).then(
        () => 'accepted' as const,
        (err) => pgError(err),
      );
      expect(refused, r.table).toEqual({ code: '23503', constraint: r.constraint });
    }
  });
});
