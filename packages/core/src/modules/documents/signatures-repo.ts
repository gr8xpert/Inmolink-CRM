/**
 * signature_requests, signature_signers, signature_events (R2-05b). Takes `tx`, selects only the columns it needs.
 * Member paths run as app_user (RLS: the agency's rows; requests inserted as the member, OPEN; signers inserted with
 * them); the signing page reads as app_public through `signing_signer()` and appends events as app_intake (pinned to the
 * signer's agency; it reads back ids, kinds and times only); the worker runs as app_system.
 */
import type { Tx } from '@inmolink/db';
import {
  signatureEvents as events,
  formDocuments as forms,
  signatureRequests as requests,
  signatureSigners as signers,
} from '@inmolink/db/schema/documents';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';

// ---- member (app_user) ------------------------------------------------------------------------------------------------

const requestColumns = {
  id: requests.id,
  agencyId: requests.agencyId,
  formId: requests.formId,
  provider: requests.provider,
  status: requests.status,
  ordered: requests.ordered,
  documentSha256: requests.documentSha256,
  message: requests.message,
  expiresAt: requests.expiresAt,
  createdByUserId: requests.createdByUserId,
  allSignedAt: requests.allSignedAt,
  signedSha256: requests.signedSha256,
  signedSizeBytes: requests.signedSizeBytes,
  completedAt: requests.completedAt,
  cancelledAt: requests.cancelledAt,
  createdAt: requests.createdAt,
};

export interface RequestRow {
  id: string;
  agencyId: string;
  formId: string;
  provider: string;
  status: string;
  ordered: boolean;
  documentSha256: string;
  message: string | null;
  expiresAt: Date;
  createdByUserId: string;
  allSignedAt: Date | null;
  signedSha256: string | null;
  signedSizeBytes: number | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

/** The form a request is made over: its state, hash, template, language, client and label. */
export async function formForSigning(tx: Tx, agencyId: string, formId: string) {
  const [r] = await tx
    .select({
      id: forms.id,
      status: forms.status,
      sha256: forms.sha256,
      template: forms.template,
      locale: forms.locale,
      label: forms.label,
    })
    .from(forms)
    .where(and(eq(forms.agencyId, agencyId), eq(forms.id, formId)));
  return r ?? null;
}

/** Whether the form was signed by everyone already (a SIGNED or COMPLETED request). */
export async function formSigned(tx: Tx, agencyId: string, formId: string): Promise<boolean> {
  const [r] = await tx
    .select({ id: requests.id })
    .from(requests)
    .where(
      and(
        eq(requests.agencyId, agencyId),
        eq(requests.formId, formId),
        inArray(requests.status, ['SIGNED', 'COMPLETED']),
      ),
    )
    .limit(1);
  return !!r;
}

export async function requestByIdempotency(
  tx: Tx,
  agencyId: string,
  hash: string,
  since: Date,
): Promise<{ row: RequestRow; requestHash: string | null } | null> {
  const [r] = await tx
    .select({ ...requestColumns, requestHash: requests.requestHash })
    .from(requests)
    .where(and(eq(requests.agencyId, agencyId), eq(requests.idempotencyHash, hash), gt(requests.createdAt, since)));
  if (!r) return null;
  const { requestHash, ...row } = r;
  return { row, requestHash };
}

export interface NewRequest {
  id: string;
  agencyId: string;
  formId: string;
  provider: string;
  ordered: boolean;
  documentSha256: string;
  message: string | null;
  expiresAt: Date;
  createdByUserId: string;
  idempotencyHash: string | null;
  requestHash: string | null;
}

export interface NewSigner {
  id: string;
  agencyId: string;
  requestId: string;
  position: number;
  role: string;
  name: string;
  email: string;
  locale: string;
}

export async function insertRequest(tx: Tx, row: NewRequest): Promise<RequestRow> {
  const [r] = await tx
    .insert(requests)
    .values({ ...row, status: 'OPEN' })
    .returning(requestColumns);
  return r as RequestRow;
}

export async function insertSigners(tx: Tx, rows: readonly NewSigner[]): Promise<void> {
  if (rows.length > 0) await tx.insert(signers).values([...rows]);
}

export async function requestOf(tx: Tx, agencyId: string, id: string): Promise<RequestRow | null> {
  const [r] = await tx
    .select(requestColumns)
    .from(requests)
    .where(and(eq(requests.agencyId, agencyId), eq(requests.id, id)));
  return r ?? null;
}

/** A form's requests, newest first (`signature_requests_form_idx`); at most `limit`. */
export function requestsOfForm(tx: Tx, agencyId: string, formId: string, limit: number): Promise<RequestRow[]> {
  return tx
    .select(requestColumns)
    .from(requests)
    .where(and(eq(requests.agencyId, agencyId), eq(requests.formId, formId)))
    .orderBy(desc(requests.createdAt), desc(requests.id))
    .limit(limit);
}

export interface SignerRow {
  id: string;
  requestId: string;
  position: number;
  role: string;
  name: string;
  email: string;
  locale: string;
  invitedAt: Date | null;
  signedAt: Date | null;
  signatureKind: string | null;
  signedIp: string | null;
}

/** The signers of these requests in order, with how and from where they signed (one statement). */
export function signersOf(tx: Tx, agencyId: string, requestIds: readonly string[]): Promise<SignerRow[]> {
  if (requestIds.length === 0) return Promise.resolve([]);
  return tx
    .select({
      id: signers.id,
      requestId: signers.requestId,
      position: signers.position,
      role: signers.role,
      name: signers.name,
      email: signers.email,
      locale: signers.locale,
      invitedAt: signers.invitedAt,
      signedAt: signers.signedAt,
      signatureKind: events.signatureKind,
      signedIp: events.ip,
    })
    .from(signers)
    .leftJoin(events, and(eq(events.id, signers.signatureEventId), eq(events.signerId, signers.id)))
    .where(and(eq(signers.agencyId, agencyId), inArray(signers.requestId, [...requestIds])))
    .orderBy(asc(signers.requestId), asc(signers.position));
}

// ---- the signing page (app_public, app_intake) ------------------------------------------------------------------------

export interface SigningSignerRow {
  signer_id: string;
  agency_id: string;
  request_id: string;
  form_id: string;
  name: string;
  email: string;
  role: string;
  position: number;
  locale: string;
  signed: boolean;
  signed_at: Date | string | null;
  request_status: string;
  ordered: boolean;
  waiting: boolean;
  expires_at: Date | string;
  completed_at: Date | string | null;
  document_sha256: string;
  signed_sha256: string | null;
  form_label: string;
  form_template: string;
  form_locale: string;
  agency_name: string | null;
  /** A later request for the same form exists (this one is superseded: closed for signing). */
  superseded: boolean;
  /** The database's now() — every time check of the page uses it, never the app clock. */
  db_now: Date | string;
}

/** The signer a verified token names (`signing_signer`, app_public; app_intake re-reads it under the lock): one row, or null. */
export async function signingSigner(tx: Tx, agencyId: string, signerId: string): Promise<SigningSignerRow | null> {
  const res = await tx.execute(sql`select * from public.signing_signer(${agencyId}::uuid, ${signerId}::uuid)`);
  return ((res as unknown as { rows: SigningSignerRow[] }).rows[0] as SigningSignerRow | undefined) ?? null;
}

/** One signer's page actions at a time (codes, guesses, the signature): a transaction-scoped advisory lock. */
export async function lockSigner(tx: Tx, signerId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`documents.signer:${signerId}`}, 0))`);
}

/** The signer's codes sent since `since`, newest first (`signature_events_signer_idx`); at most `limit`. */
export function codesSince(tx: Tx, signerId: string, since: Date, limit: number) {
  return tx
    .select({ id: events.id, createdAt: events.createdAt, expiresAt: events.otpExpiresAt })
    .from(events)
    .where(and(eq(events.signerId, signerId), eq(events.kind, 'OTP_SENT'), gt(events.createdAt, since)))
    .orderBy(desc(events.createdAt))
    .limit(limit);
}

/** Wrong codes of the signer since `since` (at most `limit` counted), and those of one code. */
export async function failuresSince(
  tx: Tx,
  signerId: string,
  since: Date,
  otpId: string | null,
  limit: number,
): Promise<{ total: number; ofCode: number }> {
  const rows = await tx
    .select({ otpId: events.otpId })
    .from(events)
    .where(and(eq(events.signerId, signerId), eq(events.kind, 'OTP_FAILED'), gt(events.createdAt, since)))
    .orderBy(desc(events.createdAt))
    .limit(limit);
  return { total: rows.length, ofCode: otpId ? rows.filter((r) => r.otpId === otpId).length : 0 };
}

export interface NewEvent {
  id: string;
  agencyId: string;
  signerId: string;
  kind: 'OTP_SENT' | 'OTP_FAILED' | 'SIGNED';
  otpId?: string | null;
  otpTtlSeconds?: number;
  ip: string | null;
  userAgent: string | null;
  signatureKind?: 'TYPED' | 'DRAWN';
  signatureText?: string;
  signaturePng?: string | null;
  documentSha256?: string;
}

/** Appends one page action (app_intake: no RETURNING — it reads back no column it did not list). */
export async function insertEvent(tx: Tx, e: NewEvent): Promise<void> {
  await tx.insert(events).values({
    id: e.id,
    agencyId: e.agencyId,
    signerId: e.signerId,
    kind: e.kind,
    otpId: e.otpId ?? null,
    otpExpiresAt: e.otpTtlSeconds ? sql`now() + make_interval(secs => ${e.otpTtlSeconds})` : null,
    ip: e.ip,
    userAgent: e.userAgent,
    signatureKind: e.signatureKind ?? null,
    signatureText: e.signatureText ?? null,
    signaturePng: e.signaturePng ?? null,
    documentSha256: e.documentSha256 ?? null,
    consented: e.kind === 'SIGNED' ? true : null,
  });
}

// ---- the worker (app_system) ------------------------------------------------------------------------------------------

/** The request, locked for the change (`FOR UPDATE`) when asked. */
export async function requestForWork(tx: Tx, id: string, lock = false): Promise<RequestRow | null> {
  const q = tx.select(requestColumns).from(requests).where(eq(requests.id, id));
  const [r] = lock ? await q.for('update') : await q;
  return r ?? null;
}

/** Other OPEN requests of the form made before this one: superseded (CANCELLED). Their ids. */
export async function cancelEarlierOpen(tx: Tx, r: RequestRow): Promise<string[]> {
  const rows = await tx
    .update(requests)
    .set({ status: 'CANCELLED', cancelledAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(requests.agencyId, r.agencyId),
        eq(requests.formId, r.formId),
        eq(requests.status, 'OPEN'),
        ne(requests.id, r.id),
        lt(requests.createdAt, r.createdAt),
      ),
    )
    .returning({ id: requests.id });
  return rows.map((x) => x.id);
}

/** Cancels one OPEN request (worker). */
export async function cancelRequest(tx: Tx, requestId: string): Promise<void> {
  await tx
    .update(requests)
    .set({ status: 'CANCELLED', cancelledAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(requests.id, requestId), eq(requests.status, 'OPEN')));
}

/** Whether a later request of the same form exists (this one is superseded by it). */
export async function laterRequestExists(tx: Tx, r: RequestRow): Promise<boolean> {
  const [x] = await tx
    .select({ id: requests.id })
    .from(requests)
    .where(
      and(
        eq(requests.agencyId, r.agencyId),
        eq(requests.formId, r.formId),
        ne(requests.id, r.id),
        gt(requests.createdAt, r.createdAt),
      ),
    )
    .limit(1);
  return !!x;
}

export function requestSigners(tx: Tx, requestId: string) {
  return tx
    .select({
      id: signers.id,
      agencyId: signers.agencyId,
      position: signers.position,
      role: signers.role,
      name: signers.name,
      email: signers.email,
      locale: signers.locale,
      invitedAt: signers.invitedAt,
      signedAt: signers.signedAt,
      signatureEventId: signers.signatureEventId,
    })
    .from(signers)
    .where(eq(signers.requestId, requestId))
    .orderBy(asc(signers.position));
}

/** One signer (the worker's checks). */
export async function signerForWork(tx: Tx, id: string) {
  const [r] = await tx
    .select({
      id: signers.id,
      agencyId: signers.agencyId,
      requestId: signers.requestId,
      position: signers.position,
      email: signers.email,
      locale: signers.locale,
      signedAt: signers.signedAt,
    })
    .from(signers)
    .where(eq(signers.id, id));
  return r ?? null;
}

/** The form's merged data (the agency's name as the form states it: e-mails and the audit trail). */
export async function formDataOf(tx: Tx, formId: string): Promise<unknown> {
  const [r] = await tx.select({ data: forms.data }).from(forms).where(eq(forms.id, formId));
  return r?.data ?? null;
}

export async function markInvited(tx: Tx, signerId: string): Promise<void> {
  await tx
    .update(signers)
    .set({ invitedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(signers.id, signerId), isNull(signers.invitedAt)));
}

/** One page action (the worker checks what the page appended). */
export async function eventOf(tx: Tx, id: string) {
  const [r] = await tx
    .select({
      id: events.id,
      agencyId: events.agencyId,
      signerId: events.signerId,
      kind: events.kind,
      otpId: events.otpId,
      otpExpiresAt: events.otpExpiresAt,
      documentSha256: events.documentSha256,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(eq(events.id, id));
  return r ?? null;
}

/** The signer's signature, applied at the time it was made (once). */
export async function applySignature(tx: Tx, signerId: string, eventId: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(signers)
    .set({ signedAt: at, signatureEventId: eventId, updatedAt: sql`now()` })
    .where(and(eq(signers.id, signerId), isNull(signers.signedAt)))
    .returning({ id: signers.id });
  return rows.length > 0;
}

export async function markAllSigned(tx: Tx, requestId: string): Promise<void> {
  await tx
    .update(requests)
    .set({ status: 'SIGNED', allSignedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(requests.id, requestId), eq(requests.status, 'OPEN')));
}

export async function markCompleted(tx: Tx, requestId: string, sha256: string, sizeBytes: number): Promise<boolean> {
  const rows = await tx
    .update(requests)
    .set({ status: 'COMPLETED', signedSha256: sha256, signedSizeBytes: sizeBytes, completedAt: sql`now()` })
    .where(and(eq(requests.id, requestId), eq(requests.status, 'SIGNED')))
    .returning({ id: requests.id });
  return rows.length > 0;
}

export async function markSealFailed(tx: Tx, requestId: string): Promise<void> {
  await tx
    .update(requests)
    .set({ status: 'FAILED', updatedAt: sql`now()` })
    .where(and(eq(requests.id, requestId), eq(requests.status, 'SIGNED')));
}

/** The audit trail: each signer's signature, the code it was checked against (when sent) — in signing order. */
export function auditTrail(tx: Tx, requestId: string) {
  const otp = sql`(select o.created_at from ${events} o where o.id = ${events.otpId} and o.signer_id = ${signers.id})`;
  return tx
    .select({
      signerId: signers.id,
      position: signers.position,
      role: signers.role,
      name: signers.name,
      email: signers.email,
      invitedAt: signers.invitedAt,
      signedAt: signers.signedAt,
      signatureKind: events.signatureKind,
      signatureText: events.signatureText,
      signaturePng: events.signaturePng,
      documentSha256: events.documentSha256,
      ip: events.ip,
      userAgent: events.userAgent,
      codeSentAt: sql<Date | string | null>`${otp}`,
    })
    .from(signers)
    .innerJoin(events, and(eq(events.id, signers.signatureEventId), eq(events.signerId, signers.id)))
    .where(and(eq(signers.requestId, requestId), isNotNull(signers.signedAt)))
    .orderBy(asc(signers.signedAt), asc(signers.position));
}

/** The form row the seal reads (agency, template, language, label, hash). */
export async function formOfRequest(tx: Tx, formId: string) {
  const [r] = await tx
    .select({
      id: forms.id,
      agencyId: forms.agencyId,
      template: forms.template,
      locale: forms.locale,
      label: forms.label,
      sha256: forms.sha256,
    })
    .from(forms)
    .where(eq(forms.id, formId));
  return r ?? null;
}

/** The requests of these forms (erasure: their signed PDFs' keys). */
export function requestIdsOfForms(tx: Tx, agencyId: string, formIds: readonly string[]) {
  if (formIds.length === 0) return Promise.resolve([] as { id: string; formId: string }[]);
  return tx
    .select({ id: requests.id, formId: requests.formId })
    .from(requests)
    .where(and(eq(requests.agencyId, agencyId), inArray(requests.formId, [...formIds])));
}

/**
 * The `SUBJECT` data export (GDPR Art. 15): a page of the signatures on the contact's forms by the client's side
 * (every role but the agency's own), by signer id — who, what role, the address, when invited and signed, how, from
 * which IP. Under the caller's RLS (`tx`).
 */
export function subjectSignatures(
  tx: Tx,
  agencyId: string,
  contactId: string,
  agencyRoles: readonly string[],
  afterId: string | null,
  limit: number,
) {
  return tx
    .select({
      id: signers.id,
      requestId: signers.requestId,
      formId: requests.formId,
      role: signers.role,
      name: signers.name,
      email: signers.email,
      invitedAt: signers.invitedAt,
      signedAt: signers.signedAt,
      signatureKind: events.signatureKind,
      ip: events.ip,
      userAgent: events.userAgent,
    })
    .from(signers)
    .innerJoin(requests, and(eq(requests.id, signers.requestId), eq(requests.agencyId, signers.agencyId)))
    .innerJoin(forms, and(eq(forms.id, requests.formId), eq(forms.agencyId, requests.agencyId)))
    .leftJoin(events, and(eq(events.id, signers.signatureEventId), eq(events.signerId, signers.id)))
    .where(
      and(
        eq(signers.agencyId, agencyId),
        eq(forms.contactId, contactId),
        agencyRoles.length > 0 ? notInArray(signers.role, [...agencyRoles]) : undefined,
        afterId ? gt(signers.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(signers.id))
    .limit(limit);
}
