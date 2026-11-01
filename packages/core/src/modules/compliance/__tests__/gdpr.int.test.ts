import { inflateRawSync } from 'node:zlib';
import {
  ConvertProspectBody,
  CreateActivityBody,
  CreateContactBody,
  CreateContactNoteBody,
  CreateLeadBody,
  CreateProspectBody,
  RETENTION_GRACE_DAYS,
  UpdateContactBody,
} from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { readSheetRows } from '@inmolink/platform/sheet';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as crm from '../../crm';
import * as compliance from '../index';
import { runDataExport } from '../worker';

/**
 * GDPR flows (S16-04): consent records, the data subject export (`SUBJECT`, a ZIP of one person's data), the retention
 * period and its anonymization job, and an erasure expiring the person's exports.
 */

const RUN = newId().slice(-8).toLowerCase();
const STAFF = '01900000-0000-7000-8000-0000000000bc';
const log = createLogger({ service: 'gdpr-test', level: 'silent' });
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('compliance.gdpr.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const store = createMemoryStore();

let a: Founder;
let b: Founder;
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

const subjectExport = (m: Founder, contactId: string | undefined, kind = 'SUBJECT') =>
  as(m, (ctx) =>
    compliance.createDataExport(
      ctx,
      { kind: kind as 'SUBJECT', format: 'csv', ...(contactId ? { contactId } : {}) },
      {
        verifyStepUp: async () => {},
        subjectExists: (id) => crm.openContactExists(ctx.tx, ctx.tenant.agencyId, id),
      },
    ),
  );

/** A ZIP's entries by name (central directory; stored or inflated). */
function unzip(zip: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(zip);
  const eocd = buf.length - 22;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const local = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(local, local + compressed);
    out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    p += 46 + nameLength;
  }
  return out;
}

const sheet = async (bytes: Uint8Array): Promise<string[][]> => {
  const out: string[][] = [];
  for await (const r of readSheetRows(bytes)) out.push(r.cells);
  return out;
};

const person = async (m: Founder, name: string, consentMarketing = false) =>
  (
    await as(m, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({
          firstName: name,
          emails: [`${name.toLowerCase()}@gdpr-${RUN}.example`],
          consentMarketing,
        }),
      ),
    )
  ).contact;

beforeAll(async () => {
  await setupTestDb('worker');
  configureStorage(store);
  [a, b] = await Promise.all([createFounder(), createFounder()]);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

describe('consent records', () => {
  it('[S16-04] every consent given or withdrawn is a consent record (who, where, when; no PII), listed newest first', async () => {
    const c = await person(a, `Cora${RUN}`, true);
    const v1 = await as(a, (ctx) => crm.getContact(ctx, c.id));
    await as(a, (ctx) =>
      crm.updateContact(
        ctx,
        c.id,
        UpdateContactBody.parse({ version: v1.version, consentMarketing: false, consentProcessing: true }),
      ),
    );
    // a change that changes nothing records nothing
    const v2 = await as(a, (ctx) => crm.getContact(ctx, c.id));
    await as(a, (ctx) =>
      crm.updateContact(ctx, c.id, UpdateContactBody.parse({ version: v2.version, consentProcessing: true })),
    );
    const list = await as(a, (ctx) => crm.listContactConsents(ctx, c.id));
    expect(list.items.map((r) => [r.purpose, r.granted, r.source, r.actorUserId])).toEqual(
      expect.arrayContaining([
        ['MARKETING', true, 'DASHBOARD', a.userId],
        ['MARKETING', false, 'DASHBOARD', a.userId],
        ['PROCESSING', true, 'DASHBOARD', a.userId],
      ]),
    );
    expect(list.items).toHaveLength(3);
    expect(list.items[2]).toMatchObject({ purpose: 'MARKETING', granted: true });
    // another agency sees none of them; members cannot rewrite or remove the evidence
    expect(await refusal(as(b, (ctx) => crm.listContactConsents(ctx, c.id)))).toBe('CONTACT_NOT_FOUND');
    const tamper = (q: ReturnType<typeof sql>) =>
      as(a, (ctx) => ctx.tx.execute(q)).then(
        () => 'accepted',
        (e: { cause?: { code?: string } }) => e.cause?.code ?? 'error',
      );
    expect(await tamper(sql`update consent_records set granted = true where contact_id = ${c.id}`)).toBe('42501');
    expect(await tamper(sql`delete from consent_records where contact_id = ${c.id}`)).toBe('42501');
  });
});

describe('data subject export', () => {
  it('[S16-04] a SUBJECT export is one person’s ZIP — contact, notes, leads, tasks, activities and consents — and nobody else’s', async () => {
    const c = await person(a, `Sven${RUN}`, true);
    const other = await person(a, `Otto${RUN}`);
    await as(a, (ctx) =>
      crm.addContactNote(ctx, c.id, CreateContactNoteBody.parse({ body: `prefers mornings ${RUN}` })),
    );
    await as(a, (ctx) =>
      crm.createLead(ctx, CreateLeadBody.parse({ contactId: c.id, message: `looking in Jávea ${RUN}` })),
    );
    await as(a, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: other.id, message: `other ${RUN}` })));

    expect(await refusal(subjectExport(a, undefined))).toBe('VALIDATION_FAILED');
    expect(await refusal(subjectExport(a, c.id, 'CONTACTS'))).toBe('VALIDATION_FAILED');
    expect(await refusal(subjectExport(a, newId()))).toBe('DATA_SUBJECT_NOT_FOUND');
    expect(await refusal(subjectExport(b, c.id))).toBe('DATA_SUBJECT_NOT_FOUND');
    // never by staff impersonating an admin
    expect(
      await refusal(
        as(a, async (ctx) =>
          compliance.createDataExport(
            await impersonatedCtx(ctx, STAFF),
            { kind: 'SUBJECT', format: 'csv', contactId: c.id },
            {
              verifyStepUp: async () => {},
              subjectExists: async () => true,
            },
          ),
        ),
      ),
    ).toBe('FORBIDDEN');

    const { export: queued } = await subjectExport(a, c.id);
    expect(queued).toMatchObject({ kind: 'SUBJECT', subjectContactId: c.id, status: 'QUEUED' });
    expect(queued.fileName).toMatch(/^inmolink-subject-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(await runDataExport({ agencyId: a.agencyId, exportId: queued.id }, job())).toEqual({ status: 'SUCCEEDED' });
    const zip = store.objects.get(`private/${compliance.dataExportKey(a.agencyId, queued.id)}`)?.body;
    expect(zip).toBeDefined();
    const entries = unzip(zip as Uint8Array);
    expect([...entries.keys()].sort()).toEqual(
      [
        'activities.csv',
        'consents.csv',
        'contact.csv',
        'enquiries.csv',
        'events.csv',
        'leads.csv',
        'manifest.json',
        'notes.csv',
        'prospects.csv',
        'registrations.csv',
        'selection_responses.csv',
        'selections.csv',
        'tasks.csv',
        'viewings.csv',
      ].sort(),
    );
    const contactRows = await sheet(entries.get('contact.csv') as Buffer);
    expect(contactRows).toHaveLength(2);
    expect(contactRows[1]?.[1]).toBe(`Sven${RUN}`);
    expect((await sheet(entries.get('notes.csv') as Buffer))[1]?.[1]).toBe(`prefers mornings ${RUN}`);
    const leadRows = await sheet(entries.get('leads.csv') as Buffer);
    expect(leadRows).toHaveLength(2);
    expect(leadRows[1]?.[6]).toBe(`looking in Jávea ${RUN}`);
    expect((await sheet(entries.get('consents.csv') as Buffer))[1]?.slice(1, 4)).toEqual([
      'MARKETING',
      'true',
      'DASHBOARD',
    ]);
    expect(entries.get('leads.csv')?.toString()).not.toContain(`other ${RUN}`);
    expect(JSON.parse(entries.get('manifest.json')?.toString() ?? '{}')).toMatchObject({
      kind: 'SUBJECT',
      subjectContactId: c.id,
    });

    // the person's erasure expires the export and deletes its file
    const { version } = await as(a, (ctx) => crm.getContact(ctx, c.id));
    await as(a, (ctx) => crm.eraseContact(ctx, c.id, { version, confirm: 'ERASE' }));
    await crm.eraseContactData({ agencyId: a.agencyId, contactId: c.id });
    const [row] = await rows<{ status: string; file_deleted_at: string | null }>(
      sql`select status, file_deleted_at from data_export_jobs where id = ${queued.id}`,
    );
    expect(row?.status).toBe('EXPIRED');
    expect(row?.file_deleted_at).not.toBeNull();
    expect(store.objects.has(`private/${compliance.dataExportKey(a.agencyId, queued.id)}`)).toBe(false);
  });
});

describe('retention', () => {
  it('[S16-04] a retention change needs a fresh second factor; a shorter period applies only after the grace window', async () => {
    const set = (m: Founder, months: number | null, verify: () => Promise<void> = async () => {}) =>
      as(m, (ctx) => compliance.setRetentionSettings(ctx, { inactiveContactMonths: months }, { verifyStepUp: verify }));
    const initial = await as(b, (ctx) => compliance.getRetentionSettings(ctx));
    expect(initial).toMatchObject({ inactiveContactMonths: null, previousMonths: null });
    // the step-up runs after the policy and before any write: a failing one changes nothing
    const failing = async () => {
      throw Object.assign(new Error('bad code'), { code: 'MFA_CODE_INVALID' });
    };
    await expect(set(b, 24, failing)).rejects.toThrow('bad code');
    expect((await as(b, (ctx) => compliance.getRetentionSettings(ctx))).inactiveContactMonths).toBeNull();
    // never by staff impersonating an admin (the code is not even asked for)
    let asked = false;
    expect(
      await refusal(
        as(b, async (ctx) =>
          compliance.setRetentionSettings(
            await impersonatedCtx(ctx, STAFF),
            { inactiveContactMonths: 24 },
            {
              verifyStepUp: async () => {
                asked = true;
              },
            },
          ),
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(asked).toBe(false);
    // turning it on is a shortening (from "never"): it applies RETENTION_GRACE_DAYS later, "never" until then
    const on = await set(b, 24);
    const days = (Date.parse(on.effectiveAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(RETENTION_GRACE_DAYS - 0.01);
    expect(on).toMatchObject({ inactiveContactMonths: 24, previousMonths: null });
    expect(await system((tx) => compliance.retentionAgenciesPage(tx, null, 10_000))).not.toContainEqual(
      expect.objectContaining({ agencyId: b.agencyId }),
    );
    const later = new Date(Date.now() + (RETENTION_GRACE_DAYS + 1) * 86_400_000);
    expect(await system((tx) => compliance.retentionAgenciesPage(tx, null, 10_000, later))).toContainEqual({
      agencyId: b.agencyId,
      months: 24,
    });
    // "never" again: at once (nothing pending any more)
    const off = await set(b, null);
    expect(off).toMatchObject({ inactiveContactMonths: null, previousMonths: null });
    expect(Date.parse(off.effectiveAt)).toBeLessThanOrEqual(Date.now() + 1_000);
    // a period in force (24 months, its grace window over), then a longer one: at once
    await set(b, 24);
    await system((tx) =>
      tx.execute(sql`update retention_settings set effective_at = now() - interval '1 day', previous_months = null
        where agency_id = ${b.agencyId}`),
    );
    const longer = await set(b, 48);
    expect(longer).toMatchObject({ inactiveContactMonths: 48, previousMonths: null });
    expect(await system((tx) => compliance.retentionAgenciesPage(tx, null, 10_000))).toContainEqual({
      agencyId: b.agencyId,
      months: 48,
    });
    // shorter again: the 48 months stay in force through the grace window
    const shorter = await set(b, 12);
    expect(shorter).toMatchObject({ inactiveContactMonths: 12, previousMonths: 48 });
    expect(await system((tx) => compliance.retentionAgenciesPage(tx, null, 10_000))).toContainEqual({
      agencyId: b.agencyId,
      months: 48,
    });
    const audits = await rows<{ metadata: { from: number | null; to: number | null } }>(
      sql`select metadata from audit_logs where agency_id = ${b.agencyId} and type = 'compliance.retention.changed'
          order by occurred_at, id`,
    );
    expect(audits.map((r) => [r.metadata.from, r.metadata.to])).toEqual([
      [null, 24],
      [null, null],
      [null, 24],
      [24, 48],
      [48, 12],
    ]);
    await set(b, null);
  });

  it('[S16-04] contacts inactive past the agency’s retention period are anonymized by the job; active ones and other agencies stay', async () => {
    await as(a, (ctx) =>
      compliance.setRetentionSettings(ctx, { inactiveContactMonths: 24 }, { verifyStepUp: async () => {} }),
    );
    const effective = new Date(Date.now() + (RETENTION_GRACE_DAYS + 1) * 86_400_000);
    const pages = await system((tx) => compliance.retentionAgenciesPage(tx, null, 10_000, effective));
    expect(pages).toContainEqual({ agencyId: a.agencyId, months: 24 });

    const old = await person(a, `Olda${RUN}`);
    const busy = await person(a, `Busy${RUN}`);
    const dealing = await person(a, `Deal${RUN}`);
    const called = await person(a, `Call${RUN}`);
    const selling = await person(a, `Sell${RUN}`);
    const fresh = await person(a, `Fred${RUN}`);
    const elsewhere = await person(b, `Elsa${RUN}`);
    // `busy`: a closed lead changed last month; `dealing`: an open deal untouched for three years; `called`: a closed
    // lead untouched for three years but a call logged on it now; `selling`: the seller of an active listing
    const { lead: closed } = await as(a, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: busy.id })));
    const { lead: open } = await as(a, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: dealing.id })));
    const { lead: logged } = await as(a, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: called.id })));
    await as(a, (ctx) =>
      crm.logActivity(ctx, CreateActivityBody.parse({ type: 'CALL', leadId: logged.id, body: 'still interested' })),
    );
    // a listing of the agency on the market, with `selling` as its seller (a converted prospect)
    const tax = await system(async (tx) => {
      const [l] = (await tx.execute<{ id: string }>(sql`select id from locations limit 1`)).rows;
      const [t] = (await tx.execute<{ id: string }>(sql`select id from property_types limit 1`)).rows;
      return { locationId: l?.id as string, propertyTypeId: t?.id as string };
    });
    const { prospect } = await as(a, (ctx) =>
      crm.createProspect(ctx, CreateProspectBody.parse({ title: `Sell villa ${RUN}`, contactId: selling.id, ...tax })),
    );
    const { listingId } = await as(a, (ctx) => crm.convertProspect(ctx, prospect.id, ConvertProspectBody.parse({})));
    await system((tx) => tx.execute(sql`update properties set status = 'ACTIVE' where id = ${listingId}`));
    const back = sql`now() - interval '36 months'`;
    await system(async (tx) => {
      await tx.execute(sql`update contacts set updated_at = ${back}, created_at = ${back}
        where id in (${old.id}, ${busy.id}, ${dealing.id}, ${called.id}, ${selling.id}, ${elsewhere.id})`);
      await tx.execute(
        sql`update leads set status = 'LOST', stage_id = (select s.id from pipeline_stages s where s.agency_id = leads.agency_id and s.status = 'LOST' limit 1), updated_at = now() - interval '1 month' where id = ${closed.id}`,
      );
      await tx.execute(sql`update leads set updated_at = ${back} where id = ${open.id}`);
      await tx.execute(
        sql`update leads set status = 'LOST', stage_id = (select s.id from pipeline_stages s where s.agency_id = leads.agency_id and s.status = 'LOST' limit 1), updated_at = ${back} where id = ${logged.id}`,
      );
      await tx.execute(sql`update activities set contact_id = null where lead_id = ${logged.id}`);
    });

    const run = () =>
      crm.anonymizeInactiveContacts({ agencyId: a.agencyId, months: 24, now: new Date(), maxContacts: 5_000 });
    expect(await run()).toBeGreaterThanOrEqual(1);
    const names = await rows<{ id: string; first_name: string | null }>(
      sql`select id, first_name from contacts
           where id in (${old.id}, ${busy.id}, ${dealing.id}, ${called.id}, ${selling.id}, ${fresh.id}, ${elsewhere.id})`,
    );
    const byId = new Map(names.map((r) => [r.id, r.first_name]));
    expect(byId.get(old.id)).toBeNull();
    expect(byId.get(busy.id)).toBe(`Busy${RUN}`);
    expect(byId.get(dealing.id)).toBe(`Deal${RUN}`);
    expect(byId.get(called.id)).toBe(`Call${RUN}`);
    expect(byId.get(selling.id)).toBe(`Sell${RUN}`);
    expect(byId.get(fresh.id)).toBe(`Fred${RUN}`);
    expect(byId.get(elsewhere.id)).toBe(`Elsa${RUN}`);
    const [anon] = await rows<{ actor_kind: string; metadata: unknown }>(
      sql`select actor_kind, metadata from audit_logs where agency_id = ${a.agencyId}
            and type = 'crm.contact.anonymized' and target_id = ${old.id}`,
    );
    expect(anon).toEqual({ actor_kind: 'system', metadata: { months: 24 } });
    const [event] = await rows<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where type = 'crm.contact.erased' and payload->>'contactId' = ${old.id}`,
    );
    expect(event?.n).toBe(1);
    // idempotent: a rerun erases nothing more of these
    await run();
    const [again] = await rows<{ n: number }>(
      sql`select count(*)::int as n from audit_logs where type = 'crm.contact.anonymized' and target_id = ${old.id}`,
    );
    expect(again?.n).toBe(1);
  });
});
