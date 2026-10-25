/**
 * Development documents (S4-F4, PLAN §7 M3): brochures, plans, price lists and legal files of a development —
 * PDFs in the private bucket under `development-documents/<agency>/<development>/<id>`, recorded in the
 * NETWORK_READ `development_documents` table. Only the owner agency uploads, re-classifies, shares and deletes
 * them; a `shared` one is readable by every agency that sees the development (RLS, S4-01), the others stay with
 * the owner. Never in Client Mode, never on websites; opened through a short signed GET.
 *
 * The upload follows the listing documents (S3-F5): the body arrives whole (the web route relays it), the type
 * comes from its magic bytes, the scan hook runs, and the object is stored outside any transaction between a
 * check and a recording transaction; a failed recording removes the object again, and a retried upload of the
 * same file answers with the document it made (changed to the kind and sharing asked for, S5-F1).
 *
 * Hygiene: a delete emits `developments.document.deleted` in its transaction and the worker deletes the object,
 * retried (`jobs.ts`); an hourly sweep removes `development-documents/` objects without a row. Uploading,
 * opening, changing and deleting a document is audited (`developments.document.*`, the development in the
 * metadata) in the caller's agency — an agency opening a shared brochure is audited in its own log.
 */
import { createHash } from 'node:crypto';
import {
  DEVELOPMENT_DOCUMENT_MAX_BYTES,
  DEVELOPMENT_DOCUMENT_URL_TTL_SECONDS,
  DEVELOPMENT_DOCUMENTS_MAX,
  type DevelopmentDocumentDto,
  type DevelopmentDocumentKind,
  type DevelopmentDocumentList,
  type DevelopmentDocumentUrlDto,
  type UpdateDevelopmentDocumentBody,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { detectFileType, scanDocument, storage } from '@inmolink/platform/storage';
import { type Ctx, type CtxRunner, memberUserId } from '../../context';
import * as billing from '../billing';
import * as compliance from '../compliance';
import { developmentsEvents } from './events';
import { assertCan, can } from './policy';
import * as repo from './repo';
import { ownForChange, readable } from './service';

/** Where a document's object lives in the private bucket: per agency and development, the id unguessable (UUIDv7). */
export const DEVELOPMENT_DOCUMENTS_PREFIX = 'development-documents/';
export const developmentDocumentKey = (agencyId: string, developmentId: string, documentId: string) =>
  `${DEVELOPMENT_DOCUMENTS_PREFIX}${agencyId}/${developmentId}/${documentId}`;

const target = (documentId: string): compliance.AuditTarget => ({ type: 'developmentDocument', id: documentId });

const toDto = (r: repo.DocumentRow): DevelopmentDocumentDto => ({
  id: r.id,
  developmentId: r.developmentId,
  kind: r.kind,
  fileName: r.fileName,
  sizeBytes: r.sizeBytes,
  shared: r.shared,
  createdAt: r.createdAt.toISOString(),
});

/** Keeps a readable name ending in `.pdf`; anything unusable becomes `document.pdf`. */
function pdfName(raw: string): string {
  // No control characters or path separators; the extension is ours.
  const kept = [...raw].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127 && c !== '/' && c !== '\\');
  const base = kept
    .join('')
    .trim()
    .replace(/\.pdf$/i, '')
    .slice(0, 180);
  return `${base || 'document'}.pdf`;
}

/** `GET /v1/developments/:id/documents`: the owner's all, another agency's the shared ones; oldest first. */
export async function listDevelopmentDocuments(ctx: Ctx, developmentId: string): Promise<DevelopmentDocumentList> {
  assertCan(ctx, 'developmentDocument.read');
  await readable(ctx, developmentId);
  const rows = await repo.listDocuments(ctx.tx, developmentId);
  // A PARTNER member of the owner sees what collaborating agencies see: the shared ones (S5-F1).
  return { items: rows.filter((r) => can(ctx, 'developmentDocument.read', r)).map(toDto) };
}

/** `POST /v1/developments/:id/documents?fileName=&kind=&shared=`: one PDF (raw body, ≤ 20 MB). */
export async function uploadDevelopmentDocument(
  run: CtxRunner,
  input: {
    developmentId: string;
    fileName: string;
    kind?: DevelopmentDocumentKind;
    shared?: boolean;
    body: Uint8Array;
  },
): Promise<DevelopmentDocumentDto> {
  if (input.body.byteLength === 0) throw new AppError('VALIDATION_FAILED', { field: 'body', reason: 'empty' });
  if (input.body.byteLength > DEVELOPMENT_DOCUMENT_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: DEVELOPMENT_DOCUMENT_MAX_BYTES });
  }
  // The real type, whatever the name or header says: a renamed image or script is refused.
  if (detectFileType(input.body)?.contentType !== 'application/pdf') {
    throw new AppError('DOCUMENT_TYPE_NOT_ALLOWED', { allowed: ['pdf'] });
  }
  const dev = await run(async (ctx) => {
    // Sharing reaches other agencies: an admin's decision, like sharing the development (security review).
    if (input.shared) assertCan(ctx, 'developmentDocument.share');
    return ownForChange(ctx, input.developmentId, 'developmentDocument.manage');
  });
  if ((await scanDocument(input.body)) !== 'clean') {
    throw new AppError('DOCUMENT_TYPE_NOT_ALLOWED', { reason: 'scan' });
  }

  const sha256 = createHash('sha256').update(input.body).digest('hex');
  const id = newId();
  // Unguessable (UUIDv7 random bits), per agency and development, never derived from the file name.
  const storageKey = developmentDocumentKey(dev.agencyId, dev.id, id);
  await storage().put('private', storageKey, input.body, { contentType: 'application/pdf' });
  try {
    const { dto, duplicate } = await run(async (ctx) => {
      const locked = await ownForChange(ctx, input.developmentId, 'developmentDocument.manage');
      if (locked.agencyId !== dev.agencyId) throw new AppError('FORBIDDEN');
      const current = await repo.listDocuments(ctx.tx, locked.id);
      // A retried upload of the same file answers with the document it made; one asking for another kind or
      // sharing changes that document, as a PATCH would (the share check included), never answers the old row.
      const same = current.find((d) => d.sha256 === sha256);
      if (same) {
        const patch = {
          ...(input.kind !== undefined && input.kind !== same.kind ? { kind: input.kind } : {}),
          ...(input.shared !== undefined && input.shared !== same.shared ? { shared: input.shared } : {}),
        };
        if (patch.shared !== undefined) assertCan(ctx, 'developmentDocument.share');
        const row =
          Object.keys(patch).length === 0
            ? same
            : await repo.updateDocument(ctx.tx, locked.agencyId, locked.id, same.id, patch);
        if (!row) throw new AppError('DEVELOPMENT_DOCUMENT_NOT_FOUND'); // unreachable: the development is locked
        await compliance.audit(ctx, 'developments.document.uploaded', target(row.id), {
          developmentId: locked.id,
          duplicate: true,
        });
        if (row !== same) {
          // The same entry a PATCH writes: a change of sharing is found under `document.changed`, however made.
          await compliance.audit(ctx, 'developments.document.changed', target(row.id), {
            developmentId: locked.id,
            kind: row.kind,
            shared: row.shared,
            kindBefore: same.kind,
            sharedBefore: same.shared,
          });
        }
        return { dto: toDto(row), duplicate: true };
      }
      if (current.length >= DEVELOPMENT_DOCUMENTS_MAX) {
        throw new AppError('DOCUMENT_LIMIT_REACHED', { max: DEVELOPMENT_DOCUMENTS_MAX });
      }
      const row = await repo.insertDocument(ctx.tx, {
        id,
        developmentId: locked.id,
        agencyId: locked.agencyId,
        kind: input.kind ?? 'OTHER',
        fileName: pdfName(input.fileName),
        contentType: 'application/pdf',
        sizeBytes: input.body.byteLength,
        sha256,
        storageKey,
        shared: input.shared ?? false,
        uploadedBy: memberUserId(ctx),
      });
      await compliance.audit(ctx, 'developments.document.uploaded', target(row.id), {
        developmentId: locked.id,
        shared: row.shared,
      });
      return { dto: toDto(row), duplicate: false };
    });
    if (duplicate)
      await storage()
        .delete('private', storageKey)
        .catch(() => {});
    return dto;
  } catch (err) {
    await storage()
      .delete('private', storageKey)
      .catch(() => {});
    throw err;
  }
}

/** `GET /v1/developments/:id/documents/:documentId/url`: a short signed GET (5 min) that downloads under its name. */
export async function openDevelopmentDocument(
  ctx: Ctx,
  input: { developmentId: string; documentId: string },
): Promise<DevelopmentDocumentUrlDto> {
  assertCan(ctx, 'developmentDocument.read');
  const development = await readable(ctx, input.developmentId);
  // S13-F21: the new-build database's full view (PLAN §11: Free views developments and units); opening another
  // agency's documents (brochures, plans) is the paid part. The owner's own files are always its own.
  if (development.agencyId !== ctx.tenant.agencyId) await billing.requirePlan(ctx, 'new_builds_full');
  // RLS: another agency's non-shared document is simply not there.
  const row = await repo.getDocument(ctx.tx, input.developmentId, input.documentId);
  if (!row) throw new AppError('DEVELOPMENT_DOCUMENT_NOT_FOUND');
  // The owner's internal files (contracts) are not for its PARTNER members (S5-F1).
  assertCan(ctx, 'developmentDocument.read', row);
  // Who opened which file, and when (signing is local: no network in the transaction).
  await compliance.audit(ctx, 'developments.document.opened', target(row.id), {
    developmentId: input.developmentId,
  });
  const url = await storage().signedGetUrl('private', row.storageKey, {
    expiresInSeconds: DEVELOPMENT_DOCUMENT_URL_TTL_SECONDS,
    responseContentType: 'application/pdf',
    downloadName: row.fileName,
  });
  return {
    url,
    expiresAt: new Date(clock.now().getTime() + DEVELOPMENT_DOCUMENT_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/** `PATCH /v1/developments/:id/documents/:documentId`: the kind, and whether collaborating agencies read it. */
export async function updateDevelopmentDocument(
  ctx: Ctx,
  input: { developmentId: string; documentId: string; patch: UpdateDevelopmentDocumentBody },
): Promise<DevelopmentDocumentDto> {
  if (input.patch.shared !== undefined) assertCan(ctx, 'developmentDocument.share');
  const dev = await ownForChange(ctx, input.developmentId, 'developmentDocument.manage');
  const row = await repo.updateDocument(ctx.tx, dev.agencyId, dev.id, input.documentId, {
    ...(input.patch.kind !== undefined ? { kind: input.patch.kind } : {}),
    ...(input.patch.shared !== undefined ? { shared: input.patch.shared } : {}),
  });
  if (!row) throw new AppError('DEVELOPMENT_DOCUMENT_NOT_FOUND');
  await compliance.audit(ctx, 'developments.document.changed', target(row.id), {
    developmentId: dev.id,
    kind: row.kind,
    shared: row.shared,
  });
  return toDto(row);
}

/**
 * `DELETE /v1/developments/:id/documents/:documentId`: the row, its audit entry and the outbox event in one
 * transaction (price lists naming it as their source lose the link); the worker deletes the object
 * (`developments.deleteDocumentObject`, retried until it is gone).
 */
export async function deleteDevelopmentDocument(
  ctx: Ctx,
  input: { developmentId: string; documentId: string },
): Promise<void> {
  const dev = await ownForChange(ctx, input.developmentId, 'developmentDocument.manage');
  const removed = await repo.deleteDocument(ctx.tx, dev.agencyId, dev.id, input.documentId);
  if (!removed) throw new AppError('DEVELOPMENT_DOCUMENT_NOT_FOUND');
  await compliance.audit(ctx, 'developments.document.deleted', target(input.documentId), {
    developmentId: dev.id,
  });
  await emit(
    ctx.tx,
    developmentsEvents.documentDeleted({ documentId: input.documentId, developmentId: dev.id, agencyId: dev.agencyId }),
  );
}
