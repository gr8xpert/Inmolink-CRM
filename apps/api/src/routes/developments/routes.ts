import {
  BulkUpdateUnitsBody,
  CreateDevelopmentBody,
  CreatePriceListBody,
  CreateUnitsBody,
  DEVELOPMENT_DOCUMENT_MAX_BYTES,
  DevelopmentDocumentDto,
  DevelopmentDocumentList,
  DevelopmentDocumentParams,
  DevelopmentDocumentUrlDto,
  DevelopmentDto,
  DevelopmentPage,
  DevelopmentParams,
  DevelopmentVersionQuery,
  ListDevelopmentsQuery,
  ListUnitsQuery,
  PageQuery,
  PriceListDto,
  PriceListPage,
  PriceListParams,
  SetDevelopmentAccessBody,
  UnitDto,
  UnitList,
  UnitPage,
  UnitParams,
  UpdateDevelopmentBody,
  UpdateDevelopmentDocumentBody,
  UpdateUnitBody,
  UploadDevelopmentDocumentQuery,
} from '@inmolink/contracts';
import * as developments from '@inmolink/core/modules/developments';
import { AppError } from '@inmolink/platform/errors';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';
import { takeUploadSlot } from '../media/routes';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'developments.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'developments.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'developments.write.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'developments.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
  { name: 'developments.write.tenant', scope: 'tenant', limit: 1_200, windowSeconds: 60 },
];

/**
 * New developments (S4-02): the agency's own, plus OPEN or PRIVATE_NETWORK ones shared with it (network view).
 * Owner views carry sharing settings and price lists, so no response is cached on the way.
 */
export async function developmentsRoutes(app: FastifyZod): Promise<void> {
  const tags = ['developments'];
  const read = { onRequest: [app.requireSession], config: { rateLimit: READ_LIMITS } };
  const write = { onRequest: [app.requireSession], config: { rateLimit: WRITE_LIMITS } };

  app.post(
    '/v1/developments',
    {
      schema: {
        tags,
        operationId: 'developments.createDevelopment',
        summary: 'Create a development of the agency; PRIVATE_NETWORK and shared with nobody until opened',
        body: CreateDevelopmentBody,
        response: { 201: DevelopmentDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(await app.withCtx(req, (ctx) => developments.createDevelopment(ctx, req.body)));
    },
  );

  app.get(
    '/v1/developments',
    {
      schema: {
        tags,
        operationId: 'developments.listDevelopments',
        summary: "The agency's developments, newest first, cursor ≤ 100",
        querystring: ListDevelopmentsQuery,
        response: { 200: DevelopmentPage },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => developments.listDevelopments(ctx, req.query));
    },
  );

  app.get(
    '/v1/developments/:id',
    {
      schema: {
        tags,
        operationId: 'developments.getDevelopment',
        summary: "A development: the owner view for the agency's own, the network view for a shared one",
        params: DevelopmentParams,
        response: { 200: DevelopmentDto },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => developments.getDevelopment(ctx, req.params.id));
    },
  );

  app.patch(
    '/v1/developments/:id',
    {
      schema: {
        tags,
        operationId: 'developments.updateDevelopment',
        summary: 'Change fields, the commission (admins) or mark units and prices verified; stale version → 409',
        params: DevelopmentParams,
        body: UpdateDevelopmentBody,
        response: { 200: DevelopmentDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => developments.updateDevelopment(ctx, req.params.id, req.body));
    },
  );

  app.put(
    '/v1/developments/:id/access',
    {
      schema: {
        tags,
        operationId: 'developments.setDevelopmentAccess',
        summary: 'OPEN to every verified agency, or PRIVATE_NETWORK with the agencies named (admins)',
        params: DevelopmentParams,
        body: SetDevelopmentAccessBody,
        response: { 200: DevelopmentDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => developments.setDevelopmentAccess(ctx, req.params.id, req.body));
    },
  );

  app.delete(
    '/v1/developments/:id',
    {
      schema: {
        tags,
        operationId: 'developments.deleteDevelopment',
        summary: 'Delete a development (admins): no agency reads it from then on',
        params: DevelopmentParams,
        querystring: DevelopmentVersionQuery,
        response: { 204: z.null() },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await app.withCtx(req, (ctx) => developments.deleteDevelopment(ctx, req.params.id, req.query.version));
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/v1/developments/:id/units',
    {
      schema: {
        tags,
        operationId: 'developments.listUnits',
        summary: 'The unit table by reference, cursor ≤ 100; for the owner and the agencies it is shared with',
        params: DevelopmentParams,
        querystring: ListUnitsQuery,
        response: { 200: UnitPage },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => developments.listUnits(ctx, req.params.id, req.query));
    },
  );

  app.post(
    '/v1/developments/:id/units',
    {
      schema: {
        tags,
        operationId: 'developments.createUnits',
        summary: 'Add one unit or up to 500 (a CSV upload); references unique within the development',
        params: DevelopmentParams,
        body: CreateUnitsBody,
        response: { 201: UnitList },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply
        .code(201)
        .send(await app.withCtx(req, (ctx) => developments.createUnits(ctx, req.params.id, req.body)));
    },
  );

  app.post(
    '/v1/developments/:id/units/bulk',
    {
      schema: {
        tags,
        operationId: 'developments.bulkUpdateUnits',
        summary: 'One change (status, price, phase, commission) on up to 500 units',
        params: DevelopmentParams,
        body: BulkUpdateUnitsBody,
        response: { 200: UnitList },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => developments.bulkUpdateUnits(ctx, req.params.id, req.body));
    },
  );

  app.patch(
    '/v1/developments/:id/units/:unitId',
    {
      schema: {
        tags,
        operationId: 'developments.updateUnit',
        summary: 'Change a unit; status and price changes write history; stale version → 409',
        params: UnitParams,
        body: UpdateUnitBody,
        response: { 200: UnitDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => developments.updateUnit(ctx, req.params.id, req.params.unitId, req.body));
    },
  );

  app.delete(
    '/v1/developments/:id/units/:unitId',
    {
      schema: {
        tags,
        operationId: 'developments.deleteUnit',
        summary: 'Remove a unit and its history',
        params: UnitParams,
        response: { 204: z.null() },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await app.withCtx(req, (ctx) => developments.deleteUnit(ctx, req.params.id, req.params.unitId));
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/v1/developments/:id/price-lists',
    {
      schema: {
        tags,
        operationId: 'developments.listPriceLists',
        summary: "The owner's price list versions, latest first, cursor ≤ 100",
        params: DevelopmentParams,
        querystring: PageQuery,
        response: { 200: PriceListPage },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => developments.listPriceLists(ctx, req.params.id, req.query));
    },
  );

  app.post(
    '/v1/developments/:id/price-lists',
    {
      schema: {
        tags,
        operationId: 'developments.createPriceList',
        summary: 'Upload the next price list version: stored with its diff against the units, applied on approval',
        params: DevelopmentParams,
        body: CreatePriceListBody,
        response: { 201: PriceListDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply
        .code(201)
        .send(await app.withCtx(req, (ctx) => developments.createPriceList(ctx, req.params.id, req.body)));
    },
  );

  app.get(
    '/v1/developments/:id/price-lists/:version',
    {
      schema: {
        tags,
        operationId: 'developments.getPriceList',
        summary: 'One price list version and its diff',
        params: PriceListParams,
        response: { 200: PriceListDto },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => developments.getPriceList(ctx, req.params.id, req.params.version));
    },
  );

  app.post(
    '/v1/developments/:id/price-lists/:version/approve',
    {
      schema: {
        tags,
        operationId: 'developments.approvePriceList',
        summary: 'Approve the latest version (admins): its prices and statuses are applied to the units',
        params: PriceListParams,
        response: { 200: PriceListDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => developments.approvePriceList(ctx, req.params.id, req.params.version));
    },
  );

  // ── Documents (S4-F4) ──────────────────────────────────────────────────────────────────────────────────────

  app.get(
    '/v1/developments/:id/documents',
    {
      schema: {
        tags,
        operationId: 'developments.listDocuments',
        summary: "A development's documents: the owner's all, a collaborating agency's the shared ones",
        params: DevelopmentParams,
        response: { 200: DevelopmentDocumentList },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => developments.listDevelopmentDocuments(ctx, req.params.id));
    },
  );

  app.get(
    '/v1/developments/:id/documents/:documentId/url',
    {
      schema: {
        tags,
        operationId: 'developments.openDocument',
        summary: 'A short signed download URL of a development document the caller may read',
        params: DevelopmentDocumentParams,
        response: { 200: DevelopmentDocumentUrlDto },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) =>
        developments.openDevelopmentDocument(ctx, { developmentId: req.params.id, documentId: req.params.documentId }),
      );
    },
  );

  app.patch(
    '/v1/developments/:id/documents/:documentId',
    {
      schema: {
        tags,
        operationId: 'developments.updateDocument',
        summary: "Change a document's kind, or whether collaborating agencies may read it",
        params: DevelopmentDocumentParams,
        body: UpdateDevelopmentDocumentBody,
        response: { 200: DevelopmentDocumentDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) =>
        developments.updateDevelopmentDocument(ctx, {
          developmentId: req.params.id,
          documentId: req.params.documentId,
          patch: req.body,
        }),
      );
    },
  );

  app.delete(
    '/v1/developments/:id/documents/:documentId',
    {
      schema: {
        tags,
        operationId: 'developments.deleteDocument',
        summary: 'Remove a development document; its file is deleted by the worker',
        params: DevelopmentDocumentParams,
        response: { 204: z.null() },
      },
      ...write,
    },
    async (req, reply) => {
      await app.withCtx(req, (ctx) =>
        developments.deleteDevelopmentDocument(ctx, {
          developmentId: req.params.id,
          documentId: req.params.documentId,
        }),
      );
      return reply.status(204).send(null);
    },
  );

  await app.register(documentUploadRoute);
}

/**
 * The document upload, in its own plugin: its body is the raw file (only this route accepts binary bodies, up to
 * 20 MB). The declared type only routes the body here; the service checks the real type by magic bytes.
 */
async function documentUploadRoute(upload: FastifyZod): Promise<void> {
  upload.addContentTypeParser(
    ['application/pdf', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: DEVELOPMENT_DOCUMENT_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  upload.post(
    '/v1/developments/:id/documents',
    {
      schema: {
        tags: ['developments'],
        operationId: 'developments.uploadDocument',
        summary: 'Upload one development document (raw PDF body, max 20 MB); owner-only unless shared=true',
        params: DevelopmentParams,
        querystring: UploadDevelopmentDocumentQuery,
        response: { 201: DevelopmentDocumentDto },
      },
      bodyLimit: DEVELOPMENT_DOCUMENT_MAX_BYTES,
      onRequest: [upload.requireSession, takeUploadSlot],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      const body = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      const doc = await developments.uploadDevelopmentDocument(upload.ctxRunner(req), {
        developmentId: req.params.id,
        fileName: req.query.fileName,
        kind: req.query.kind,
        shared: req.query.shared === 'true',
        body,
      });
      return reply.status(201).send(doc);
    },
  );
}
