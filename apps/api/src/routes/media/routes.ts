import {
  AddListingVideoBody,
  LISTING_DOCUMENT_MAX_BYTES,
  ListingDocumentDto,
  ListingDocumentList,
  ListingDocumentParams,
  ListingDocumentUrlDto,
  ListingMediaList,
  ListingMediaParams,
  ListingParams,
  MediaCheckBody,
  MediaCheckResult,
  RegisterMediaBody,
  ReorderListingMediaBody,
  UpdateListingMediaBody,
  UploadListingDocumentQuery,
} from '@inmolink/contracts';
import * as media from '@inmolink/core/modules/media';
import { AppError } from '@inmolink/platform/errors';
import {
  createUploadSlots,
  LISTING_DOCUMENT_UPLOAD_SLOTS,
  LISTING_DOCUMENT_UPLOAD_TOTAL,
  type RateLimitRule,
} from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'media.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'media.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
/** A check or register call carries up to 100 files, so a 1,000-photo import fits in 20 calls. */
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'media.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'media.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
  { name: 'media.write.tenant', scope: 'tenant', limit: 1_200, windowSeconds: 60 },
];

/**
 * Listing media (S3-03): content-addressed uploads. The browser hashes files, `check` answers which are stored
 * already (zero bytes to send) and signs PUT URLs for the rest — the file goes straight to object storage, never
 * through the API — then `register` verifies the uploads and attaches them to a listing.
 */
export async function mediaRoutes(app: FastifyZod): Promise<void> {
  app.post(
    '/v1/media/check',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.checkUploads',
        summary:
          "Which of a listing's files (by SHA-256) the agency stores already; signed upload URLs for the others (≤ 100)",
        body: MediaCheckBody,
        response: { 200: MediaCheckResult },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return media.checkUploads(app.ctxRunner(req), req.body);
    },
  );

  app.post(
    '/v1/media/register',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.registerUploads',
        summary: "Verify uploaded files and attach them to a listing in order; answers the listing's media",
        body: RegisterMediaBody,
        response: { 200: ListingMediaList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return media.registerUploads(app.ctxRunner(req), req.body);
    },
  );

  app.get(
    '/v1/listings/:id/media',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.listListingMedia',
        summary: "A listing's media in order (other agencies never see its documents)",
        params: ListingParams,
        response: { 200: ListingMediaList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => media.listListingMedia(ctx, req.params.id));
    },
  );

  app.delete(
    '/v1/listings/:id/media/:mediaId',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.detachListingMedia',
        summary: 'Remove a file from a listing; an object nothing uses any more is deleted after 7 days',
        params: ListingMediaParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await app.withCtx(req, (ctx) =>
        media.detachListingMedia(ctx, { listingId: req.params.id, mediaId: req.params.mediaId }),
      );
      return reply.code(204).send(null);
    },
  );

  app.patch(
    '/v1/listings/:id/media/:mediaId',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.updateListingMedia',
        summary: "Change one file's kind, cover, alt text or room type; answers the listing's media",
        params: ListingMediaParams,
        body: UpdateListingMediaBody,
        response: { 200: ListingMediaList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) =>
        media.updateListingMedia(ctx, { listingId: req.params.id, mediaId: req.params.mediaId, patch: req.body }),
      );
    },
  );

  app.put(
    '/v1/listings/:id/media/order',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.reorderListingMedia',
        summary: "Put the listing's media in this order (every id once); answers the listing's media",
        params: ListingParams,
        body: ReorderListingMediaBody,
        response: { 200: ListingMediaList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => media.reorderListingMedia(ctx, { listingId: req.params.id, ids: req.body.ids }));
    },
  );

  app.post(
    '/v1/listings/:id/videos',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.addListingVideo',
        summary: "Add a YouTube, Vimeo or Matterport link to the listing's media (last); answers the listing's media",
        params: ListingParams,
        body: AddListingVideoBody,
        response: { 201: ListingMediaList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const list = await app.withCtx(req, (ctx) =>
        media.addListingVideo(ctx, { listingId: req.params.id, url: req.body.url }),
      );
      return reply.status(201).header('cache-control', 'no-store').send(list);
    },
  );

  app.get(
    '/v1/listings/:id/documents',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.listListingDocuments',
        summary: "The own listing's documents (private to the agency)",
        params: ListingParams,
        response: { 200: ListingDocumentList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => media.listListingDocuments(ctx, req.params.id));
    },
  );

  app.get(
    '/v1/listings/:id/documents/:documentId/url',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.openListingDocument',
        summary: 'A short signed download URL of one of the own listing documents',
        params: ListingDocumentParams,
        response: { 200: ListingDocumentUrlDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) =>
        media.openListingDocument(ctx, { listingId: req.params.id, documentId: req.params.documentId }),
      );
    },
  );

  app.delete(
    '/v1/listings/:id/documents/:documentId',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.deleteListingDocument',
        summary: 'Remove a listing document',
        params: ListingDocumentParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await media.deleteListingDocument(app.ctxRunner(req), {
        listingId: req.params.id,
        documentId: req.params.documentId,
      });
      return reply.status(204).send(null);
    },
  );

  await app.register(documentUploadRoute);
}

/**
 * Buffered document bodies per user and per process (S3 review): the web relay caps its own process, this caps
 * the API for callers that send bodies to it directly. Development documents (S4-F4) take the same slots. Taken in `onRequest` (after the session, before the body
 * is read) and released when the response is done or the connection closes.
 */
export const listingDocumentUploads = createUploadSlots(LISTING_DOCUMENT_UPLOAD_SLOTS, LISTING_DOCUMENT_UPLOAD_TOTAL);

export async function takeUploadSlot(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) throw new AppError('NOT_AUTHENTICATED');
  const release = listingDocumentUploads.take(req.auth.userId);
  if (!release) throw new AppError('RATE_LIMITED');
  reply.raw.once('close', release);
  reply.raw.once('finish', release);
}

/**
 * The document upload, in its own plugin: its body is the raw file (only this route accepts binary bodies, up to
 * 20 MB). The declared type only routes the body here; the service checks the real type by magic bytes.
 */
async function documentUploadRoute(upload: FastifyZod): Promise<void> {
  upload.addContentTypeParser(
    ['application/pdf', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: LISTING_DOCUMENT_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  upload.post(
    '/v1/listings/:id/documents',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.uploadListingDocument',
        summary: 'Upload one listing document (raw PDF body, max 20 MB)',
        params: ListingParams,
        querystring: UploadListingDocumentQuery,
        response: { 201: ListingDocumentDto },
      },
      bodyLimit: LISTING_DOCUMENT_MAX_BYTES,
      onRequest: [upload.requireSession, takeUploadSlot],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      const body = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      const doc = await media.uploadListingDocument(upload.ctxRunner(req), {
        listingId: req.params.id,
        fileName: req.query.fileName,
        body,
      });
      return reply.status(201).send(doc);
    },
  );
}
