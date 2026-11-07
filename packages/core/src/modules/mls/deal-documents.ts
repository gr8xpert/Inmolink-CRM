/**
 * The deal room's documents (R2-04b, PLAN §7 M10): the offer, the reservation and arras contracts, the deed, a
 * commission invoice — PDFs both parties of a deal read. One object in the private bucket under
 * `deal-documents/<deal>/<id>` (unguessable: UUIDv7), one `deal_documents` row per party like the deal itself; the
 * database appends the peer's copy (`deal_documents_mirror`) and refuses an upload to a closed deal, as someone else, or
 * under another key (`deal_documents_guard`).
 *
 * The upload follows the development documents (S4-F4): the body arrives whole (the route relays it), the type comes
 * from its magic bytes (PDF only), the scan hook runs, and the object is stored outside any transaction between a check
 * and a recording transaction; a failed recording removes the object again, and a retried upload of the same file by
 * the same agency answers with the document it made. Opening is a short signed GET (5 minutes), audited in the opening
 * agency's log. Only the uploading agency removes a document, while the deal is open: both copies stay listed as
 * removed (the deal's evidence) and the worker deletes the object (`mls.deleteDealDocumentObject`); an hourly sweep
 * removes `deal-documents/` objects no live row names (`mls.sweepOrphanDealDocuments`). A closed deal's documents are
 * fixed, like the deal. Never in Client Mode; nothing of a client is derived from them.
 */
import { createHash } from 'node:crypto';
import {
  DEAL_DOCUMENT_MAX_BYTES,
  DEAL_DOCUMENT_URL_TTL_SECONDS,
  DEAL_DOCUMENTS_MAX,
  type DealDocumentDto,
  type DealDocumentKind,
  type DealDocumentList,
  type DealDocumentUrlDto,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError, isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { detectFileType, scanDocument, storage } from '@inmolink/platform/storage';
import { type Ctx, type CtxRunner, memberUserId } from '../../context';
import { advisoryLock } from '../../idempotency';
import * as compliance from '../compliance';
import * as identity from '../identity';
import * as repo from './deal-documents-repo';
import * as deals from './deals-repo';
import { mlsEvents } from './events';
import { assertCan } from './policy';

/** Where a deal document's object lives in the private bucket: per deal, the id unguessable (UUIDv7). */
export const DEAL_DOCUMENTS_PREFIX = 'deal-documents/';
export const dealDocumentKey = (dealId: string, documentId: string) =>
  `${DEAL_DOCUMENTS_PREFIX}${dealId}/${documentId}`;

const CLOSED = new Set(['COMPLETION', 'FELL_THROUGH']);

const target = (id: string): compliance.AuditTarget => ({ type: 'dealDocument', id });

const toDto = (r: repo.DealDocumentRow, readerAgencyId: string): DealDocumentDto => ({
  id: r.id,
  dealId: r.dealId,
  kind: r.kind as DealDocumentKind,
  fileName: r.fileName,
  sizeBytes: r.sizeBytes,
  uploadedBy: { name: r.uploaderName, ownAgency: r.uploaderAgencyId === readerAgencyId },
  createdAt: r.createdAt.toISOString(),
  removedAt: r.removedAt ? r.removedAt.toISOString() : null,
});

/** Control and format characters (bidi overrides), line / paragraph separators, path separators. */
const UNSAFE_NAME_CHAR = /[\p{Cc}\p{Cf}\u2028\u2029/\\]/u;

/** Keeps a readable name ending in `.pdf`; anything unusable becomes `document.pdf`. */
export function dealPdfName(raw: string): string {
  // No control characters, line separators, bidi or other format characters, nor path separators; the extension is ours.
  const kept = [...raw].filter((c) => !UNSAFE_NAME_CHAR.test(c));
  const base = kept
    .join('')
    .trim()
    .replace(/\.pdf$/i, '')
    .slice(0, 180);
  return `${base || 'document'}.pdf`;
}

/** The caller's copy of the deal (`mls.deals.read`): `DEAL_NOT_FOUND` when its agency is no party. */
async function ownDeal(ctx: Ctx, dealId: string): Promise<deals.DealRow> {
  const deal = await deals.dealOf(ctx.tx, ctx.tenant.agencyId, dealId);
  if (!deal) throw new AppError('DEAL_NOT_FOUND');
  return deal;
}

/** An open deal of the caller's agency, for a change of its documents (`mls.deals.write`). */
async function openDealFor(ctx: Ctx, dealId: string): Promise<deals.DealRow> {
  assertCan(ctx, 'mls.deals.write');
  const deal = await ownDeal(ctx, dealId);
  if (CLOSED.has(deal.stage)) throw new AppError('DEAL_STATE', { reason: 'closed' });
  return deal;
}

/** `GET /v1/mls/deals/:id/documents`: every document of the deal (both parties' uploads), oldest first. Two queries. */
export async function listDealDocuments(ctx: Ctx, dealId: string): Promise<DealDocumentList> {
  assertCan(ctx, 'mls.deals.read');
  await ownDeal(ctx, dealId);
  const rows = await repo.documentsOf(ctx.tx, ctx.tenant.agencyId, dealId, DEAL_DOCUMENTS_MAX);
  return { items: rows.map((r) => toDto(r, ctx.tenant.agencyId)) };
}

/**
 * `POST /v1/mls/deals/:id/documents?kind=`: one PDF (raw body, ≤ 20 MB) to an open deal, by either party (any member
 * who works clients). Both parties see it at once. ≤ `DEAL_DOCUMENTS_MAX` per deal (removed ones count).
 */
export async function uploadDealDocument(
  run: CtxRunner,
  input: { dealId: string; fileName: string; kind?: DealDocumentKind; body: Uint8Array },
): Promise<DealDocumentDto> {
  if (input.body.byteLength === 0) throw new AppError('VALIDATION_FAILED', { field: 'body', reason: 'empty' });
  if (input.body.byteLength > DEAL_DOCUMENT_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: DEAL_DOCUMENT_MAX_BYTES });
  }
  // The real type, whatever the name or header says: a renamed image or script is refused.
  if (detectFileType(input.body)?.contentType !== 'application/pdf') {
    throw new AppError('DOCUMENT_TYPE_NOT_ALLOWED', { allowed: ['pdf'] });
  }
  const sha256 = createHash('sha256').update(input.body).digest('hex');
  // A retried upload of the same file by this agency answers with the document it made — before storing anything.
  const prior = await run(async (ctx) => {
    const deal = await openDealFor(ctx, input.dealId);
    return replayOf(ctx, deal.id, sha256);
  });
  if (prior) return prior;
  if ((await scanDocument(input.body)) !== 'clean') {
    throw new AppError('DOCUMENT_TYPE_NOT_ALLOWED', { reason: 'scan' });
  }

  const id = newId();
  // Unguessable (UUIDv7 random bits), per deal, never derived from the file name; the guard insists on this key.
  const storageKey = dealDocumentKey(input.dealId, id);
  await storage().put('private', storageKey, input.body, { contentType: 'application/pdf' });
  try {
    const { dto, duplicate } = await run(async (ctx) => {
      // the deal's lock: its moves take it too, so the deal does not close between the check and the insert
      await advisoryLock(ctx.tx, `mls.deal:${input.dealId}`);
      const deal = await openDealFor(ctx, input.dealId);
      const same = await replayOf(ctx, deal.id, sha256);
      if (same) return { dto: same, duplicate: true };
      const agencyId = ctx.tenant.agencyId;
      const current = await repo.documentsOf(ctx.tx, agencyId, deal.id, DEAL_DOCUMENTS_MAX);
      if (current.length >= DEAL_DOCUMENTS_MAX) {
        throw new AppError('DOCUMENT_LIMIT_REACHED', { max: DEAL_DOCUMENTS_MAX });
      }
      const me = memberUserId(ctx);
      const name = ((await identity.memberNames(ctx, [me])).get(me) ?? '').slice(0, 200);
      const row = await repo.insertDocument(ctx.tx, {
        agencyId,
        id,
        dealId: deal.id,
        uploadedByUserId: me,
        uploaderName: name,
        kind: input.kind ?? 'OTHER',
        fileName: dealPdfName(input.fileName),
        sizeBytes: input.body.byteLength,
        sha256,
        storageKey,
      });
      await compliance.audit(ctx, 'mls.dealDocument.uploaded', target(row.id), { dealId: deal.id, kind: row.kind });
      return { dto: toDto(row, agencyId), duplicate: false };
    });
    if (duplicate) {
      await storage()
        .delete('private', storageKey)
        .catch(() => {});
    }
    return dto;
  } catch (err) {
    // Refused (the transaction rolled back): the object goes now. Any other failure — a lost connection after the
    // commit, say — may have recorded it: the hourly sweep removes it if no live row names it.
    if (isAppError(err) || hasSqlState(err)) {
      await storage()
        .delete('private', storageKey)
        .catch(() => {});
    }
    throw err;
  }
}

/** The agency's live upload of this file to the deal, as a retried upload answers it (audited as a duplicate). */
async function replayOf(ctx: Ctx, dealId: string, sha256: string): Promise<DealDocumentDto | null> {
  const agencyId = ctx.tenant.agencyId;
  const current = await repo.documentsOf(ctx.tx, agencyId, dealId, DEAL_DOCUMENTS_MAX);
  const same = current.find((d) => d.sha256 === sha256 && d.uploaderAgencyId === agencyId && !d.removedAt);
  if (!same) return null;
  await compliance.audit(ctx, 'mls.dealDocument.uploaded', target(same.id), {
    dealId,
    kind: same.kind,
    duplicate: true,
  });
  return toDto(same, agencyId);
}

/** A database refusal (an SQLSTATE), wherever Drizzle wraps it: the statement's transaction did not commit. */
function hasSqlState(err: unknown): boolean {
  for (
    let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0;
    e && i < 4;
    e = e.cause as typeof e, i++
  ) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return true;
  }
  return false;
}

/**
 * `GET /v1/mls/deals/:id/documents/:documentId/url`: a short signed GET (5 min) that downloads under its name — either
 * party, also on a closed deal. A removed document no longer opens. Audited in the opening agency's log.
 */
export async function openDealDocument(
  ctx: Ctx,
  input: { dealId: string; documentId: string },
): Promise<DealDocumentUrlDto> {
  assertCan(ctx, 'mls.deals.read');
  const row = await repo.documentOf(ctx.tx, ctx.tenant.agencyId, input.dealId, input.documentId);
  if (!row || row.removedAt) throw new AppError('DEAL_DOCUMENT_NOT_FOUND');
  await compliance.audit(ctx, 'mls.dealDocument.opened', target(row.id), { dealId: row.dealId, kind: row.kind });
  // signing is local: no network in the transaction
  const url = await storage().signedGetUrl('private', row.storageKey, {
    expiresInSeconds: DEAL_DOCUMENT_URL_TTL_SECONDS,
    responseContentType: 'application/pdf',
    downloadName: row.fileName,
  });
  return {
    url,
    expiresAt: new Date(clock.now().getTime() + DEAL_DOCUMENT_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * `DELETE /v1/mls/deals/:id/documents/:documentId`: the uploading agency removes its document from an open deal (both
 * copies stay listed as removed); the event in the same transaction has the worker delete the object. Another
 * agency's upload, or one removed already: `DEAL_DOCUMENT_NOT_FOUND`.
 */
export async function removeDealDocument(ctx: Ctx, input: { dealId: string; documentId: string }): Promise<void> {
  assertCan(ctx, 'mls.deals.write');
  await advisoryLock(ctx.tx, `mls.deal:${input.dealId}`);
  await openDealFor(ctx, input.dealId);
  const agencyId = ctx.tenant.agencyId;
  const row = await repo.removeDocument(ctx.tx, agencyId, input.dealId, input.documentId, memberUserId(ctx));
  if (!row) throw new AppError('DEAL_DOCUMENT_NOT_FOUND');
  await compliance.audit(ctx, 'mls.dealDocument.removed', target(row.id), { dealId: row.dealId, kind: row.kind });
  await emit(ctx.tx, mlsEvents.dealDocumentRemoved({ agencyId, dealId: row.dealId, documentId: row.id }));
}
