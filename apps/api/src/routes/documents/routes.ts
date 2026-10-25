import { CreateBrochureBody, CreatePortfolioBody, PdfDocumentDto, PdfDocumentParams } from '@inmolink/contracts';
import * as documents from '@inmolink/core/modules/documents';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

/** Status polls are frequent while a document renders. */
const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'documents.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'documents.read.user', scope: 'user', limit: 300, windowSeconds: 60 },
];
/** Each request may start a render (a browser page for seconds): per user, and a ceiling per agency. */
const RENDER_LIMITS: readonly RateLimitRule[] = [
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
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

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
      config: { rateLimit: RENDER_LIMITS },
    },
    async (req, reply) =>
      reply.code(202).send(await app.withCtx(req, (ctx) => documents.requestBrochure(ctx, req.body))),
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
      config: { rateLimit: RENDER_LIMITS },
    },
    async (req, reply) =>
      reply.code(202).send(await app.withCtx(req, (ctx) => documents.requestPortfolio(ctx, req.body))),
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
    async (req) => app.withCtx(req, (ctx) => documents.getDocument(ctx, req.params.documentId)),
  );
}
