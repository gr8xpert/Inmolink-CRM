import {
  CreateContactBody,
  CreateListingBody,
  CreateTaskBody,
  ListTasksQuery,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, withSystem, withTenant } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { loadConfig, storageEnv } from '@inmolink/platform/config';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { configureStorage, createS3Store, storage, storageConfigFromEnv } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, StaffCtx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { countQueries, createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as chat from '../../chat';
import * as crm from '../../crm';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as mls from '../index';

/**
 * The deal room's documents, tasks, chat thread and notifications (R2-04b): both parties read a deal's documents, only
 * the uploader removes one (while the deal is open), and the database refuses anything else; a deal's tasks are the
 * agency's own CRM tasks; a deal's chat thread is between exactly its two parties; a `mls.deal.changed` notifies the
 * other party only after the deal is re-read and the event's agency proved one of its parties. Every query is scoped to
 * this file's agencies and deals.
 */

const RUN = newId().slice(-8).toLowerCase();
const DAY_MS = 86_400_000;
const keyring = createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('mls.dealRoom.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** `a` introduces, `b` owns the listing, `c` is a stranger to both. */
let a: Founder;
let b: Founder;
let c: Founder;
let ids: { city: string; villa: string };
let listingId: string;
let dataOps: string;
let seq = 0;
const objectKeys: string[] = [];

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const runner =
  (m: Founder) =>
  <T>(fn: (ctx: Ctx) => Promise<T>) =>
    as(m, fn);
const asStaff = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'mls deal room int test' }, fn);
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
const eur = (amountCents: number) => ({ amountCents, currency: 'EUR' });
const log = createLogger({ service: 'test', level: 'silent' });
const jobCtx = () => ({
  log,
  jobId: 'test',
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

/** A PDF-looking file unique to this run (magic bytes, then filler). */
const pdf = (label: string) => new TextEncoder().encode(`%PDF-1.7\n% ${RUN} ${label}\n%%EOF\n`);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) {
      const reason = (err.details as { reason?: string } | undefined)?.reason;
      return reason ? `${err.code}:${reason}` : err.code;
    }
    throw err;
  }
  return 'accepted';
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
      if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    }
    return `no sqlstate: ${String(err)}`;
  }
  return undefined;
}

/** An open deal between `a` (introducer) and `b` (owner) of a fresh accepted viewing. */
async function openDeal(): Promise<string> {
  seq += 1;
  const contact = (
    await as(a, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({
          firstName: 'Room',
          lastName: `Buyer${seq}`,
          emails: [`room-${seq}-${RUN}@example.com`],
        }),
      ),
    )
  ).contact;
  const reg = await mls.registerClient((fn) => as(a, fn), {
    contactId: contact.id,
    target: { kind: 'LISTING', id: listingId },
  });
  const req = await as(a, (ctx) =>
    mls.requestViewing(ctx, { registrationId: reg.registration.id, proposedStartAt: inDays(5) }),
  );
  await as(b, (ctx) => mls.acceptViewing(ctx, req.request.id));
  const opened = await as(a, (ctx) => mls.openDeal(ctx, { viewingRequestId: req.request.id, price: eur(58_000_000) }));
  return opened.deal.id;
}

const upload = (m: Founder, dealId: string, label: string, body = pdf(label)) =>
  mls.uploadDealDocument(runner(m), { dealId, fileName: `${label}.pdf`, kind: 'OFFER', body }).then((d) => {
    objectKeys.push(mls.dealDocumentKey(dealId, d.id));
    return d;
  });

/** The dispatcher's part: the delete job for the document's `mls.dealDocument.removed` event. */
async function runDeleteJob(documentId: string): Promise<void> {
  const [e] = await rows<{ id: string; agency_id: string; payload: { dealId: string; documentId: string } }>(
    sql`select id, agency_id, payload from outbox_events
         where type = 'mls.dealDocument.removed' and payload->>'documentId' = ${documentId}`,
  );
  if (!e) throw new Error('no mls.dealDocument.removed event');
  await mls.mlsJobs.deleteDealDocumentObject.spec.run(
    { eventId: e.id, agencyId: e.agency_id, dealId: e.payload.dealId, documentId: e.payload.documentId },
    jobCtx(),
  );
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  configureStorage(createS3Store(storageConfigFromEnv(loadConfig(storageEnv))));
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  mls.configureMls({
    keyring,
    fingerprintKey: `test-fingerprint-key-${RUN}-0123456789abcdef`,
    viewingRequestExpiryDays: 3,
  });
  [a, b, c] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  for (const m of [a, b, c]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  dataOps = (await createStaffUser('STAFF_DATA_OPS')).userId;
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `mls-dr-${RUN}`,
      translations: name('Roomcountry'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `mls-dr-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `mls-dr-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  const { id } = await as(b, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 60_000_000,
        energyRating: 'B',
        commission: { type: 'PCT', basisPoints: 300, includesVat: false },
        splitBp: 5000,
      }),
    ),
  );
  await as(b, async (ctx) =>
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
  listingId = id;
}, 180_000);

afterAll(async () => {
  for (const k of objectKeys) {
    await storage()
      .delete('private', k)
      .catch(() => {});
  }
  await closeRateLimit();
  await closeDb();
});

describe('[R2-04b] deal documents', () => {
  it('[R2-04b] both parties read a deal’s documents; a stranger nothing; only PDFs; a retried upload answers the first', async () => {
    const deal = await openDeal();
    const offer = await upload(a, deal, 'offer');
    expect(offer).toMatchObject({ dealId: deal, kind: 'OFFER', fileName: 'offer.pdf', removedAt: null });
    expect(offer.uploadedBy.ownAgency).toBe(true);

    const owners = await as(b, (ctx) => mls.listDealDocuments(ctx, deal));
    expect(owners.items).toHaveLength(1);
    expect(owners.items[0]).toMatchObject({ id: offer.id, uploadedBy: { ownAgency: false } });
    const opened = await as(b, (ctx) => mls.openDealDocument(ctx, { dealId: deal, documentId: offer.id }));
    expect(opened.url).toContain(offer.id);

    expect(await refusal(as(c, (ctx) => mls.listDealDocuments(ctx, deal)))).toBe('DEAL_NOT_FOUND');
    expect(await refusal(as(c, (ctx) => mls.openDealDocument(ctx, { dealId: deal, documentId: offer.id })))).toBe(
      'DEAL_DOCUMENT_NOT_FOUND',
    );
    expect(await refusal(upload(c, deal, 'stranger'))).toBe('DEAL_NOT_FOUND');

    // the real type decides: a PNG renamed .pdf is refused
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(await refusal(upload(a, deal, 'image', png))).toBe('DOCUMENT_TYPE_NOT_ALLOWED');

    const again = await upload(a, deal, 'offer');
    expect(again.id).toBe(offer.id);
    expect((await as(a, (ctx) => mls.listDealDocuments(ctx, deal))).items).toHaveLength(1);

    // audited in each agency's own log
    const audits = await rows<{ agency_id: string; type: string }>(sql`
      select agency_id, type from audit_logs where target_id = ${offer.id}
        and agency_id in (${a.agencyId}, ${b.agencyId}) order by occurred_at`);
    expect(audits).toEqual(
      expect.arrayContaining([
        { agency_id: a.agencyId, type: 'mls.dealDocument.uploaded' },
        { agency_id: b.agencyId, type: 'mls.dealDocument.opened' },
      ]),
    );
  });

  it('[R2-04b] only the uploading agency removes a document, while the deal is open; both copies stay listed as removed and the object goes', async () => {
    const deal = await openDeal();
    const doc = await upload(a, deal, 'reservation');
    expect(await refusal(as(b, (ctx) => mls.removeDealDocument(ctx, { dealId: deal, documentId: doc.id })))).toBe(
      'DEAL_DOCUMENT_NOT_FOUND',
    );
    await as(a, (ctx) => mls.removeDealDocument(ctx, { dealId: deal, documentId: doc.id }));
    for (const m of [a, b]) {
      const [listed] = (await as(m, (ctx) => mls.listDealDocuments(ctx, deal))).items;
      expect(listed?.removedAt).not.toBeNull();
      expect(await refusal(as(m, (ctx) => mls.openDealDocument(ctx, { dealId: deal, documentId: doc.id })))).toBe(
        'DEAL_DOCUMENT_NOT_FOUND',
      );
    }
    const key = mls.dealDocumentKey(deal, doc.id);
    expect(await storage().head('private', key)).not.toBeNull();
    await runDeleteJob(doc.id);
    expect(await storage().head('private', key)).toBeNull();

    // a closed deal's documents are fixed: no upload, no removal
    const kept = await upload(b, deal, 'arras');
    await as(a, (ctx) => mls.fallThroughDeal(ctx, deal, { reason: 'Buyer withdrew' }));
    expect(await refusal(upload(a, deal, 'late'))).toBe('DEAL_STATE:closed');
    expect(await refusal(as(b, (ctx) => mls.removeDealDocument(ctx, { dealId: deal, documentId: kept.id })))).toBe(
      'DEAL_STATE:closed',
    );
    // still readable by both
    await as(a, (ctx) => mls.openDealDocument(ctx, { dealId: deal, documentId: kept.id }));
  });

  it('[R2-04b] the database refuses an upload as someone else, under another key, for the peer, on a closed deal, and any edit or delete', async () => {
    const deal = await openDeal();
    const doc = await upload(a, deal, 'deed');
    const insert = (m: Founder, over: { agency?: string; key?: string; user?: string; deal?: string } = {}) =>
      withTenant({ agencyId: m.agencyId, userId: m.userId }, async (tx) => {
        const id = newId();
        const dealId = over.deal ?? deal;
        await tx.execute(sql`
            insert into deal_documents (agency_id, id, deal_id, uploader_agency_id, uploaded_by_user_id, uploader_name,
              kind, file_name, size_bytes, sha256, storage_key)
            values (${over.agency ?? m.agencyId}, ${id}, ${dealId}, ${over.agency ?? m.agencyId},
              ${over.user ?? m.userId}, 'X', 'OTHER', 'x.pdf', 10, ${'a'.repeat(64)},
              ${over.key ?? `deal-documents/${dealId}/${id}`})`);
      });
    // another object's key (the other document's), as another member, into the peer's copy, by a stranger
    expect(await sqlState(insert(a, { key: mls.dealDocumentKey(deal, doc.id) }))).toBe('42501');
    expect(await sqlState(insert(a, { user: b.userId }))).toBe('42501');
    expect(await sqlState(insert(a, { agency: b.agencyId }))).toBe('42501');
    expect(await sqlState(insert(c))).toBe('42501');
    // the owner may not rewrite or delete the introducer's document; the uploader may not rewrite its own
    const tenant = (m: Founder) => ({
      agencyId: m.agencyId,
      userId: m.userId,
    });
    expect(
      await sqlState(
        withTenant(tenant(b), (tx) =>
          tx.execute(sql`update deal_documents set removed_at = now(), removed_by_user_id = ${b.userId}
                          where agency_id = ${b.agencyId} and id = ${doc.id}`),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        withTenant(tenant(a), (tx) =>
          tx.execute(sql`update deal_documents set storage_key = 'deal-documents/x' where agency_id = ${a.agencyId}
                          and id = ${doc.id}`),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        withTenant(tenant(a), (tx) =>
          tx.execute(sql`delete from deal_documents where agency_id = ${a.agencyId} and id = ${doc.id}`),
        ),
      ),
    ).toBe('42501');
    // a closed deal takes no document, even by SQL
    await as(b, (ctx) => mls.fallThroughDeal(ctx, deal, { reason: 'No mortgage' }));
    expect(await sqlState(insert(a))).toBe('42501');
  });

  it('[R2-04b] an hour-old deal-documents/ object no live row names is swept; a live one stays', async () => {
    const deal = await openDeal();
    const kept = await upload(a, deal, 'kept');
    const orphan = mls.dealDocumentKey(deal, newId());
    objectKeys.push(orphan);
    await storage().put('private', orphan, pdf('orphan'), { contentType: 'application/pdf' });
    const sweep = () => mls.mlsJobs.sweepOrphanDealDocuments.spec.run({}, jobCtx());
    await sweep(); // younger than an hour: may still be between store and record
    expect(await storage().head('private', orphan)).not.toBeNull();
    useFakeClock(Date.now() + 61 * 60_000);
    try {
      await sweep();
    } finally {
      restoreClock();
    }
    expect(await storage().head('private', orphan)).toBeNull();
    expect(await storage().head('private', mls.dealDocumentKey(deal, kept.id))).not.toBeNull();
  });

  it('[R2-04b] staff impersonating a member and Client Mode change nothing in the deal room; the document list is 2 queries', async () => {
    const deal = await openDeal();
    const doc = await upload(a, deal, 'imp');
    const staffId = newId();
    const imp =
      <T>(fn: (ctx: Ctx) => Promise<T>) =>
      (m: Founder) =>
        as(m, async (ctx) => fn(await impersonatedCtx(ctx, staffId)));
    const client =
      <T>(fn: (ctx: Ctx) => Promise<T>) =>
      (m: Founder) =>
        as(m, (ctx) => fn({ ...ctx, clientMode: true }));
    for (const wrap of [imp, client]) {
      const run = <T>(fn: (ctx: Ctx) => Promise<T>) => wrap(fn)(a);
      expect(
        await refusal(mls.uploadDealDocument(run, { dealId: deal, fileName: 'x.pdf', body: pdf(`w-${seq}`) })),
      ).toBe('FORBIDDEN');
      expect(await refusal(run((ctx) => mls.removeDealDocument(ctx, { dealId: deal, documentId: doc.id })))).toBe(
        'FORBIDDEN',
      );
      expect(await refusal(run((ctx) => mls.createDealTask(ctx, deal, CreateTaskBody.parse({ title: 'Imp' }))))).toBe(
        'FORBIDDEN',
      );
      expect(await refusal(run((ctx) => chat.openDealThread(ctx, { dealId: deal })))).toBe('FORBIDDEN');
    }
    const queries = await countQueries(() => as(b, (ctx) => mls.listDealDocuments(ctx, deal)));
    expect(queries).toBeLessThanOrEqual(2 + 4); // the list's 2, plus the member context's own setup
  });

  it('[R2-04b] an agency erasure blanks the member and file names of its uploads on both copies; the rows and PDFs stay', async () => {
    const deal = await openDeal();
    const doc = await mls.uploadDealDocument(runner(a), {
      dealId: deal,
      fileName: 'Arras - Zelda Quuxberry.pdf',
      kind: 'ARRAS',
      body: pdf('erase'),
    });
    objectKeys.push(mls.dealDocumentKey(deal, doc.id));
    const other = await upload(b, deal, 'owner-side');
    let more = true;
    while (more) more = (await mls.eraseAgencyDealDocuments({ agencyId: a.agencyId })).more;
    const copies = await rows<{ agency_id: string; id: string; uploader_name: string; file_name: string }>(sql`
      select agency_id, id, uploader_name, file_name from deal_documents
       where deal_id = ${deal} and agency_id in (${a.agencyId}, ${b.agencyId}) order by agency_id, id`);
    const mine = copies.filter((r) => r.id === doc.id);
    expect(mine).toHaveLength(2);
    for (const r of mine) expect(r).toMatchObject({ uploader_name: '', file_name: 'arras.pdf' });
    // the other party's upload keeps its names; the PDF stays for both
    expect(copies.filter((r) => r.id === other.id).every((r) => r.file_name === 'owner-side.pdf')).toBe(true);
    expect(await storage().head('private', mls.dealDocumentKey(deal, doc.id))).not.toBeNull();
    expect((await mls.eraseAgencyDealDocuments({ agencyId: a.agencyId })).rows).toBe(0);
  });
});

describe('[R2-04b] deal tasks', () => {
  it('[R2-04b] a deal’s tasks are the agency’s own CRM tasks linked to its copy; the other party never sees them', async () => {
    const deal = await openDeal();
    const { task } = await as(a, (ctx) =>
      mls.createDealTask(ctx, deal, CreateTaskBody.parse({ title: 'Send the reservation contract' })),
    );
    expect(task).toMatchObject({ dealId: deal, assignedUserId: a.userId, status: 'OPEN' });
    const mine = await as(a, (ctx) => crm.listTasks(ctx, ListTasksQuery.parse({ dealId: deal, assignee: 'any' })));
    expect(mine.items.map((t) => t.id)).toEqual([task.id]);
    const theirs = await as(b, (ctx) => crm.listTasks(ctx, ListTasksQuery.parse({ dealId: deal, assignee: 'any' })));
    expect(theirs.items).toEqual([]);
    expect(await refusal(as(c, (ctx) => mls.createDealTask(ctx, deal, CreateTaskBody.parse({ title: 'Snoop' }))))).toBe(
      'DEAL_NOT_FOUND',
    );
    // an Idempotency-Key replays on the same deal only
    const key = `deal-task-${RUN}-0001`;
    const first = await as(b, (ctx) =>
      mls.createDealTask(ctx, deal, CreateTaskBody.parse({ title: 'Book the notary' }), { idempotencyKey: key }),
    );
    const replay = await as(b, (ctx) =>
      mls.createDealTask(ctx, deal, CreateTaskBody.parse({ title: 'Book the notary' }), { idempotencyKey: key }),
    );
    expect(replay).toMatchObject({ replayed: true, task: { id: first.task.id } });
    const other = await openDeal();
    expect(
      await refusal(
        as(b, (ctx) =>
          mls.createDealTask(ctx, other, CreateTaskBody.parse({ title: 'Book the notary' }), { idempotencyKey: key }),
        ),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('[R2-04b] the deal’s chat thread', () => {
  it('[R2-04b] a deal’s thread is between its two parties only: both copies, seated, messages reach the other party', async () => {
    const deal = await openDeal();
    const thread = await as(a, (ctx) => chat.openDealThread(ctx, { dealId: deal }));
    expect(thread).toMatchObject({ id: deal, kind: 'DEAL', dealId: deal, peerAgency: { id: b.agencyId } });
    await chat.seatDealThread({ agencyId: a.agencyId, threadId: deal });
    await chat.seatDealThread({ agencyId: a.agencyId, threadId: deal }); // idempotent
    // the owner's side was seated (the listing's agent: its founder); opening again joins the same thread
    const owners = await as(b, (ctx) => chat.getThread(ctx, deal));
    expect(owners.participants.map((p) => p.userId)).toEqual([b.userId]);
    expect((await as(b, (ctx) => chat.openDealThread(ctx, { dealId: deal }))).id).toBe(deal);
    expect(owners.subject).not.toBeNull();

    await as(a, (ctx) => chat.sendMessage(ctx, deal, { body: 'The buyer accepts the offer' }));
    const seen = await as(b, (ctx) => chat.listMessages(ctx, deal, { limit: 10 }));
    expect(seen.items.map((m) => m.body)).toEqual(['The buyer accepts the offer']);

    // a stranger cannot open it nor plant a copy naming the deal
    expect(await refusal(as(c, (ctx) => chat.openDealThread(ctx, { dealId: deal })))).toBe('DEAL_NOT_FOUND');
    expect(await refusal(as(c, (ctx) => chat.getThread(ctx, deal)))).toBe('CHAT_THREAD_NOT_FOUND');
    const plant = (peer: string) =>
      withTenant({ agencyId: c.agencyId, userId: c.userId }, (tx) =>
        tx.execute(sql`insert into chat_threads (agency_id, id, kind, peer_agency_id)
                          values (${c.agencyId}, ${deal}, 'DEAL', ${peer})`),
      );
    expect(await sqlState(plant(a.agencyId))).toBe('42501');
    expect(await sqlState(plant(b.agencyId))).toBe('42501');
    // the stranger's seat job does nothing
    expect(await chat.seatDealThread({ agencyId: c.agencyId, threadId: deal })).toEqual({ seated: 0 });
  });
});

describe('[R2-04b] notifications on deal changes', () => {
  const eventsOf = (dealId: string) =>
    rows<{ id: string; agency_id: string; payload: unknown; created_at: Date }>(sql`
      select id, agency_id, payload, created_at from outbox_events
       where type = 'mls.deal.changed' and payload->>'dealId' = ${dealId} order by created_at, id`);
  const notified = (eventId: string) =>
    rows<{ agency_id: string; user_id: string; type: string; link: string }>(sql`
      select agency_id, user_id, type, link from notifications where source_key like ${`${eventId}:%`}`);
  const run = (e: { id: string; agency_id: string; payload: unknown; created_at: Date }) =>
    mls.notifyDealChange(mls.mlsEvents.dealChanged.schema.parse(e.payload), {
      eventId: e.id,
      agencyId: e.agency_id,
      createdAt: new Date(e.created_at),
    });

  it('[R2-04b] a party’s move notifies the other party’s members, once', async () => {
    const deal = await openDeal();
    await as(b, (ctx) => mls.advanceDeal(ctx, deal, { stage: 'RESERVATION' }));
    const [opened, advanced] = await eventsOf(deal);
    if (!opened || !advanced) throw new Error('no deal events');
    expect(await run(opened)).toEqual({ notified: 1 });
    expect(await run(opened)).toEqual({ notified: 0 }); // a redelivery adds nothing
    expect(await notified(opened.id)).toEqual([
      { agency_id: b.agencyId, user_id: b.userId, type: 'DEAL_UPDATED', link: mls.dealLink(deal) },
    ]);
    await run(advanced);
    expect(await notified(advanced.id)).toEqual([
      { agency_id: a.agencyId, user_id: a.userId, type: 'DEAL_UPDATED', link: mls.dealLink(deal) },
    ]);
  });

  it('[R2-04b] a mediation notifies each party; an event whose agency is no party, or of no deal, notifies nobody', async () => {
    const deal = await openDeal();
    await asStaff(dataOps, (ctx) => mls.mediateDeal(ctx, deal, { reason: 'Agreed price', price: eur(57_000_000) }));
    const mediated = (await eventsOf(deal)).filter((e) => (e.payload as { action: string }).action === 'MEDIATED');
    expect(mediated).toHaveLength(2);
    for (const e of mediated) await run(e);
    const told = (await Promise.all(mediated.map((e) => notified(e.id)))).flat();
    expect(told.map((n) => n.agency_id).sort()).toEqual([a.agencyId, b.agencyId].sort());

    // staff may write the event for any agency: one naming a stranger's agency (or claiming the stranger is a party)
    // reaches nobody; nor one of a deal that does not exist
    const forged = (agencyId: string, dealId: string, by: 'STAFF' | 'OWNER') => ({
      payload: {
        agencyId,
        dealId,
        introducerAgencyId: c.agencyId,
        ownerAgencyId: agencyId,
        action: 'MEDIATED' as const,
        by,
        userId: dataOps,
      },
      meta: { eventId: newId(), agencyId, createdAt: new Date() },
    });
    for (const f of [
      forged(c.agencyId, deal, 'STAFF'),
      forged(c.agencyId, deal, 'OWNER'),
      forged(a.agencyId, newId(), 'STAFF'),
    ]) {
      expect(await mls.notifyDealChange(f.payload, f.meta)).toEqual({ notified: 0 });
      expect(await notified(f.meta.eventId)).toEqual([]);
    }
  });
});
