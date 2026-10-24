import {
  ConvertProspectBody,
  CreateContactHeaders,
  CreateProspectBody,
  ListProspectsQuery,
  MoveProspectBody,
  ProspectBoardDto,
  ProspectBoardQuery,
  ProspectColumnQuery,
  ProspectConversionDto,
  ProspectDeletedDto,
  ProspectDto,
  ProspectFollowUpsQuery,
  ProspectPage,
  ProspectParams,
  ProspectStageParams,
  UpdateProspectBody,
} from '@inmolink/contracts';
import * as crm from '@inmolink/core/modules/crm';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.prospects.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'crm.prospects.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
/** Drags come in bursts while a member sorts the board. */
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.prospects.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'crm.prospects.write.user', scope: 'user', limit: 180, windowSeconds: 60 },
  { name: 'crm.prospects.write.tenant', scope: 'tenant', limit: 5_000, windowSeconds: 3_600 },
];

const tags = ['crm'];

/**
 * The seller acquisition board (S10-07): prospects on a board, a list and by follow-up date; a drag; one-click
 * conversion to a DRAFT listing. Registered inside `crmRoutes` (its `no-store` hook applies).
 */
export async function crmProspectRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/crm/prospects',
    {
      schema: {
        tags,
        operationId: 'crm.listProspects',
        summary: 'Seller prospects newest first, one stage or everyone’s (assigned=me|unassigned|<user id>), keyset',
        querystring: ListProspectsQuery,
        response: { 200: ProspectPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listProspects(ctx, req.query)),
  );

  app.get(
    '/v1/crm/prospects/board',
    {
      schema: {
        tags,
        operationId: 'crm.getProspectBoard',
        summary: 'The acquisition board: every stage with its count and first cards in board order',
        querystring: ProspectBoardQuery,
        response: { 200: ProspectBoardDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getProspectBoard(ctx, req.query)),
  );

  app.get(
    '/v1/crm/prospects/stages/:stage',
    {
      schema: {
        tags,
        operationId: 'crm.listStageProspects',
        summary: 'One acquisition stage’s next cards in board order (keyset)',
        params: ProspectStageParams,
        querystring: ProspectColumnQuery,
        response: { 200: ProspectPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listStageProspects(ctx, req.params.stage, req.query)),
  );

  app.get(
    '/v1/crm/prospects/follow-ups',
    {
      schema: {
        tags,
        operationId: 'crm.listProspectFollowUps',
        summary: 'Seller prospects whose next follow-up falls in [from, to) (≤ 92 days), soonest first (keyset)',
        querystring: ProspectFollowUpsQuery,
        response: { 200: ProspectPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listProspectFollowUps(ctx, req.query)),
  );

  app.get(
    '/v1/crm/prospects/:id',
    {
      schema: {
        tags,
        operationId: 'crm.getProspect',
        summary: 'One seller prospect (confidential notes for the agency’s members only)',
        params: ProspectParams,
        response: { 200: ProspectDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getProspect(ctx, req.params.id)),
  );

  app.post(
    '/v1/crm/prospects',
    {
      schema: {
        tags,
        operationId: 'crm.createProspect',
        summary:
          'Add a seller prospect to the acquisition board (201). With an Idempotency-Key, a retry within 24 h answers the first prospect (200)',
        headers: CreateContactHeaders,
        body: CreateProspectBody,
        response: { 201: ProspectDto, 200: ProspectDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        crm.createProspect(ctx, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.prospect);
    },
  );

  app.patch(
    '/v1/crm/prospects/:id',
    {
      schema: {
        tags,
        operationId: 'crm.updateProspect',
        summary: 'Change a seller prospect (version)',
        params: ProspectParams,
        body: UpdateProspectBody,
        response: { 200: ProspectDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.updateProspect(ctx, req.params.id, req.body)),
  );

  app.post(
    '/v1/crm/prospects/:id/move',
    {
      schema: {
        tags,
        operationId: 'crm.moveProspect',
        summary: 'Drag a seller prospect to a stage, after another card (version); LISTED only by converting',
        params: ProspectParams,
        body: MoveProspectBody,
        response: { 200: ProspectDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.moveProspect(ctx, req.params.id, req.body)),
  );

  app.post(
    '/v1/crm/prospects/:id/convert',
    {
      schema: {
        tags,
        operationId: 'crm.convertProspect',
        summary:
          'Convert a seller prospect into a DRAFT listing with the seller linked privately; converting again answers the same listing',
        params: ProspectParams,
        body: ConvertProspectBody,
        response: { 200: ProspectConversionDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.convertProspect(ctx, req.params.id, req.body)),
  );

  app.delete(
    '/v1/crm/prospects/:id',
    {
      schema: {
        tags,
        operationId: 'crm.deleteProspect',
        summary: 'Delete a seller prospect (a listing it became stays)',
        params: ProspectParams,
        response: { 200: ProspectDeletedDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req) => {
      await app.withCtx(req, (ctx) => crm.deleteProspect(ctx, req.params.id));
      return { deleted: true as const };
    },
  );
}
