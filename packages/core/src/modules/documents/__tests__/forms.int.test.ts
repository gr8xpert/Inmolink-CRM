import { createHash } from 'node:crypto';
import {
  CreateContactBody,
  CreateFormDocumentBody,
  CreateListingBody,
  ListFormDocumentsQuery,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { invalidateFlags, setFlag, setFlagOverride } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { configurePdf } from '@inmolink/platform/pdf';
import { fakePdfRenderer } from '@inmolink/platform/pdf/testing';
import { configureStorage, createMemoryStore, type MemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as crm from '../../crm';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as documents from '../index';

/**
 * The forms library (R2-05a): a member makes a form merged from the agency's data (listing, contact, agency, request
 * amounts), behind the `documents.forms` flag; the row is PENDING with a `documents.form.created` event in the same
 * transaction; the render stores the PDF once and records its SHA-256, which matches the stored bytes; lists page by
 * keyset; contact and agency erasure remove forms and their PDFs. Every query is scoped to this file's agencies.
 */

const RUN = newId().slice(-8).toLowerCase();
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('documents.forms.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** a: makes forms (flag on) · b: another agency (flag off). */
let a: Founder;
let b: Founder;
let ids: { city: string; villa: string };
let own: string;
let own2: string;
let bListing: string;
let seller: string;
let buyer: string;
let bContact: string;
let store: MemoryStore;
let fake: ReturnType<typeof fakePdfRenderer>;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const eur = (amountCents: number) => ({ amountCents, currency: 'EUR' });

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

async function listing(m: Founder, body: Partial<CreateListingBody>): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.villa, locationId: ids.city, priceCents: 45_000_050, ...body }),
    ),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ status: 'ACTIVE', version: (await properties.getListing(ctx, id)).version }),
    ),
  );
  return id;
}

async function contact(m: Founder, firstName: string): Promise<string> {
  const { contact: c } = await as(m, (ctx) =>
    crm.createContact(
      ctx,
      CreateContactBody.parse({ firstName, lastName: `Forms${RUN}`, emails: [`${firstName}-${RUN}@example.com`] }),
    ),
  );
  return c.id;
}

/** Runs `fn` with the forms flag on for `m` (then back to the default). */
async function withFlag(m: Founder, fn: () => Promise<void>): Promise<void> {
  await system((tx) => setFlagOverride(tx, documents.FORMS_FLAG, m.agencyId, true));
  invalidateFlags();
  try {
    await fn();
  } finally {
    await system((tx) => setFlagOverride(tx, documents.FORMS_FLAG, m.agencyId, null));
    invalidateFlags();
  }
}

const make = (m: Founder, body: unknown, key?: string) =>
  as(m, (ctx) =>
    documents.createFormDocument(ctx, CreateFormDocumentBody.parse(body), key ? { idempotencyKey: key } : {}),
  );

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  store = createMemoryStore();
  configureStorage(store);
  fake = fakePdfRenderer();
  configurePdf(fake);
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  await system(async (tx) => {
    await setFlag(tx, documents.FORMS_FLAG, { enabled: false });
    await setFlagOverride(tx, documents.FORMS_FLAG, a.agencyId, true);
  });
  invalidateFlags();
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `forms-${RUN}`,
      translations: name('Formland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `forms-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `forms-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  own = await listing(a, { commission: { type: 'PCT', basisPoints: 350, includesVat: false }, splitBp: 5000 });
  own2 = await listing(a, { priceCents: 30_000_000 });
  bListing = await listing(b, {});
  seller = await contact(a, 'Sella');
  buyer = await contact(a, 'Bruno');
  bContact = await contact(b, 'Other');
}, 180_000);

afterAll(async () => {
  await system(async (tx) => {
    await tx.execute(sql`delete from form_documents where agency_id in (${a.agencyId}, ${b.agencyId})`);
    await setFlagOverride(tx, documents.FORMS_FLAG, a.agencyId, null);
  });
  await closeDb();
});

describe('[R2-05a] making forms', () => {
  it('[R2-05a] each template is merged from the agency’s data: PENDING row + created event in one transaction', async () => {
    const listingAgreement = await make(a, {
      template: 'LISTING_AGREEMENT',
      listingId: own,
      contactId: seller,
      exclusive: true,
      termMonths: 6,
      locale: 'es',
    });
    expect(listingAgreement.replayed).toBe(false);
    const f = listingAgreement.form;
    expect(f).toMatchObject({
      template: 'LISTING_AGREEMENT',
      locale: 'es',
      status: 'PENDING',
      listingId: own,
      contactId: seller,
      dealId: null,
      sha256: null,
      createdByUserId: a.userId,
      url: null,
    });
    expect(f.label).toContain(`Sella Forms${RUN}`);
    const [stored] = await rows<{ data: Record<string, unknown> }>(
      sql`select data from form_documents where id = ${f.id}`,
    );
    const data = documents.FormData.parse(stored?.data);
    expect(data).toMatchObject({
      template: 'LISTING_AGREEMENT',
      client: { contactId: seller, name: `Sella Forms${RUN}`, email: `sella-${RUN}@example.com` },
      property: { listingId: own, price: eur(45_000_050) },
      commission: { bp: 350, fixed: null, includesVat: false },
      exclusive: true,
      termMonths: 6,
    });
    const events = await rows<{ type: string; payload: { formId: string } }>(
      sql`select type, payload from outbox_events where agency_id = ${a.agencyId} and type = 'documents.form.created'
          and payload->>'formId' = ${f.id}`,
    );
    expect(events).toHaveLength(1);

    const reservation = (
      await make(a, {
        template: 'RESERVATION',
        listingId: own,
        contactId: buyer,
        deposit: eur(600_050),
        holdDays: 15,
      })
    ).form;
    const offer = (
      await make(a, {
        template: 'OFFER',
        listingId: own,
        contactId: buyer,
        offer: eur(43_000_000),
        validUntil: '2026-12-01',
        conditions: 'Subject to a mortgage',
      })
    ).form;
    const sheet = (
      await make(a, { template: 'VIEWING_SHEET', contactId: buyer, listingIds: [own, own2], visitedOn: '2026-11-06' })
    ).form;
    const [res, sh] = await rows<{ id: string; data: Record<string, unknown> }>(
      sql`select id, data from form_documents where id in (${reservation.id}, ${sheet.id}) order by template`,
    );
    // the reservation's price defaults to the listing's; the sheet keeps the listings in the order asked
    expect(documents.FormData.parse(res?.data)).toMatchObject({ price: eur(45_000_050), deposit: eur(600_050) });
    expect(
      (documents.FormData.parse(sh?.data) as { properties: { listingId: string }[] }).properties.map(
        (p) => p.listingId,
      ),
    ).toEqual([own, own2]);
    expect(offer.status).toBe('PENDING');
  });

  it('[R2-05a] refused: flag off, Client Mode, impersonation, another agency’s listing or contact, bad amounts', async () => {
    const body = { template: 'OFFER', listingId: own, contactId: buyer, offer: eur(1_000), validUntil: '2026-12-01' };
    expect(await refusal(make(b, { ...body, listingId: bListing, contactId: bContact }))).toBe('FORMS_NOT_ENABLED');
    expect(
      await refusal(
        as(a, (ctx) => documents.createFormDocument({ ...ctx, clientMode: true }, CreateFormDocumentBody.parse(body))),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await refusal(
        as(a, async (ctx) =>
          documents.createFormDocument(await impersonatedCtx(ctx, newId()), CreateFormDocumentBody.parse(body)),
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(await refusal(make(a, { ...body, listingId: bListing }))).toBe('LISTING_NOT_FOUND');
    expect(await refusal(make(a, { ...body, contactId: bContact }))).toBe('CONTACT_NOT_FOUND');
    expect(await refusal(make(a, { ...body, offer: { amountCents: 1_000, currency: 'USD' } }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      await refusal(
        make(a, { template: 'RESERVATION', listingId: own, contactId: buyer, deposit: eur(50_000_000), holdDays: 5 }),
      ),
    ).toBe('VALIDATION_FAILED');
    // no form was written by any refusal
    const [n] = await rows<{ n: number }>(
      sql`select count(*)::int as n from form_documents where agency_id = ${b.agencyId}`,
    );
    expect(n?.n).toBe(0);
  });

  it('[R2-05a] an Idempotency-Key replays the first form; another body with the key is refused', async () => {
    const key = `forms-${RUN}`;
    const body = {
      template: 'OFFER',
      listingId: own2,
      contactId: buyer,
      offer: eur(29_000_000),
      validUntil: '2026-12-01',
    };
    const first = await make(a, body, key);
    const again = await make(a, body, key);
    expect(again).toEqual({ form: first.form, replayed: true });
    expect(await refusal(make(a, { ...body, offer: eur(28_000_000) }, key))).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('[R2-05a] making a form stays within the dashboard budget (≤ 10 statements)', async () => {
    const setup = await countQueries(() => as(a, async () => null));
    const n =
      (await countQueries(() =>
        make(a, {
          template: 'OFFER',
          listingId: own,
          contactId: buyer,
          offer: eur(1_000_000),
          validUntil: '2026-12-01',
        }),
      )) - setup;
    expect(n).toBeLessThanOrEqual(10);
  });
});

describe('[R2-05a] rendering, reading and erasure', () => {
  it('[R2-05a] the render stores the PDF once and records its SHA-256, which verifies against the stored bytes', async () => {
    const { form } = await make(a, {
      template: 'VIEWING_SHEET',
      contactId: seller,
      listingIds: [own],
      visitedOn: '2026-11-05',
      locale: 'en',
    });
    const before = fake.documents.length;
    expect(await documents.renderFormDocument(form.id, a.agencyId)).toMatchObject({ rendered: true });
    // idempotent: a READY form is not rendered again
    expect(await documents.renderFormDocument(form.id, a.agencyId)).toEqual({ rendered: false });
    expect(fake.documents.length).toBe(before + 1);
    const html = fake.documents.at(-1) as string;
    expect(html).toContain('Viewing sheet');
    expect(html).toContain('Draft clauses pending lawyer review');
    const ready = await as(a, (ctx) => documents.getFormDocument(ctx, form.id));
    expect(ready.status).toBe('READY');
    expect(ready.url).toContain(documents.formDocumentKey(a.agencyId, form.id));
    const object = store.objects.get(`private/${documents.formDocumentKey(a.agencyId, form.id)}`);
    expect(object?.contentType).toBe('application/pdf');
    const hash = createHash('sha256')
      .update(object?.body as Uint8Array)
      .digest('hex');
    expect(ready.sha256).toBe(hash);
    expect(ready.sizeBytes).toBe(object?.body.length);
    // the hash cannot be rewritten by a member: no UPDATE grant
    expect(
      await as(a, (ctx) =>
        ctx.tx.execute(sql`update form_documents set sha256 = ${'0'.repeat(64)} where id = ${form.id}`).then(
          () => 'updated',
          (err: { cause?: { code?: string } }) => err.cause?.code,
        ),
      ),
    ).toBe('42501');
    // the flag gates reads; with it, another agency does not find it
    expect(await refusal(as(b, (ctx) => documents.getFormDocument(ctx, form.id)))).toBe('FORMS_NOT_ENABLED');
    await withFlag(b, async () => {
      expect(await refusal(as(b, (ctx) => documents.getFormDocument(ctx, form.id)))).toBe('FORM_DOCUMENT_NOT_FOUND');
      expect((await as(b, (ctx) => documents.listFormDocuments(ctx, ListFormDocumentsQuery.parse({})))).items).toEqual(
        [],
      );
    });
    // staff impersonating the member see the form, never a link to the PDF
    const seen = await as(a, async (ctx) => documents.getFormDocument(await impersonatedCtx(ctx, newId()), form.id));
    expect(seen).toMatchObject({ status: 'READY', sha256: hash, url: null });
    // the render job of another agency's event renders nothing
    expect(await documents.renderFormDocument(form.id, b.agencyId)).toEqual({ rendered: false });
  });

  it('[R2-05a] overlapping or retried renders record the hash of the bytes actually stored, never their own', async () => {
    const { form } = await make(a, {
      template: 'VIEWING_SHEET',
      contactId: buyer,
      listingIds: [own2],
      visitedOn: '2026-11-04',
    });
    const key = documents.formDocumentKey(a.agencyId, form.id);
    // a first run stored its PDF and crashed before recording it (or still runs): the key is taken
    const first = new TextEncoder().encode('%PDF-1.4\n% first run\n%%EOF\n');
    await store.put('private', key, first, { contentType: 'application/pdf' });
    expect(await documents.renderFormDocument(form.id, a.agencyId)).toMatchObject({ rendered: true });
    const ready = await as(a, (ctx) => documents.getFormDocument(ctx, form.id));
    expect(ready.sha256).toBe(createHash('sha256').update(first).digest('hex'));
    expect(store.objects.get(`private/${key}`)?.body).toEqual(first);
  });

  it('[R2-05a] a form erased while it renders leaves no PDF; a render that fails for good leaves it FAILED', async () => {
    const { form } = await make(a, {
      template: 'VIEWING_SHEET',
      contactId: buyer,
      listingIds: [own],
      visitedOn: '2026-11-03',
    });
    const key = `private/${documents.formDocumentKey(a.agencyId, form.id)}`;
    // the row is erased between the render's read and its record
    configurePdf({
      ...fake,
      async render(html, options) {
        const bytes = await fake.render(html, options);
        await system((tx) => tx.execute(sql`delete from form_documents where id = ${form.id}`));
        return bytes;
      },
    });
    try {
      expect(await documents.renderFormDocument(form.id, a.agencyId)).toMatchObject({ rendered: false });
    } finally {
      configurePdf(fake);
    }
    expect(store.objects.has(key)).toBe(false);

    const failing = (
      await make(a, { template: 'VIEWING_SHEET', contactId: buyer, listingIds: [own], visitedOn: '2026-11-02' })
    ).form;
    configurePdf({
      ...fake,
      async render() {
        throw new Error('chrome crashed');
      },
    });
    try {
      // retryable attempts leave it PENDING; the last one marks it FAILED
      const job = documents.documentsJobs.renderForm.spec;
      const ctx = (attempt: number) =>
        ({ attempt, signal: new AbortController().signal, log: undefined, jobId: failing.id }) as unknown as Parameters<
          typeof job.run
        >[1];
      await expect(job.run({ formId: failing.id, agencyId: a.agencyId }, ctx(1))).rejects.toThrow('chrome crashed');
      expect((await as(a, (c) => documents.getFormDocument(c, failing.id))).status).toBe('PENDING');
      await expect(
        job.run({ formId: failing.id, agencyId: a.agencyId }, ctx(documents.documentsJobs.renderForm.attempts)),
      ).rejects.toThrow('chrome crashed');
      expect((await as(a, (c) => documents.getFormDocument(c, failing.id))).status).toBe('FAILED');
    } finally {
      configurePdf(fake);
    }
  });

  it('[R2-05a] a merged contact\u2019s forms follow the survivor', async () => {
    const merged = await contact(a, 'Mergee');
    const { form } = await make(a, {
      template: 'OFFER',
      listingId: own,
      contactId: merged,
      offer: eur(3_000_000),
      validUntil: '2026-12-01',
    });
    expect(await documents.repointContactForms({ agencyId: a.agencyId, survivorId: buyer, mergedId: merged })).toBe(1);
    expect((await as(a, (ctx) => documents.getFormDocument(ctx, form.id))).contactId).toBe(buyer);
  });

  it('[R2-05a] the list pages newest first by keyset and filters by template and contact', async () => {
    const all = await as(a, (ctx) => documents.listFormDocuments(ctx, ListFormDocumentsQuery.parse({ limit: 100 })));
    expect(all.items.length).toBeGreaterThanOrEqual(6);
    const created = all.items.map((f) => f.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    const first = await as(a, (ctx) => documents.listFormDocuments(ctx, ListFormDocumentsQuery.parse({ limit: 2 })));
    const second = await as(a, (ctx) =>
      documents.listFormDocuments(
        ctx,
        ListFormDocumentsQuery.parse({ limit: 2, cursor: first.nextCursor ?? undefined }),
      ),
    );
    expect([...first.items, ...second.items].map((f) => f.id)).toEqual(all.items.slice(0, 4).map((f) => f.id));
    const offers = await as(a, (ctx) =>
      documents.listFormDocuments(ctx, ListFormDocumentsQuery.parse({ template: 'OFFER', contactId: buyer })),
    );
    expect(offers.items.length).toBeGreaterThan(0);
    expect(offers.items.every((f) => f.template === 'OFFER' && f.contactId === buyer)).toBe(true);
    expect(all.items.every((f) => f.url === null)).toBe(true);
  });

  it('[R2-05a] erasing a contact deletes its forms and their PDFs; an agency erasure deletes the rest', async () => {
    const { form } = await make(a, {
      template: 'OFFER',
      listingId: own,
      contactId: seller,
      offer: eur(2_000_000),
      validUntil: '2026-12-01',
    });
    await documents.renderFormDocument(form.id, a.agencyId);
    const key = `private/${documents.formDocumentKey(a.agencyId, form.id)}`;
    expect(store.objects.has(key)).toBe(true);
    const sellerForms = await rows<{ n: number }>(
      sql`select count(*)::int as n from form_documents where agency_id = ${a.agencyId} and contact_id = ${seller}`,
    );
    expect(await documents.eraseContactForms({ agencyId: a.agencyId, contactIds: [seller] })).toBe(sellerForms[0]?.n);
    expect(store.objects.has(key)).toBe(false);
    const left = await rows<{ contact_id: string }>(
      sql`select contact_id from form_documents where agency_id = ${a.agencyId}`,
    );
    expect(left.length).toBeGreaterThan(0);
    expect(left.some((r) => r.contact_id === seller)).toBe(false);
    for (;;) if (!(await documents.eraseAgencyForms(a.agencyId)).more) break;
    expect(await rows(sql`select 1 from form_documents where agency_id = ${a.agencyId}`)).toEqual([]);
    expect([...store.objects.keys()].some((k) => k.startsWith(`private/form-documents/${a.agencyId}/`))).toBe(false);
  });
});
