/**
 * Simple electronic signature of forms (R2-05b, PLAN §7 M13; H17 open — built-in simple signature vs a provider, after
 * lawyer input: built behind the `@inmolink/platform/esign` adapter and the `documents.esign` flag).
 *
 * 1. A member asks for signatures on a READY form (`POST /v1/documents/forms/:id/signature-requests`): the signers
 *    (name, e-mail, the template's role they sign as; the collaboration agreement needs both agencies), optionally in
 *    order. The request records the form's SHA-256 — what everyone signs. One transaction with the
 *    `documents.signature.requested` event; a new request supersedes the form's earlier open one (the worker cancels it).
 * 2. The worker invites the signers whose turn it is (`email` pool): a signed link to the public signing page.
 * 3. The signer, on the page (`signing-public.ts`), reads the document, asks for a one-time code by e-mail and signs
 *    with it (typed name or drawn signature, explicit consent). The page appends what happened as `app_intake`; the
 *    worker e-mails the code and applies the signature (re-checking the request is open, the order, the code's row and
 *    the hash signed).
 * 4. When everyone has signed, the `pdf` pool seals the signed PDF: the stored original (its SHA-256 checked again)
 *    and an audit-trail page (signers, e-mails, codes sent, times, IPs, browsers, the original's SHA-256), through the
 *    provider; it is stored once and its own SHA-256 recorded (`COMPLETED`). Signers and the requester are e-mailed the
 *    link and the hash. `verifySignedPdf` checks any file against the stored hashes.
 */
import { createHash } from 'node:crypto';
import {
  CreateSignatureRequestBody,
  type SignatureRequestDto,
  type SignatureRequestList,
  type SignatureRequestStatus,
  type VerifySignedPdfResult,
} from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { clock } from '@inmolink/platform/clock';
import { mailer } from '@inmolink/platform/email';
import { AppError } from '@inmolink/platform/errors';
import { ESignInputError, esign } from '@inmolink/platform/esign';
import { flag } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { pdf } from '@inmolink/platform/pdf';
import { RetryableError, UnrecoverableError } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import { type Ctx, memberUserId } from '../../context';
import { advisoryLock, idempotencyOf, keyReusedOn, replayOf } from '../../idempotency';
import { impersonatorOf } from '../../impersonation';
import * as identity from '../identity';
import { DOCUMENT_LINK_SECONDS, DOCUMENT_MAX_BYTES } from './config';
import { documentsEvents } from './events';
import { FORMS_FLAG, formDocumentKey, lockDealAgreement } from './forms';
import { FormData } from './forms-data';
import { FORM_SIGNERS } from './forms-templates';
import { assertCan } from './policy';
import { signedFormKey } from './signature-keys';
import { type AuditSigner, auditTrailHtml } from './signatures-audit';
import { renderCodeEmail, renderCompletedEmail, renderInviteEmail } from './signatures-emails';
import * as repo from './signatures-repo';
import { signingCode, signingUrl } from './signing-token';

/** The feature flag e-signature ships dark behind (on top of `documents.forms`; STATUS Decisions R2-05b). */
export const ESIGN_FLAG = 'documents.esign';

/** The signature blocks the agency itself signs (never the client's: the SUBJECT export leaves them out). */
export const AGENCY_SIGNER_ROLES: readonly string[] = ['agency', 'ownerAgency', 'introducerAgency'];

/** Requests listed per form (newest first): a form is signed once, so a few superseded ones at most. */
const REQUESTS_PER_FORM = 20;

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const uiLocale = (l: string) => (isUiLocale(l) ? l : DEFAULT_UI_LOCALE);

async function assertEsignEnabled(ctx: Ctx): Promise<void> {
  if (!(await flag(ctx, FORMS_FLAG))) throw new AppError('FORMS_NOT_ENABLED');
  if (!(await flag(ctx, ESIGN_FLAG))) throw new AppError('ESIGN_NOT_ENABLED');
}

/**
 * R2-05c: the caller may ask for signatures (`documents.forms.sign`: no Client Mode, never impersonated) and both flags
 * are on — what `mls.dealSigners` checks before it reads the other agency's signers.
 */
export async function assertCanRequestSignatures(ctx: Ctx): Promise<void> {
  assertCan(ctx, 'documents.forms.sign');
  await assertEsignEnabled(ctx);
}

const statusOf = (r: repo.RequestRow, now = clock.nowMs()): SignatureRequestStatus =>
  r.status === 'OPEN' && r.expiresAt.getTime() <= now ? 'EXPIRED' : (r.status as SignatureRequestStatus);

function toDto(
  r: repo.RequestRow,
  signers: readonly repo.SignerRow[],
  link?: { url: string; expiresAt: Date },
): SignatureRequestDto {
  return {
    id: r.id,
    formId: r.formId,
    provider: r.provider,
    status: statusOf(r),
    ordered: r.ordered,
    documentSha256: r.documentSha256,
    signedSha256: r.signedSha256,
    signedSizeBytes: r.signedSizeBytes,
    message: r.message,
    expiresAt: r.expiresAt.toISOString(),
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt.toISOString(),
    allSignedAt: iso(r.allSignedAt),
    completedAt: iso(r.completedAt),
    cancelledAt: iso(r.cancelledAt),
    signers: signers
      .filter((s) => s.requestId === r.id)
      .map((s) => ({
        id: s.id,
        position: s.position,
        role: s.role,
        name: s.name,
        email: s.email,
        locale: s.locale,
        invitedAt: iso(s.invitedAt),
        signedAt: iso(s.signedAt),
        signatureKind: (s.signatureKind as 'TYPED' | 'DRAWN' | null) ?? null,
        signedIp: s.signedAt ? s.signedIp : null,
      })),
    url: link?.url ?? null,
    urlExpiresAt: link?.expiresAt.toISOString() ?? null,
  };
}

// ---- member -----------------------------------------------------------------------------------------------------------

const invalid = (reason: string, extra: Record<string, unknown> = {}): never => {
  throw new AppError('SIGNERS_INVALID', { reason, ...extra });
};

/**
 * Who may sign a deal's collaboration agreement for each party (R2-05c): the addresses `mls.dealSigners` read through
 * the `deal_signers()` definer — each party's deal member and admins. Passed by `mls.createDealSignatureRequest` only.
 */
export interface DealSigners {
  dealId: string;
  /** Signer role (`ownerAgency`, `introducerAgency`) → the e-mail addresses accepted for it. */
  allowed: Readonly<Record<string, readonly string[]>>;
}

const emailKey = (e: string) => e.trim().toLowerCase();

/**
 * The signers fit the form: roles of its template, every party of a collaboration agreement, no address twice. A
 * collaboration agreement is signed only from its deal (`deal`): each agency's signer is one of that party's deal
 * members or admins (R2-05c — the requester cannot name a stranger as the other agency's signatory).
 */
function checkSigners(
  form: { template: string; dealId: string | null },
  signers: CreateSignatureRequestBody['signers'],
  deal: DealSigners | undefined,
): void {
  const { template } = form;
  const roles = FORM_SIGNERS[template as keyof typeof FORM_SIGNERS] ?? [];
  for (const s of signers) if (!roles.includes(s.role)) invalid('role', { role: s.role });
  if (template === 'COLLABORATION_AGREEMENT') {
    if (!deal || form.dealId !== deal.dealId) invalid('deal');
    for (const role of roles) if (!signers.some((s) => s.role === role)) invalid('party', { role });
    for (const s of signers) {
      const allowed = (deal?.allowed[s.role] ?? []).map(emailKey);
      if (!allowed.includes(emailKey(s.email))) invalid('party_member', { role: s.role });
    }
  }
  const emails = signers.map((s) => emailKey(s.email));
  if (new Set(emails).size !== emails.length) invalid('duplicate');
}

/**
 * `POST /v1/documents/forms/:id/signature-requests`. With an `Idempotency-Key`, a retry by the same member within 24 h
 * with the same body answers the first request (`replayed`). One transaction (≤ 10 statements).
 */
export async function createSignatureRequest(
  ctx: Ctx,
  formId: string,
  body: CreateSignatureRequestBody,
  opts: { idempotencyKey?: string; deal?: DealSigners } = {},
): Promise<{ request: SignatureRequestDto; replayed: boolean }> {
  assertCan(ctx, 'documents.forms.sign');
  await assertEsignEnabled(ctx);
  const input = CreateSignatureRequestBody.parse(body);
  const agencyId = ctx.tenant.agencyId;
  const idempotency = idempotencyOf('documents.signature', memberUserId(ctx), opts.idempotencyKey, {
    formId,
    ...input,
  });
  const prior = await replayOf(
    ctx.tx,
    idempotency,
    (since, key) => repo.requestByIdempotency(ctx.tx, agencyId, key.hash, since),
    { lock: true },
  );
  if (prior) {
    return { request: toDto(prior.row, await repo.signersOf(ctx.tx, agencyId, [prior.row.id])), replayed: true };
  }
  // R2-05c: a deal's agreement, then one request at a time per form (the signed check and the insert)
  if (opts.deal) await lockDealAgreement(ctx, opts.deal.dealId);
  await advisoryLock(ctx.tx, `documents.sign-form:${formId}`);
  const form = await repo.formForSigning(ctx.tx, agencyId, formId);
  if (!form) throw new AppError('FORM_DOCUMENT_NOT_FOUND');
  if (form.status !== 'READY' || !form.sha256) throw new AppError('FORM_NOT_READY');
  if (await repo.formSigned(ctx.tx, agencyId, formId)) throw new AppError('FORM_ALREADY_SIGNED');
  checkSigners(form, input.signers, opts.deal);
  // R2-05c: another agreement of the deal out for signature or signed (a request for this one replaces its own)
  if (opts.deal && (await repo.dealAgreementInSignature(ctx.tx, agencyId, opts.deal.dealId, formId))) {
    throw new AppError('AGREEMENT_IN_SIGNATURE');
  }
  const defaultLocale = uiLocale(form.locale);
  for (const s of input.signers) {
    if (s.locale !== undefined && !isUiLocale(s.locale)) throw new AppError('VALIDATION_FAILED', { field: 'locale' });
  }
  const id = newId();
  const row = await repo
    .insertRequest(ctx.tx, {
      id,
      agencyId,
      formId,
      provider: esign().name,
      ordered: input.ordered,
      documentSha256: form.sha256,
      message: input.message ?? null,
      expiresAt: new Date(clock.nowMs() + input.expiresInDays * 86_400_000),
      createdByUserId: memberUserId(ctx),
      idempotencyHash: idempotency?.hash ?? null,
      requestHash: idempotency?.requestHash ?? null,
    })
    .catch(keyReusedOn('signature_requests_idempotency_uq'));
  const signers: repo.NewSigner[] = input.signers.map((s, i) => ({
    id: newId(),
    agencyId,
    requestId: id,
    position: i + 1,
    role: s.role,
    name: s.name.trim(),
    email: s.email.trim(),
    locale: s.locale ?? defaultLocale,
  }));
  await repo.insertSigners(ctx.tx, signers);
  await emit(ctx.tx, documentsEvents.signatureRequested({ agencyId, requestId: id }));
  const rows: repo.SignerRow[] = signers.map((s) => ({
    ...s,
    invitedAt: null,
    signedAt: null,
    signatureKind: null,
    signedIp: null,
  }));
  return { request: toDto(row, rows), replayed: false };
}

/** `GET /v1/documents/forms/:id/signature-requests`: the form's requests, newest first, with their signers. */
export async function listSignatureRequests(ctx: Ctx, formId: string): Promise<SignatureRequestList> {
  assertCan(ctx, 'documents.forms.read');
  await assertEsignEnabled(ctx);
  const agencyId = ctx.tenant.agencyId;
  if (!(await repo.formForSigning(ctx.tx, agencyId, formId))) throw new AppError('FORM_DOCUMENT_NOT_FOUND');
  const rows = await repo.requestsOfForm(ctx.tx, agencyId, formId, REQUESTS_PER_FORM);
  const signers = await repo.signersOf(
    ctx.tx,
    agencyId,
    rows.map((r) => r.id),
  );
  return { items: rows.map((r) => toDto(r, signers)) };
}

async function requestOrThrow(ctx: Ctx, id: string): Promise<repo.RequestRow> {
  const row = await repo.requestOf(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('SIGNATURE_REQUEST_NOT_FOUND');
  return row;
}

/** `GET /v1/documents/signature-requests/:id`: with a short signed link to the signed PDF once `COMPLETED`. */
export async function getSignatureRequest(ctx: Ctx, id: string): Promise<SignatureRequestDto> {
  assertCan(ctx, 'documents.forms.read');
  await assertEsignEnabled(ctx);
  const row = await requestOrThrow(ctx, id);
  const signers = await repo.signersOf(ctx.tx, ctx.tenant.agencyId, [row.id]);
  // staff impersonating the member see the request, never a link to the signed PDF (as forms, R2-05a)
  if (row.status !== 'COMPLETED' || impersonatorOf(ctx)) return toDto(row, signers);
  const expiresAt = new Date(clock.nowMs() + DOCUMENT_LINK_SECONDS * 1_000);
  const url = await storage().signedGetUrl('private', signedFormKey(row.agencyId, row.formId, row.id), {
    expiresInSeconds: DOCUMENT_LINK_SECONDS,
    downloadName: `signed-${row.formId}.pdf`,
    responseContentType: 'application/pdf',
  });
  return toDto(row, signers, { url, expiresAt });
}

/**
 * `POST /v1/documents/signature-requests/:id/verify`: whether `bytes` are, byte for byte (SHA-256), the signed PDF of
 * the request (`SIGNED`), the original the signers signed (`ORIGINAL`), or neither (`NONE`). No storage read.
 */
export async function verifySignedPdf(ctx: Ctx, id: string, bytes: Uint8Array): Promise<VerifySignedPdfResult> {
  assertCan(ctx, 'documents.forms.read');
  await assertEsignEnabled(ctx);
  const row = await requestOrThrow(ctx, id);
  return verifyAgainst(row, bytes);
}

/** The comparison itself (constant inputs: two stored hashes). */
export function verifyAgainst(
  row: Pick<repo.RequestRow, 'id' | 'documentSha256' | 'signedSha256'>,
  bytes: Uint8Array,
): VerifySignedPdfResult {
  const sha256 = sha256Hex(bytes);
  const match = row.signedSha256 === sha256 ? 'SIGNED' : row.documentSha256 === sha256 ? 'ORIGINAL' : 'NONE';
  return { requestId: row.id, match, sha256, documentSha256: row.documentSha256, signedSha256: row.signedSha256 };
}

// ---- worker: invitations and codes (email pool) -------------------------------------------------------------------

function agencyNameOf(data: unknown): string {
  const parsed = FormData.safeParse(data);
  return parsed.success ? parsed.data.agency.name : '';
}

/**
 * `documents.signature.requested`: supersedes the form's earlier open requests (and cancels itself when an earlier one
 * was signed first), then invites the signers whose turn it
 * is (all of an unordered request; the first who has not signed of an ordered one) who were not invited yet. The send
 * is outside the transaction, keyed per signer (a retry is delivered once). Idempotent.
 */
export async function inviteSigners(p: { agencyId: string; requestId: string }): Promise<{ invited: number }> {
  const work = await withSystem('documents.signature.invite', async (tx) => {
    const r = await repo.requestForWork(tx, p.requestId);
    if (!r || r.agencyId !== p.agencyId || r.status !== 'OPEN') return null;
    await repo.cancelEarlierOpen(tx, r);
    if (r.expiresAt.getTime() <= clock.nowMs() || (await repo.laterRequestExists(tx, r))) return null;
    // another request of the form was signed first (it collected its last signature before this one superseded it)
    if (await repo.formSigned(tx, r.agencyId, r.formId)) {
      await repo.cancelRequest(tx, r.id);
      return null;
    }
    const form = await repo.formOfRequest(tx, r.formId);
    if (!form) return null;
    const data = await repo.formDataOf(tx, r.formId);
    const signers = await repo.requestSigners(tx, r.id);
    const unsigned = signers.filter((s) => !s.signedAt);
    const due = (r.ordered ? unsigned.slice(0, 1) : unsigned).filter((s) => !s.invitedAt);
    return { r, form, agencyName: agencyNameOf(data), due };
  });
  if (!work || work.due.length === 0) return { invited: 0 };
  for (const s of work.due) {
    const url = signingUrl({ agencyId: s.agencyId, signerId: s.id, locale: s.locale });
    if (!url) throw new Error('documents: signing links are not configured (PUBLIC_PAGES_URL)');
    await mailer().send(
      renderInviteEmail({
        to: { email: s.email, name: s.name, locale: s.locale },
        agencyName: work.agencyName,
        document: work.form.label,
        expiresAt: work.r.expiresAt,
        message: work.r.message,
        url,
        idempotencyKey: `sign-invite-${s.id}`,
      }),
    );
    await withSystem('documents.signature.invited', (tx) => repo.markInvited(tx, s.id));
  }
  return { invited: work.due.length };
}

/** `documents.signature.codeRequested`: e-mails the code of that `OTP_SENT` row while it lives. Idempotent per row. */
export async function sendSigningCode(p: { agencyId: string; signerId: string; otpId: string }): Promise<boolean> {
  const work = await withSystem('documents.signature.code', async (tx) => {
    const otp = await repo.eventOf(tx, p.otpId);
    if (otp?.kind !== 'OTP_SENT' || otp.signerId !== p.signerId || otp.agencyId !== p.agencyId) return null;
    if (!otp.otpExpiresAt || otp.otpExpiresAt.getTime() <= clock.nowMs()) return null;
    const signer = await repo.signerForWork(tx, p.signerId);
    if (!signer || signer.agencyId !== p.agencyId || signer.signedAt) return null;
    const r = await repo.requestForWork(tx, signer.requestId);
    if (r?.status !== 'OPEN') return null;
    const form = await repo.formOfRequest(tx, r.formId);
    if (!form) return null;
    return { signer, form, agencyName: agencyNameOf(await repo.formDataOf(tx, r.formId)) };
  });
  if (!work) return false;
  await mailer().send(
    renderCodeEmail({
      to: { email: work.signer.email, locale: work.signer.locale },
      agencyName: work.agencyName,
      document: work.form.label,
      code: signingCode(p.otpId, p.signerId),
      idempotencyKey: `sign-code-${p.otpId}`,
    }),
  );
  return true;
}

// ---- worker: applying a signature (maintenance pool) ------------------------------------------------------------------

/** A code still counts this long after its row's expiry (the page checked it in time; the clocks are the database's). */
const CODE_GRACE_MS = 60_000;

export type ApplyResult = 'applied' | 'already' | 'closed' | 'refused';

/**
 * `documents.signature.signed`: the signer's signature, applied at the time they signed — after checking again what the
 * page checked: the request is open and was not expired then, the signer's turn (ordered), the code row it was made
 * with (the signer's, live then), and the hash they were shown is the request's. Everyone signed: `SIGNED` and
 * `documents.signature.allSigned` (the seal); an ordered request's next signer is invited. Idempotent.
 */
export async function applySignatureEvent(p: {
  agencyId: string;
  signerId: string;
  eventId: string;
}): Promise<ApplyResult> {
  return withSystem('documents.signature.apply', async (tx) => {
    const ev = await repo.eventOf(tx, p.eventId);
    if (ev?.kind !== 'SIGNED' || ev.signerId !== p.signerId || ev.agencyId !== p.agencyId) return 'refused';
    const signer = await repo.signerForWork(tx, p.signerId);
    if (!signer || signer.agencyId !== p.agencyId) return 'refused';
    const r = await repo.requestForWork(tx, signer.requestId, true);
    if (!r) return 'refused';
    if (signer.signedAt) return 'already';
    if (r.status !== 'OPEN' || ev.createdAt.getTime() > r.expiresAt.getTime()) return 'closed';
    // the form's request lock (as a new request takes it): a request superseded meanwhile never advances, and a new
    // one is refused once this one is SIGNED — one signed PDF per form (code review)
    await advisoryLock(tx, `documents.sign-form:${r.formId}`);
    if (await repo.laterRequestExists(tx, r)) return 'closed';
    if (ev.documentSha256 !== r.documentSha256) return 'refused';
    const otp = ev.otpId ? await repo.eventOf(tx, ev.otpId) : null;
    if (otp?.kind !== 'OTP_SENT' || otp.signerId !== signer.id || !otp.otpExpiresAt) return 'refused';
    if (ev.createdAt.getTime() > otp.otpExpiresAt.getTime() + CODE_GRACE_MS) return 'refused';
    const all = await repo.requestSigners(tx, r.id);
    if (r.ordered && all.some((s) => s.position < signer.position && !s.signedAt)) return 'refused';
    if (!(await repo.applySignature(tx, signer.id, ev.id, ev.createdAt))) return 'already';
    const remaining = all.filter((s) => s.id !== signer.id && !s.signedAt);
    if (remaining.length === 0) {
      await repo.markAllSigned(tx, r.id);
      await emit(tx, documentsEvents.signatureAllSigned({ agencyId: r.agencyId, requestId: r.id }), {
        agencyId: r.agencyId,
      });
    } else if (r.ordered) {
      await emit(tx, documentsEvents.signatureRequested({ agencyId: r.agencyId, requestId: r.id }), {
        agencyId: r.agencyId,
      });
    }
    return 'applied';
  });
}

// ---- worker: the signed PDF (pdf pool) --------------------------------------------------------------------------------

const roleLabel = (t: ReturnType<typeof translator>, role: string) => {
  const key = `forms.signers.${role}`;
  const label = t(key);
  return label === key ? role : label;
};

/**
 * `documents.signature.allSigned`: the signed PDF of a `SIGNED` request — the stored original (its SHA-256 must still
 * be the one signed: anything else fails the request for good) and the audit-trail page, sealed by the provider; stored
 * once (`ifNoneMatch`: overlapping runs record the stored bytes' hash) and recorded (`COMPLETED`, its SHA-256 and size)
 * with `documents.signature.completed`. A request erased meanwhile has its object deleted. Idempotent.
 */
export async function sealSignatureRequest(
  p: { agencyId: string; requestId: string },
  options: { signal?: AbortSignal } = {},
): Promise<{ sealed: boolean; bytes?: number }> {
  const work = await withSystem('documents.signature.seal', async (tx) => {
    const r = await repo.requestForWork(tx, p.requestId);
    if (!r || r.agencyId !== p.agencyId || r.status !== 'SIGNED') return null;
    const form = await repo.formOfRequest(tx, r.formId);
    if (!form) return null;
    return {
      r,
      form,
      agencyName: agencyNameOf(await repo.formDataOf(tx, r.formId)),
      trail: await repo.auditTrail(tx, r.id),
    };
  });
  if (!work) return { sealed: false };
  const { r, form } = work;
  const original = await storage().get('private', formDocumentKey(r.agencyId, r.formId), {
    maxBytes: DOCUMENT_MAX_BYTES,
  });
  if (!original) throw new RetryableError(`signature ${r.id}: the original PDF is missing`);
  if (sha256Hex(original) !== r.documentSha256) {
    throw new UnrecoverableError(`signature ${r.id}: the stored original is not the document signed`);
  }
  const lang = uiLocale(form.locale);
  const t = translator(lang, 'documents');
  const signers: AuditSigner[] = work.trail.map((s) => ({ ...s, role: roleLabel(t, s.role) }));
  const html = auditTrailHtml({
    t,
    lang,
    agencyName: work.agencyName,
    documentLabel: form.label,
    formId: form.id,
    requestId: r.id,
    requestedAt: r.createdAt,
    allSignedAt: r.allSignedAt,
    originalSha256: r.documentSha256,
    signers,
  });
  const auditTrail = await pdf().render(html, { signal: options.signal });
  let signed: Uint8Array;
  try {
    signed = await esign().seal({
      original,
      auditTrail,
      info: { title: form.label, subject: t('signing.audit.title'), keywords: [r.id, r.documentSha256] },
    });
  } catch (err) {
    if (err instanceof ESignInputError) throw new UnrecoverableError(err.message);
    throw err;
  }
  if (signed.length > DOCUMENT_MAX_BYTES) throw new UnrecoverableError(`signature ${r.id}: signed PDF too large`);
  const key = signedFormKey(r.agencyId, r.formId, r.id);
  const written = await storage().putIf(
    'private',
    key,
    signed,
    { contentType: 'application/pdf' },
    { ifNoneMatch: '*' },
  );
  const stored = written ? signed : await storage().get('private', key, { maxBytes: DOCUMENT_MAX_BYTES });
  if (!stored) throw new RetryableError(`signature ${r.id}: stored object vanished`);
  const outcome = await withSystem('documents.signature.sealed', async (tx) => {
    if (await repo.markCompleted(tx, r.id, sha256Hex(stored), stored.length)) {
      await emit(tx, documentsEvents.signatureCompleted({ agencyId: r.agencyId, requestId: r.id }), {
        agencyId: r.agencyId,
      });
      return 'recorded';
    }
    return (await repo.requestForWork(tx, r.id)) ? 'kept' : 'gone';
  });
  if (outcome === 'gone') await storage().delete('private', key);
  return { sealed: outcome === 'recorded', bytes: stored.length };
}

/** The seal failed for good (the job's last attempt): the request shows `FAILED`. */
export async function failSignatureSeal(requestId: string): Promise<void> {
  await withSystem('documents.signature.sealFailed', (tx) => repo.markSealFailed(tx, requestId));
}

/**
 * `documents.signature.completed`: every signer is e-mailed the signed PDF's link (their signing link's `/signed`)
 * and SHA-256, the member who asked the hash (the file is in the dashboard). Keyed per recipient (delivered once).
 */
export async function notifySignatureCompleted(p: { agencyId: string; requestId: string }): Promise<number> {
  const work = await withSystem('documents.signature.notify', async (tx) => {
    const r = await repo.requestForWork(tx, p.requestId);
    if (!r || r.agencyId !== p.agencyId || r.status !== 'COMPLETED' || !r.signedSha256) return null;
    const form = await repo.formOfRequest(tx, r.formId);
    if (!form) return null;
    return {
      r,
      form,
      agencyName: agencyNameOf(await repo.formDataOf(tx, r.formId)),
      signers: await repo.requestSigners(tx, r.id),
      requester: await identity.memberRecipient(tx, r.agencyId, r.createdByUserId),
    };
  });
  if (!work) return 0;
  const hash = work.r.signedSha256 as string;
  let sent = 0;
  for (const s of work.signers) {
    const url = signingUrl({ agencyId: s.agencyId, signerId: s.id, locale: s.locale }, '/signed');
    if (!url) throw new Error('documents: signing links are not configured (PUBLIC_PAGES_URL)');
    await mailer().send(
      renderCompletedEmail({
        to: { email: s.email, locale: s.locale },
        agencyName: work.agencyName,
        document: work.form.label,
        sha256: hash,
        url,
        idempotencyKey: `sign-done-${s.id}`,
      }),
    );
    sent += 1;
  }
  if (work.requester) {
    await mailer().send(
      renderCompletedEmail({
        to: { email: work.requester.email, locale: work.requester.locale },
        agencyName: work.agencyName,
        document: work.form.label,
        sha256: hash,
        url: null,
        idempotencyKey: `sign-done-${work.r.id}-requester`,
      }),
    );
    sent += 1;
  }
  return sent;
}
