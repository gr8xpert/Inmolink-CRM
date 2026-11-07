import {
  AdvanceDealBody,
  ConfirmDealBody,
  CreateContactHeaders,
  CreateDealBody,
  CreateRegistrationBody,
  CreateTaskBody,
  CreateViewingRequestBody,
  DEAL_DOCUMENT_MAX_BYTES,
  DealDisputeDto,
  DealDisputeList,
  DealDisputeParams,
  DealDocumentDto,
  DealDocumentList,
  DealDocumentParams,
  DealDocumentUrlDto,
  DealDto,
  DealPage,
  DealParams,
  FallThroughDealBody,
  ListDealsQuery,
  ListRegistrationsQuery,
  ListViewingRequestsQuery,
  MediateDealBody,
  OpenDealDisputeBody,
  ReceivedRegistrationPage,
  RegistrationDto,
  RegistrationPage,
  RescheduleViewingBody,
  ResolveDealDisputeBody,
  SetDealPriceBody,
  StaffDealDisputeDto,
  StaffDealDisputeList,
  StaffDealDisputePage,
  StaffDealDisputesQuery,
  StaffDealDto,
  TaskDto,
  UploadDealDocumentHeaders,
  UploadDealDocumentQuery,
  ViewingOutcomeBody,
  ViewingRequestDto,
  ViewingRequestPage,
  ViewingRequestParams,
  ViewingTermsDocumentDto,
} from '@inmolink/contracts';
import * as mls from '@inmolink/core/modules/mls';
import { AppError } from '@inmolink/platform/errors';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';
import { takeUploadSlot } from '../media/routes';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'mls.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'mls.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'mls.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'mls.write.user', scope: 'user', limit: 60, windowSeconds: 60 },
  { name: 'mls.write.tenant', scope: 'tenant', limit: 1_000, windowSeconds: 3_600 },
];

const STAFF_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.mls.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'staff.mls.user', scope: 'user', limit: 300, windowSeconds: 60 },
];

const tags = ['mls'];

/**
 * MLS collaboration (PLAN §7 M10). S11-01, client registration: register a contact for another agency's listing or
 * development, the agency's registrations, and the ones other agencies made for its targets (never the client).
 * S11-02, viewing requests: request a viewing for a registered client with the target's terms as a snapshot, answer it
 * (accept and with it the terms, decline, another time), cancel, record the outcome; the accepted terms.
 * R2-04a, the deal room: open a deal of an accepted viewing, move it forward, set its price, the completion handshake,
 * fall-through; staff read and mediate a deal.
 * Registrations name clients and viewing terms carry commission: every answer is `no-store`.
 */
export async function mlsRoutes(app: FastifyZod): Promise<void> {
  app.post(
    '/v1/mls/registrations',
    {
      schema: {
        tags,
        operationId: 'mls.registerClient',
        summary:
          'Register a contact for another agency’s listing or development (201); first valid registration wins. The agency’s own valid registration of the client answers as is (200)',
        body: CreateRegistrationBody,
        response: { 200: RegistrationDto, 201: RegistrationDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const result = await mls.registerClient((fn) => app.withCtx(req, fn), req.body);
      return reply.code(result.outcome === 'CREATED' ? 201 : 200).send(result.registration);
    },
  );

  app.get(
    '/v1/mls/registrations',
    {
      schema: {
        tags,
        operationId: 'mls.listRegistrations',
        summary: 'The agency’s client registrations with their clients, newest first',
        querystring: ListRegistrationsQuery,
        response: { 200: RegistrationPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.listRegistrations(ctx, req.query)),
  );

  app.get(
    '/v1/mls/received-registrations',
    {
      schema: {
        tags,
        operationId: 'mls.listReceivedRegistrations',
        summary:
          'Clients other agencies registered for the agency’s listings and developments: who and until when, never the client',
        querystring: ListRegistrationsQuery,
        response: { 200: ReceivedRegistrationPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.listReceivedRegistrations(ctx, req.query)),
  );

  app.post(
    '/v1/mls/viewing-requests',
    {
      schema: {
        tags,
        operationId: 'mls.requestViewing',
        summary:
          'Ask the owner for a viewing of a registered client, with the target’s commission terms as the snapshot (201). With an Idempotency-Key, a retry within 24 h answers the first request (200)',
        headers: CreateContactHeaders,
        body: CreateViewingRequestBody,
        response: { 200: ViewingRequestDto, 201: ViewingRequestDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        mls.requestViewing(ctx, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.request);
    },
  );

  app.get(
    '/v1/mls/viewing-requests',
    {
      schema: {
        tags,
        operationId: 'mls.listViewingRequests',
        summary: 'The agency’s viewing requests as introducer, newest first',
        querystring: ListViewingRequestsQuery,
        response: { 200: ViewingRequestPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.listViewingRequests(ctx, req.query)),
  );

  app.get(
    '/v1/mls/received-viewing-requests',
    {
      schema: {
        tags,
        operationId: 'mls.listReceivedViewingRequests',
        summary: 'Viewing requests other agencies made for the agency’s listings and developments — never the client',
        querystring: ListViewingRequestsQuery,
        response: { 200: ViewingRequestPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.listReceivedViewingRequests(ctx, req.query)),
  );

  app.get(
    '/v1/mls/viewing-requests/:id',
    {
      schema: {
        tags,
        operationId: 'mls.getViewingRequest',
        summary: 'A viewing request as the caller’s side holds it',
        params: ViewingRequestParams,
        response: { 200: ViewingRequestDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.getViewingRequest(ctx, req.params.id)),
  );

  app.get(
    '/v1/mls/viewing-requests/:id/terms',
    {
      schema: {
        tags,
        operationId: 'mls.getViewingTerms',
        summary: 'The terms snapshot and who accepted it when (the PDF link stays null until the PDF service exists)',
        params: ViewingRequestParams,
        response: { 200: ViewingTermsDocumentDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    // S12-05: the PDF link is checked after the transaction.
    (req) => mls.viewingTerms((fn) => app.withCtx(req, fn), req.params.id),
  );

  app.post(
    '/v1/mls/viewing-requests/:id/accept',
    {
      schema: {
        tags,
        operationId: 'mls.acceptViewing',
        summary:
          'The side awaited accepts the proposed time; the owner accepting also accepts the terms (then immutable)',
        params: ViewingRequestParams,
        response: { 200: ViewingRequestDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.acceptViewing(ctx, req.params.id)),
  );

  app.post(
    '/v1/mls/viewing-requests/:id/decline',
    {
      schema: {
        tags,
        operationId: 'mls.declineViewing',
        summary: 'The side awaited declines the proposed time',
        params: ViewingRequestParams,
        response: { 200: ViewingRequestDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.declineViewing(ctx, req.params.id)),
  );

  app.post(
    '/v1/mls/viewing-requests/:id/reschedule',
    {
      schema: {
        tags,
        operationId: 'mls.rescheduleViewing',
        summary: 'Propose another time; the other side must answer it',
        params: ViewingRequestParams,
        body: RescheduleViewingBody,
        response: { 200: ViewingRequestDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.rescheduleViewing(ctx, req.params.id, req.body)),
  );

  app.post(
    '/v1/mls/viewing-requests/:id/cancel',
    {
      schema: {
        tags,
        operationId: 'mls.cancelViewing',
        summary: 'Call off a requested or scheduled viewing',
        params: ViewingRequestParams,
        response: { 200: ViewingRequestDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.cancelViewing(ctx, req.params.id)),
  );

  app.post(
    '/v1/mls/viewing-requests/:id/outcome',
    {
      schema: {
        tags,
        operationId: 'mls.recordViewingOutcome',
        summary: 'After the scheduled time, record whether the client attended',
        params: ViewingRequestParams,
        body: ViewingOutcomeBody,
        response: { 200: ViewingRequestDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.recordViewingOutcome(ctx, req.params.id, req.body)),
  );

  // ── R2-04a, the deal room ──────────────────────────────────────────────────────────────────────

  app.post(
    '/v1/mls/deals',
    {
      schema: {
        tags,
        operationId: 'mls.openDeal',
        summary:
          'Open the deal of an accepted viewing request at the offered price (201), with its terms snapshot; the live deal of the viewing answers a repeat (200)',
        body: CreateDealBody,
        response: { 200: DealDto, 201: DealDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const result = await app.withCtx(req, (ctx) => mls.openDeal(ctx, req.body));
      return reply.code(result.created ? 201 : 200).send(result.deal);
    },
  );

  app.get(
    '/v1/mls/deals',
    {
      schema: {
        tags,
        operationId: 'mls.listDeals',
        summary: 'The agency’s deals (as owner and as introducer) with their commission, newest first',
        querystring: ListDealsQuery,
        response: { 200: DealPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.listDeals(ctx, req.query)),
  );

  app.get(
    '/v1/mls/deals/:id',
    {
      schema: {
        tags,
        operationId: 'mls.getDeal',
        summary: 'A deal as the caller’s side holds it',
        params: DealParams,
        response: { 200: DealDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.getDeal(ctx, req.params.id)),
  );

  app.post(
    '/v1/mls/deals/:id/advance',
    {
      schema: {
        tags,
        operationId: 'mls.advanceDeal',
        summary: 'Move an open deal forward to reservation or arras (never back)',
        params: DealParams,
        body: AdvanceDealBody,
        response: { 200: DealDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.advanceDeal(ctx, req.params.id, req.body)),
  );

  app.post(
    '/v1/mls/deals/:id/price',
    {
      schema: {
        tags,
        operationId: 'mls.setDealPrice',
        summary: 'Set the agreed price of an open deal; both sides’ completion confirmations are cleared',
        params: DealParams,
        body: SetDealPriceBody,
        response: { 200: DealDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.setDealPrice(ctx, req.params.id, req.body)),
  );

  app.post(
    '/v1/mls/deals/:id/confirm',
    {
      schema: {
        tags,
        operationId: 'mls.confirmDeal',
        summary:
          'Confirm the completion at the price seen (the handshake); the second side’s confirmation completes it',
        params: DealParams,
        body: ConfirmDealBody,
        response: { 200: DealDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.confirmDeal(ctx, req.params.id, req.body)),
  );

  app.post(
    '/v1/mls/deals/:id/withdraw',
    {
      schema: {
        tags,
        operationId: 'mls.withdrawDealConfirmation',
        summary: 'Take the caller’s side’s completion confirmation back (before the deal completes)',
        params: DealParams,
        response: { 200: DealDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.withdrawDealConfirmation(ctx, req.params.id)),
  );

  app.post(
    '/v1/mls/deals/:id/fall-through',
    {
      schema: {
        tags,
        operationId: 'mls.fallThroughDeal',
        summary: 'Close an open deal as fallen through, with a reason',
        params: DealParams,
        body: FallThroughDealBody,
        response: { 200: DealDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.fallThroughDeal(ctx, req.params.id, req.body)),
  );

  // ── R2-04b, the deal room: documents and tasks (the thread: `POST /v1/chat/deal-threads`) ─────────

  app.get(
    '/v1/mls/deals/:id/documents',
    {
      schema: {
        tags,
        operationId: 'mls.listDealDocuments',
        summary: 'A deal’s documents (both parties’ uploads; removed ones listed as removed), oldest first',
        params: DealParams,
        response: { 200: DealDocumentList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.listDealDocuments(ctx, req.params.id)),
  );

  app.get(
    '/v1/mls/deals/:id/documents/:documentId/url',
    {
      schema: {
        tags,
        operationId: 'mls.openDealDocument',
        summary: 'A short signed download URL (5 min) of a deal document; audited',
        params: DealDocumentParams,
        response: { 200: DealDocumentUrlDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) =>
      app.withCtx(req, (ctx) =>
        mls.openDealDocument(ctx, { dealId: req.params.id, documentId: req.params.documentId }),
      ),
  );

  app.delete(
    '/v1/mls/deals/:id/documents/:documentId',
    {
      schema: {
        tags,
        operationId: 'mls.removeDealDocument',
        summary: 'Remove a document the caller’s agency uploaded to an open deal (it stays listed as removed)',
        response: { 204: z.null() },
        params: DealDocumentParams,
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withCtx(req, (ctx) =>
        mls.removeDealDocument(ctx, { dealId: req.params.id, documentId: req.params.documentId }),
      );
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/mls/deals/:id/tasks',
    {
      schema: {
        tags,
        operationId: 'mls.createDealTask',
        summary:
          'Create the agency’s own task about a deal (201; private to the agency) — listed by GET /v1/crm/tasks?dealId=. With an Idempotency-Key, a retry within 24 h answers the first task (200)',
        params: DealParams,
        headers: CreateContactHeaders,
        body: CreateTaskBody,
        response: { 201: TaskDto, 200: TaskDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        mls.createDealTask(ctx, req.params.id, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.task);
    },
  );

  await app.register(dealDocumentUploadRoute);

  // ── R2-04c, disputes: a party asks staff to mediate ──────────────────────────────────────────────

  app.post(
    '/v1/mls/deals/:id/disputes',
    {
      schema: {
        tags,
        operationId: 'mls.openDealDispute',
        summary:
          'Raise a dispute of a deal for staff mediation, with a reason (201); also on a closed deal. One open dispute per agency and deal; the other party is told one was raised, never its text',
        params: DealParams,
        body: OpenDealDisputeBody,
        response: { 201: DealDisputeDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const dispute = await app.withCtx(req, (ctx) => mls.openDealDispute(ctx, req.params.id, req.body));
      return reply.code(201).send(dispute);
    },
  );

  app.get(
    '/v1/mls/deals/:id/disputes',
    {
      schema: {
        tags,
        operationId: 'mls.listDealDisputes',
        summary: 'The caller’s agency’s disputes of a deal, newest first, with staff’s notes',
        params: DealParams,
        response: { 200: DealDisputeList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => mls.listDealDisputes(ctx, req.params.id)),
  );

  // ── Staff: mediation ───────────────────────────────────────────────────────────────────────────

  app.get(
    '/v1/staff/deals/:id',
    {
      schema: {
        tags: ['staff'],
        operationId: 'mls.getStaffDeal',
        summary: 'A deal with both parties, for mediation',
        params: DealParams,
        response: { 200: StaffDealDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'mls.getStaffDeal', (ctx) => mls.getStaffDeal(ctx, req.params.id)),
  );

  app.post(
    '/v1/staff/deals/:id/mediate',
    {
      schema: {
        tags: ['staff'],
        operationId: 'mls.mediateDeal',
        summary:
          'Mediate a deal (data ops, super admins): set its stage and / or price with a reason both parties see — the only change a closed deal takes; audited',
        params: DealParams,
        body: MediateDealBody,
        response: { 200: StaffDealDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'mls.mediateDeal', (ctx) => mls.mediateDeal(ctx, req.params.id, req.body)),
  );

  app.get(
    '/v1/staff/deal-disputes',
    {
      schema: {
        tags: ['staff'],
        operationId: 'mls.listStaffDealDisputes',
        summary: 'Every agency’s deal disputes of one status, oldest first (the mediation queue)',
        querystring: StaffDealDisputesQuery,
        response: { 200: StaffDealDisputePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'mls.listStaffDealDisputes', (ctx) => mls.listStaffDealDisputes(ctx, req.query)),
  );

  app.get(
    '/v1/staff/deals/:id/disputes',
    {
      schema: {
        tags: ['staff'],
        operationId: 'mls.listStaffDisputesOfDeal',
        summary: 'Both parties’ disputes of a deal, newest first',
        params: DealParams,
        response: { 200: StaffDealDisputeList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'mls.listStaffDisputesOfDeal', (ctx) => mls.listStaffDisputesOfDeal(ctx, req.params.id)),
  );

  app.post(
    '/v1/staff/deal-disputes/:id/resolve',
    {
      schema: {
        tags: ['staff'],
        operationId: 'mls.resolveDealDispute',
        summary:
          'Resolve an open deal dispute with a note the raising agency reads (data ops, super admins); audited. Changing the deal is a mediation',
        params: DealDisputeParams,
        body: ResolveDealDisputeBody,
        response: { 200: StaffDealDisputeDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'mls.resolveDealDispute', (ctx) => mls.resolveDealDispute(ctx, req.params.id, req.body)),
  );
}

/**
 * R2-04b: the deal document upload, in its own plugin: its body is the raw file (only this route accepts binary bodies,
 * up to 20 MB). The declared type only routes the body here; the service checks the real type by magic bytes.
 */
async function dealDocumentUploadRoute(upload: FastifyZod): Promise<void> {
  upload.addContentTypeParser(
    ['application/pdf', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: DEAL_DOCUMENT_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  upload.post(
    '/v1/mls/deals/:id/documents',
    {
      schema: {
        tags,
        operationId: 'mls.uploadDealDocument',
        summary: 'Upload one document to an open deal (raw PDF body, max 20 MB); both parties read it',
        params: DealParams,
        querystring: UploadDealDocumentQuery,
        headers: UploadDealDocumentHeaders,
        response: { 201: DealDocumentDto },
      },
      bodyLimit: DEAL_DOCUMENT_MAX_BYTES,
      onRequest: [upload.requireSession, takeUploadSlot],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      const body = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      const doc = await mls.uploadDealDocument(upload.ctxRunner(req), {
        dealId: req.params.id,
        fileName: req.headers['x-file-name'],
        kind: req.query.kind,
        body,
      });
      return reply.status(201).send(doc);
    },
  );
}
