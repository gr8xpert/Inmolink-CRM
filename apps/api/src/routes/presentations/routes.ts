import {
  CreateSelectionBody,
  ListSelectionInteractionsQuery,
  ListSelectionsQuery,
  PdfDocumentDto,
  SelectionCreatedDto,
  SelectionDto,
  SelectionInteractionPage,
  SelectionPage,
  SelectionParams,
  UpdateSelectionBody,
} from '@inmolink/contracts';
import * as presentations from '@inmolink/core/modules/presentations';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';
import { DOCUMENT_RENDER_LIMITS } from '../documents/routes';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'presentations.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'presentations.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'presentations.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'presentations.write.user', scope: 'user', limit: 60, windowSeconds: 60 },
  { name: 'presentations.write.tenant', scope: 'tenant', limit: 600, windowSeconds: 60 },
];

const RotateBody = z.strictObject({ version: z.number().int().min(1) });

/**
 * Selections (S12-04): listings and units picked for a client, shared as a live page on the public pages host. A
 * link's token is in the create and rotate answers only (never stored): those answers are `no-store`, like all here.
 */
export async function presentationsRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/selections',
    {
      schema: {
        tags: ['presentations'],
        operationId: 'presentations.listSelections',
        summary: "The agency's selections (one contact's with `contactId`), newest first",
        querystring: ListSelectionsQuery,
        response: { 200: SelectionPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, _reply) => {
      return app.withCtx(req, (ctx) => presentations.listSelections(ctx, req.query));
    },
  );

  app.post(
    '/v1/selections',
    {
      schema: {
        tags: ['presentations'],
        operationId: 'presentations.createSelection',
        summary: 'Create a selection from chosen listings or a bookmark folder; answers its link (shown once)',
        body: CreateSelectionBody,
        response: { 201: SelectionCreatedDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      return reply.code(201).send(await app.withCtx(req, (ctx) => presentations.createSelection(ctx, req.body)));
    },
  );

  app.get(
    '/v1/selections/:id',
    {
      schema: {
        tags: ['presentations'],
        operationId: 'presentations.getSelection',
        summary: 'A selection with its items, likes, enquiries and views',
        params: SelectionParams,
        response: { 200: SelectionDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, _reply) => {
      return app.withCtx(req, (ctx) => presentations.getSelection(ctx, req.params.id));
    },
  );

  app.patch(
    '/v1/selections/:id',
    {
      schema: {
        tags: ['presentations'],
        operationId: 'presentations.updateSelection',
        summary: 'Change the title, message, language, expiry or items (in their new order); optimistic',
        params: SelectionParams,
        body: UpdateSelectionBody,
        response: { 200: SelectionDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, _reply) => {
      return app.withCtx(req, (ctx) => presentations.updateSelection(ctx, req.params.id, req.body));
    },
  );

  // S12-05: the selection as a PDF portfolio (rendered by the pdf pool; poll `GET /v1/documents/:documentId`).
  app.post(
    '/v1/selections/:id/pdf',
    {
      schema: {
        tags: ['presentations'],
        operationId: 'presentations.createSelectionPdf',
        summary: "The selection as a branded PDF portfolio in the client's language (202; poll the document)",
        params: SelectionParams,
        response: { 202: PdfDocumentDto },
      },
      onRequest: [app.requireSession],
      // The documents' render budget (per IP, user and agency), shared with the documents routes.
      config: { rateLimit: DOCUMENT_RENDER_LIMITS },
    },
    async (req, reply) => {
      return reply.code(202).send(await presentations.selectionPdf((fn) => app.withCtx(req, fn), req.params.id));
    },
  );

  app.post(
    '/v1/selections/:id/link',
    {
      schema: {
        tags: ['presentations'],
        operationId: 'presentations.rotateSelectionLink',
        summary: 'A new link for the selection (shown once); the old link stops working',
        params: SelectionParams,
        body: RotateBody,
        response: { 200: SelectionCreatedDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, _reply) => {
      return app.withCtx(req, (ctx) => presentations.rotateSelectionLink(ctx, req.params.id, req.body.version));
    },
  );

  app.get(
    '/v1/selections/:id/interactions',
    {
      schema: {
        tags: ['presentations'],
        operationId: 'presentations.listSelectionInteractions',
        summary: "What the client did on the selection's page (views, likes, enquiries), newest first",
        params: SelectionParams,
        querystring: ListSelectionInteractionsQuery,
        response: { 200: SelectionInteractionPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, _reply) => {
      return app.withCtx(req, (ctx) => presentations.listSelectionInteractions(ctx, req.params.id, req.query));
    },
  );
}
