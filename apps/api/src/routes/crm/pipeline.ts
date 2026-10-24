import {
  CreateContactHeaders,
  CreatePipelineStageBody,
  LeadParams,
  LeadStageHistoryPage,
  ListPipelineStagesQuery,
  MoveLeadBody,
  PageQuery,
  PipelineBoardDto,
  PipelineBoardQuery,
  PipelineColumnQuery,
  PipelineLeadDto,
  PipelineLeadPage,
  PipelineReportDto,
  PipelineReportQuery,
  PipelineStageDto,
  PipelineStageList,
  PipelineStageParams,
  ReorderPipelineStagesBody,
  UpdatePipelineStageBody,
} from '@inmolink/contracts';
import * as crm from '@inmolink/core/modules/crm';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.pipeline.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'crm.pipeline.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
/** Drags come in bursts while a member sorts the board. */
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.pipeline.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'crm.pipeline.write.user', scope: 'user', limit: 180, windowSeconds: 60 },
  { name: 'crm.pipeline.write.tenant', scope: 'tenant', limit: 5_000, windowSeconds: 3_600 },
];

const tags = ['crm'];

/**
 * CRM pipeline (S10-03): the agency's stages (admins change them), the board and its columns, a drag, a lead's stage
 * history and the pipeline report. Registered inside `crmRoutes` (its `no-store` hook applies).
 */
export async function crmPipelineRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/crm/pipeline/stages',
    {
      schema: {
        tags,
        operationId: 'crm.listPipelineStages',
        summary: 'The agency’s pipeline stages in order (archived ones too with includeArchived)',
        querystring: ListPipelineStagesQuery,
        response: { 200: PipelineStageList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listPipelineStages(ctx, req.query)),
  );

  app.post(
    '/v1/crm/pipeline/stages',
    {
      schema: {
        tags,
        operationId: 'crm.createPipelineStage',
        summary:
          'Add a stage of a kind (open, won, lost), last or at a position (admins, 201). With an Idempotency-Key, a retry within 24 h answers the first stage (200)',
        headers: CreateContactHeaders,
        body: CreatePipelineStageBody,
        response: { 201: PipelineStageDto, 200: PipelineStageDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        crm.createPipelineStage(ctx, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.stage);
    },
  );

  app.put(
    '/v1/crm/pipeline/stages/order',
    {
      schema: {
        tags,
        operationId: 'crm.reorderPipelineStages',
        summary: 'Reorder the active stages: every one once, in the new order (admins)',
        body: ReorderPipelineStagesBody,
        response: { 200: PipelineStageList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.reorderPipelineStages(ctx, req.body)),
  );

  app.patch(
    '/v1/crm/pipeline/stages/:id',
    {
      schema: {
        tags,
        operationId: 'crm.updatePipelineStage',
        summary: 'Rename, archive (an empty stage) or restore a stage (admins, version)',
        params: PipelineStageParams,
        body: UpdatePipelineStageBody,
        response: { 200: PipelineStageDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.updatePipelineStage(ctx, req.params.id, req.body)),
  );

  app.get(
    '/v1/crm/pipeline/stages/:id/leads',
    {
      schema: {
        tags,
        operationId: 'crm.listStageLeads',
        summary: 'One board column’s leads in board order (keyset)',
        params: PipelineStageParams,
        querystring: PipelineColumnQuery,
        response: { 200: PipelineLeadPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listStageLeads(ctx, req.params.id, req.query)),
  );

  app.get(
    '/v1/crm/pipeline/board',
    {
      schema: {
        tags,
        operationId: 'crm.getPipelineBoard',
        summary: 'The board: every active stage with its lead count and first leads; filters by assignee',
        querystring: PipelineBoardQuery,
        response: { 200: PipelineBoardDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getPipelineBoard(ctx, req.query)),
  );

  app.get(
    '/v1/crm/pipeline/report',
    {
      schema: {
        tags,
        operationId: 'crm.getPipelineReport',
        summary:
          'Per stage: leads in it now, leads that entered and left it in a range and their time in stage; won and lost',
        querystring: PipelineReportQuery,
        response: { 200: PipelineReportDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getPipelineReport(ctx, req.query)),
  );

  app.post(
    '/v1/crm/leads/:id/move',
    {
      schema: {
        tags,
        operationId: 'crm.moveLead',
        summary: 'Drag a lead: into a stage, right after another lead of that column (null: the top) (version)',
        params: LeadParams,
        body: MoveLeadBody,
        response: { 200: PipelineLeadDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.moveLead(ctx, req.params.id, req.body)),
  );

  app.get(
    '/v1/crm/leads/:id/stage-history',
    {
      schema: {
        tags,
        operationId: 'crm.listLeadStageHistory',
        summary: 'A lead’s stage changes with the time spent in each stage, newest first (keyset)',
        params: LeadParams,
        querystring: PageQuery,
        response: { 200: LeadStageHistoryPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listLeadStageHistory(ctx, req.params.id, req.query)),
  );
}
