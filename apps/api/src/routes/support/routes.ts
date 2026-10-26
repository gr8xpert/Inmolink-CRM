import {
  CreateSupportTicketBody,
  PostSupportMessageBody,
  SignedUrlDto,
  StaffPostSupportMessageBody,
  StaffSupportQueuePage,
  StaffSupportQueueQuery,
  StaffSupportTicketDto,
  StaffUpdateSupportTicketBody,
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_TYPES,
  SupportAttachmentDto,
  SupportAttachmentParams,
  SupportTicketDto,
  SupportTicketListQuery,
  SupportTicketPage,
  SupportTicketParams,
  SupportTicketQuery,
  UploadSupportAttachmentQuery,
} from '@inmolink/contracts';
import * as support from '@inmolink/core/modules/support';
import { AppError } from '@inmolink/platform/errors';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'support.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'support.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
/** Opening tickets and replying: generous for a conversation, tight enough that a script cannot flood the inbox. */
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'support.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'support.write.user', scope: 'user', limit: 20, windowSeconds: 60 },
  { name: 'support.write.tenant', scope: 'tenant', limit: 200, windowSeconds: 3_600 },
];
/** 10 MB bodies: a tight per-tenant hourly budget on top of the per-user one. */
const UPLOAD_LIMITS: readonly RateLimitRule[] = [
  { name: 'support.upload.ip', scope: 'ip', limit: 30, windowSeconds: 60 },
  { name: 'support.upload.user', scope: 'user', limit: 20, windowSeconds: 600 },
  { name: 'support.upload.tenant', scope: 'tenant', limit: 50, windowSeconds: 3_600 },
];
const STAFF_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.support.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'staff.support.user', scope: 'user', limit: 300, windowSeconds: 60 },
];

/**
 * Support tickets (S13-05, PLAN §7 M21). Agency side under `/v1/support/tickets` (every member of the caller's
 * agency; never in Client Mode); staff side under `/v1/staff/support/tickets` (`withStaffCtx`: 403 for non-staff).
 * Agency answers never carry internal notes; staff answers do (`internal`).
 */
export async function supportRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/support/tickets',
    {
      schema: {
        tags: ['support'],
        operationId: 'support.listSupportTickets',
        summary: "The agency's support tickets, newest first",
        querystring: SupportTicketListQuery,
        response: { 200: SupportTicketPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => support.listTickets(ctx, req.query)),
  );

  app.post(
    '/v1/support/tickets',
    {
      schema: {
        tags: ['support'],
        operationId: 'support.createSupportTicket',
        summary: 'Open a support ticket (subject, category, priority and the first message)',
        body: CreateSupportTicketBody,
        response: { 201: SupportTicketDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => reply.status(201).send(await app.withCtx(req, (ctx) => support.createTicket(ctx, req.body))),
  );

  app.get(
    '/v1/support/tickets/:id',
    {
      schema: {
        tags: ['support'],
        operationId: 'support.getSupportTicket',
        summary: 'One ticket with the latest page of its conversation (or the page `before`) and its attachments',
        params: SupportTicketParams,
        querystring: SupportTicketQuery,
        response: { 200: SupportTicketDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => support.getTicket(ctx, { ...req.params, ...req.query })),
  );

  app.post(
    '/v1/support/tickets/:id/messages',
    {
      schema: {
        tags: ['support'],
        operationId: 'support.postSupportMessage',
        summary: 'Reply on a ticket (reopens a resolved one)',
        params: SupportTicketParams,
        body: PostSupportMessageBody,
        response: { 200: SupportTicketDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => support.postMessage(ctx, { id: req.params.id, ...req.body })),
  );

  app.post(
    '/v1/support/tickets/:id/resolve',
    {
      schema: {
        tags: ['support'],
        operationId: 'support.resolveSupportTicket',
        summary: 'Mark a ticket resolved',
        params: SupportTicketParams,
        response: { 200: SupportTicketDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => support.resolveTicket(ctx, req.params)),
  );

  await app.register(uploadRoute);

  app.get(
    '/v1/support/tickets/:id/attachments/:attachmentId/url',
    {
      schema: {
        tags: ['support'],
        operationId: 'support.getSupportAttachmentUrl',
        summary: 'A 5-minute download link for one attachment',
        params: SupportAttachmentParams,
        response: { 200: SignedUrlDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, _reply) => {
      // The link is a bearer credential for the file: never cached on the way.
      return app.withCtx(req, (ctx) => support.getAttachmentUrl(ctx, req.params));
    },
  );

  // ── Staff ────────────────────────────────────────────────────────────────────────────────────

  app.get(
    '/v1/staff/support/tickets',
    {
      schema: {
        tags: ['staff'],
        operationId: 'support.listStaffSupportQueue',
        summary: 'Support tickets of every agency by status, oldest first',
        querystring: StaffSupportQueueQuery,
        response: { 200: StaffSupportQueuePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'support.listQueue', (ctx) => support.listQueue(ctx, req.query)),
  );

  app.get(
    '/v1/staff/support/tickets/:id',
    {
      schema: {
        tags: ['staff'],
        operationId: 'support.getStaffSupportTicket',
        summary: 'One ticket with a page of its conversation and internal notes, and its attachments',
        params: SupportTicketParams,
        querystring: SupportTicketQuery,
        response: { 200: StaffSupportTicketDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'support.getStaffTicket', (ctx) =>
        support.getStaffTicket(ctx, { ...req.params, ...req.query }),
      ),
  );

  app.post(
    '/v1/staff/support/tickets/:id/messages',
    {
      schema: {
        tags: ['staff'],
        operationId: 'support.postStaffSupportMessage',
        summary: 'Reply to the agency, or add an internal note (`internal`)',
        params: SupportTicketParams,
        body: StaffPostSupportMessageBody,
        response: { 200: StaffSupportTicketDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'support.postStaffMessage', (ctx) =>
        support.postStaffMessage(ctx, { id: req.params.id, ...req.body }),
      ),
  );

  app.patch(
    '/v1/staff/support/tickets/:id',
    {
      schema: {
        tags: ['staff'],
        operationId: 'support.updateStaffSupportTicket',
        summary: 'Triage a ticket: status, priority, take or release it',
        params: SupportTicketParams,
        body: StaffUpdateSupportTicketBody,
        response: { 200: StaffSupportTicketDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'support.updateStaffTicket', (ctx) =>
        support.updateStaffTicket(ctx, { id: req.params.id, ...req.body }),
      ),
  );

  app.get(
    '/v1/staff/support/tickets/:id/attachments/:attachmentId/url',
    {
      schema: {
        tags: ['staff'],
        operationId: 'support.getStaffSupportAttachmentUrl',
        summary: 'A 5-minute download link for one attachment',
        params: SupportAttachmentParams,
        response: { 200: SignedUrlDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    async (req, _reply) => {
      return app.withStaffCtx(req, 'support.getStaffAttachmentUrl', (ctx) =>
        support.getStaffAttachmentUrl(ctx, req.params),
      );
    },
  );
}

/**
 * The upload, in its own plugin: its body is the raw file, and only this route accepts binary bodies (up to 10 MB).
 * The declared type only routes the body here; the service checks the real type by magic bytes.
 */
async function uploadRoute(upload: FastifyZod): Promise<void> {
  upload.addContentTypeParser(
    [...SUPPORT_ATTACHMENT_TYPES, 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: SUPPORT_ATTACHMENT_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  upload.post(
    '/v1/support/tickets/:id/attachments',
    {
      schema: {
        tags: ['support'],
        operationId: 'support.uploadSupportAttachment',
        summary: 'Attach one file to a ticket (raw PDF/PNG/JPEG/WebP body, max 10 MB, 5 per ticket)',
        params: SupportTicketParams,
        querystring: UploadSupportAttachmentQuery,
        response: { 201: SupportAttachmentDto },
      },
      bodyLimit: SUPPORT_ATTACHMENT_MAX_BYTES,
      onRequest: [upload.requireSession],
      config: { rateLimit: UPLOAD_LIMITS },
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      const body = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      const file = await support.uploadAttachment(upload.ctxRunner(req), {
        id: req.params.id,
        ...req.query,
        body,
      });
      return reply.status(201).send(file);
    },
  );
}
