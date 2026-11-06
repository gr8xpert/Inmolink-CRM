import { inflateRawSync } from 'node:zlib';
import {
  CreateActivityBody,
  CreateCalendarEventBody,
  CreateContactBody,
  CreateLeadBody,
  CreateListingBody,
  CreateProspectBody,
  CreateTaskBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { readSheetRows } from '@inmolink/platform/sheet';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../../crm';
import * as mls from '../../mls';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import { SUBJECT_EXPORT_CATEGORIES } from '../data-export-subject';
import * as compliance from '../index';
import { runDataExport } from '../worker';

/**
 * S16-F5: the `SUBJECT` export holds every category of client data the privacy notice lists — the contact and its
 * consents, enquiries (leads, website enquiries, selections and what the person did on them), viewings (client
 * registrations, viewing requests, calendar events) and notes (notes, tasks, activities, seller prospects) — and pages
 * every table, so a person with more than 1,000 notes gets all of them.
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'subject-export-test', level: 'silent' });
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('compliance.subject-export.test', fn);
const store = createMemoryStore();
const NOTES = 1_005;

let a: Founder;
let b: Founder;
let ids: { city: string; villa: string };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

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

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  configureStorage(store);
  mls.configureMls({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    fingerprintKey: `test-fingerprint-key-${RUN}-0123456789abcdef`,
  });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `subj-${RUN}`,
      translations: name('Subjectland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `subj-g-${RUN}`,
      sort: 0,
      translations: name('H'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `subj-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
}, 180_000);

afterAll(async () => {
  await closeRateLimit();
  await closeDb();
});

describe('SUBJECT export', () => {
  it('[S16-F5] the SUBJECT export ZIP of a seeded person contains every category the privacy notice lists, paged past 1,000 rows', async () => {
    const { contact } = await as(a, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({
          firstName: `Sara${RUN}`,
          emails: [`sara-${RUN}@subject.example`],
          consentMarketing: true,
        }),
      ),
    );
    const id = contact.id;
    // notes past one page
    await system((tx) =>
      tx.execute(sql`insert into contact_notes (id, agency_id, contact_id, body, created_at)
        select gen_random_uuid(), ${a.agencyId}::uuid, ${id}::uuid, 'note ' || n,
               now() - make_interval(secs => ${NOTES} - n)
          from generate_series(1, ${NOTES}) n`),
    );
    const { lead } = await as(a, (ctx) => crm.createLead(ctx, CreateLeadBody.parse({ contactId: id, message: 'hi' })));
    await as(a, (ctx) => crm.logActivity(ctx, CreateActivityBody.parse({ type: 'CALL', contactId: id, body: 'rang' })));
    await as(a, (ctx) => crm.createTask(ctx, CreateTaskBody.parse({ title: 'Call back', contactId: id })));
    await as(a, (ctx) =>
      crm.createCalendarEvent(
        ctx,
        CreateCalendarEventBody.parse({
          type: 'MEETING',
          title: 'Coffee',
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          endsAt: new Date(Date.now() + 90_000_000).toISOString(),
          contactIds: [id],
        }),
      ),
    );
    await as(a, (ctx) =>
      crm.createProspect(
        ctx,
        CreateProspectBody.parse({
          title: 'Her flat',
          contactId: id,
          propertyTypeId: ids.villa,
          locationId: ids.city,
          confidentialNotes: 'wants to sell in spring',
        }),
      ),
    );
    // a website enquiry promoted into the lead
    const enquiryId = newId();
    await system(async (tx) => {
      await tx.execute(sql`insert into website_leads (id, agency_id, kind, request_hash, verification, locale, name,
          email, email_hash, key_tier, message)
        values (${enquiryId}, ${a.agencyId}, 'ENQUIRY', 'x', 'SERVER_KEY', 'en', ${`Sara${RUN}`},
          ${`sara-${RUN}@subject.example`}, ${`h-${RUN}`}, 'STANDARD', 'Is it still available?')`);
      await tx.execute(sql`update leads set inbound_lead_id = ${enquiryId} where id = ${lead.id}`);
    });
    // a selection made for her, with her enquiry on it
    const selectionId = newId();
    await system(async (tx) => {
      await tx.execute(sql`insert into selections (id, agency_id, created_by, contact_id, title, message, locale,
          token_hash, token_hint, expires_at)
        values (${selectionId}, ${a.agencyId}, ${a.userId}, ${id}, 'For Sara', 'A few ideas', 'en',
          ${`subj-${selectionId}`}, 'abcd', now() + interval '30 days')`);
      await tx.execute(sql`insert into selection_interactions (id, agency_id, selection_id, kind, message)
        values (${newId()}, ${a.agencyId}, ${selectionId}, 'ENQUIRE', 'Can I see it Friday?')`);
    });
    // R2-02a: her search profile
    await system((tx) =>
      tx.execute(sql`insert into client_profiles (id, agency_id, contact_id, mode, transaction_type, wishes)
        values (${newId()}, ${a.agencyId}, ${id}, 'REVIEW', 'SALE', 'near the sea, quiet street')`),
    );
    // MLS: registered for another agency's shared listing, a viewing requested
    const { id: theirs } = await as(b, (ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({
          propertyTypeId: ids.villa,
          locationId: ids.city,
          priceCents: 50_000_000,
          energyRating: 'B',
          commission: { type: 'PCT', basisPoints: 400, includesVat: true },
          splitBp: 5000,
        }),
      ),
    );
    await as(b, async (ctx) =>
      properties.updateListing(
        ctx,
        theirs,
        UpdateListingBody.parse({
          status: 'ACTIVE',
          visibility: 'SHARED',
          shareScope: 'ALL',
          version: (await properties.getListing(ctx, theirs)).version,
        }),
      ),
    );
    const reg = await mls.registerClient((fn) => as(a, fn), { contactId: id, target: { kind: 'LISTING', id: theirs } });
    await as(a, (ctx) =>
      mls.requestViewing(ctx, {
        registrationId: reg.registration.id,
        proposedStartAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      }),
    );

    const { export: queued } = await as(a, (ctx) =>
      compliance.createDataExport(
        ctx,
        { kind: 'SUBJECT', format: 'csv', contactId: id, confirmContactId: id },
        {
          verifyStepUp: async () => {},
          subjectExists: (cid) => crm.openContactExists(ctx.tx, ctx.tenant.agencyId, cid),
        },
      ),
    );
    expect(await runDataExport({ agencyId: a.agencyId, exportId: queued.id }, job())).toEqual({ status: 'SUCCEEDED' });
    const zip = store.objects.get(`private/${compliance.dataExportKey(a.agencyId, queued.id)}`)?.body;
    const entries = unzip(zip as Uint8Array);

    // every category of the privacy notice, each table with the seeded person's rows
    const tables = Object.values(SUBJECT_EXPORT_CATEGORIES).flat();
    expect(Object.keys(SUBJECT_EXPORT_CATEGORIES).sort()).toEqual(
      ['contacts', 'enquiries', 'notes', 'viewings'].sort(),
    );
    for (const t of tables) {
      const file = entries.get(`${t}.csv`);
      expect(file, `${t}.csv`).toBeDefined();
      expect((await sheet(file as Buffer)).length, `${t}.csv rows`).toBeGreaterThan(1);
    }
    // paged past 1,000: every note
    const [notes] = await system(
      async (tx) =>
        (await tx.execute(sql`select count(*)::int as n from contact_notes where contact_id = ${id}`)).rows as {
          n: number;
        }[],
    );
    expect(notes?.n).toBeGreaterThanOrEqual(NOTES);
    expect(await sheet(entries.get('notes.csv') as Buffer)).toHaveLength((notes?.n ?? 0) + 1);
    const manifest = JSON.parse(entries.get('manifest.json')?.toString() ?? '{}');
    expect(manifest.files.notes.rows).toBe(notes?.n);
    expect(manifest.reviewBeforeSending).toEqual(expect.arrayContaining(['events', 'prospects']));
    // what the person sent, and nothing of the agencies' terms
    expect(entries.get('enquiries.csv')?.toString()).toContain('Is it still available?');
    expect(entries.get('selection_responses.csv')?.toString()).toContain('Can I see it Friday?');
    expect(entries.get('prospects.csv')?.toString()).toContain('wants to sell in spring');
    expect(entries.get('viewings.csv')?.toString()).toContain('REQUESTED');
    expect(entries.get('client_profiles.csv')?.toString()).toContain('near the sea, quiet street');
    for (const f of ['viewings.csv', 'registrations.csv']) {
      expect(entries.get(f)?.toString()).not.toMatch(/commission|split/i);
    }
  }, 300_000);
});
