import {
  CreateBrochureBody,
  CreateContactHeaders,
  CreateFormDocumentBody,
  CreatePortfolioBody,
  FormDocumentDto,
  FormDocumentPage,
  FormDocumentParams,
  ListFormDocumentsQuery,
  PdfDocumentDto,
  PdfDocumentParams,
} from '@inmolink/contracts';
import * as documents from '@inmolink/core/modules/documents';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

/** Status polls are frequent while a document renders. */
const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'documents.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'documents.read.user', scope: 'user', limit: 300, windowSeconds: 60 },
];
/**
 * Each request may start a render (a browser page for seconds): per IP, per user, and a ceiling per agency. Shared by
 * every route that renders (the selection PDF too): the same rule names, the same counters.
 */
export const DOCUMENT_RENDER_LIMITS: readonly RateLimitRule[] = [
  { name: 'documents.render.ip', scope: 'ip', limit: 60, windowSeconds: 60 },
  { name: 'documents.render.user', scope: 'user', limit: 30, windowSeconds: 60 },
  { name: 'documents.render.tenant', scope: 'tenant', limit: 600, windowSeconds: 3_600 },
];

const tags = ['documents'];

/**
 * PDF brochures and portfolios (S12-05, PLAN §7 M13): ask for one (202, `PENDING` — or `READY` when the same document
 * was rendered in the last minutes), then poll it until `READY` with its signed link. Answers carry signed links:
 * `no-store`.
 */
export async function documentsRoutes(app: FastifyZod): Promise<void> {
  app.post(
    '/v1/documents/brochures',
    {
      schema: {
        tags,
        operationId: 'documents.createBrochure',
        summary: "A listing's branded brochure in the client's language (rendered by the pdf pool; poll the document)",
        body: CreateBrochureBody,
        response: { 202: PdfDocumentDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: DOCUMENT_RENDER_LIMITS },
    },
    async (req, reply) => reply.code(202).send(await documents.requestBrochure((fn) => app.withCtx(req, fn), req.body)),
  );

  app.post(
    '/v1/documents/portfolios',
    {
      schema: {
        tags,
        operationId: 'documents.createPortfolio',
        summary: 'A branded portfolio of several listings (a cover, then a page each, in order); poll the document',
        body: CreatePortfolioBody,
        response: { 202: PdfDocumentDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: DOCUMENT_RENDER_LIMITS },
    },
    async (req, reply) =>
      reply.code(202).send(await documents.requestPortfolio((fn) => app.withCtx(req, fn), req.body)),
  );

  // ── R2-05a, the forms library ───────────────────────────────────────────────────────────────────────

  app.post(
    '/v1/documents/forms',
    {
      schema: {
        tags,
        operationId: 'documents.createForm',
        summary:
          'Make a form (listing agreement, reservation, viewing sheet, offer) merged from the agency’s data (201, PENDING; poll the form). With an Idempotency-Key, a retry within 24 h answers the first form (200)',
        headers: CreateContactHeaders,
        body: CreateFormDocumentBody,
        response: { 201: FormDocumentDto, 200: FormDocumentDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: DOCUMENT_RENDER_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        documents.createFormDocument(ctx, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.form);
    },
  );

  app.get(
    '/v1/documents/forms',
    {
      schema: {
        tags,
        operationId: 'documents.listForms',
        summary: 'The agency’s forms, newest first (keyset); optionally one template and a contact, listing or deal',
        querystring: ListFormDocumentsQuery,
        response: { 200: FormDocumentPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req) => app.withCtx(req, (ctx) => documents.listFormDocuments(ctx, req.query)),
  );

  app.get(
    '/v1/documents/forms/:id',
    {
      schema: {
        tags,
        operationId: 'documents.getForm',
        summary: 'A form with its SHA-256 and, once READY, a short signed download link',
        params: FormDocumentParams,
        response: { 200: FormDocumentDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req) => app.withCtx(req, (ctx) => documents.getFormDocument(ctx, req.params.id)),
  );

  app.get(
    '/v1/documents/:documentId',
    {
      schema: {
        tags,
        operationId: 'documents.getDocument',
        summary: "A document's state, with a short signed download link once it is ready",
        params: PdfDocumentParams,
        response: { 200: PdfDocumentDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req) => documents.getDocument((fn) => app.withCtx(req, fn), req.params.documentId),
  );
}
