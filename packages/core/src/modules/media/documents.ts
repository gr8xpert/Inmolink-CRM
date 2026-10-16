/**
 * Listing documents (S3-F5): PDFs such as the nota simple, contracts or plans, private to the owner agency. Not
 * content-addressed (S3-03 decision 4): each upload is its own object under `documents/<agency>/<listing>/<id>` in
 * the private bucket, recorded in the STRICT `listing_documents` table, opened through a short signed GET. Never
 * on websites, never to other agencies (RLS), never in Client Mode.
 *
 * The upload follows the verification documents (S1-03): the body arrives whole (the web route relays it), the
 * type comes from its magic bytes, the scan hook runs, and the object is stored outside any transaction between a
 * check and a recording transaction; a failed recording removes the object again.
 *
 * Hygiene (S3-F8): a delete emits `media.document.deleted` in its transaction and the worker deletes the object,
 * retried (`document-jobs.ts`); an hourly sweep removes `documents/` objects without a row (a crash between store
 * and record, a cascade from a purged listing); `requestDocumentPurge` empties a listing's or agency's prefix.
 * Uploading, opening and deleting a document is audited (`media.document.*`, the listing in the metadata).
 */
import { createHash } from 'node:crypto';
import {
  LISTING_DOCUMENT_MAX_BYTES,
  LISTING_DOCUMENT_URL_TTL_SECONDS,
  LISTING_DOCUMENTS_MAX,
  type ListingDocumentDto,
  type ListingDocumentList,
  type ListingDocumentUrlDto,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { detectFileType, storage } from '@inmolink/platform/storage';
import type { Ctx, CtxRunner } from '../../context';
import * as compliance from '../compliance';
import * as properties from '../properties';
import { mediaEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';

/** A virus scanner's verdict; `clean` unless one is configured (security rules: "if a scanner is configured"). */
export type DocumentScanner = (bytes: Uint8Array) => Promise<'clean' | 'infected'>;
let scanner: DocumentScanner = async () => 'clean';

/** Plugs in a scanner (e.g. ClamAV in the worker image, later); tests pass a fake. */
export function configureDocumentScanner(next: DocumentScanner): void {
  scanner = next;
}

/** Where a document's object lives in the private bucket: per agency and listing, the id unguessable (UUIDv7). */
export const DOCUMENTS_PREFIX = 'documents/';
export const documentKey = (agencyId: string, listingId: string, documentId: string) =>
  `${DOCUMENTS_PREFIX}${agencyId}/${listingId}/${documentId}`;

const target = (documentId: string): compliance.AuditTarget => ({ type: 'listingDocument', id: documentId });

const toDto = (r: repo.DocumentRow): ListingDocumentDto => ({
  id: r.id,
  fileName: r.fileName,
  sizeBytes: r.sizeBytes,
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

function assertNotClient(ctx: Ctx): void {
  if (ctx.clientMode) throw new AppError('FORBIDDEN');
}

/** `GET /v1/listings/:id/documents`: the own listing's documents, oldest first. */
export async function listListingDocuments(ctx: Ctx, listingId: string): Promise<ListingDocumentList> {
  assertNotClient(ctx);
  assertCan(ctx, 'media.documents.read');
  await properties.assertListingReadable(ctx, listingId);
  return { items: (await repo.listDocuments(ctx.tx, ctx.tenant.agencyId, listingId)).map(toDto) };
}

/** `POST /v1/listings/:id/documents?fileName=`: one PDF (raw body, ≤ 20 MB). */
export async function uploadListingDocument(
  run: CtxRunner,
  input: { listingId: string; fileName: string; body: Uint8Array },
): Promise<ListingDocumentDto> {
  if (input.body.byteLength === 0) throw new AppError('VALIDATION_FAILED', { field: 'body', reason: 'empty' });
  if (input.body.byteLength > LISTING_DOCUMENT_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: LISTING_DOCUMENT_MAX_BYTES });
  }
  // The real type, whatever the name or header says: a renamed image or script is refused.
  if (detectFileType(input.body)?.contentType !== 'application/pdf') {
    throw new AppError('DOCUMENT_TYPE_NOT_ALLOWED', { allowed: ['pdf'] });
  }
  const listing = await run(async (ctx) => {
    assertCan(ctx, 'media.manage');
    return properties.lockListingForMedia(ctx, input.listingId);
  });
  if ((await scanner(input.body)) !== 'clean') throw new AppError('DOCUMENT_TYPE_NOT_ALLOWED', { reason: 'scan' });

  const sha256 = createHash('sha256').update(input.body).digest('hex');
  const id = newId();
  // Unguessable (UUIDv7 random bits), per agency and listing, never derived from the file name.
  const storageKey = documentKey(listing.agencyId, listing.id, id);
  await storage().put('private', storageKey, input.body, { contentType: 'application/pdf' });
  try {
    const { dto, duplicate } = await run(async (ctx) => {
      assertCan(ctx, 'media.manage');
      const locked = await properties.lockListingForMedia(ctx, input.listingId);
      if (locked.agencyId !== listing.agencyId) throw new AppError('FORBIDDEN');
      const current = await repo.listDocuments(ctx.tx, locked.agencyId, locked.id);
      // A retried upload of the same file answers with the document it made.
      const same = current.find((d) => d.sha256 === sha256);
      if (same) return { dto: toDto(same), duplicate: true };
      if (current.length >= LISTING_DOCUMENTS_MAX) {
        throw new AppError('DOCUMENT_LIMIT_REACHED', { max: LISTING_DOCUMENTS_MAX });
      }
      const row = await repo.insertDocument(ctx.tx, {
        id,
        agencyId: locked.agencyId,
        propertyId: locked.id,
        fileName: pdfName(input.fileName),
        contentType: 'application/pdf',
        sizeBytes: input.body.byteLength,
        sha256,
        storageKey,
        uploadedBy: ctx.actor.kind === 'user' ? ctx.actor.userId : '',
      });
      await compliance.audit(ctx, 'media.document.uploaded', target(row.id), { listingId: locked.id });
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

/** `GET /v1/listings/:id/documents/:documentId/url`: a short signed GET (5 min) that downloads under its name. */
export async function openListingDocument(
  ctx: Ctx,
  input: { listingId: string; documentId: string },
): Promise<ListingDocumentUrlDto> {
  assertNotClient(ctx);
  assertCan(ctx, 'media.documents.read');
  await properties.assertListingReadable(ctx, input.listingId);
  // STRICT: another agency's document is simply not there.
  const row = await repo.getDocument(ctx.tx, ctx.tenant.agencyId, input.listingId, input.documentId);
  if (!row) throw new AppError('MEDIA_NOT_FOUND');
  // Who opened which private file, and when (signing is local: no network in the transaction).
  await compliance.audit(ctx, 'media.document.opened', target(row.id), { listingId: input.listingId });
  const url = await storage().signedGetUrl('private', row.storageKey, {
    expiresInSeconds: LISTING_DOCUMENT_URL_TTL_SECONDS,
    responseContentType: 'application/pdf',
    downloadName: row.fileName,
  });
  return { url, expiresAt: new Date(clock.now().getTime() + LISTING_DOCUMENT_URL_TTL_SECONDS * 1000).toISOString() };
}

/**
 * `DELETE /v1/listings/:id/documents/:documentId`: the row, its audit entry and the outbox event in one
 * transaction; the worker deletes the object (`media.deleteDocumentObject`, retried until it is gone).
 */
export async function deleteListingDocument(run: CtxRunner, input: { listingId: string; documentId: string }) {
  await run(async (ctx) => {
    assertCan(ctx, 'media.manage');
    const listing = await properties.lockListingForMedia(ctx, input.listingId);
    const removed = await repo.deleteDocument(ctx.tx, listing.agencyId, listing.id, input.documentId);
    if (!removed) throw new AppError('MEDIA_NOT_FOUND');
    await compliance.audit(ctx, 'media.document.deleted', target(input.documentId), { listingId: listing.id });
    await emit(ctx.tx, mediaEvents.documentDeleted({ listingId: listing.id, documentId: input.documentId }));
  });
}
