import { createHash } from 'node:crypto';
import {
  type AgencyVerificationDto,
  type DecideVerificationBody,
  type SignedUrlDto,
  type SubmitVerificationBody,
  type UploadVerificationDocumentQuery,
  VERIFICATION_DOCUMENT_MAX_BYTES,
  VERIFICATION_DOCUMENT_MAX_COUNT,
  VERIFICATION_DOCUMENT_TYPES,
  type VerificationDocumentDto,
  type VerificationQueuePage,
  type VerificationQueueQuery,
  type VerificationRequestDto,
} from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { detectFileType, storage } from '@inmolink/platform/storage';
import type { Ctx, CtxRunner, StaffCtx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as compliance from '../compliance';
import { agenciesEvents } from './events';
import { assertCan, assertStaffCan } from './policy';
import * as repo from './repo';
import { toAgencyDto } from './service';

/**
 * Staff verification of agencies (S1-03, PLAN §3 #3). The agency uploads documents (private bucket)
 * and submits; staff approve or reject with a reason, bound to the details `version` they reviewed.
 * Approval makes the agency VERIFIED: `withMemberCtx` reads the status per request, so SHARED/PUBLIC
 * listings and API keys unlock on the agency's next request.
 */

/** Signed document links live this long: enough to open the file, too short to share around. */
export const DOCUMENT_URL_TTL_SECONDS = 300;

const userIdOf = (ctx: Ctx) => (ctx.actor.kind === 'user' ? ctx.actor.userId : '');

function toDocumentDto(row: repo.DocumentRow): VerificationDocumentDto {
  return {
    id: row.id,
    kind: row.kind,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    submitted: row.requestId !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The display name ends in the extension of the type we detected (a renamed `.exe` stays a PDF). */
function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name.slice(0, 115)}.${extension}`;
}

/** Uploads are allowed while the agency is PENDING with no request waiting for staff. */
async function assertCanAddDocuments(ctx: Ctx): Promise<void> {
  if (ctx.tenant.verified) throw new AppError('VERIFICATION_NOT_OPEN', { reason: 'verified' });
  const latest = await repo.getLatestRequest(ctx.tx, ctx.tenant.agencyId);
  if (latest?.status === 'SUBMITTED') throw new AppError('VERIFICATION_ALREADY_SUBMITTED');
  const pending = await repo.countUnattachedDocuments(ctx.tx, ctx.tenant.agencyId);
  if (pending >= VERIFICATION_DOCUMENT_MAX_COUNT) {
    throw new AppError('DOCUMENT_LIMIT_REACHED', { max: VERIFICATION_DOCUMENT_MAX_COUNT });
  }
}

/**
 * Stores one document. Checks run in a first transaction, the file goes to the private bucket outside
 * any transaction, and a second transaction records it (re-checking the rules). If recording fails,
 * the stored object is removed again. The type comes from the file's magic bytes, never the header.
 */
export async function uploadVerificationDocument(
  run: CtxRunner,
  input: UploadVerificationDocumentQuery & { body: Uint8Array },
): Promise<VerificationDocumentDto> {
  if (input.body.byteLength === 0) throw new AppError('VALIDATION_FAILED', { field: 'body', reason: 'empty' });
  if (input.body.byteLength > VERIFICATION_DOCUMENT_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: VERIFICATION_DOCUMENT_MAX_BYTES });
  }
  const type = detectFileType(input.body);
  if (!type || !(VERIFICATION_DOCUMENT_TYPES as readonly string[]).includes(type.contentType)) {
    throw new AppError('DOCUMENT_TYPE_NOT_ALLOWED', { allowed: ['pdf', 'png', 'jpeg', 'webp'] });
  }

  const agencyId = await run(async (ctx) => {
    assertCan(ctx, 'agencies.verification.manage');
    await assertCanAddDocuments(ctx);
    return ctx.tenant.agencyId;
  });

  const sha256 = createHash('sha256').update(input.body).digest('hex');
  const id = newId();
  // Unguessable (UUIDv7 random bits), per agency, never derived from the file name.
  const storageKey = `verification/${agencyId}/${id}`;
  await storage().put('private', storageKey, input.body, { contentType: type.contentType });

  try {
    const { dto, duplicate } = await run(async (ctx) => {
      // Same agency as the check: the caller's token names one agency.
      if (ctx.tenant.agencyId !== agencyId) throw new AppError('FORBIDDEN');
      assertCan(ctx, 'agencies.verification.manage');
      // One upload at a time per agency, so parallel uploads cannot slip past the cap (S1-F7).
      await repo.lockDocumentCap(ctx.tx, agencyId);
      // A retried upload (same content, still unsubmitted) answers with the document it already made.
      const existing = await repo.findUnattachedBySha(ctx.tx, agencyId, sha256);
      if (existing) return { dto: toDocumentDto(existing), duplicate: true };
      await assertCanAddDocuments(ctx);
      const row = await repo.insertDocument(ctx.tx, {
        id,
        agencyId,
        kind: input.kind,
        fileName: withExtension(input.fileName, type.extension),
        contentType: type.contentType,
        sizeBytes: input.body.byteLength,
        sha256,
        storageKey,
        uploadedBy: userIdOf(ctx),
      });
      return { dto: toDocumentDto(row), duplicate: false };
    });
    if (duplicate) {
      await storage()
        .delete('private', storageKey)
        .catch(() => {});
    }
    return dto;
  } catch (err) {
    await storage()
      .delete('private', storageKey)
      .catch(() => {});
    throw err;
  }
}

/** Removes a document that was not submitted yet (row first, then the object, outside the transaction). */
export async function deleteVerificationDocument(run: CtxRunner, input: { id: string }): Promise<void> {
  const storageKey = await run(async (ctx) => {
    assertCan(ctx, 'agencies.verification.manage');
    const doc = await repo.getDocument(ctx.tx, ctx.tenant.agencyId, input.id);
    if (!doc) throw new AppError('NOT_FOUND');
    if (doc.requestId) throw new AppError('DOCUMENT_LOCKED');
    const key = await repo.deleteUnattachedDocument(ctx.tx, ctx.tenant.agencyId, input.id);
    if (!key) throw new AppError('DOCUMENT_LOCKED');
    return key;
  });
  // A failed delete leaves an unreferenced object in a private bucket; it is never readable.
  await storage()
    .delete('private', storageKey)
    .catch(() => {});
}

/** Where the agency stands: status, documents and the latest request (3 indexed queries). */
export async function getAgencyVerification(ctx: Ctx): Promise<AgencyVerificationDto> {
  assertCan(ctx, 'agencies.verification.read');
  const agency = await repo.getAgency(ctx.tx, ctx.tenant.agencyId);
  if (!agency) throw new AppError('NOT_FOUND');
  const latest = await repo.getLatestRequest(ctx.tx, ctx.tenant.agencyId);
  const documents = await repo.listAgencyDocuments(ctx.tx, ctx.tenant.agencyId, latest?.id ?? null);
  return {
    agencyStatus: agency.status,
    onboarded: agency.onboardedAt !== null,
    agencyVersion: agency.version,
    documents: documents.map(toDocumentDto),
    latestRequest: latest
      ? {
          id: latest.id,
          status: latest.status,
          submittedAt: latest.submittedAt.toISOString(),
          decidedAt: latest.decidedAt?.toISOString() ?? null,
          decisionReason: latest.decisionReason,
        }
      : null,
  };
}

/**
 * Sends the company details (as of `version`, which the admin confirms) and every uploaded document to
 * staff. One open request at a time; after a rejection the agency fixes what staff asked and submits again.
 */
export async function submitVerification(ctx: Ctx, input: SubmitVerificationBody): Promise<AgencyVerificationDto> {
  assertCan(ctx, 'agencies.verification.manage');
  const agency = await repo.getAgency(ctx.tx, ctx.tenant.agencyId);
  if (!agency) throw new AppError('NOT_FOUND');
  if (agency.status !== 'PENDING') throw new AppError('VERIFICATION_NOT_OPEN', { status: agency.status });
  if (!agency.onboardedAt) throw new AppError('AGENCY_NOT_ONBOARDED');
  if (agency.version !== input.version) throw new AppError('VERSION_CONFLICT', { currentVersion: agency.version });
  const latest = await repo.getLatestRequest(ctx.tx, agency.id);
  if (latest?.status === 'SUBMITTED') throw new AppError('VERIFICATION_ALREADY_SUBMITTED');

  const requestId = newId();
  try {
    await repo.insertRequest(ctx.tx, {
      id: requestId,
      agencyId: agency.id,
      detailsVersion: agency.version,
      submittedBy: userIdOf(ctx),
      submittedAt: clock.now(),
    });
  } catch (err) {
    // A concurrent submission won the one-open-request index.
    const e = err as { cause?: { code?: string }; code?: string };
    if (e.cause?.code === '23505' || e.code === '23505') {
      throw new AppError('VERIFICATION_ALREADY_SUBMITTED');
    }
    throw err;
  }
  // Throwing rolls the request back too.
  if ((await repo.attachDocuments(ctx.tx, agency.id, requestId)) === 0) {
    throw new AppError('VERIFICATION_DOCUMENTS_REQUIRED');
  }
  await emit(ctx.tx, agenciesEvents.verificationSubmitted({ agencyId: agency.id, requestId }));
  return getAgencyVerification(ctx);
}

// ── Staff ──────────────────────────────────────────────────────────────────────────────────────

/** The queue, oldest submission first (keyset). */
export async function listVerificationQueue(ctx: StaffCtx, q: VerificationQueueQuery): Promise<VerificationQueuePage> {
  assertStaffCan(ctx, 'staff.verification.read');
  const rows = await repo.listQueue(ctx.tx, { status: q.status, limit: q.limit, cursor: decodeCursor(q.cursor) });
  return toPage(
    rows,
    q.limit,
    (r) => ({ at: r.submittedAt, id: r.id }),
    (r) => ({
      id: r.id,
      status: r.status,
      submittedAt: r.submittedAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      agency: { id: r.agencyId, name: r.agencyName, kind: r.agencyKind, taxId: r.taxId },
    }),
  );
}

async function loadRequestDto(tx: Tx, id: string): Promise<VerificationRequestDto> {
  const request = await repo.getRequest(tx, id);
  if (!request) throw new AppError('NOT_FOUND');
  const agency = await repo.getAgency(tx, request.agencyId);
  if (!agency) throw new AppError('NOT_FOUND');
  const documents = await repo.listRequestDocuments(tx, id);
  return {
    id: request.id,
    status: request.status,
    submittedAt: request.submittedAt.toISOString(),
    detailsVersion: request.detailsVersion,
    decidedAt: request.decidedAt?.toISOString() ?? null,
    decisionReason: request.decisionReason,
    reviewerUserId: request.reviewerUserId,
    reviewedVersion: request.reviewedVersion,
    agency: toAgencyDto(agency),
    documents: documents.map(toDocumentDto),
  };
}

/** One request for review: the agency's current details (and `version`) and its documents. */
export async function getVerificationRequest(ctx: StaffCtx, input: { id: string }): Promise<VerificationRequestDto> {
  assertStaffCan(ctx, 'staff.verification.read');
  return loadRequestDto(ctx.tx, input.id);
}

/**
 * A 5-minute download link for one document of a request. Signing is local (no network call); the
 * bucket is private, so this link is the only way to read the file.
 */
export async function getVerificationDocumentUrl(
  ctx: StaffCtx,
  input: { id: string; documentId: string },
): Promise<SignedUrlDto> {
  assertStaffCan(ctx, 'staff.verification.read');
  const doc = await repo.getRequestDocument(ctx.tx, input.id, input.documentId);
  if (!doc) throw new AppError('NOT_FOUND');
  const url = await storage().signedGetUrl('private', doc.storageKey, {
    expiresInSeconds: DOCUMENT_URL_TTL_SECONDS,
    downloadName: doc.fileName,
  });
  return { url, expiresAt: new Date(clock.now().getTime() + DOCUMENT_URL_TTL_SECONDS * 1_000).toISOString() };
}

/**
 * Approves or rejects an open request. Bound to `agencyVersion`, the details staff reviewed: if the
 * agency edited them since, the decision is refused (`VERIFICATION_STALE`) and staff review again.
 * The request row records reviewer, reason, reviewed version and time, and cannot change afterwards.
 * Approval sets the agency VERIFIED in the same transaction.
 */
export async function decideVerification(
  ctx: StaffCtx,
  input: DecideVerificationBody & { id: string },
): Promise<VerificationRequestDto> {
  assertStaffCan(ctx, 'staff.verification.decide');
  const request = await repo.getRequest(ctx.tx, input.id, { forUpdate: true });
  if (!request) throw new AppError('NOT_FOUND');
  if (request.status !== 'SUBMITTED') throw new AppError('VERIFICATION_NOT_OPEN', { status: request.status });
  const agency = await repo.getAgency(ctx.tx, request.agencyId);
  if (!agency) throw new AppError('NOT_FOUND');
  if (agency.status !== 'PENDING') throw new AppError('VERIFICATION_NOT_OPEN', { agencyStatus: agency.status });
  if (agency.version !== input.agencyVersion) {
    throw new AppError('VERIFICATION_STALE', { reviewedVersion: input.agencyVersion, currentVersion: agency.version });
  }

  const now = clock.now();
  const approve = input.decision === 'APPROVE';
  // The decision first: the agencies guard (migration 0012) accepts VERIFIED only after an APPROVED
  // decision for this version was written in the same transaction.
  const decided = await repo.decideRequest(ctx.tx, request.id, {
    status: approve ? 'APPROVED' : 'REJECTED',
    reviewerUserId: ctx.actor.userId,
    reviewedVersion: input.agencyVersion,
    reason: input.reason,
    now,
  });
  if (!decided) throw new AppError('VERIFICATION_NOT_OPEN');
  if (approve) {
    const changed = await repo.changeStatus(ctx.tx, agency.id, {
      from: 'PENDING',
      to: 'VERIFIED',
      version: input.agencyVersion,
      now,
    });
    // The agency saved new details between our read and this update; throwing undoes the decision too.
    if (!changed) throw new AppError('VERIFICATION_STALE', { reviewedVersion: input.agencyVersion });
    await emit(
      ctx.tx,
      agenciesEvents.statusChanged({ agencyId: agency.id, from: 'PENDING', to: 'VERIFIED', version: changed.version }),
      { agencyId: agency.id },
    );
  }
  await emit(
    ctx.tx,
    agenciesEvents.verificationDecided({
      agencyId: agency.id,
      requestId: request.id,
      decision: approve ? 'APPROVED' : 'REJECTED',
    }),
    { agencyId: agency.id },
  );
  // The request row keeps reviewer, reason and version; the audit log records the decision with the
  // request id (S1-08). The staff reason text stays on the request (no free text in audit metadata).
  await compliance.auditStaff(
    ctx,
    agency.id,
    'agencies.verification.decided',
    { type: 'verificationRequest', id: request.id },
    { decision: approve ? 'APPROVED' : 'REJECTED', reviewedVersion: input.agencyVersion },
  );
  return loadRequestDto(ctx.tx, request.id);
}

/** For the decision email job (`withSystem`; no `ctx`): what was decided, why, and the agency's name. */
export async function getVerificationDecision(tx: Tx, requestId: string) {
  return repo.getDecision(tx, requestId);
}
