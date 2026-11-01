import {
  CreateActivityBody,
  CreateContactBody,
  CreateLeadBody,
  CreateTaskBody,
  StartContactImportBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import { runContactImport } from '../import';
import * as crm from '../index';

/**
 * S16-F5, GDPR at scale (the S16-04 review): the system erasure is set-based — a batch of contacts is erased, audited
 * and announced in a constant number of statements, and its after-commit work too, whatever the batch's size — and
 * consent records are written by a contact import (`IMPORT`) and a merge (`MERGE`), not only by the dashboard.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'crm-gdpr-scale-test', level: 'silent' });
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.gdpr-scale.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const store = createMemoryStore();

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

/** `n` contacts of the agency (direct rows: the plan's contact quota is not what this test is about). */
async function seedContacts(m: Founder, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => newId());
  await system(async (tx) => {
    await tx.execute(sql`insert into contacts (id, agency_id, first_name, last_name, source, consent_marketing)
      select id, ${m.agencyId}::uuid, 'Batch' || n, ${`Person${RUN}`}, 'MANUAL', true
        from unnest(${sql.param(ids)}::uuid[]) with ordinality as u(id, n)`);
    await tx.execute(sql`insert into contact_emails (id, agency_id, contact_id, email, position)
      select gen_random_uuid(), ${m.agencyId}::uuid, id, 'batch' || n || ${`-${RUN}@scale.example`}, 0
        from unnest(${sql.param(ids)}::uuid[]) with ordinality as u(id, n)`);
  });
  return ids;
}

let a: Founder;
let b: Founder;

beforeAll(async () => {
  await setupTestDb('worker');
  configureStorage(store);
  [a, b] = await Promise.all([createFounder(), createFounder()]);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

describe('set-based erasure', () => {
  it('[S16-F5] erasing 100 contacts runs ≤ 10 statements per table batch (query count), the same as erasing 10', async () => {
    const big = await seedContacts(a, 100);
    const small = await seedContacts(b, 10);
    // something in each table the erasure touches, for a few of them
    for (const [m, id] of [
      [a, big[0]],
      [a, big[1]],
      [b, small[0]],
    ] as const) {
      const contactId = id as string;
      const { lead } = await as(m, (ctx) =>
        crm.createLead(ctx, CreateLeadBody.parse({ contactId, message: `secret ${RUN}` })),
      );
      await as(m, (ctx) =>
        crm.logActivity(ctx, CreateActivityBody.parse({ type: 'CALL', contactId, body: `call ${RUN}` })),
      );
      await as(m, (ctx) =>
        crm.logActivity(ctx, CreateActivityBody.parse({ type: 'OTHER', leadId: lead.id, body: `lead ${RUN}` })),
      );
      await as(m, (ctx) => crm.createTask(ctx, CreateTaskBody.parse({ title: `Ring ${RUN}`, contactId })));
    }

    const statements: string[] = [];
    let erased = 0;
    const bigErase = await countQueries(
      async () => {
        erased = await crm.eraseContactsBySystem({ agencyId: a.agencyId, contactIds: big, why: { kind: 'AGENCY' } });
      },
      { onQuery: (q) => statements.push(q) },
    );
    expect(erased).toBe(100);
    const smallErase = await countQueries(() =>
      crm.eraseContactsBySystem({ agencyId: b.agencyId, contactIds: small, why: { kind: 'AGENCY' } }),
    );
    // lock, erase (every crm table in one statement), audit rows, events — plus the tenant scope
    expect(bigErase).toBeLessThanOrEqual(10);
    expect(bigErase).toBe(smallErase);
    // one statement per table batch: each table is written by one statement, never one per contact
    for (const table of ['audit_logs', 'outbox_events']) {
      expect(statements.filter((q) => new RegExp(`insert into "?${table}"?`, 'i').test(q))).toHaveLength(1);
    }
    expect(statements.filter((q) => /update "?contacts"?/i.test(q))).toHaveLength(1);

    // the after-commit work of the batch (the agency erasure runs it inline): constant too
    const bigData = await countQueries(() =>
      crm.eraseContactsData({ agencyId: a.agencyId, contactIds: big, agencyErasure: true }),
    );
    const smallData = await countQueries(() =>
      crm.eraseContactsData({ agencyId: b.agencyId, contactIds: small, agencyErasure: true }),
    );
    expect(bigData).toBe(smallData);
    expect(bigData).toBeLessThanOrEqual(20);

    const [left] = await rows<{ open: number; emails: number; bodies: number; audits: number; events: number }>(sql`
      select (select count(*) from contacts where id = any(${sql.param(big)}::uuid[]) and deleted_at is null)::int as open,
        (select count(*) from contact_emails where contact_id = any(${sql.param(big)}::uuid[]))::int as emails,
        (select count(*) from activities where agency_id = ${a.agencyId} and body like ${`%${RUN}%`})::int as bodies,
        (select count(*) from audit_logs where agency_id = ${a.agencyId}
           and type in ('crm.contact.erased', 'crm.contact.erasureCompleted'))::int as audits,
        (select count(*) from outbox_events where agency_id = ${a.agencyId} and type = 'crm.contact.erased')::int as events`);
    expect(left).toEqual({ open: 0, emails: 0, bodies: 0, audits: 200, events: 100 });
  });
});

describe('consent records from imports and merges', () => {
  const csv = (lines: string[]) => new TextEncoder().encode(`${lines.join('\n')}\n`);
  const consents = (contactId: string) =>
    rows<{ purpose: string; granted: boolean; source: string; actor_user_id: string | null }>(
      sql`select purpose, granted, source, actor_user_id from consent_records where contact_id = ${contactId}
           order by recorded_at, purpose`,
    );

  it('[S16-F5] a contact import (IMPORT) and a merge (MERGE) write consent records', async () => {
    // an existing contact who never chose: the import's "yes" grants marketing (merged), a new row is created
    const { contact: existing } = await as(a, (ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Ines', emails: [`ines-${RUN}@imp.example`] })),
    );
    const upload = await crm.uploadContactImport(
      (fn) => as(a, fn),
      csv(['email,name,newsletter', `ines-${RUN}@imp.example,Ines Old,yes`, `nuno-${RUN}@imp.example,Nuno New,yes`]),
    );
    await as(a, (ctx) =>
      crm.startContactImport(
        ctx,
        upload.id,
        StartContactImportBody.parse({
          mapping: { emails: [0], fullName: 1, consentMarketing: 2 },
          onDuplicate: 'MERGE',
          consentProcessing: true,
        }),
      ),
    );
    await runContactImport({ agencyId: a.agencyId, importId: upload.id }, job());
    const done = await as(a, (ctx) => crm.getContactImport(ctx, upload.id));
    expect(done).toMatchObject({ status: 'SUCCEEDED', createdCount: 1, mergedCount: 1 });
    const [created] = await rows<{ id: string }>(
      sql`select contact_id as id from contact_emails where email = ${`nuno-${RUN}@imp.example`}`,
    );
    expect(await consents(created?.id as string)).toEqual([
      { purpose: 'MARKETING', granted: true, source: 'IMPORT', actor_user_id: null },
      { purpose: 'PROCESSING', granted: true, source: 'IMPORT', actor_user_id: null },
    ]);
    expect(await consents(existing.id)).toEqual([
      { purpose: 'MARKETING', granted: true, source: 'IMPORT', actor_user_id: null },
      { purpose: 'PROCESSING', granted: true, source: 'IMPORT', actor_user_id: null },
    ]);

    // a merge: the survivor never chose, the duplicate gave marketing consent → the survivor takes it (MERGE)
    const { contact: survivor } = await as(a, (ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Olga', emails: [`olga-${RUN}@m.example`] })),
    );
    const { contact: dup } = await as(a, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({ firstName: 'Olga', emails: [`olga2-${RUN}@m.example`], consentMarketing: true }),
      ),
    );
    await as(a, (ctx) => crm.mergeContacts(ctx, survivor.id, { duplicateId: dup.id, version: survivor.version }));
    expect(await consents(survivor.id)).toEqual([
      { purpose: 'MARKETING', granted: true, source: 'MERGE', actor_user_id: a.userId },
    ]);
    // nothing changed, nothing recorded: merging a contact with the same consent writes no record
    const { contact: dup2 } = await as(a, (ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: 'Olga', emails: [`olga3-${RUN}@m.example`] })),
    );
    const now = await as(a, (ctx) => crm.getContact(ctx, survivor.id));
    await as(a, (ctx) => crm.mergeContacts(ctx, survivor.id, { duplicateId: dup2.id, version: now.version }));
    expect(await consents(survivor.id)).toHaveLength(1);
  });
});
