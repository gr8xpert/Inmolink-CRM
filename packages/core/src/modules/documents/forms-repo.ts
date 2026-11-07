/**
 * form_documents (R2-05a). Takes `tx`, selects only the columns it needs, keyset pages on the raw `created_at`.
 * Request paths run as app_user (RLS: the agency's own rows; insert only as the member, PENDING, unrendered); the
 * render and erasure as app_system.
 */
import type { Tx } from '@inmolink/db';
import { formDocuments as forms } from '@inmolink/db/schema/documents';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

const columns = {
  id: forms.id,
  agencyId: forms.agencyId,
  template: forms.template,
  locale: forms.locale,
  templateVersion: forms.templateVersion,
  status: forms.status,
  label: forms.label,
  listingId: forms.listingId,
  contactId: forms.contactId,
  dealId: forms.dealId,
  sha256: forms.sha256,
  sizeBytes: forms.sizeBytes,
  createdByUserId: forms.createdByUserId,
  createdAt: forms.createdAt,
  renderedAt: forms.renderedAt,
};

export interface FormRow {
  id: string;
  agencyId: string;
  template: string;
  locale: string;
  templateVersion: number;
  status: string;
  label: string;
  listingId: string | null;
  contactId: string | null;
  dealId: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  createdByUserId: string;
  createdAt: Date;
  renderedAt: Date | null;
}

export interface NewForm {
  id: string;
  agencyId: string;
  template: string;
  locale: string;
  templateVersion: number;
  label: string;
  listingId: string | null;
  contactId: string | null;
  dealId: string | null;
  data: unknown;
  createdByUserId: string;
  idempotencyHash: string | null;
  requestHash: string | null;
}

export async function insertForm(tx: Tx, row: NewForm): Promise<FormRow> {
  const [created] = await tx.insert(forms).values(row).returning(columns);
  if (!created) throw new Error('form_documents insert returned no row');
  return created;
}

/** The member's earlier create with this key (POST replay, `form_documents_idempotency_uq`). One statement. */
export async function formByIdempotency(
  tx: Tx,
  agencyId: string,
  hash: string,
  since: Date,
): Promise<{ row: FormRow; requestHash: string | null } | null> {
  const [r] = await tx
    .select({ ...columns, requestHash: forms.requestHash })
    .from(forms)
    .where(and(eq(forms.agencyId, agencyId), eq(forms.idempotencyHash, hash), gt(forms.createdAt, since)));
  if (!r) return null;
  const { requestHash, ...row } = r;
  return { row, requestHash };
}

export async function formOf(tx: Tx, agencyId: string, id: string): Promise<FormRow | null> {
  const [r] = await tx
    .select(columns)
    .from(forms)
    .where(and(eq(forms.agencyId, agencyId), eq(forms.id, id)));
  return r ?? null;
}

export type FormPageRow = FormRow & { atUs: string };

/**
 * The agency's forms, newest first, optionally one template and one subject (contact, listing or deal) — the index of
 * that subject (`form_documents_<subject>_idx`) or `form_documents_list_idx`. `limit + 1` rows. One statement.
 */
export function formsPage(
  tx: Tx,
  agencyId: string,
  q: {
    template?: string | undefined;
    contactId?: string | undefined;
    listingId?: string | undefined;
    dealId?: string | undefined;
    cursor?: KeysetCursor | undefined;
    limit: number;
  },
): Promise<FormPageRow[]> {
  return tx
    .select({ ...columns, atUs: keysetStamp(forms.createdAt) })
    .from(forms)
    .where(
      and(
        eq(forms.agencyId, agencyId),
        q.contactId ? eq(forms.contactId, q.contactId) : undefined,
        q.listingId ? eq(forms.listingId, q.listingId) : undefined,
        q.dealId ? eq(forms.dealId, q.dealId) : undefined,
        q.template ? eq(forms.template, q.template) : undefined,
        keysetAfterRaw(forms.createdAt, forms.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(forms.createdAt, forms.id, 'desc'))
    .limit(q.limit + 1);
}

// ---- worker (app_system) ----

/** What the render reads: the row's template, locale, version, state and merged data. */
export async function formForRender(tx: Tx, id: string) {
  const [r] = await tx
    .select({
      id: forms.id,
      agencyId: forms.agencyId,
      template: forms.template,
      locale: forms.locale,
      templateVersion: forms.templateVersion,
      status: forms.status,
      data: forms.data,
    })
    .from(forms)
    .where(eq(forms.id, id));
  return r ?? null;
}

/** Records the render of a PENDING form (a READY or FAILED one is left as it is). True when it was recorded. */
export async function markRendered(tx: Tx, id: string, sha256: string, sizeBytes: number): Promise<boolean> {
  const rows = await tx
    .update(forms)
    .set({ status: 'READY', sha256, sizeBytes, renderedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(forms.id, id), eq(forms.status, 'PENDING')))
    .returning({ id: forms.id });
  return rows.length > 0;
}

export async function markFailed(tx: Tx, id: string): Promise<void> {
  await tx
    .update(forms)
    .set({ status: 'FAILED', updatedAt: sql`now()` })
    .where(and(eq(forms.id, id), eq(forms.status, 'PENDING')));
}

/** The forms of these contacts of one agency (erasure). At most `limit`. */
export function formIdsOfContacts(tx: Tx, agencyId: string, contactIds: readonly string[], limit: number) {
  if (contactIds.length === 0) return Promise.resolve([] as { id: string }[]);
  return tx
    .select({ id: forms.id })
    .from(forms)
    .where(and(eq(forms.agencyId, agencyId), inArray(forms.contactId, [...contactIds])))
    .limit(limit);
}

/** Every form of an agency, a batch at a time (agency erasure). */
export function formIdsOfAgency(tx: Tx, agencyId: string, limit: number) {
  return tx.select({ id: forms.id }).from(forms).where(eq(forms.agencyId, agencyId)).limit(limit);
}

/** A merged contact's forms move to the survivor (`form_documents_contact_idx`). */
export async function repointContact(tx: Tx, agencyId: string, mergedId: string, survivorId: string): Promise<number> {
  const rows = await tx
    .update(forms)
    .set({ contactId: survivorId, updatedAt: sql`now()` })
    .where(and(eq(forms.agencyId, agencyId), eq(forms.contactId, mergedId)))
    .returning({ id: forms.id });
  return rows.length;
}

export async function deleteForms(tx: Tx, agencyId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx
    .delete(forms)
    .where(and(eq(forms.agencyId, agencyId), inArray(forms.id, [...ids])))
    .returning({ id: forms.id });
  return rows.length;
}

/**
 * The `SUBJECT` data export (GDPR Art. 15): a page of the forms made for the contact, by id — what each is, its
 * language, state, label and times, and the PDF's hash; never the merged data (the agency's terms). Under the caller's
 * RLS (`tx`).
 */
export function subjectForms(tx: Tx, agencyId: string, contactId: string, afterId: string | null, limit: number) {
  return tx
    .select({
      id: forms.id,
      template: forms.template,
      locale: forms.locale,
      status: forms.status,
      label: forms.label,
      listingId: forms.listingId,
      sha256: forms.sha256,
      createdAt: forms.createdAt,
      renderedAt: forms.renderedAt,
    })
    .from(forms)
    .where(
      and(eq(forms.agencyId, agencyId), eq(forms.contactId, contactId), afterId ? gt(forms.id, afterId) : undefined),
    )
    .orderBy(asc(forms.id))
    .limit(limit);
}
