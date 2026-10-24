import {
  CreateCalendarEventBody,
  CreateContactBody,
  type CreateContactInput,
  CreateLeadBody,
  CreateProspectBody,
  CreateTaskBody,
  ListActivitiesQuery,
  ListCalendarEventsQuery,
  ListContactsQuery,
  ListLeadsQuery,
  ListProspectsQuery,
  ListTasksQuery,
  PipelineBoardQuery,
  ProspectBoardQuery,
  ProspectFollowUpsQuery,
  StartContactImportBody,
} from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { createStaffUser, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as identity from '../../identity';
import * as crm from '../index';

/**
 * crm's audit trail (S11-F2): the ICS feed credential, contact merges and bulk imports each write one audit row in the
 * transaction of the change; client data read by staff impersonating a member is traceable in the audit log.
 */

const RUN = newId().slice(-8).toLowerCase();
const KEY = 'crm-audit-test-hmac-key-0123456789abcdef';
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.audit.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

interface AuditRow {
  type: string;
  actor_user_id: string | null;
  impersonated_by: string | null;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
}

const auditOf = (agencyId: string, requestId: string) =>
  rows<AuditRow>(sql`select type, actor_user_id, impersonated_by, target_type, target_id, request_id, metadata
    from audit_logs where agency_id = ${agencyId} and request_id = ${requestId} order by occurred_at, id`);

let a: Founder;
/** Runs `fn` as `m` with a known request id and answers the result and the audit rows that request wrote. */
async function audited<T>(m: Founder, fn: (ctx: Ctx) => Promise<T>): Promise<{ result: T; audit: AuditRow[] }> {
  const requestId = newId();
  const result = await withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId, locale: 'en' }, fn);
  return { result, audit: await auditOf(m.agencyId, requestId) };
}
const asA = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);
const create = async (body: CreateContactInput) =>
  (await asA((ctx) => crm.createContact(ctx, CreateContactBody.parse(body)))).contact;
const email = (name: string) => `${name}-${RUN}@example.com`;

beforeAll(async () => {
  await setupTestDb('worker');
  configureStorage(createMemoryStore());
  crm.configureCalendarFeeds({ tokenKey: KEY });
  a = await createFounder();
}, 120_000);

afterAll(async () => {
  await closeDb();
});

describe('credential and bulk changes', () => {
  it('[S11-F2] issuing, rotating and revoking the ICS feed each write one audit row (never the token)', async () => {
    const issued = await audited(a, (ctx) => crm.rotateCalendarFeed(ctx));
    expect(issued.audit).toHaveLength(1);
    const [first] = issued.audit;
    expect(first).toMatchObject({
      type: 'crm.calendarFeed.issued',
      actor_user_id: a.userId,
      impersonated_by: null,
      target_type: 'calendarFeed',
    });
    expect(JSON.stringify(first)).not.toContain(issued.result.token);

    const rotated = await audited(a, (ctx) => crm.rotateCalendarFeed(ctx));
    expect(rotated.audit).toHaveLength(1);
    expect(rotated.audit[0]).toMatchObject({
      type: 'crm.calendarFeed.rotated',
      actor_user_id: a.userId,
      metadata: { previousId: first?.target_id },
    });
    expect(rotated.audit[0]?.target_id).not.toBe(first?.target_id);
    expect(JSON.stringify(rotated.audit[0])).not.toContain(rotated.result.token);

    const revoked = await audited(a, (ctx) => crm.revokeCalendarFeed(ctx));
    expect(revoked.audit).toHaveLength(1);
    expect(revoked.audit[0]).toMatchObject({
      type: 'crm.calendarFeed.revoked',
      actor_user_id: a.userId,
      target_id: rotated.audit[0]?.target_id,
    });
    // revoking nothing changes nothing, and records nothing
    expect((await audited(a, (ctx) => crm.revokeCalendarFeed(ctx))).audit).toHaveLength(0);
  });

  it('[S11-F2] a contact merge writes one audit row naming the survivor and the closed contact', async () => {
    const survivor = await create({ firstName: 'Audit survivor', emails: [email('audit.s')] });
    const duplicate = await create({ firstName: 'Audit duplicate', emails: [email('audit.d')] });
    const { audit } = await audited(a, (ctx) =>
      crm.mergeContacts(ctx, survivor.id, { duplicateId: duplicate.id, version: survivor.version }),
    );
    expect(audit).toEqual([
      expect.objectContaining({
        type: 'crm.contact.merged',
        actor_user_id: a.userId,
        impersonated_by: null,
        target_type: 'contact',
        target_id: survivor.id,
        metadata: { mergedId: duplicate.id },
      }),
    ]);
  });

  it('[S11-F2] starting a bulk contact import writes one audit row (ids and settings, no file content)', async () => {
    const file = new TextEncoder().encode(`Name,Email\nAudit Row,${email('audit.imp')}\n`);
    const upload = await crm.uploadContactImport(
      (fn) => withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn),
      file,
    );
    const { audit } = await audited(a, (ctx) =>
      crm.startContactImport(
        ctx,
        upload.id,
        StartContactImportBody.parse({ mapping: { fullName: 0, emails: [1] }, onDuplicate: 'SKIP' }),
      ),
    );
    expect(audit).toEqual([
      expect.objectContaining({
        type: 'crm.contactImport.started',
        actor_user_id: a.userId,
        target_type: 'contactImport',
        target_id: upload.id,
        metadata: { kind: upload.kind, onDuplicate: 'SKIP', mappedColumns: 2 },
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain('audit.imp');
  });
});

describe('reads under impersonation', () => {
  it('[S11-F2] client data read by staff impersonating a member is in the audit log; the member’s own reads are not', async () => {
    const contact = await create({ firstName: 'Seen by staff', emails: [email('audit.seen')] });
    const support = await createStaffUser('STAFF_SUPPORT');
    const session = await withStaffCtx(
      { userId: support.userId, requestId: newId(), reason: 'crm audit test' },
      (ctx) =>
        identity.startImpersonation(ctx, {
          agencyId: a.agencyId,
          userId: a.userId,
          reason: 'Support ticket',
          minutes: 30,
        }),
    );
    const now = Date.now();
    const range = { from: new Date(now - 86_400_000).toISOString(), to: new Date(now + 86_400_000).toISOString() };
    const lead = (await asA((ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id })))).lead;
    const prospect = (await asA((ctx) => crm.createProspect(ctx, CreateProspectBody.parse({ title: `Audit ${RUN}` }))))
      .prospect;
    const task = (await asA((ctx) => crm.createTask(ctx, CreateTaskBody.parse({ title: `Audit ${RUN}` })))).task;
    const event = (
      await asA((ctx) =>
        crm.createCalendarEvent(
          ctx,
          CreateCalendarEventBody.parse({
            type: 'CALL',
            title: `Audit ${RUN}`,
            startsAt: new Date(now + 3_600_000).toISOString(),
            endsAt: new Date(now + 5_400_000).toISOString(),
          }),
        ),
      )
    ).event;
    const imports = await asA((ctx) => crm.listContactImports(ctx, { limit: 1 }));
    type Read = [string, (ctx: Ctx) => Promise<unknown>, { target_id?: string; metadata?: Record<string, unknown> }];
    const reads: Read[] = [
      ['contacts', (ctx) => crm.listContacts(ctx, ListContactsQuery.parse({})), {}],
      ['contacts', (ctx) => crm.getContact(ctx, contact.id), { target_id: contact.id }],
      ['contacts', (ctx) => crm.lookupContacts(ctx, { emails: [email('audit.seen')], phones: [] }), {}],
      ['contactNotes', (ctx) => crm.listContactNotes(ctx, contact.id, { limit: 25 }), {}],
      ['contactImports', (ctx) => crm.listContactImports(ctx, { limit: 25 }), {}],
      ['leads', (ctx) => crm.listLeads(ctx, ListLeadsQuery.parse({})), {}],
      ['leads', (ctx) => crm.getLead(ctx, lead.id), { target_id: lead.id }],
      ['stageHistory', (ctx) => crm.listLeadStageHistory(ctx, lead.id, { limit: 25 }), {}],
      [
        'pipeline',
        (ctx) => crm.getPipelineBoard(ctx, PipelineBoardQuery.parse({ assigned: 'unassigned' })),
        { metadata: { assigned: 'unassigned' } },
      ],
      [
        'pipeline',
        (ctx) => crm.listStageLeads(ctx, lead.stageId, { limit: 25, assigned: 'me' }),
        { metadata: { assigned: 'me', parentId: lead.stageId } },
      ],
      ['activities', (ctx) => crm.listActivities(ctx, ListActivitiesQuery.parse({})), {}],
      ['calendar', (ctx) => crm.listCalendarEvents(ctx, ListCalendarEventsQuery.parse(range)), {}],
      ['calendar', (ctx) => crm.getCalendarEvent(ctx, event.id), { target_id: event.id }],
      [
        'prospects',
        (ctx) => crm.listProspects(ctx, ListProspectsQuery.parse({ stage: 'NEW', assigned: 'me' })),
        { metadata: { stage: 'NEW', assigned: 'me' } },
      ],
      ['prospects', (ctx) => crm.listProspectFollowUps(ctx, ProspectFollowUpsQuery.parse(range)), {}],
      ['prospects', (ctx) => crm.getProspectBoard(ctx, ProspectBoardQuery.parse({})), {}],
      ['prospects', (ctx) => crm.listStageProspects(ctx, 'NEW', { limit: 25 }), { metadata: { stage: 'NEW' } }],
      ['prospects', (ctx) => crm.getProspect(ctx, prospect.id), { target_id: prospect.id }],
      ['tasks', (ctx) => crm.listTasks(ctx, ListTasksQuery.parse({})), {}],
      ['tasks', (ctx) => crm.getTask(ctx, task.id), { target_id: task.id }],
    ];
    const firstImport = imports.items[0];
    if (firstImport) {
      reads.push(['contactImports', (ctx) => crm.getContactImport(ctx, firstImport.id), { target_id: firstImport.id }]);
    }
    for (const [resource, read, expected] of reads) {
      const requestId = newId();
      await withMemberCtx(
        {
          userId: a.userId,
          agencyId: a.agencyId,
          requestId,
          locale: 'en',
          impersonation: { id: session.id, staffUserId: support.userId, sessionVersion: 1 },
        },
        read,
      );
      const audit = await auditOf(a.agencyId, requestId);
      expect(audit, resource).toEqual([
        expect.objectContaining({
          type: 'crm.clientData.read',
          actor_user_id: a.userId,
          impersonated_by: support.userId,
          metadata: expect.objectContaining({
            resource,
            view: expected.target_id ? 'get' : 'list',
            ...expected.metadata,
          }),
          ...(expected.target_id ? { target_id: expected.target_id } : { target_id: null }),
        }),
      ]);
    }
    // the member reading the same data records nothing
    for (const [, read] of reads) expect((await audited(a, read)).audit).toHaveLength(0);
  });
});
