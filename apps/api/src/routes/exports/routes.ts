import {
  CreatePortalConnectionBody,
  CreatePortalConnectionHeaders,
  ListPortalOverridesQuery,
  PageQuery,
  PortalChannelList,
  PortalConnectionDto,
  PortalConnectionPage,
  PortalConnectionParams,
  PortalConnectionSecretDto,
  PortalFeedRunList,
  PortalIssuePage,
  PortalOverridePage,
  PortalSelectionPage,
  PortalSelectionQuery,
  SetPortalOverridesBody,
  UpdatePortalConnectionBody,
} from '@inmolink/contracts';
import * as exportsModule from '@inmolink/core/modules/exports';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'exports.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'exports.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'exports.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'exports.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
  { name: 'exports.write.tenant', scope: 'tenant', limit: 200, windowSeconds: 3_600 },
];

const tags = ['exports'];

/**
 * Portal connections (S9-01): members see the catalog, the agency's connections and what each one sends; admins
 * create and change connections (selection rule, credentials, feed token) and choose listings one by one.
 */
export async function exportsRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/portal-channels',
    {
      schema: {
        tags,
        operationId: 'exports.listPortalChannels',
        summary: 'The portals an agency can feed',
        response: { 200: PortalChannelList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => exportsModule.listChannels(ctx)),
  );

  app.get(
    '/v1/portal-connections',
    {
      schema: {
        tags,
        operationId: 'exports.listPortalConnections',
        summary: 'The agency’s portal connections, oldest first',
        querystring: PageQuery,
        response: { 200: PortalConnectionPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => exportsModule.listConnections(ctx, req.query)),
  );

  app.post(
    '/v1/portal-connections',
    {
      schema: {
        tags,
        operationId: 'exports.createPortalConnection',
        summary:
          'Connect a portal; the feed token is in the answer only (agency admins). With an Idempotency-Key, a retry within 24 h answers the same connection and token (200)',
        headers: CreatePortalConnectionHeaders,
        body: CreatePortalConnectionBody,
        response: { 200: PortalConnectionSecretDto, 201: PortalConnectionSecretDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const { replayed, ...secret } = await app.withCtx(req, (ctx) =>
        exportsModule.createConnection(ctx, req.body, {
          idempotencyKey: req.headers['idempotency-key'],
        }),
      );
      return reply.code(replayed ? 200 : 201).send(secret);
    },
  );

  app.get(
    '/v1/portal-connections/:connectionId',
    {
      schema: {
        tags,
        operationId: 'exports.getPortalConnection',
        summary: 'One portal connection',
        params: PortalConnectionParams,
        response: { 200: PortalConnectionDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => exportsModule.getConnection(ctx, req.params)),
  );

  app.patch(
    '/v1/portal-connections/:connectionId',
    {
      schema: {
        tags,
        operationId: 'exports.updatePortalConnection',
        summary: 'Change a portal connection: name, on/off, selection rule, credentials (agency admins)',
        params: PortalConnectionParams,
        body: UpdatePortalConnectionBody,
        response: { 200: PortalConnectionDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => exportsModule.updateConnection(ctx, req.params, req.body)),
  );

  app.delete(
    '/v1/portal-connections/:connectionId',
    {
      schema: {
        tags,
        operationId: 'exports.deletePortalConnection',
        summary: 'Remove a portal connection and its per-property choices (agency admins)',
        params: PortalConnectionParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withCtx(req, (ctx) => exportsModule.deleteConnection(ctx, req.params));
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/portal-connections/:connectionId/token',
    {
      schema: {
        tags,
        operationId: 'exports.rotatePortalConnectionToken',
        summary: 'A new feed token, shown once; the previous one stops working (agency admins)',
        params: PortalConnectionParams,
        response: { 200: PortalConnectionSecretDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => exportsModule.rotateConnectionToken(ctx, req.params)),
  );

  app.delete(
    '/v1/portal-connections/:connectionId/token',
    {
      schema: {
        tags,
        operationId: 'exports.revokePortalConnectionToken',
        summary: 'Turn the feed URL off until the token is rotated (agency admins)',
        params: PortalConnectionParams,
        response: { 200: PortalConnectionDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => exportsModule.revokeConnectionToken(ctx, req.params)),
  );

  app.get(
    '/v1/portal-connections/:connectionId/properties',
    {
      schema: {
        tags,
        operationId: 'exports.listPortalConnectionProperties',
        summary: 'The listings chosen one by one (always sent / never sent), by listing id',
        params: PortalConnectionParams,
        querystring: ListPortalOverridesQuery,
        response: { 200: PortalOverridePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => exportsModule.listOverrides(ctx, req.params, req.query)),
  );

  app.put(
    '/v1/portal-connections/:connectionId/properties',
    {
      schema: {
        tags,
        operationId: 'exports.setPortalConnectionProperties',
        summary: 'Include, exclude or clear up to 200 listings of the connection (agency admins)',
        params: PortalConnectionParams,
        body: SetPortalOverridesBody,
        response: { 200: PortalConnectionDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => exportsModule.setOverrides(ctx, req.params, req.body)),
  );

  app.get(
    '/v1/portal-connections/:connectionId/selection',
    {
      schema: {
        tags,
        operationId: 'exports.previewPortalSelection',
        summary: 'A page of the listings the connection sends now, by listing id',
        params: PortalConnectionParams,
        querystring: PortalSelectionQuery,
        response: { 200: PortalSelectionPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => exportsModule.previewSelection(ctx, req.params, req.query)),
  );

  app.get(
    '/v1/portal-connections/:connectionId/issues',
    {
      schema: {
        tags,
        operationId: 'exports.listPortalIssues',
        summary: 'The listings the last feed run left out, with the reasons, by listing id',
        params: PortalConnectionParams,
        querystring: PortalSelectionQuery,
        response: { 200: PortalIssuePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => exportsModule.listIssues(ctx, req.params, req.query)),
  );

  app.get(
    '/v1/portal-connections/:connectionId/runs',
    {
      schema: {
        tags,
        operationId: 'exports.listPortalFeedRuns',
        summary: "The connection's latest feed runs (written, unchanged, failed, skipped), newest first",
        params: PortalConnectionParams,
        response: { 200: PortalFeedRunList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => exportsModule.listFeedRuns(ctx, req.params)),
  );
}
