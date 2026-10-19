import {
  CreateFeedConnectionBody,
  CreateMappingProfileBody,
  FeedConnectionDto,
  FeedConnectionPage,
  FeedConnectionParams,
  FeedItemErrorPage,
  FeedRunDto,
  FeedRunPage,
  FeedRunParams,
  ListFeedConnectionsQuery,
  ListFeedItemErrorsQuery,
  ListFeedRunsQuery,
  ListMappingProfilesQuery,
  MAPPER_SAMPLE,
  MapperDryRunBody,
  MapperDryRunDto,
  MapperPreviewBody,
  MapperPreviewDto,
  MapperSampleDto,
  MapperSampleUploadQuery,
  MapperSampleUrlBody,
  MappingProfileDto,
  MappingProfilePage,
  MappingProfileParams,
  SHEET_UPLOAD_MAX_BYTES,
  StartSheetImportBody,
  StartSheetImportDto,
  UpdateFeedConnectionBody,
  UpdateMappingProfileBody,
} from '@inmolink/contracts';
import * as imports from '@inmolink/core/modules/imports';
import { AppError } from '@inmolink/platform/errors';
import { createUploadSlots, type RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'imports.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'imports.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'imports.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'imports.write.user', scope: 'user', limit: 60, windowSeconds: 60 },
  { name: 'imports.write.tenant', scope: 'tenant', limit: 300, windowSeconds: 60 },
];
/** "Run now" fetches a remote feed: few per agency and minute (the per-connection mutex refuses overlaps anyway). */
const RUN_LIMITS: readonly RateLimitRule[] = [
  { name: 'imports.run.user', scope: 'user', limit: 20, windowSeconds: 60 },
  { name: 'imports.run.tenant', scope: 'tenant', limit: 60, windowSeconds: 60 },
];

/**
 * The mapper's sample calls read up to 2 MB of an upload or of a remote feed: a few at a time per user and process
 * (the body is buffered), and few per minute (a URL sample is an outbound fetch).
 */
const SAMPLE_LIMITS: readonly RateLimitRule[] = [
  { name: 'imports.sample.user', scope: 'user', limit: 20, windowSeconds: 60 },
  { name: 'imports.sample.tenant', scope: 'tenant', limit: 60, windowSeconds: 60 },
];
/** The mapper previews after every pick (debounced): its own bucket, so a busy session cannot lock out "save". */
const PREVIEW_LIMITS: readonly RateLimitRule[] = [
  { name: 'imports.preview.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'imports.preview.user', scope: 'user', limit: 300, windowSeconds: 60 },
];
const sampleSlots = createUploadSlots(2, 16);
async function takeSampleSlot(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) throw new AppError('NOT_AUTHENTICATED');
  const release = sampleSlots.take(req.auth.userId);
  if (!release) throw new AppError('RATE_LIMITED');
  reply.raw.once('close', release);
  reply.raw.once('finish', release);
}

/**
 * Feed imports (S6-01): the agency's feed connections (credentials write-only), "run now", and the run history
 * with per-item errors. Nothing here is cached on the way.
 */
export async function importsRoutes(app: FastifyZod): Promise<void> {
  const tags = ['imports'];
  const read = { onRequest: [app.requireSession], config: { rateLimit: READ_LIMITS } };
  const write = { onRequest: [app.requireSession], config: { rateLimit: WRITE_LIMITS } };

  app.get(
    '/v1/imports/connections',
    {
      schema: {
        tags,
        operationId: 'imports.listFeedConnections',
        summary: "The agency's feed connections, newest first, cursor ≤ 100",
        querystring: ListFeedConnectionsQuery,
        response: { 200: FeedConnectionPage },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.listFeedConnections(ctx, req.query));
    },
  );

  app.post(
    '/v1/imports/connections',
    {
      schema: {
        tags,
        operationId: 'imports.createFeedConnection',
        summary: 'Connect a feed (admins); credentials are stored encrypted and never returned',
        body: CreateFeedConnectionBody,
        response: { 201: FeedConnectionDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(await app.withCtx(req, (ctx) => imports.createFeedConnection(ctx, req.body)));
    },
  );

  app.get(
    '/v1/imports/connections/:id',
    {
      schema: {
        tags,
        operationId: 'imports.getFeedConnection',
        summary: 'A feed connection',
        params: FeedConnectionParams,
        response: { 200: FeedConnectionDto },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.getFeedConnection(ctx, req.params.id));
    },
  );

  app.patch(
    '/v1/imports/connections/:id',
    {
      schema: {
        tags,
        operationId: 'imports.updateFeedConnection',
        summary: 'Change a feed connection (admins): URL, credentials (null removes them), schedule, on/off',
        params: FeedConnectionParams,
        body: UpdateFeedConnectionBody,
        response: { 200: FeedConnectionDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.updateFeedConnection(ctx, req.params.id, req.body));
    },
  );

  app.delete(
    '/v1/imports/connections/:id',
    {
      schema: {
        tags,
        operationId: 'imports.deleteFeedConnection',
        summary: 'Delete a feed connection and its run history (admins)',
        params: FeedConnectionParams,
        response: { 204: z.null() },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await app.withCtx(req, (ctx) => imports.deleteFeedConnection(ctx, req.params.id));
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/imports/connections/:id/runs',
    {
      schema: {
        tags,
        operationId: 'imports.requestFeedRun',
        summary: 'Run the feed now; 409 FEED_RUN_ACTIVE while a run of it is queued or running',
        params: FeedConnectionParams,
        response: { 202: FeedRunDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: [...WRITE_LIMITS, ...RUN_LIMITS] },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(202).send(await app.withCtx(req, (ctx) => imports.requestFeedRun(ctx, req.params.id)));
    },
  );

  app.get(
    '/v1/imports/connections/:id/runs',
    {
      schema: {
        tags,
        operationId: 'imports.listFeedRuns',
        summary: "A connection's run history, newest first, cursor ≤ 100",
        params: FeedConnectionParams,
        querystring: ListFeedRunsQuery,
        response: { 200: FeedRunPage },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.listFeedRuns(ctx, req.params.id, req.query));
    },
  );

  app.get(
    '/v1/imports/runs/:runId',
    {
      schema: {
        tags,
        operationId: 'imports.getFeedRun',
        summary: 'A feed run with its counts',
        params: FeedRunParams,
        response: { 200: FeedRunDto },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.getFeedRun(ctx, req.params.runId));
    },
  );

  app.get(
    '/v1/imports/runs/:runId/errors',
    {
      schema: {
        tags,
        operationId: 'imports.listFeedItemErrors',
        summary: "A run's per-item errors in feed order, cursor ≤ 100",
        params: FeedRunParams,
        querystring: ListFeedItemErrorsQuery,
        response: { 200: FeedItemErrorPage },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.listFeedItemErrors(ctx, req.params.runId, req.query));
    },
  );

  // ── Generic XML mapper (S6-04) ──────────────────────────────────────────────────────────────────────────────
  app.post(
    '/v1/imports/mapper/sample-url',
    {
      schema: {
        tags,
        operationId: 'imports.sampleFromUrl',
        summary: 'Read the head of a feed URL (2 MB, SSRF-checked) and detect its records (admins)',
        body: MapperSampleUrlBody,
        response: { 200: MapperSampleDto },
      },
      onRequest: [app.requireSession, takeSampleSlot],
      config: { rateLimit: SAMPLE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return imports.sampleFromUrl(app.ctxRunner(req), req.body);
    },
  );

  app.post(
    '/v1/imports/mapper/preview',
    {
      schema: {
        tags,
        operationId: 'imports.previewMapping',
        summary: 'Map the sample records with a mapping and show each listing or its problem (admins)',
        body: MapperPreviewBody,
        response: { 200: MapperPreviewDto },
      },
      bodyLimit: 2 * 1024 * 1024,
      onRequest: [app.requireSession],
      config: { rateLimit: PREVIEW_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.previewMapping(ctx, req.body));
    },
  );

  app.post(
    '/v1/imports/mapper/dry-run',
    {
      schema: {
        tags,
        operationId: 'imports.dryRunMapping',
        summary: 'What an import of the sample records would create, update, hold or refuse; writes nothing (admins)',
        body: MapperDryRunBody,
        response: { 200: MapperDryRunDto },
      },
      bodyLimit: 2 * 1024 * 1024,
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.dryRunMapping(ctx, req.body));
    },
  );

  app.get(
    '/v1/imports/mapping-profiles',
    {
      schema: {
        tags,
        operationId: 'imports.listMappingProfiles',
        summary: 'The mapping profiles of the agency, newest first, cursor ≤ 100',
        querystring: ListMappingProfilesQuery,
        response: { 200: MappingProfilePage },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.listMappingProfiles(ctx, req.query));
    },
  );

  app.post(
    '/v1/imports/mapping-profiles',
    {
      schema: {
        tags,
        operationId: 'imports.createMappingProfile',
        summary: 'Save a mapping profile for a feed or an uploaded file (admins)',
        body: CreateMappingProfileBody,
        response: { 201: MappingProfileDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(await app.withCtx(req, (ctx) => imports.createMappingProfile(ctx, req.body)));
    },
  );

  app.get(
    '/v1/imports/mapping-profiles/:id',
    {
      schema: {
        tags,
        operationId: 'imports.getMappingProfile',
        summary: 'A mapping profile',
        params: MappingProfileParams,
        response: { 200: MappingProfileDto },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.getMappingProfile(ctx, req.params.id));
    },
  );

  app.patch(
    '/v1/imports/mapping-profiles/:id',
    {
      schema: {
        tags,
        operationId: 'imports.updateMappingProfile',
        summary:
          'Change a mapping profile (admins, optimistic concurrency); its connections use it from their next run',
        params: MappingProfileParams,
        body: UpdateMappingProfileBody,
        response: { 200: MappingProfileDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.updateMappingProfile(ctx, req.params.id, req.body));
    },
  );

  app.post(
    '/v1/imports/sheets/import',
    {
      schema: {
        tags,
        operationId: 'imports.startSheetImport',
        summary:
          'Import an uploaded CSV or Excel file with a mapping: saves the profile, connects the file and queues the run (admins)',
        body: StartSheetImportBody,
        response: { 201: StartSheetImportDto },
      },
      bodyLimit: 64 * 1024,
      onRequest: [app.requireSession],
      config: { rateLimit: RUN_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(await app.withCtx(req, (ctx) => imports.startSheetImport(ctx, req.body)));
    },
  );

  await app.register(sampleUploadRoute);
  await app.register(sheetUploadRoute);
}

/**
 * The sample upload, in its own plugin: its body is the raw XML file (only this route accepts these content types,
 * up to 2 MB). The declared type only routes the body here; the service checks the real content by magic bytes.
 */
async function sampleUploadRoute(upload: FastifyZod): Promise<void> {
  upload.addContentTypeParser(
    ['application/xml', 'text/xml', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAPPER_SAMPLE.maxBytes },
    (_req, body, done) => done(null, body),
  );

  upload.post(
    '/v1/imports/mapper/sample',
    {
      schema: {
        tags: ['imports'],
        operationId: 'imports.sampleFromUpload',
        summary: 'Read an uploaded XML sample (raw body, max 2 MB) and detect its records (admins)',
        querystring: MapperSampleUploadQuery,
        response: { 200: MapperSampleDto },
      },
      bodyLimit: MAPPER_SAMPLE.maxBytes,
      onRequest: [upload.requireSession, takeSampleSlot],
      config: { rateLimit: SAMPLE_LIMITS },
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      reply.header('cache-control', 'no-store');
      const bytes = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      return imports.sampleFromUpload(upload.ctxRunner(req), bytes, { recordElement: req.query.recordElement });
    },
  );
}

/**
 * The CSV / Excel upload (S6-05), in its own plugin like the XML sample: the body is the raw file, up to 25 MB. The
 * declared type only routes the body here; the service decides by the first bytes. One at a time per user, four per
 * process (the body is buffered), a few per minute.
 */
const SHEET_LIMITS: readonly RateLimitRule[] = [
  { name: 'imports.sheet.user', scope: 'user', limit: 10, windowSeconds: 60 },
  { name: 'imports.sheet.tenant', scope: 'tenant', limit: 30, windowSeconds: 60 },
];
const sheetSlots = createUploadSlots(1, 4);
async function takeSheetSlot(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) throw new AppError('NOT_AUTHENTICATED');
  const release = sheetSlots.take(req.auth.userId);
  if (!release) throw new AppError('RATE_LIMITED');
  reply.raw.once('close', release);
  reply.raw.once('finish', release);
}

async function sheetUploadRoute(upload: FastifyZod): Promise<void> {
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
    '/v1/imports/sheets',
    {
      schema: {
        tags: ['imports'],
        operationId: 'imports.uploadSheet',
        summary: 'Upload a CSV or Excel file (raw body, max 25 MB): header and first rows for the mapper (admins)',
        response: { 200: MapperSampleDto },
      },
      bodyLimit: SHEET_UPLOAD_MAX_BYTES,
      onRequest: [upload.requireSession, takeSheetSlot],
      config: { rateLimit: SHEET_LIMITS },
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
      reply.header('cache-control', 'no-store');
      const bytes = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
      return imports.uploadSheet(upload.ctxRunner(req), bytes);
    },
  );
}
