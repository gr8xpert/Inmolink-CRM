import { inflateRawSync } from 'node:zlib';
import {
  ConvertProspectBody,
  CreateActivityBody,
  CreateCalendarEventBody,
  CreateContactBody,
  CreateContactNoteBody,
  CreateLeadBody,
  CreateListingBody,
  CreateProspectBody,
  type CreateSiteInput,
  CreateTaskBody,
  UpdateContactBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, withIntake, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey, rowCipher } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers, type EventDef } from '@inmolink/platform/outbox';
import { closeQueues, configureQueue, type JobDef } from '@inmolink/platform/queue';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import { scanForTokens, scanObjects } from '../../../testing/pii-scan';
import * as compliance from '../../compliance';
import * as mls from '../../mls';
import * as notifications from '../../notifications';
import * as presentations from '../../presentations';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websites from '../../websites';
import * as crm from '../index';

/**
 * S16-04: erasure of a contact removes its personal data from every table, the stored files, the search index and the
 * read models — proved by a scan, not by a list of columns someone remembered.
 *
 * The person's data is spread over everything the platform copies it into: identifiers, a note, calls, a lead with a
 * message and a website enquiry, a task, a solo meeting, a seller prospect turned listing, a contact merged into it,
 * consent records, a client registration (encrypted snapshot + fingerprints) and a viewing request at another agency's
 * listing, a selection with the client's enquiry, a member's notification, a contact import CSV and CONTACTS / ACCOUNT
 * export files. After `crm.eraseContact`, the outbox is driven: `crm.contact.erased` reaches its real subscribers (crm,
 * mls, presentations — their jobs run inline), and the erasure's own `properties.listing.updated` reaches search,
 * whose queue rebuilds the read model and pushes the document to a live Meilisearch index. Then every text, array and
 * json(b) column of every table, the decrypted registration snapshots, the stored objects and the live index are
 * searched for each token. Deal (lead) and audit rows stay, keyed by ids only.
 *
 * Not in scope by design (STATUS Decisions): chat messages (the participants' correspondence) and members' saved
 * search names — erased with the agency (agency-erasure test).
 */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({ service: 'erasure-scan-test', level: 'silent' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('crm.erasure-scan.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const store = createMemoryStore();
const keyring = createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' });
/** mls's registration cipher, rebuilt on the same keyring: the test decrypts what the column scan sees as ciphertext. */
const registrationCipher = rowCipher('client_registrations', 'details_enc', () => keyring, z.unknown());

/** Distinctive tokens: none of them can appear anywhere by chance. */
const FIRST = `Xenia${RUN}`;
const LAST = `Quorvath${RUN}`;
const EMAIL = `xenia.${RUN}@erasure-scan.example`;
const PHONE_DIGITS = `6${String(Number.parseInt(RUN.slice(0, 6), 16) % 1e8).padStart(8, '0')}`;
const PHONE = `+34${PHONE_DIGITS}`;
const SECRET = `divorce settlement ${RUN} ${LAST}`;
const WEB_EMAIL = `xq-web-${RUN}@erasure-scan.example`;
const DUP_EMAIL = `xq-old-${RUN}@erasure-scan.example`;
const TOKENS = [FIRST, LAST, EMAIL, PHONE_DIGITS, `divorce settlement ${RUN}`, WEB_EMAIL, DUP_EMAIL];

let a: Founder;
let b: Founder;
let siteId: string;
let ids: { city: string; villa: string };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

/** A ZIP's entries as text (central directory; stored or inflated). */
function zipTexts(body: Uint8Array): string[] {
  const zip = Buffer.from(body);
  const eocd = zip.length - 22;
  if (eocd < 0 || zip.readUInt32LE(eocd) !== 0x06054b50) return [];
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const offset = zip.readUInt32LE(p + 42);
    const local = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(local, local + compressed);
    out.push((method === 0 ? Buffer.from(raw) : inflateRawSync(raw)).toString('utf8'));
    p += 46 + nameLength;
  }
  return out;
}

/** The agency's client registration snapshots, decrypted (`details_enc` is ciphertext to the column scan). */
async function decryptedRegistrations(agencyId: string): Promise<string> {
  const regs = await rows<{ id: string; details_enc: string }>(
    sql`select id, details_enc from client_registrations where agency_id = ${agencyId}`,
  );
  return JSON.stringify(regs.map((r) => registrationCipher.decrypt(agencyId, r.id, r.details_enc)));
}

/**
 * Delivers the agency's outbox events of `type` created after `since` to their real subscribers; the jobs they queue
 * among `inline` run at once (the others are queued as in production).
 */
async function deliver(type: EventDef['type'], since: Date, inline: readonly JobDef[]): Promise<number> {
  const events = await rows<{ id: string; type: string; version: number; payload: unknown; created_at: string }>(
    sql`select id, type, version, payload, created_at from outbox_events
         where agency_id = ${a.agencyId} and type = ${type} and created_at >= ${since.toISOString()}::timestamptz
         order by created_at, id`,
  );
  const spies = inline.map((job) =>
    vi.spyOn(job, 'enqueue').mockImplementation(async (payload) => {
      await job.spec.run(job.spec.payload.parse(payload), {
        log,
        jobId: newId(),
        attempt: 1,
        progress: async () => {},
        signal: new AbortController().signal,
      } as never);
      return { id: 'inline', added: true } as unknown as Awaited<ReturnType<typeof job.enqueue>>;
    }),
  );
  try {
    for (const e of events) {
      for (const sub of defaultSubscribers.get(e.type, e.version)) {
        await sub.handler(sub.def.schema.parse(e.payload), {
          eventId: e.id,
          agencyId: a.agencyId,
          type: e.type,
          version: e.version,
          createdAt: new Date(e.created_at),
          attempt: 1,
        });
      }
    }
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return events.length;
}

/** An `owner` listing, active and shared with the network (another agency may register a client for it). */
async function sharedListing(owner: Founder): Promise<string> {
  const { id } = await as(owner, (ctx) =>
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
  await as(owner, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  return id;
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureQueue({ prefix: `test-erasure-scan-${RUN}`, logger: log });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  configureStorage(store);
  mls.configureMls({
    keyring,
    fingerprintKey: `test-fingerprint-key-${RUN}-0123456789abcdef`,
    viewingRequestExpiryDays: 3,
  });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  const site: CreateSiteInput = {
    name: 'Scan Homes web',
    domains: [`www.scan-homes-${RUN}.example`],
    mode: 'WP_PLUGIN',
    inventoryPolicy: 'OWN_ONLY',
    inventoryFilters: null,
    referencePrefix: 'SH',
    locales: ['en'],
    contact: { name: 'Scan Homes', email: 'office@scan-homes.example', phone: '+34 600 000 004' },
  };
  siteId = (await as(a, (ctx) => websites.createSite(ctx, site))).id;
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `crm-scan-${RUN}`,
      translations: name('Scanland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `crm-scan-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `crm-scan-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
}, 180_000);

afterAll(async () => {
  await closeRateLimit();
  await closeQueues();
  await closeDb();
});

describe('contact erasure scan', () => {
  it('[S16-04] erasure of a contact removes its PII from all tables, files, the search index and the read models', async () => {
    const { contact } = await as(a, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({
          firstName: FIRST,
          lastName: LAST,
          emails: [EMAIL],
          phones: [PHONE],
          types: ['SELLER', 'BUYER'],
          tags: [`vip-${RUN}`],
          consentMarketing: true,
        }),
      ),
    );
    const id = contact.id;
    // a contact merged into it (an old record of the same person)
    const { contact: dup } = await as(a, (ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: FIRST, lastName: 'Old', emails: [DUP_EMAIL] })),
    );
    const merging = await as(a, (ctx) => crm.getContact(ctx, id));
    await as(a, (ctx) => crm.mergeContacts(ctx, id, { duplicateId: dup.id, version: merging.version }));
    // a consent change: the consent record (no PII) stays as evidence
    const created = await as(a, (ctx) => crm.getContact(ctx, id));
    await as(a, (ctx) =>
      crm.updateContact(ctx, id, UpdateContactBody.parse({ version: created.version, consentMarketing: false })),
    );
    await as(a, (ctx) => crm.addContactNote(ctx, id, CreateContactNoteBody.parse({ body: SECRET })));
    await as(a, (ctx) => crm.logActivity(ctx, CreateActivityBody.parse({ type: 'CALL', contactId: id, body: SECRET })));
    const { lead } = await as(a, (ctx) =>
      crm.createLead(ctx, CreateLeadBody.parse({ contactId: id, message: SECRET })),
    );
    await as(a, (ctx) =>
      crm.logActivity(ctx, CreateActivityBody.parse({ type: 'OTHER', leadId: lead.id, body: SECRET })),
    );
    await as(a, (ctx) =>
      crm.createTask(ctx, CreateTaskBody.parse({ title: `Call ${FIRST}`, description: SECRET, contactId: id })),
    );
    await as(a, (ctx) =>
      crm.createCalendarEvent(
        ctx,
        CreateCalendarEventBody.parse({
          type: 'MEETING',
          title: `Meet ${FIRST} ${LAST}`,
          description: SECRET,
          location: `${LAST} home`,
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          endsAt: new Date(Date.now() + 90_000_000).toISOString(),
          contactIds: [id],
        }),
      ),
    );
    // a website enquiry promoted into the lead
    const inboundId = newId();
    await withIntake({ agencyId: a.agencyId }, (tx) =>
      websites.recordInboundLead(tx, {
        id: inboundId,
        agencyId: a.agencyId,
        siteId,
        kind: 'ENQUIRY',
        idempotencyHash: `idem-${inboundId}`,
        requestHash: 'x',
        verification: 'SERVER_KEY',
        target: null,
        locale: 'en',
        name: `${FIRST} ${LAST}`,
        email: WEB_EMAIL,
        emailHash: `h-${inboundId}`,
        keyTier: 'STANDARD',
        phone: PHONE,
        message: SECRET,
        viewingSlots: null,
        marketingConsent: true,
        pageUrl: `https://www.scan-homes-${RUN}.example/villa?ref=${LAST}`,
      }),
    );
    await system((tx) => tx.execute(sql`update leads set inbound_lead_id = ${inboundId} where id = ${lead.id}`));
    // a seller prospect with confidential notes, converted into a listing that names the contact as seller; shared
    const { prospect } = await as(a, (ctx) =>
      crm.createProspect(
        ctx,
        CreateProspectBody.parse({
          title: `${LAST} villa`,
          contactId: id,
          propertyTypeId: ids.villa,
          locationId: ids.city,
          confidentialNotes: SECRET,
        }),
      ),
    );
    const { listingId } = await as(a, (ctx) => crm.convertProspect(ctx, prospect.id, ConvertProspectBody.parse({})));
    await system((tx) =>
      tx.execute(sql`update properties set status = 'ACTIVE', visibility = 'SHARED' where id = ${listingId}`),
    );
    // MLS: the client registered for another agency's listing (encrypted snapshot, fingerprints), a viewing requested
    const theirs = await sharedListing(b);
    const reg = await mls.registerClient((fn) => as(a, fn), { contactId: id, target: { kind: 'LISTING', id: theirs } });
    const viewing = await as(a, (ctx) =>
      mls.requestViewing(ctx, {
        registrationId: reg.registration.id,
        proposedStartAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      }),
    );
    // a selection made for the client, with the client's enquiry on it
    const selectionId = newId();
    await system(async (tx) => {
      await tx.execute(sql`insert into selections (id, agency_id, created_by, contact_id, title, message, locale,
          token_hash, token_hint, expires_at)
        values (${selectionId}, ${a.agencyId}, ${a.userId}, ${id}, ${`For ${FIRST}`}, ${SECRET}, 'en',
          ${`scan-${selectionId}`}, 'abcd', now() + interval '30 days')`);
      await tx.execute(sql`insert into selection_interactions (id, agency_id, selection_id, kind, message)
        values (${newId()}, ${a.agencyId}, ${selectionId}, 'ENQUIRE', ${SECRET})`);
    });
    // a member's notification naming the person (the lead assignment's subject)
    await system((tx) =>
      notifications.raiseNotifications(tx, {
        agencyId: a.agencyId,
        actorUserId: null,
        type: 'LEAD_ASSIGNED',
        userIds: [a.userId],
        params: { subject: `${FIRST} ${LAST}` },
        link: `/inbox/${lead.id}`,
        sourceKey: `crm.lead:${newId()}`,
        at: new Date(),
      }),
    );
    // a contact import CSV listing the person, and CONTACTS / ACCOUNT exports holding them
    const upload = await crm.uploadContactImport(
      (fn) => as(a, fn),
      Buffer.from(`first_name,last_name,email\n${FIRST},${LAST},${EMAIL}\n`),
    );
    // finished CONTACTS / ACCOUNT exports whose files list the person (the runs are compliance's own tests)
    const exportIds = [newId(), newId()];
    for (const [i, kind] of (['CONTACTS', 'ACCOUNT'] as const).entries()) {
      const exportId = exportIds[i] as string;
      await system((tx) =>
        tx.execute(sql`insert into data_export_jobs (id, agency_id, created_by, kind, format, status, finished_at, expires_at)
          values (${exportId}, ${a.agencyId}, ${a.userId}, ${kind}, 'csv', 'SUCCEEDED', now(), now() + interval '7 days')`),
      );
      await store.put(
        'private',
        compliance.dataExportKey(a.agencyId, exportId),
        Buffer.from(`id,first_name,emails
${id},${FIRST},${EMAIL}
`),
        { contentType: 'text/csv' },
      );
    }

    // the scans find the PII before erasure (they would find a leak)
    const before = await scanForTokens(TOKENS);
    expect(before).toEqual(
      expect.arrayContaining([
        'contacts.first_name',
        'contact_emails.email',
        'website_leads.email',
        'selections.title',
        'selection_interactions.message',
        'notifications.params',
      ]),
    );
    expect(await decryptedRegistrations(a.agencyId)).toContain(EMAIL);
    const [fingerprints] = await rows<{ n: number }>(
      sql`select count(*)::int as n from client_registration_fingerprints where registration_id = ${reg.registration.id}`,
    );
    expect(fingerprints?.n).toBeGreaterThan(0);
    const stored = scanObjects(store.objects, TOKENS, zipTexts);
    expect(stored).toEqual(
      expect.arrayContaining([
        `private/crm/contact-imports/${a.agencyId}/${upload.id}`,
        ...exportIds.map((e) => `private/${compliance.dataExportKey(a.agencyId, e)}`),
      ]),
    );

    // the erasure, then the outbox as production drives it
    const since = new Date(Date.now() - 1_000);
    const { version } = await as(a, (ctx) => crm.getContact(ctx, id));
    await as(a, (ctx) => crm.eraseContact(ctx, id, { version, confirm: 'ERASE' }));
    crm.registerCrmSubscriptions();
    mls.registerMlsSubscriptions();
    presentations.registerPresentationsSubscriptions();
    search.registerSearchSubscriptions();
    try {
      const erasedEvents = await deliver('crm.contact.erased', since, [
        crm.crmJobs.eraseContactData,
        mls.mlsJobs.eraseContactRegistrations,
        presentations.presentationsJobs.eraseContactSelections,
      ]);
      expect(erasedEvents).toBe(1);
      // the erasure itself asked for the listing's refresh: `properties.listing.updated` → the read-model queue
      expect(await deliver('properties.listing.updated', since, [])).toBeGreaterThanOrEqual(1);
    } finally {
      search.unregisterSearchSubscriptions();
      presentations.unregisterPresentationsSubscriptions();
      mls.unregisterMlsSubscriptions();
      crm.unregisterCrmSubscriptions();
    }
    const queued = await rows<{ target_id: string }>(
      sql`select target_id from read_model_queue where target_id = ${listingId}`,
    );
    expect(queued).toHaveLength(1);

    // the queue rebuilds the read model and queues the index push; the push goes to a live index
    const engine = createMeiliEngine({
      url: process.env.MEILI_URL as string,
      apiKey: process.env.MEILI_MASTER_KEY as string,
    });
    const uid = `t_erasure_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
    const def = search.listingsIndex(uid);
    configureSearch(engine);
    search.configureSearchIndex({ uid, scope: [listingId] });
    try {
      await search.ensureListingsIndex(engine, def);
      const drained = await search.drainReadModelQueue(a.agencyId, {
        recheckMs: 0,
        maxRechecks: 0,
        leaseMs: 60_000,
        budgetMs: 30_000,
        waitMs: 5_000,
      });
      expect(drained.built).toBeGreaterThanOrEqual(1);
      expect(await search.syncIndex({ engine })).toMatchObject({ more: false });
      // the control: the listing's document is in the live index
      expect((await engine.fetch(uid, [listingId], ['id'])).length).toBe(1);
      for (const t of TOKENS) expect((await engine.search(def, { text: t, limit: 5 })).ids).toEqual([]);
      const [doc] = await engine.fetch(uid, [listingId], ['*']);
      for (const t of TOKENS) expect(JSON.stringify(doc).toLowerCase()).not.toContain(t.toLowerCase());
    } finally {
      await engine.dropIndex(uid);
      search.configureSearchIndex({ uid: search.LISTINGS_INDEX_UID });
    }

    // every table, every decrypted snapshot, every stored object: no token anywhere
    expect(await scanForTokens(TOKENS)).toEqual([]);
    expect(await decryptedRegistrations(a.agencyId)).not.toMatch(new RegExp(`${RUN}`, 'i'));
    const [fpAfter] = await rows<{ n: number }>(
      sql`select count(*)::int as n from client_registration_fingerprints where registration_id = ${reg.registration.id}`,
    );
    expect(fpAfter?.n).toBe(0);
    expect(scanObjects(store.objects, TOKENS, zipTexts)).toEqual([]);
    const exportsAfter = await rows<{ status: string; file_deleted_at: string | null }>(
      sql`select status, file_deleted_at from data_export_jobs where id in (${sql.join(
        exportIds.map((e) => sql`${e}::uuid`),
        sql`, `,
      )})`,
    );
    expect(exportsAfter.map((r) => [r.status, r.file_deleted_at !== null])).toEqual([
      ['EXPIRED', true],
      ['EXPIRED', true],
    ]);
    const [selection] = await rows<{ revoked: boolean }>(
      sql`select revoked_at is not null as revoked from selections where id = ${selectionId}`,
    );
    expect(selection?.revoked).toBe(true);

    // kept: the deal (lead), the registration and viewing request (evidence, ids only), the audit trail, the consents
    const [kept] = await rows<{
      leads: number;
      registrations: number;
      viewings: number;
      audits: number;
      consents: number;
    }>(sql`select
        (select count(*) from leads where id = ${lead.id} and contact_id = ${id})::int as leads,
        (select count(*) from client_registrations where id = ${reg.registration.id})::int as registrations,
        (select count(*) from viewing_requests where id = ${viewing.request.id})::int as viewings,
        (select count(*) from audit_logs where agency_id = ${a.agencyId} and target_id = ${id}
           and type in ('crm.contact.erased', 'crm.contact.erasureCompleted'))::int as audits,
        (select count(*) from consent_records where contact_id = ${id})::int as consents`);
    expect(kept).toEqual({ leads: 1, registrations: 1, viewings: 1, audits: 2, consents: 2 });
    // the consent history is still readable through crm's access check — but the contact is gone, so crm refuses
    expect(
      await as(a, (ctx) => crm.listContactConsents(ctx, id)).then(
        () => 'read',
        (e: { code?: string }) => e.code,
      ),
    ).toBe('CONTACT_NOT_FOUND');
    const [consents] = await rows<{ purposes: string[] }>(
      sql`select array_agg(granted::text order by recorded_at desc, id desc) as purposes from consent_records
           where contact_id = ${id}`,
    );
    expect(consents?.purposes).toEqual(['false', 'true']);
  }, 300_000);
});
