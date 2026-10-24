import {
  CreateContactHeaders,
  CreateLeadBody,
  LeadDto,
  LeadIntroductionPage,
  LeadPage,
  LeadParams,
  LeadRoutingDto,
  ListLeadsQuery,
  PageQuery,
  UpdateLeadBody,
  UpdateLeadRoutingBody,
} from '@inmolink/contracts';
import * as crm from '@inmolink/core/modules/crm';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.leads.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'crm.leads.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'crm.leads.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'crm.leads.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
  { name: 'crm.leads.write.tenant', scope: 'tenant', limit: 2_000, windowSeconds: 3_600 },
];

const tags = ['crm'];

/**
 * CRM leads (S10-02): the unified inbox, manual leads, status and assignment, the introductions other agencies made to
 * the caller's listings (never the client), and the agency's assignment rule. Registered inside `crmRoutes` (its
 * `no-store` hook applies).
 */
export async function crmLeadRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/crm/leads',
    {
      schema: {
        tags,
        operationId: 'crm.listLeads',
        summary:
          'The lead inbox (website, portal, iFrame, selections, chatbot, manual), newest first; filters by status, source, assignee',
        querystring: ListLeadsQuery,
        response: { 200: LeadPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listLeads(ctx, req.query)),
  );

  app.post(
    '/v1/crm/leads',
    {
      schema: {
        tags,
        operationId: 'crm.createLead',
        summary:
          'Enter a lead for a contact (201); the agency rule assigns it unless assignedUserId is sent. With an Idempotency-Key, a retry within 24 h answers the first lead (200)',
        headers: CreateContactHeaders,
        body: CreateLeadBody,
        response: { 201: LeadDto, 200: LeadDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        crm.createLead(ctx, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.lead);
    },
  );

  app.get(
    '/v1/crm/leads/:id',
    {
      schema: {
        tags,
        operationId: 'crm.getLead',
        summary: 'A lead with its contact, target and message',
        params: LeadParams,
        response: { 200: LeadDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getLead(ctx, req.params.id)),
  );

  app.patch(
    '/v1/crm/leads/:id',
    {
      schema: {
        tags,
        operationId: 'crm.updateLead',
        summary: 'Change a lead’s status or assignee (version)',
        params: LeadParams,
        body: UpdateLeadBody,
        response: { 200: LeadDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.updateLead(ctx, req.params.id, req.body)),
  );

  app.get(
    '/v1/crm/lead-introductions',
    {
      schema: {
        tags,
        operationId: 'crm.listLeadIntroductions',
        summary:
          'Clients other agencies introduced for the agency’s listings: the introducer and the target, never the client',
        querystring: PageQuery,
        response: { 200: LeadIntroductionPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.listLeadIntroductions(ctx, req.query)),
  );

  app.get(
    '/v1/crm/lead-routing',
    {
      schema: {
        tags,
        operationId: 'crm.getLeadRouting',
        summary: 'The agency’s lead assignment rule',
        response: { 200: LeadRoutingDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.getLeadRouting(ctx)),
  );

  app.put(
    '/v1/crm/lead-routing',
    {
      schema: {
        tags,
        operationId: 'crm.updateLeadRouting',
        summary: 'Set the lead assignment rule: unassigned, round robin over agents, or the listing’s agent (admins)',
        body: UpdateLeadRoutingBody,
        response: { 200: LeadRoutingDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => crm.updateLeadRouting(ctx, req.body)),
  );
}
