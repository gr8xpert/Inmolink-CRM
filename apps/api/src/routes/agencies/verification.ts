import {
  AgencyVerificationDto,
  DecideVerificationBody,
  DocumentParams,
  SignedUrlDto,
  SubmitVerificationBody,
  UploadVerificationDocumentQuery,
  VERIFICATION_DOCUMENT_MAX_BYTES,
  VERIFICATION_DOCUMENT_TYPES,
  VerificationDocumentDto,
  VerificationDocumentParams,
  VerificationQueuePage,
  VerificationQueueQuery,
  VerificationRequestDto,
  VerificationRequestParams,
} from '@inmolink/contracts';
import * as agencies from '@inmolink/core/modules/agencies';
import { AppError } from '@inmolink/platform/errors';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'verification.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'verification.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'verification.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'verification.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
];
/** 10 MB bodies: a tight per-tenant hourly budget on top of the per-user one. */
const UPLOAD_LIMITS: readonly RateLimitRule[] = [
  { name: 'verification.upload.ip', scope: 'ip', limit: 30, windowSeconds: 60 },
  { name: 'verification.upload.user', scope: 'user', limit: 20, windowSeconds: 600 },
  { name: 'verification.upload.tenant', scope: 'tenant', limit: 50, windowSeconds: 3_600 },
];
const STAFF_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.verification.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'staff.verification.user', scope: 'user', limit: 300, windowSeconds: 60 },
];

const NoContent = z.null();

/**
 * Agency verification (S1-03). Agency side under `/v1/agency/verification` (admins of the caller's
 * agency); staff side under `/v1/staff/verification-requests` (`withStaffCtx`: 403 for non-staff).
 */
export async function verificationRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/agency/verification',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.getAgencyVerification',
        summary: "The agency's verification status, documents and latest request",
        response: { 200: AgencyVerificationDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => agencies.getAgencyVerification(ctx)),
  );

  await app.register(uploadRoute);

  app.delete(
    '/v1/agency/verification/documents/:id',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.deleteVerificationDocument',
        summary: 'Remove a document that was not submitted yet',
        params: DocumentParams,
        response: { 204: NoContent },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await agencies.deleteVerificationDocument(app.ctxRunner(req), req.params);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/agency/verification',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.submitVerification',
        summary: 'Send the company details (at `version`) and uploaded documents to staff',
        body: SubmitVerificationBody,
        response: { 200: AgencyVerificationDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => agencies.submitVerification(ctx, req.body)),
  );

  // ── Staff ────────────────────────────────────────────────────────────────────────────────────

  app.get(
    '/v1/staff/verification-requests',
    {
      schema: {
        tags: ['staff'],
        operationId: 'agencies.listVerificationQueue',
        summary: 'Verification requests by status, oldest first',
        querystring: VerificationQueueQuery,
        response: { 200: VerificationQueuePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'agencies.listVerificationQueue', (ctx) => agencies.listVerificationQueue(ctx, req.query)),
  );

  app.get(
    '/v1/staff/verification-requests/:id',
    {
      schema: {
        tags: ['staff'],
        operationId: 'agencies.getVerificationRequest',
        summary: "One request with the agency's current details and its documents",
        params: VerificationRequestParams,
        response: { 200: VerificationRequestDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'agencies.getVerificationRequest', (ctx) =>
        agencies.getVerificationRequest(ctx, req.params),
      ),
  );

  app.get(
    '/v1/staff/verification-requests/:id/documents/:documentId/url',
    {
      schema: {
        tags: ['staff'],
        operationId: 'agencies.getVerificationDocumentUrl',
        summary: 'A 5-minute download link for one document',
        params: VerificationDocumentParams,
        response: { 200: SignedUrlDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    async (req, reply) => {
      // The link is a bearer credential for the file: never cached on the way.
      reply.header('cache-control', 'no-store');
      return app.withStaffCtx(req, 'agencies.getVerificationDocumentUrl', (ctx) =>
        agencies.getVerificationDocumentUrl(ctx, req.params),
      );
    },
  );

  app.post(
    '/v1/staff/verification-requests/:id/decision',
    {
      schema: {
        tags: ['staff'],
        operationId: 'agencies.decideVerification',
        summary: 'Approve or reject, with a reason, the details version reviewed',
        params: VerificationRequestParams,
        body: DecideVerificationBody,
        response: { 200: VerificationRequestDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'agencies.decideVerification', (ctx) =>
        agencies.decideVerification(ctx, { id: req.params.id, ...req.body }),
      ),
  );
}

/**
 * The upload, in its own plugin: its body is the raw file, and only this route accepts binary bodies
 * (up to 10 MB). The declared type only routes the body here; the service checks the real type by
 * magic bytes.
 */
async function uploadRoute(upload: FastifyZod): Promise<void> {
  upload.addContentTypeParser(
    [...VERIFICATION_DOCUMENT_TYPES, 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: VERIFICATION_DOCUMENT_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  upload.post(
    '/v1/agency/verification/documents',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.uploadVerificationDocument',
        summary: 'Upload one verification document (raw PDF/PNG/JPEG/WebP body, max 10 MB)',
        querystring: UploadVerificationDocumentQuery,
        response: { 201: VerificationDocumentDto },
      },
      bodyLimit: VERIFICATION_DOCUMENT_MAX_BYTES,
      onRequest: [upload.requireSession],
      config: { rateLimit: UPLOAD_LIMITS },
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      const body = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      const doc = await agencies.uploadVerificationDocument(upload.ctxRunner(req), { ...req.query, body });
      return reply.status(201).send(doc);
    },
  );
}
