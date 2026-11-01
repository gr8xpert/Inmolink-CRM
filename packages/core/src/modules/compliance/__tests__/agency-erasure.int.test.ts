import {
  CreateContactBody,
  CreateLeadBody,
  CreateListingBody,
  CreateTaskBody,
  StartSheetImportBody,
  type XmlMappingInput,
} from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { AppError, isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, StaffCtx } from '../../../context';
import { startStaffOperation } from '../../../gdpr-requests';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import { scanForTokens, scanObjects } from '../../../testing/pii-scan';
import * as admin from '../../admin';
import * as crm from '../../crm';
import * as imports from '../../imports';
import * as media from '../../media';
import * as notifications from '../../notifications';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import { dataExportKey } from '../index';
import { eraseAgencyData } from '../worker';

/**
 * Agency erasure (S16-04, offboarding): the `ERASE_AGENCY` staff operation (super admins, suspended agencies only)
 * removes the agency's import connections and every uploaded sheet under `imports/sheets/<agency>/`
 * (`imports.deleteAgencySheets`, S7-F1 / S8-F4), erases its contacts and deletes its data export files; deals and audit
 * rows stay, keyed by ids. Another agency's sheets and contacts are untouched.
 */

const RUN = newId().slice(-8).toLowerCase();
const REASON = `Offboarding ticket ${RUN}: the agency asked to leave`;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('compliance.agency-erasure.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const store = createMemoryStore();

const MAPPING: XmlMappingInput = {
  schemaVersion: 1,
  recordElement: 'row',
  decimalSeparator: 'point',
  fields: {
    ref: { path: 'Ref' },
    propertyType: { constant: 'Villa' },
    price: { path: 'Price' },
    country: { constant: 'Spain' },
    transactionType: { constant: 'SALE' },
  },
  features: [],
  images: [],
  translations: [],
};

let leaving: Founder;
let staying: Founder;
let superAdmin: string;
let dataOps: string;
let ids: { city: string; villa: string };

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const asStaff = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'agency erasure int test' }, fn);
const upload = (m: Founder, ref: string) =>
  imports.uploadSheet((fn) => as(m, fn), Buffer.from(`Ref,Price\n${ref},250000\n`));
const sheetObjects = async (agencyId: string) =>
  (await store.list('private', `imports/sheets/${agencyId}/`, { limit: 1_000 })).objects.map((o) => o.key);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  configureStorage(store);
  imports.configureImports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    withdrawAfterMissedRuns: 3,
  });
  [leaving, staying] = await Promise.all([createFounder(), createFounder()]);
  superAdmin = (await createStaffUser('SUPER_ADMIN')).userId;
  dataOps = (await createStaffUser('STAFF_DATA_OPS')).userId;
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `erase-${RUN}`,
      translations: name('Eraseland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `erase-g-${RUN}`,
      sort: 0,
      translations: name('H'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `erase-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
}, 120_000);

afterAll(async () => {
  admin.configureAgencyEraser(null);
  await closeDb();
});

/** Starts `ERASE_AGENCY` the way the API does (the step-up bound in core): `code` undefined = none sent. */
const startErasure = (userId: string, agencyId: string, code: string | undefined) =>
  asStaff(userId, (ctx) =>
    startStaffOperation(ctx, {
      kind: 'ERASE_AGENCY',
      agencyId,
      reason: REASON,
      ...(code ? { twoFactorCode: code as never } : {}),
    }),
  );
/** The admin service with a step-up stub (identity's own tests cover the codes). */
const startWithStepUp = (userId: string, agencyId: string, verify: () => Promise<void>) =>
  asStaff(userId, (ctx) =>
    admin.startOperation(ctx, { kind: 'ERASE_AGENCY', agencyId, reason: REASON }, { verifyStepUp: verify }),
  );
const operationsOf = (agencyId: string) =>
  rows<{ n: number }>(
    sql`select count(*)::int as n from staff_operations where kind = 'ERASE_AGENCY' and target_agency_id = ${agencyId}`,
  ).then((r) => r[0]?.n ?? 0);

describe('agency erasure', () => {
  it('[S16-04] ERASE_AGENCY needs a super admin, a suspended agency and a fresh second factor; without a code nothing starts', async () => {
    const target = await createFounder();
    expect(await refusal(startWithStepUp(dataOps, target.agencyId, async () => {}))).toBe('FORBIDDEN');
    expect(await refusal(startWithStepUp(superAdmin, target.agencyId, async () => {}))).toBe('AGENCY_ERASURE_REFUSED');
    await setAgencyStatus(target.agencyId, 'SUSPENDED');
    // no code: refused by core's step-up, and by admin when no step-up is bound at all
    expect(await refusal(startErasure(superAdmin, target.agencyId, undefined))).toBe('MFA_CODE_INVALID');
    expect(
      await refusal(
        asStaff(superAdmin, (ctx) =>
          admin.startOperation(ctx, { kind: 'ERASE_AGENCY', agencyId: target.agencyId, reason: REASON }),
        ),
      ),
    ).toBe('MFA_CODE_INVALID');
    // a failing step-up (a wrong code: identity's own tests): refused, nothing written
    expect(
      await refusal(
        startWithStepUp(superAdmin, target.agencyId, async () => {
          throw new AppError('MFA_CODE_INVALID');
        }),
      ),
    ).toBe('MFA_CODE_INVALID');
    expect(await operationsOf(target.agencyId)).toBe(0);
  });

  it('[S16-04] an agency reinstated while its erasure runs: the next step refuses and the operation ends FAILED', async () => {
    const target = await createFounder();
    await setAgencyStatus(target.agencyId, 'SUSPENDED');
    const op = await startWithStepUp(superAdmin, target.agencyId, async () => {});
    await setAgencyStatus(target.agencyId, 'VERIFIED');
    let called = false;
    admin.configureAgencyEraser(async () => {
      called = true;
      return { finished: true, state: null };
    });
    expect(await admin.runStaffOperation(op.id)).toMatchObject({ state: 'FAILED', more: false });
    expect(called).toBe(false);
    const [row] = await rows<{ error_code: string }>(sql`select error_code from staff_operations where id = ${op.id}`);
    expect(row?.error_code).toBe('AGENCY_ERASURE_REFUSED');
  });

  it('[S16-04] agency erasure leaves no object under imports/sheets/<agency>/ and no PII of the agency anywhere; deals and audit rows stay with ids only', async () => {
    const T = `Leif${RUN}`;
    const MAIL = `leif-${RUN}@example.com`;
    const NOTE = `private matter ${RUN}`;
    const TOKENS = [T, MAIL, NOTE];
    // the leaving agency: a sheet connection (its file in use), a file never started, a contact with a deal, an export
    const used = await upload(leaving, `L1-${RUN}`);
    await as(leaving, (ctx) =>
      imports.startSheetImport(
        ctx,
        StartSheetImportBody.parse({ fileId: used.sheet?.fileId, name: `Leaving sheet ${RUN}`, mapping: MAPPING }),
      ),
    );
    await upload(leaving, `L2-${RUN}`);
    const kept = await upload(staying, `S1-${RUN}`);
    expect(await sheetObjects(leaving.agencyId)).toHaveLength(2);
    const { contact } = await as(leaving, (ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: T, emails: [MAIL], consentMarketing: true })),
    );
    const { lead } = await as(leaving, (ctx) =>
      crm.createLead(ctx, CreateLeadBody.parse({ contactId: contact.id, message: NOTE })),
    );
    const { contact: other } = await as(staying, (ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: `Stay${RUN}` })),
    );
    // what the agency holds outside its contacts: a task without a contact, a website lead never promoted, a chat
    // message, a member's saved search, a notification, a selection, a contact import file
    await as(leaving, (ctx) => crm.createTask(ctx, CreateTaskBody.parse({ title: `Ring ${T}`, description: NOTE })));
    const threadId = newId();
    await system(async (tx) => {
      await tx.execute(sql`insert into website_leads (id, agency_id, kind, request_hash, verification, locale, name,
          email, email_hash, key_tier, message)
        values (${newId()}, ${leaving.agencyId}, 'ENQUIRY', 'x', 'SERVER_KEY', 'en', ${T}, ${MAIL}, ${`h-${RUN}`},
          'STANDARD', ${NOTE})`);
      await tx.execute(sql`insert into chat_threads (id, agency_id, kind, title, created_by_user_id)
        values (${threadId}, ${leaving.agencyId}, 'DIRECT', ${`About ${T}`}, ${leaving.userId})`);
      await tx.execute(sql`insert into chat_participants (agency_id, thread_id, user_id)
        values (${leaving.agencyId}, ${threadId}, ${leaving.userId})`);
      await tx.execute(sql`insert into chat_messages (id, agency_id, thread_id, sender_agency_id, sender_user_id,
          sender_name, body)
        values (${newId()}, ${leaving.agencyId}, ${threadId}, ${leaving.agencyId}, ${leaving.userId}, 'Agent', ${NOTE})`);
      await tx.execute(sql`insert into saved_searches (id, agency_id, user_id, name, match_keys)
        values (${newId()}, ${leaving.agencyId}, ${leaving.userId}, ${`For ${T}`}, '{any}')`);
      await tx.execute(sql`insert into selections (id, agency_id, created_by, title, message, locale, token_hash,
          token_hint, expires_at)
        values (${newId()}, ${leaving.agencyId}, ${leaving.userId}, ${`For ${T}`}, ${NOTE}, 'en', ${`ae-${RUN}`},
          'abcd', now() + interval '30 days')`);
      await notifications.raiseNotifications(tx, {
        agencyId: leaving.agencyId,
        actorUserId: null,
        type: 'LEAD_ASSIGNED',
        userIds: [leaving.userId],
        params: { subject: T },
        link: '/inbox',
        sourceKey: `test:${RUN}`,
        at: new Date(),
      });
    });
    // S16-F5, the full tenant purge: a listing (its text names the client) and a listing document in storage
    const listing = await as(leaving, (ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({ propertyTypeId: ids.villa, locationId: ids.city, priceCents: 30_000_000 }),
      ),
    );
    await system((tx) =>
      tx.execute(sql`insert into property_translations (property_id, agency_id, locale, title, description, slug)
        values (${listing.id}, ${leaving.agencyId}, 'en', ${`Villa sold by ${T}`}, ${NOTE}, ${`villa-${RUN}`})`),
    );
    await store.put('private', `documents/${leaving.agencyId}/${listing.id}/${newId()}`, Buffer.from(`deed of ${T}`), {
      contentType: 'application/pdf',
    });
    const importFile = await crm.uploadContactImport(
      (fn) => as(leaving, fn),
      Buffer.from(`first_name,email\n${T},${MAIL}\n`),
    );
    const exportId = newId();
    await system((tx) =>
      tx.execute(sql`insert into data_export_jobs (id, agency_id, created_by, kind, format, status, finished_at,
          expires_at)
        values (${exportId}, ${leaving.agencyId}, ${leaving.userId}, 'ACCOUNT', 'csv', 'SUCCEEDED', now(),
                now() + interval '7 days')`),
    );
    await store.put('private', dataExportKey(leaving.agencyId, exportId), Buffer.from(`${T},${MAIL}`), {
      contentType: 'application/zip',
    });
    const before = await scanForTokens(TOKENS, { agencyId: leaving.agencyId });
    expect(before).toEqual(
      expect.arrayContaining([
        'contacts.first_name',
        'tasks.title',
        'website_leads.email',
        'chat_messages.body',
        'property_translations.title',
        'saved_searches.name',
        'selections.title',
        'notifications.params',
      ]),
    );
    expect(scanObjects(store.objects, TOKENS)).toEqual(
      expect.arrayContaining([`private/crm/contact-imports/${leaving.agencyId}/${importFile.id}`]),
    );

    await setAgencyStatus(leaving.agencyId, 'SUSPENDED');
    const op = await startWithStepUp(superAdmin, leaving.agencyId, async () => {});
    admin.configureAgencyEraser(eraseAgencyData);
    // one step at a time: the totals add up across steps
    let result = await admin.runStaffOperation(op.id, { maxSteps: 1 });
    for (let i = 0; i < 20 && result.state === 'RUNNING'; i++) {
      result = await admin.runStaffOperation(op.id, { maxSteps: 1 });
    }
    expect(result).toMatchObject({ state: 'SUCCEEDED', more: false });

    // no object under the leaving agency's prefixes; the other agency's file stays
    expect(await sheetObjects(leaving.agencyId)).toEqual([]);
    expect(await sheetObjects(staying.agencyId)).toEqual([`imports/sheets/${staying.agencyId}/${kept.sheet?.fileId}`]);
    expect(scanObjects(store.objects, TOKENS)).toEqual([]);
    expect([...store.objects.keys()].filter((k) => k.includes(`contact-imports/${leaving.agencyId}/`))).toEqual([]);
    // no token in any row of the agency
    expect(await scanForTokens(TOKENS, { agencyId: leaving.agencyId })).toEqual([]);
    const [left] = await rows<{ connections: number; open: number; exports: string }>(sql`select
        (select count(*) from feed_connections where agency_id = ${leaving.agencyId})::int as connections,
        (select count(*) from contacts where agency_id = ${leaving.agencyId} and deleted_at is null)::int as open,
        (select status from data_export_jobs where id = ${exportId}) as exports`);
    expect(left).toEqual({ connections: 0, open: 0, exports: 'EXPIRED' });
    // S16-F5, the full tenant purge: no listing, chat thread, participant or notification of the agency is left
    const [purged] = await rows<Record<string, number>>(sql`select
        (select count(*) from properties where agency_id = ${leaving.agencyId})::int as listings,
        (select count(*) from property_translations where agency_id = ${leaving.agencyId})::int as translations,
        (select count(*) from chat_threads where agency_id = ${leaving.agencyId})::int as threads,
        (select count(*) from chat_participants where agency_id = ${leaving.agencyId})::int as participants,
        (select count(*) from chat_messages where agency_id = ${leaving.agencyId})::int as messages,
        (select count(*) from notifications where agency_id = ${leaving.agencyId})::int as notifications,
        (select count(*) from outbox_events where agency_id = ${leaving.agencyId}
           and type = 'properties.listing.purged' and payload->>'listingId' = ${listing.id})::int as purged_events`);
    expect(purged).toEqual({
      listings: 0,
      translations: 0,
      threads: 0,
      participants: 0,
      messages: 0,
      notifications: 0,
      purged_events: 1,
    });
    expect([...store.objects.keys()].filter((k) => k.includes(`documents/${leaving.agencyId}/`))).toEqual([]);
    // the other agency's listings are untouched; the member account stays (platform account, PLAN §13)
    const [member] = await rows<{ users: number; members: number }>(sql`select
        (select count(*) from users where id = ${leaving.userId})::int as users,
        (select count(*) from agency_members where agency_id = ${leaving.agencyId})::int as members`);
    expect(member).toEqual({ users: 1, members: 1 });
    // the deal stays (ids, stage), pointing at the tombstone; the audit trail: ids and counts only
    const [deal] = await rows<{ contact_id: string; message: string | null }>(
      sql`select contact_id, message from leads where id = ${lead.id}`,
    );
    expect(deal).toEqual({ contact_id: contact.id, message: null });
    const audits = await rows<{ type: string; actor_kind: string; metadata: Record<string, number> }>(
      sql`select type, actor_kind, metadata from audit_logs where agency_id = ${leaving.agencyId}
            and type in ('compliance.agency.erased', 'imports.connections.erased', 'crm.contact.erased',
                         'crm.contact.erasureCompleted')
          order by occurred_at, id`,
    );
    expect(audits.map((r) => [r.type, r.actor_kind])).toEqual([
      ['imports.connections.erased', 'system'],
      ['crm.contact.erased', 'system'],
      // the contact's after-commit work ran inline, before the agency's erasure was audited
      ['crm.contact.erasureCompleted', 'system'],
      ['compliance.agency.erased', 'system'],
    ]);
    expect(audits[3]?.metadata).toMatchObject({
      imports: 3, // 1 connection + 2 sheets
      contacts: 1,
      websiteLeads: 1,
      chat: 2, // the message, then the thread (with its participant)
      listings: 1,
      listingPurge: 1,
      savedSearches: 1,
      selections: 1,
      exports: 1,
    });
    expect(audits[3]?.metadata.notifications).toBeGreaterThanOrEqual(1);
    expect(audits[3]?.metadata.contactImports).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits)).not.toContain(RUN);
    // the other agency is untouched
    const [stay] = await rows<{ first_name: string }>(sql`select first_name from contacts where id = ${other.id}`);
    expect(stay?.first_name).toBe(`Stay${RUN}`);

    // idempotent: a fresh erasure finds nothing left
    // (S15-F10: 14 phases — even an empty pass can need more than one step's call budget, as the worker runs it)
    let again = await eraseAgencyData(leaving.agencyId);
    for (let step = 0; !again.finished && step < 5; step++) {
      again = await eraseAgencyData(leaving.agencyId, { state: again.state });
    }
    expect(again.finished).toBe(true);
    expect(Object.values(again.state.counts).every((n) => n === 0)).toBe(true);
  }, 180_000);
  it('[S16-F5] a listing another transaction holds keeps the listings and purge phases going until it is retired and purged', async () => {
    const m = await createFounder();
    const listing = await as(m, (ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({ propertyTypeId: ids.villa, locationId: ids.city, priceCents: 20_000_000 }),
      ),
    );
    await store.put('private', `documents/${m.agencyId}/${listing.id}/${newId()}`, Buffer.from('deed'), {
      contentType: 'application/pdf',
    });
    const lockWhile = <T>(fn: () => Promise<T>) =>
      system(async (tx) => {
        await tx.execute(sql`select id from properties where id = ${listing.id} for update`);
        return fn();
      });
    // locked: skipped, but the phase is not done
    expect(await lockWhile(() => properties.retireAgencyListings({ agencyId: m.agencyId }))).toEqual({
      rows: 0,
      more: true,
    });
    expect(await properties.retireAgencyListings({ agencyId: m.agencyId })).toEqual({ rows: 1, more: false });
    // the purge: a soft-deleted listing held by another transaction keeps it going, its documents stay meanwhile
    expect(await lockWhile(() => media.purgeAgencyListings({ agencyId: m.agencyId }))).toMatchObject({
      listings: 0,
      documents: 0,
      more: true,
    });
    expect([...store.objects.keys()].some((k) => k.includes(`documents/${m.agencyId}/`))).toBe(true);
    expect(await media.purgeAgencyListings({ agencyId: m.agencyId })).toMatchObject({ listings: 1, more: false });
    expect([...store.objects.keys()].some((k) => k.includes(`documents/${m.agencyId}/`))).toBe(false);
    const [left] = await rows<{ n: number }>(
      sql`select count(*)::int as n from properties where agency_id = ${m.agencyId}`,
    );
    expect(left?.n).toBe(0);
  });

  it('[S16-F5] an agency reinstated between two batches of one step: the erasure stops before the next batch', async () => {
    const m = await createFounder();
    const { contact } = await as(m, (ctx) =>
      crm.createContact(ctx, CreateContactBody.parse({ firstName: `Keep${RUN}` })),
    );
    await setAgencyStatus(m.agencyId, 'SUSPENDED');
    let checks = 0;
    const assertSuspended = async () => {
      checks += 1;
      if (checks === 2) await setAgencyStatus(m.agencyId, 'VERIFIED'); // reinstated after the first batch
      const [row] = await rows<{ status: string }>(sql`select status from agencies where agency_id = ${m.agencyId}`);
      if (row?.status !== 'SUSPENDED') throw new AppError('AGENCY_ERASURE_REFUSED');
    };
    expect(await refusal(eraseAgencyData(m.agencyId, { assertSuspended }))).toBe('AGENCY_ERASURE_REFUSED');
    expect(checks).toBe(2);
    // the first batch (imports) ran; the contacts batch never did
    const [open] = await rows<{ first_name: string | null; deleted: boolean }>(
      sql`select first_name, deleted_at is not null as deleted from contacts where id = ${contact.id}`,
    );
    expect(open).toEqual({ first_name: `Keep${RUN}`, deleted: false });
  });
});
