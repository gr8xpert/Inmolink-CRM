import {
  CLIENT_PROFILE_LIMITS,
  ClientProfileDto,
  ClientProfilePage,
  ClientProfileParams,
  ContactParams,
  CreateClientProfileBody,
  PageQuery,
  SavedSearchBody,
  SavedSearchDto,
  SavedSearchList,
  SavedSearchParams,
  UpdateClientProfileBody,
} from '@inmolink/contracts';
import * as matching from '@inmolink/core/modules/matching';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'matching.saved-searches.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'matching.saved-searches.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'matching.saved-searches.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'matching.saved-searches.write.user', scope: 'user', limit: 60, windowSeconds: 60 },
];

const PROFILE_READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'matching.client-profiles.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'matching.client-profiles.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const PROFILE_WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'matching.client-profiles.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'matching.client-profiles.write.user', scope: 'user', limit: 60, windowSeconds: 60 },
];

const tags = ['matching'];

/**
 * Saved searches (S5-06, PLAN §7 M9): the caller's own searches with alerts on new listings, price drops and returns
 * to the market. Per caller: every answer is `no-store`.
 */
export async function matchingRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/saved-searches',
    {
      schema: {
        tags,
        operationId: 'matching.listSavedSearches',
        summary: 'The caller’s saved searches, oldest first (at most 50)',
        response: { 200: SavedSearchList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => matching.listSavedSearches(ctx)),
  );

  app.post(
    '/v1/saved-searches',
    {
      schema: {
        tags,
        operationId: 'matching.createSavedSearch',
        summary: 'Save a search with alerts (201; at most 50 per member)',
        body: SavedSearchBody,
        response: { 201: SavedSearchDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) =>
      reply.code(201).send(await app.withCtx(req, (ctx) => matching.createSavedSearch(ctx, req.body))),
  );

  app.put(
    '/v1/saved-searches/:id',
    {
      schema: {
        tags,
        operationId: 'matching.updateSavedSearch',
        summary: 'Replace one of the caller’s saved searches',
        params: SavedSearchParams,
        body: SavedSearchBody,
        response: { 200: SavedSearchDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => matching.updateSavedSearch(ctx, req.params.id, req.body)),
  );

  app.delete(
    '/v1/saved-searches/:id',
    {
      schema: {
        tags,
        operationId: 'matching.deleteSavedSearch',
        summary: 'Delete one of the caller’s saved searches and its alerts',
        params: SavedSearchParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withCtx(req, (ctx) => matching.deleteSavedSearch(ctx, req.params.id));
      return reply.code(204).send(null);
    },
  );

  /*
   * R2-02a, client profiles (PLAN §7 M9): what a client (a CRM contact) is looking for and how the match engine works
   * it. The owning contact's rule (crm contacts read / write); internal client data, never in Client Mode.
   */
  app.get(
    '/v1/crm/contacts/:id/profiles',
    {
      schema: {
        tags,
        operationId: 'matching.listClientProfiles',
        summary: 'A contact’s client profiles, oldest first',
        params: ContactParams,
        querystring: PageQuery,
        response: { 200: ClientProfilePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: PROFILE_READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => matching.listClientProfiles(ctx, req.params.id, req.query)),
  );

  app.post(
    '/v1/crm/contacts/:id/profiles',
    {
      schema: {
        tags,
        operationId: 'matching.createClientProfile',
        summary: `Add a client profile to a contact (201; at most ${CLIENT_PROFILE_LIMITS.perContact} per contact)`,
        params: ContactParams,
        body: CreateClientProfileBody,
        response: { 201: ClientProfileDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: PROFILE_WRITE_LIMITS },
    },
    async (req, reply) =>
      reply.code(201).send(await app.withCtx(req, (ctx) => matching.createClientProfile(ctx, req.params.id, req.body))),
  );

  app.get(
    '/v1/client-profiles/:id',
    {
      schema: {
        tags,
        operationId: 'matching.getClientProfile',
        summary: 'One client profile',
        params: ClientProfileParams,
        response: { 200: ClientProfileDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: PROFILE_READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => matching.getClientProfile(ctx, req.params.id)),
  );

  app.put(
    '/v1/client-profiles/:id',
    {
      schema: {
        tags,
        operationId: 'matching.updateClientProfile',
        summary: 'Replace a client profile at its version (409 VERSION_CONFLICT on another version)',
        params: ClientProfileParams,
        body: UpdateClientProfileBody,
        response: { 200: ClientProfileDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: PROFILE_WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => matching.updateClientProfile(ctx, req.params.id, req.body)),
  );

  app.delete(
    '/v1/client-profiles/:id',
    {
      schema: {
        tags,
        operationId: 'matching.deleteClientProfile',
        summary: 'Delete a client profile',
        params: ClientProfileParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: PROFILE_WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withCtx(req, (ctx) => matching.deleteClientProfile(ctx, req.params.id));
      return reply.code(204).send(null);
    },
  );
}
