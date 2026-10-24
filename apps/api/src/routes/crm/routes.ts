import {
  AppError,
  ContactDto,
  ContactImportDto,
  ContactImportPage,
  ContactImportParams,
  ContactImportUploadDto,
  ContactLookupBody,
  ContactLookupDto,
  ContactNoteDto,
  ContactNotePage,
  ContactPage,
  ContactParams,
  CreateContactBody,
  CreateContactHeaders,
  CreateContactNoteBody,
  ListContactsQuery,
  MergeContactsBody,
  PageQuery,
  SHEET_UPLOAD_MAX_BYTES,
  StartContactImportBody,
  UpdateContactBody,
} from '@inmolink/contracts';
import * as crm from '@inmolink/core/modules/crm';
import { createUploadSlots, type RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'crm.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'crm.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
  { name: 'crm.write.tenant', scope: 'tenant', limit: 2_000, windowSeconds: 3_600 },
];
const IMPORT_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.import.ip', scope: 'ip', limit: 20, windowSeconds: 60 },
  { name: 'crm.import.user', scope: 'user', limit: 10, windowSeconds: 60 },
  { name: 'crm.import.tenant', scope: 'tenant', limit: 30, windowSeconds: 3_600 },
];

const tags = ['crm'];

/**
 * CRM contacts (S10-01): contacts with duplicate detection and merge, notes, and CSV / Excel imports. Contacts are
 * PII: every answer is `no-store`, and nothing of it is open in Client Mode (policy).
 */
export async function crmRoutes(app: FastifyZod): Promise<void> {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '/v1/crm/contacts',
    {
      schema: {
        tags,
        operationId: 'crm.listContacts',
        summary: 'The agency’s contacts, newest first; filters by tag, type, owner',
        querystring: ListContactsQuery,
        response: { 200: ContactPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listContacts(ctx, req.query)),
  );

  app.post(
    '/v1/crm/contacts',
    {
      schema: {
        tags,
        operationId: 'crm.createContact',
        summary:
          'Create a contact (201); an e-mail or phone that already belongs to a contact answers 409 CONTACT_DUPLICATE with the matches — send again with mergeInto to add the details to it (200). With an Idempotency-Key, a retry within 24 h answers the contact created (200)',
        headers: CreateContactHeaders,
        body: CreateContactBody,
        response: { 201: ContactDto, 200: ContactDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        crm.createContact(ctx, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.outcome === 'CREATED' ? 201 : 200).send(result.contact);
    },
  );

  app.post(
    '/v1/crm/contacts/lookup',
    {
      schema: {
        tags,
        operationId: 'crm.lookupContacts',
        summary: 'The contacts owning any of these e-mails or phones (normalized, exact): the duplicate check',
        body: ContactLookupBody,
        response: { 200: ContactLookupDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.lookupContacts(ctx, req.body)),
  );

  app.get(
    '/v1/crm/contacts/:id',
    {
      schema: {
        tags,
        operationId: 'crm.getContact',
        summary: 'A contact with its e-mails and phones',
        params: ContactParams,
        response: { 200: ContactDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getContact(ctx, req.params.id)),
  );

  app.patch(
    '/v1/crm/contacts/:id',
    {
      schema: {
        tags,
        operationId: 'crm.updateContact',
        summary: 'Change a contact (version); e-mails / phones replace the lists',
        params: ContactParams,
        body: UpdateContactBody,
        response: { 200: ContactDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.updateContact(ctx, req.params.id, req.body)),
  );

  app.post(
    '/v1/crm/contacts/:id/merge',
    {
      schema: {
        tags,
        operationId: 'crm.mergeContacts',
        summary:
          'Merge duplicateId into this contact: its e-mails, phones and notes move here and it is closed (crm.contact.merged lets other modules follow)',
        params: ContactParams,
        body: MergeContactsBody,
        response: { 200: ContactDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.mergeContacts(ctx, req.params.id, req.body)),
  );

  app.get(
    '/v1/crm/contacts/:id/notes',
    {
      schema: {
        tags,
        operationId: 'crm.listContactNotes',
        summary: 'A contact’s notes, newest first',
        params: ContactParams,
        querystring: PageQuery,
        response: { 200: ContactNotePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listContactNotes(ctx, req.params.id, req.query)),
  );

  app.post(
    '/v1/crm/contacts/:id/notes',
    {
      schema: {
        tags,
        operationId: 'crm.addContactNote',
        summary: 'Add a note to a contact',
        params: ContactParams,
        body: CreateContactNoteBody,
        response: { 201: ContactNoteDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) =>
      reply.code(201).send(await app.withCtx(req, (ctx) => crm.addContactNote(ctx, req.params.id, req.body))),
  );

  app.get(
    '/v1/crm/contact-imports',
    {
      schema: {
        tags,
        operationId: 'crm.listContactImports',
        summary: 'The agency’s contact imports, newest first',
        querystring: PageQuery,
        response: { 200: ContactImportPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listContactImports(ctx, req.query)),
  );

  app.get(
    '/v1/crm/contact-imports/:id',
    {
      schema: {
        tags,
        operationId: 'crm.getContactImport',
        summary: 'A contact import: status, counts and the rows that could not be imported',
        params: ContactImportParams,
        response: { 200: ContactImportDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getContactImport(ctx, req.params.id)),
  );

  app.post(
    '/v1/crm/contact-imports/:id/start',
    {
      schema: {
        tags,
        operationId: 'crm.startContactImport',
        summary: 'Start an uploaded contact import with a column mapping (admins); the run is a background job',
        params: ContactImportParams,
        body: StartContactImportBody,
        response: { 202: ContactImportDto },
      },
      bodyLimit: 64 * 1024,
      onRequest: [app.requireSession],
      config: { rateLimit: IMPORT_LIMITS },
    },
    async (req, reply) =>
      reply.code(202).send(await app.withCtx(req, (ctx) => crm.startContactImport(ctx, req.params.id, req.body))),
  );

  await app.register(contactImportUploadRoute);
}

/** One upload at a time per member, four per process: a 25 MB body each. */
const uploadSlots = createUploadSlots(1, 4);
async function takeUploadSlot(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) throw new AppError('NOT_AUTHENTICATED');
  const release = uploadSlots.take(req.auth.userId);
  if (!release) throw new AppError('RATE_LIMITED');
  reply.raw.once('close', release);
  reply.raw.once('finish', release);
}

/**
 * The upload, in its own plugin: its body is the raw CSV / XLSX file (only this route accepts these content types).
 * The declared type only routes the body here; the service identifies the file by its first bytes.
 */
async function contactImportUploadRoute(upload: FastifyZod): Promise<void> {
  upload.addContentTypeParser(
    [
      'application/octet-stream',
      'text/csv',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    { parseAs: 'buffer', bodyLimit: SHEET_UPLOAD_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  upload.post(
    '/v1/crm/contact-imports',
    {
      schema: {
        tags,
        operationId: 'crm.uploadContactImport',
        summary: 'Upload a CSV or Excel file of contacts (raw body, max 25 MB): header and first rows (admins)',
        response: { 201: ContactImportUploadDto },
      },
      bodyLimit: SHEET_UPLOAD_MAX_BYTES,
      // The role check runs before Fastify buffers the body; the service checks again.
      onRequest: [upload.requireSession, (req) => upload.withCtx(req, crm.authorizeContactImport), takeUploadSlot],
      config: { rateLimit: IMPORT_LIMITS },
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      const bytes = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      return reply.code(201).send(await crm.uploadContactImport(upload.ctxRunner(req), bytes));
    },
  );
}
