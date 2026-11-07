import {
  CreateBrochureBody,
  CreateContactHeaders,
  CreateFormDocumentBody,
  CreatePortfolioBody,
  CreateSignatureRequestBody,
  FormDocumentDto,
  FormDocumentPage,
  FormDocumentParams,
  ListFormDocumentsQuery,
  PdfDocumentDto,
  PdfDocumentParams,
  SIGNED_PDF_VERIFY_MAX_BYTES,
  SignatureRequestDto,
  SignatureRequestList,
  SignatureRequestParams,
  VerifySignedPdfResult,
} from '@inmolink/contracts';
import * as documents from '@inmolink/core/modules/documents';
import { AppError } from '@inmolink/platform/errors';
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

/** R2-05b: each signing request e-mails every signer: per IP, per user, and a ceiling per agency. */
export const SIGNATURE_REQUEST_LIMITS: readonly RateLimitRule[] = [
  { name: 'documents.sign.ip', scope: 'ip', limit: 30, windowSeconds: 60 },
  { name: 'documents.sign.user', scope: 'user', limit: 20, windowSeconds: 60 },
  { name: 'documents.sign.tenant', scope: 'tenant', limit: 300, windowSeconds: 3_600 },
];

/** R2-05b: a PDF checked against a request's hashes (the body is read and hashed, nothing stored). */
const VERIFY_LIMITS: readonly RateLimitRule[] = [
  { name: 'documents.verify.ip', scope: 'ip', limit: 30, windowSeconds: 60 },
  { name: 'documents.verify.user', scope: 'user', limit: 20, windowSeconds: 60 },
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

  // ── R2-05b, simple electronic signature ─────────────────────────────────────────────────────────────

  app.post(
    '/v1/documents/forms/:id/signature-requests',
    {
      schema: {
        tags,
        operationId: 'documents.createSignatureRequest',
        summary:
          'Ask people to sign a READY form (its SHA-256 as stored): each is e-mailed a signing link (201). A new request replaces the form’s open one. With an Idempotency-Key, a retry within 24 h answers the first request (200)',
        headers: CreateContactHeaders,
        params: FormDocumentParams,
        body: CreateSignatureRequestBody,
        response: { 201: SignatureRequestDto, 200: SignatureRequestDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: SIGNATURE_REQUEST_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        documents.createSignatureRequest(ctx, req.params.id, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.request);
    },
  );

  app.get(
    '/v1/documents/forms/:id/signature-requests',
    {
      schema: {
        tags,
        operationId: 'documents.listSignatureRequests',
        summary: 'A form’s signing requests, newest first, with their signers (at most 20)',
        params: FormDocumentParams,
        response: { 200: SignatureRequestList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req) => app.withCtx(req, (ctx) => documents.listSignatureRequests(ctx, req.params.id)),
  );

  app.get(
    '/v1/documents/signature-requests/:id',
    {
      schema: {
        tags,
        operationId: 'documents.getSignatureRequest',
        summary:
          'A signing request with its signers and, once COMPLETED, the signed PDF’s SHA-256 and a short signed download link',
        params: SignatureRequestParams,
        response: { 200: SignatureRequestDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req) => app.withCtx(req, (ctx) => documents.getSignatureRequest(ctx, req.params.id)),
  );

  await app.register(verifySignedPdfRoute);

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

/** R2-05b: the largest PDF checked against a request (the forms library's documents are far smaller). */
const VERIFY_MAX_BYTES = SIGNED_PDF_VERIFY_MAX_BYTES;

/**
 * R2-05b: the verification, in its own plugin: its body is the raw PDF (only this route of the module accepts one).
 * The bytes are hashed and compared with the request's stored hashes; nothing is stored.
 */
async function verifySignedPdfRoute(upload: FastifyZod): Promise<void> {
  upload.addContentTypeParser(
    ['application/pdf', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: VERIFY_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  upload.post(
    '/v1/documents/signature-requests/:id/verify',
    {
      schema: {
        tags,
        operationId: 'documents.verifySignedPdf',
        summary:
          'Check a PDF (raw body, max 25 MB) against a signing request: the signed PDF (SIGNED), the original signed (ORIGINAL) or neither (NONE), by SHA-256',
        params: SignatureRequestParams,
        response: { 200: VerifySignedPdfResult },
      },
      bodyLimit: VERIFY_MAX_BYTES,
      onRequest: [upload.requireSession],
      config: { rateLimit: VERIFY_LIMITS },
    },
    async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      const body = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      return upload.withCtx(req, (ctx) => documents.verifySignedPdf(ctx, req.params.id, body));
    },
  );
}
