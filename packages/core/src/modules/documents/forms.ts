/**
 * The forms library (R2-05a, PLAN §7 M13): a member generates a listing agreement, reservation, viewing sheet or offer
 * (and, from the deal room through mls, a collaboration agreement) for the agency — branded, in the client's language,
 * merged from the agency's data. Prices, commission and parties come from the listing, the contact, the agency and the
 * deal as stored; the amounts, dates and conditions a form asks for come from the request. No AI writes any of it.
 *
 * One transaction (CLAUDE.md rule 6): the checks, the reads (each module through its index), the row (`PENDING`, with
 * the merged data) and the `documents.form.created` event. The event's subscriber queues the render (`pdf` pool, job
 * id = the form id): the PDF is stored once under `form-documents/<agency>/<id>.pdf` (private bucket — outside the
 * `documents/` prefix the listing-document orphan sweep owns) and its SHA-256 recorded with it (`READY`), the hash a
 * signature (R2-05b) is made over. A made form never changes: a new version is a new form.
 *
 * Behind the feature flag `documents.forms` (the clause texts are placeholders pending lawyer review — H17).
 */
import { createHash } from 'node:crypto';
import type {
  CreateCollaborationAgreementBody,
  CreateFormDocumentBody,
  FormDocumentDto,
  FormDocumentPage,
  FormTemplate,
  ListFormDocumentsQuery,
} from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { flag } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { pdf } from '@inmolink/platform/pdf';
import { RetryableError, UnrecoverableError } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import { type Ctx, memberUserId } from '../../context';
import { advisoryLock, idempotencyOf, keyReusedOn, replayOf } from '../../idempotency';
import { impersonatorOf } from '../../impersonation';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as crm from '../crm';
import * as properties from '../properties';
import * as search from '../search';
import { DOCUMENT_LINK_SECONDS, DOCUMENT_MAX_BYTES } from './config';
import { documentsEvents } from './events';
import {
  FORM_PLACEHOLDER_UNTIL_VERSION,
  FORM_TEMPLATE_VERSION,
  type FormAgency,
  type FormClient,
  FormData,
  type FormProperty,
} from './forms-data';
import * as repo from './forms-repo';
import { formHtml } from './forms-templates';
import { assertCan } from './policy';
import { signedObjectKeys } from './signature-keys';
import * as signaturesRepo from './signatures-repo';
import { docFormat } from './templates';

/** The feature flag the forms library ships dark behind (STATUS Decisions R2-05a). */
export const FORMS_FLAG = 'documents.forms';

/** Storage: private bucket, never public; not under `documents/` (the listing-document orphan sweep's prefix). */
export const FORM_DOCUMENTS_PREFIX = 'form-documents/';
export const formDocumentKey = (agencyId: string, id: string) => `${FORM_DOCUMENTS_PREFIX}${agencyId}/${id}.pdf`;

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

async function assertFormsEnabled(ctx: Ctx): Promise<void> {
  if (!(await flag(ctx, FORMS_FLAG))) throw new AppError('FORMS_NOT_ENABLED');
}

const incomplete = (missing: string): never => {
  throw new AppError('FORM_DATA_INCOMPLETE', { missing });
};

// ---- merged data ------------------------------------------------------------------------------------------------------

async function agencyData(ctx: Ctx): Promise<FormAgency> {
  const agency = await agencies.getMyAgency(ctx);
  const profile = await agencies.getAgencyProfile(ctx);
  const address = [agency.addressLine, [agency.postalCode, agency.city].filter(Boolean).join(' ')]
    .filter((x): x is string => !!x)
    .join(', ');
  return {
    name: clip(agency.name, 200),
    taxId: agency.taxId,
    address: address ? clip(address, 400) : null,
    registerNumber: agency.registerNumber,
    email: profile.contactEmail,
    phone: profile.contactPhone,
    website: profile.websiteUrl,
    primaryColor: profile.primaryColor,
    accentColor: profile.accentColor,
  };
}

async function clientData(ctx: Ctx, contactId: string): Promise<FormClient> {
  const c = await crm.getContact(ctx, contactId);
  const name = [c.firstName, c.lastName].filter((x): x is string => !!x?.trim()).join(' ');
  if (!name) incomplete('contact.name');
  return { contactId: c.id, name: clip(name, 300), email: c.emails[0] ?? null, phone: c.phones[0] ?? null };
}

/** The agency's own listings, in the requested order (one statement each for the listings and their titles). */
async function propertyData(
  ctx: Ctx,
  listingIds: readonly string[],
  locale: string,
): Promise<{ property: FormProperty; listing: properties.FormListing }[]> {
  const rows = await properties.formListings(ctx, listingIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (listingIds.some((id) => !byId.has(id))) throw new AppError('LISTING_NOT_FOUND');
  const labels = await search.listingLabels(ctx.tx, listingIds, locale);
  return listingIds.map((id) => {
    const l = byId.get(id) as properties.FormListing;
    return {
      listing: l,
      property: {
        listingId: l.id,
        reference: l.ref,
        title: labels.get(id)?.title ?? null,
        cadastralRef: l.cadastralRef,
        transactionType: l.transactionType,
        price: l.price,
      },
    };
  });
}

async function oneProperty(ctx: Ctx, listingId: string, locale: string) {
  const [one] = await propertyData(ctx, [listingId], locale);
  if (!one) throw new AppError('LISTING_NOT_FOUND');
  return one;
}

/** The listing's commission, else the agency's default (listing agreements state it; it is never typed in). */
async function commissionOf(ctx: Ctx, l: properties.FormListing, currency: string) {
  if (l.commissionBp !== null) return { bp: l.commissionBp, fixed: null, includesVat: l.commissionIncludesVat };
  if (l.commissionFixedCents !== null) {
    return {
      bp: null,
      fixed: { amountCents: l.commissionFixedCents, currency },
      includesVat: l.commissionIncludesVat,
    };
  }
  const { commission } = await agencies.getAgencyDefaultCommission(ctx);
  return commission.type === 'PCT'
    ? { bp: commission.basisPoints, fixed: null, includesVat: commission.includesVat }
    : { bp: null, fixed: commission.amount, includesVat: commission.includesVat };
}

function sameCurrency(field: string, a: { currency: string }, b: { currency: string } | null): void {
  if (b && a.currency !== b.currency) throw new AppError('VALIDATION_FAILED', { field });
}

interface Merged {
  data: FormData;
  label: string;
  listingId: string | null;
  contactId: string | null;
  dealId: string | null;
}

async function merge(ctx: Ctx, body: CreateFormDocumentBody, locale: string): Promise<Merged> {
  const generatedAt = clock.now().toISOString();
  const agency = await agencyData(ctx);
  const common = { v: 1 as const, generatedAt, agency };
  switch (body.template) {
    case 'LISTING_AGREEMENT': {
      const { property, listing } = await oneProperty(ctx, body.listingId, locale);
      const client = await clientData(ctx, body.contactId);
      const commission = await commissionOf(ctx, listing, listing.currency);
      return {
        data: {
          template: body.template,
          ...common,
          client,
          property,
          commission,
          exclusive: body.exclusive,
          termMonths: body.termMonths,
        },
        label: `${property.reference} · ${client.name}`,
        listingId: listing.id,
        contactId: client.contactId,
        dealId: null,
      };
    }
    case 'RESERVATION': {
      const { property } = await oneProperty(ctx, body.listingId, locale);
      const price = body.price ?? property.price ?? incomplete('listing.price');
      sameCurrency('deposit', body.deposit, price);
      if (body.deposit.amountCents > price.amountCents) throw new AppError('VALIDATION_FAILED', { field: 'deposit' });
      const client = await clientData(ctx, body.contactId);
      return {
        data: {
          template: body.template,
          ...common,
          client,
          property,
          price,
          deposit: body.deposit,
          holdDays: body.holdDays,
        },
        label: `${property.reference} · ${client.name}`,
        listingId: property.listingId,
        contactId: client.contactId,
        dealId: null,
      };
    }
    case 'VIEWING_SHEET': {
      const props = (await propertyData(ctx, body.listingIds, locale)).map((p) => p.property);
      const client = await clientData(ctx, body.contactId);
      const first = props[0] as FormProperty;
      const more = props.length > 1 ? ` +${props.length - 1}` : '';
      return {
        data: { template: body.template, ...common, client, properties: props, visitedOn: body.visitedOn },
        label: `${first.reference}${more} · ${client.name}`,
        listingId: first.listingId,
        contactId: client.contactId,
        dealId: null,
      };
    }
    case 'OFFER': {
      const { property } = await oneProperty(ctx, body.listingId, locale);
      sameCurrency('offer', body.offer, property.price);
      const client = await clientData(ctx, body.contactId);
      return {
        data: {
          template: body.template,
          ...common,
          client,
          property,
          offer: body.offer,
          validUntil: body.validUntil,
          conditions: body.conditions ?? null,
        },
        label: `${property.reference} · ${client.name}`,
        listingId: property.listingId,
        contactId: client.contactId,
        dealId: null,
      };
    }
  }
}

// ---- create -----------------------------------------------------------------------------------------------------------

/**
 * The document's language: the one asked for, else the agency's first. Forms are written in the hand-written UI
 * languages only (EN, ES): another language would mix English clauses with its own formats, so it is refused.
 */
function localeOf(ctx: Ctx, locale: string | undefined): string {
  const chosen = locale ?? ctx.tenant.locales.find((l) => isUiLocale(l)) ?? DEFAULT_UI_LOCALE;
  if (!isUiLocale(chosen)) throw new AppError('VALIDATION_FAILED', { field: 'locale' });
  return chosen;
}

async function insertMerged(
  ctx: Ctx,
  template: FormTemplate,
  locale: string,
  merged: Merged,
  idempotency: ReturnType<typeof idempotencyOf>,
) {
  // the caps of the stored shape (the merge clips texts; anything else is a gap in the data, never a 500)
  const parsed = FormData.safeParse(merged.data);
  if (!parsed.success) throw new AppError('FORM_DATA_INCOMPLETE', { missing: 'shape' });
  const data = parsed.data;
  const row = await repo
    .insertForm(ctx.tx, {
      id: newId(),
      agencyId: ctx.tenant.agencyId,
      template,
      locale,
      templateVersion: FORM_TEMPLATE_VERSION,
      label: clip(merged.label, 300),
      listingId: merged.listingId,
      contactId: merged.contactId,
      dealId: merged.dealId,
      data,
      createdByUserId: memberUserId(ctx),
      idempotencyHash: idempotency?.hash ?? null,
      requestHash: idempotency?.requestHash ?? null,
    })
    .catch(keyReusedOn('form_documents_idempotency_uq'));
  await emit(ctx.tx, documentsEvents.formCreated({ agencyId: row.agencyId, formId: row.id }));
  return row;
}

/**
 * `POST /v1/documents/forms`. With an `Idempotency-Key`, a retry by the same member within 24 h with the same body
 * answers the first form (`replayed`); another body is `IDEMPOTENCY_KEY_REUSED`.
 */
export async function createFormDocument(
  ctx: Ctx,
  body: CreateFormDocumentBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ form: FormDocumentDto; replayed: boolean }> {
  assertCan(ctx, 'documents.forms.create');
  await assertFormsEnabled(ctx);
  const agencyId = ctx.tenant.agencyId;
  const idempotency = idempotencyOf('documents.form', memberUserId(ctx), opts.idempotencyKey, body);
  const prior = await replayOf(
    ctx.tx,
    idempotency,
    (since, key) => repo.formByIdempotency(ctx.tx, agencyId, key.hash, since),
    { lock: true },
  );
  if (prior) return { form: toDto(prior.row), replayed: true };
  const locale = localeOf(ctx, body.locale);
  const row = await insertMerged(ctx, body.template, locale, await merge(ctx, body, locale), idempotency);
  return { form: toDto(row), replayed: false };
}

/** A deal as mls hands it over (mls checked the caller is a party and reads its own copy). */
export interface CollaborationDeal {
  id: string;
  party: 'OWNER' | 'INTRODUCER';
  counterpartName: string | null;
  property: { reference: string; title: string | null } | null;
  price: { amountCents: number; currency: string };
  terms: {
    commissionBp: number | null;
    commissionFixed: { amountCents: number; currency: string } | null;
    splitBp: number;
    includesVat: boolean;
  };
  commission: { totalCents: number; introducerShareCents: number; ownerShareCents: number; currency: string };
}

/**
 * One collaboration agreement change of a deal at a time per agency (R2-05c): making an agreement and sending one for
 * signature take this lock before they check that none of the deal's is out for signature.
 */
export async function lockDealAgreement(ctx: Ctx, dealId: string): Promise<void> {
  await advisoryLock(ctx.tx, `documents.deal-agreement:${ctx.tenant.agencyId}:${dealId}`);
}

/**
 * The collaboration agreement of a deal (`POST /v1/mls/deals/:id/collaboration-agreement`, through
 * `mls.createDealCollaborationAgreement`): both agencies, the property, the price and the commission split exactly as
 * the deal's terms snapshot and the database's commission columns say. In the caller's transaction.
 */
export async function createCollaborationAgreement(
  ctx: Ctx,
  deal: CollaborationDeal,
  body: CreateCollaborationAgreementBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ form: FormDocumentDto; replayed: boolean }> {
  assertCan(ctx, 'documents.forms.create');
  await assertFormsEnabled(ctx);
  const agencyId = ctx.tenant.agencyId;
  const idempotency = idempotencyOf('documents.form', memberUserId(ctx), opts.idempotencyKey, {
    ...body,
    template: 'COLLABORATION_AGREEMENT',
    dealId: deal.id,
  });
  const prior = await replayOf(
    ctx.tx,
    idempotency,
    (since, key) => repo.formByIdempotency(ctx.tx, agencyId, key.hash, since),
    { lock: true },
  );
  if (prior) return { form: toDto(prior.row), replayed: true };
  // R2-05c: no second agreement while one of the deal's is out for signature or signed (two could end up signed)
  await lockDealAgreement(ctx, deal.id);
  if (await signaturesRepo.dealAgreementInSignature(ctx.tx, agencyId, deal.id, null)) {
    throw new AppError('AGREEMENT_IN_SIGNATURE');
  }
  const locale = localeOf(ctx, body.locale);
  const agency = await agencyData(ctx);
  const counterpart = deal.counterpartName ?? incomplete('deal.counterpart');
  const merged: Merged = {
    data: {
      template: 'COLLABORATION_AGREEMENT',
      v: 1,
      generatedAt: clock.now().toISOString(),
      agency,
      dealId: deal.id,
      party: deal.party,
      counterpart: { name: counterpart },
      property: deal.property,
      price: deal.price,
      terms: deal.terms,
      commission: deal.commission,
    },
    label: `${deal.property?.reference ?? deal.id.slice(0, 8)} · ${counterpart}`,
    listingId: null,
    contactId: null,
    dealId: deal.id,
  };
  const row = await insertMerged(ctx, 'COLLABORATION_AGREEMENT', locale, merged, idempotency);
  return { form: toDto(row), replayed: false };
}

// ---- read -------------------------------------------------------------------------------------------------------------

function toDto(r: repo.FormRow, link?: { url: string; expiresAt: Date }): FormDocumentDto {
  return {
    id: r.id,
    template: r.template as FormTemplate,
    locale: r.locale,
    templateVersion: r.templateVersion,
    status: r.status as FormDocumentDto['status'],
    label: r.label,
    listingId: r.listingId,
    contactId: r.contactId,
    dealId: r.dealId,
    sha256: r.sha256,
    sizeBytes: r.sizeBytes,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt.toISOString(),
    renderedAt: r.renderedAt?.toISOString() ?? null,
    placeholder: r.templateVersion <= FORM_PLACEHOLDER_UNTIL_VERSION,
    url: link?.url ?? null,
    urlExpiresAt: link?.expiresAt.toISOString() ?? null,
  };
}

/** `GET /v1/documents/forms`: newest first, keyset; one statement. */
export async function listFormDocuments(ctx: Ctx, q: ListFormDocumentsQuery): Promise<FormDocumentPage> {
  assertCan(ctx, 'documents.forms.read');
  await assertFormsEnabled(ctx);
  const rows = await repo.formsPage(ctx.tx, ctx.tenant.agencyId, {
    template: q.template,
    contactId: q.contactId,
    listingId: q.listingId,
    dealId: q.dealId,
    cursor: decodeCursor(q.cursor),
    limit: q.limit,
  });
  return toPage(
    rows,
    q.limit,
    (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }),
    (r) => toDto(r),
  );
}

/** `GET /v1/documents/forms/:id`: the form, with a short signed link to its PDF once `READY` (local signing). */
export async function getFormDocument(ctx: Ctx, id: string): Promise<FormDocumentDto> {
  assertCan(ctx, 'documents.forms.read');
  await assertFormsEnabled(ctx);
  const row = await repo.formOf(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('FORM_DOCUMENT_NOT_FOUND');
  // staff impersonating the member see the form, never a link to the client's PDF (no audited read path for it)
  if (row.status !== 'READY' || impersonatorOf(ctx)) return toDto(row);
  const expiresAt = new Date(clock.nowMs() + DOCUMENT_LINK_SECONDS * 1_000);
  const url = await storage().signedGetUrl('private', formDocumentKey(row.agencyId, row.id), {
    expiresInSeconds: DOCUMENT_LINK_SECONDS,
    downloadName: `${row.template.toLowerCase().replaceAll('_', '-')}-${row.id}.pdf`,
    responseContentType: 'application/pdf',
  });
  return toDto(row, { url, expiresAt });
}

// ---- render (the `pdf` pool) ------------------------------------------------------------------------------------------

const uiLocale = (locale: string) => (isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);

type RenderRow = NonNullable<Awaited<ReturnType<typeof repo.formForRender>>>;

function htmlOf(row: RenderRow): string {
  const data = FormData.safeParse(row.data);
  if (!data.success) throw new UnrecoverableError(`form ${row.id}: stored data does not parse`);
  return formHtml({
    documentId: row.id,
    data: data.data,
    t: translator(uiLocale(row.locale), 'documents'),
    format: docFormat(row.locale),
    templateVersion: row.templateVersion,
  });
}

/** The HTML of a stored form (tests read it). Null when the form is gone. */
export async function formDocumentHtml(id: string): Promise<{ html: string; agencyId: string; status: string } | null> {
  const row = await withSystem('documents.form.render', (tx) => repo.formForRender(tx, id));
  return row ? { html: htmlOf(row), agencyId: row.agencyId, status: row.status } : null;
}

/**
 * Renders a PENDING form of `agencyId` once: the PDF is stored, then its hash recorded (`READY`). Idempotent: a READY
 * or FAILED form, one erased or another agency's is not rendered again.
 *
 * The object is written only when its key is free (`ifNoneMatch`): two overlapping runs (a stalled job re-run) or a
 * retry after a crash between the store and the record find the first run's object and record the hash of the bytes
 * actually stored, never their own — the recorded SHA-256 always matches the stored PDF. A form erased while it
 * rendered (the row gone when the hash is recorded) has its object deleted again, so no PDF outlives its row.
 */
export async function renderFormDocument(
  formId: string,
  agencyId: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ rendered: boolean; bytes?: number }> {
  const row = await withSystem('documents.form.render', (tx) => repo.formForRender(tx, formId));
  if (!row || row.agencyId !== agencyId || row.status !== 'PENDING') return { rendered: false };
  const bytes = await pdf().render(htmlOf(row), { signal: options.signal });
  if (bytes.length > DOCUMENT_MAX_BYTES) throw new UnrecoverableError(`pdf: ${bytes.length} bytes over the limit`);
  const key = formDocumentKey(agencyId, formId);
  const written = await storage().putIf(
    'private',
    key,
    bytes,
    { contentType: 'application/pdf' },
    { ifNoneMatch: '*' },
  );
  const stored = written ? bytes : await storage().get('private', key, { maxBytes: DOCUMENT_MAX_BYTES });
  // taken, then gone: an erasure deleted it between the two calls — the next attempt finds the row gone (or renders)
  if (!stored) throw new RetryableError(`form ${formId}: stored object vanished`);
  const recorded = await withSystem('documents.form.rendered', async (tx) => {
    if (await repo.markRendered(tx, formId, sha256Hex(stored), stored.length)) return 'recorded';
    return (await repo.formForRender(tx, formId)) ? 'kept' : 'gone';
  });
  if (recorded === 'gone') await storage().delete('private', key);
  return { rendered: recorded === 'recorded', bytes: stored.length };
}

/** The render failed for good (the job's last attempt): the form shows `FAILED`; asking again makes a new form. */
export async function failFormDocument(formId: string): Promise<void> {
  await withSystem('documents.form.failed', (tx) => repo.markFailed(tx, formId));
}

// ---- contact merge ---------------------------------------------------------------------------------------------------

/** `crm.contact.merged`: the merged contact's forms now list under the survivor (their `data` keeps who they named). */
export function repointContactForms(p: { agencyId: string; survivorId: string; mergedId: string }): Promise<number> {
  return withSystem('documents.forms.contactMerged', (tx) =>
    repo.repointContact(tx, p.agencyId, p.mergedId, p.survivorId),
  );
}

// ---- erasure ----------------------------------------------------------------------------------------------------------

const ERASE_BATCH = 500;
const DELETES_AT_ONCE = 16;

/**
 * The PDFs of these forms and their signed PDFs (`signed`: keys read before the rows went — R2-05b), 16 at a time (a
 * missing object deletes fine).
 */
async function deleteObjects(agencyId: string, ids: readonly string[], signed: readonly string[]): Promise<void> {
  const keys = [...ids.map((id) => formDocumentKey(agencyId, id)), ...signed];
  for (let i = 0; i < keys.length; i += DELETES_AT_ONCE) {
    await Promise.all(keys.slice(i, i + DELETES_AT_ONCE).map((key) => storage().delete('private', key)));
  }
}

/**
 * GDPR (`crm.contact.erased`, and the agency erasure's contacts): the forms made for these contacts are deleted — the
 * PDFs first, then the rows, then the PDFs again (a retry finds what a failed delete left; a render racing the
 * erasure deletes what it stored once it finds the row gone). R2-05b: signed forms too — their signing requests,
 * signers' names, e-mails, IPs and signatures (the cascade) and the signed PDFs (STATUS Decisions R2-05b: no
 * evidence-retention exception until the lawyer's input, H17). Idempotent.
 */
export async function eraseContactForms(p: { agencyId: string; contactIds: readonly string[] }): Promise<number> {
  let total = 0;
  for (;;) {
    const ids = (
      await withSystem('documents.forms.contactErased', (tx) =>
        repo.formIdsOfContacts(tx, p.agencyId, p.contactIds, ERASE_BATCH),
      )
    ).map((r) => r.id);
    if (ids.length === 0) return total;
    const signed = await signedObjectKeys(p.agencyId, ids);
    await deleteObjects(p.agencyId, ids, signed);
    total += await withSystem('documents.forms.contactErased', (tx) => repo.deleteForms(tx, p.agencyId, ids));
    // again: a render that stored its PDF between the first delete and the rows' (its own check covers later ones)
    await deleteObjects(p.agencyId, ids, signed);
    if (ids.length < ERASE_BATCH) return total;
  }
}

/**
 * Agency erasure (compliance `forms` phase): one batch of the agency's forms (PDFs, then rows). `more`: call again.
 */
export async function eraseAgencyForms(agencyId: string): Promise<{ rows: number; more: boolean }> {
  const ids = (
    await withSystem('documents.forms.agencyErased', (tx) => repo.formIdsOfAgency(tx, agencyId, ERASE_BATCH))
  ).map((r) => r.id);
  const signed = await signedObjectKeys(agencyId, ids);
  await deleteObjects(agencyId, ids, signed);
  const rows = await withSystem('documents.forms.agencyErased', (tx) => repo.deleteForms(tx, agencyId, ids));
  await deleteObjects(agencyId, ids, signed);
  return { rows, more: ids.length === ERASE_BATCH };
}
