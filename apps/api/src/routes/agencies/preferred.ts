import {
  AddPreferredAgencyBody,
  DirectorySearchQuery,
  DirectorySearchResult,
  PageQuery,
  PreferredAgencyDto,
  PreferredAgencyPage,
  PreferredAgencyParams,
  UpdatePreferredAgencyBody,
} from '@inmolink/contracts';
import * as agencies from '@inmolink/core/modules/agencies';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'agencies.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'agencies.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'agencies.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'agencies.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
];
/** The directory lists other tenants: tighter, also per agency, so it cannot be walked quickly. */
const DIRECTORY_LIMITS: readonly RateLimitRule[] = [
  { name: 'agencies.directory.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'agencies.directory.user', scope: 'user', limit: 30, windowSeconds: 60 },
  { name: 'agencies.directory.tenant', scope: 'tenant', limit: 100, windowSeconds: 3_600 },
];

/** Preferred agencies and the agency directory (S1-07). */
export async function preferredAgencyRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/agency/preferred-agencies',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.listPreferredAgencies',
        summary: 'The agency’s preferred agencies with their internal notes, oldest first (members)',
        querystring: PageQuery,
        response: { 200: PreferredAgencyPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => agencies.listPreferredAgencies(ctx, req.query)),
  );

  app.post(
    '/v1/agency/preferred-agencies',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.addPreferredAgency',
        summary: 'Add a verified agency to the preferred list (admins of a verified agency)',
        body: AddPreferredAgencyBody,
        response: { 201: PreferredAgencyDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) =>
      reply.code(201).send(await app.withCtx(req, (ctx) => agencies.addPreferredAgency(ctx, req.body))),
  );

  app.patch(
    '/v1/agency/preferred-agencies/:agencyId',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.updatePreferredAgency',
        summary: 'Replace the internal note on a preferred agency (admins)',
        params: PreferredAgencyParams,
        body: UpdatePreferredAgencyBody,
        response: { 200: PreferredAgencyDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => agencies.updatePreferredAgency(ctx, req.params, req.body)),
  );

  app.delete(
    '/v1/agency/preferred-agencies/:agencyId',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.removePreferredAgency',
        summary: 'Remove an agency from the preferred list; it loses PREFERRED listings at once (admins)',
        params: PreferredAgencyParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withCtx(req, (ctx) => agencies.removePreferredAgency(ctx, req.params));
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/v1/agency-directory',
    {
      schema: {
        tags: ['agencies'],
        operationId: 'agencies.searchAgencyDirectory',
        summary: 'Verified agencies whose name contains `q`: name and kind only, at most 20 (verified agencies)',
        querystring: DirectorySearchQuery,
        response: { 200: DirectorySearchResult },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: DIRECTORY_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => agencies.searchAgencyDirectory(ctx, req.query)),
  );
}
