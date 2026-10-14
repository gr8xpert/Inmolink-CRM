import {
  AddAliasInput,
  AliasParams,
  CatalogAliasParams,
  CatalogItemParams,
  CatalogKindParams,
  CreateLocationInput,
  LocationParams,
  ReorderCatalogInput,
  ReorderLocationsInput,
  StaffCatalogItemDto,
  StaffLocationDto,
  TaxonomyDto,
  UpdateCatalogItemInput,
  UpdateLocationInput,
} from '@inmolink/contracts';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.taxonomy.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'staff.taxonomy.read.user', scope: 'user', limit: 300, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.taxonomy.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'staff.taxonomy.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
];

const NoContent = z.null().describe('No content');
const tags = ['staff', 'taxonomy'];

/**
 * Staff taxonomy admin (S2-04): the tree editor API. `withStaffCtx` answers 403 to anyone who is not
 * active staff; writes are for super admins and data ops (`staff.taxonomy.write`) and are audited.
 * Responses are never cached: the editor must see its own save.
 */
export async function staffTaxonomyRoutes(app: FastifyZod): Promise<void> {
  const staff = [app.requireSession];

  app.get(
    '/v1/staff/taxonomy',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffGetTaxonomy',
        summary: 'The whole taxonomy in the staff locale, uncached (tree editor)',
        response: { 200: TaxonomyDto },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withStaffCtx(req, 'taxonomy.staffGetTaxonomy', (ctx) => taxonomy.getStaffTaxonomy(ctx));
    },
  );

  app.get(
    '/v1/staff/taxonomy/locations/:id',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffGetLocation',
        summary: 'One location with all translations, aliases and its polygon (GeoJSON)',
        params: LocationParams,
        response: { 200: StaffLocationDto },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withStaffCtx(req, 'taxonomy.staffGetLocation', (ctx) => taxonomy.getStaffLocation(ctx, req.params.id));
    },
  );

  app.post(
    '/v1/staff/taxonomy/locations',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffCreateLocation',
        summary: 'Create a location (last among its siblings)',
        body: CreateLocationInput,
        response: { 201: StaffLocationDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const dto = await app.withStaffCtx(req, 'taxonomy.staffCreateLocation', (ctx) =>
        taxonomy.createStaffLocation(ctx, req.body),
      );
      return reply.code(201).send(dto);
    },
  );

  app.patch(
    '/v1/staff/taxonomy/locations/:id',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffUpdateLocation',
        summary: 'Change the code, centroid, polygon or translations of a location',
        params: LocationParams,
        body: UpdateLocationInput,
        response: { 200: StaffLocationDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'taxonomy.staffUpdateLocation', (ctx) =>
        taxonomy.updateStaffLocation(ctx, req.params.id, req.body),
      ),
  );

  app.put(
    '/v1/staff/taxonomy/locations-order',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffReorderLocations',
        summary: 'Set the order of one parent: every child, once',
        body: ReorderLocationsInput,
        response: { 204: NoContent },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withStaffCtx(req, 'taxonomy.staffReorderLocations', (ctx) =>
        taxonomy.reorderStaffLocations(ctx, req.body),
      );
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/staff/taxonomy/locations/:id/aliases',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffAddLocationAlias',
        summary: 'Map a feed spelling to the location',
        params: LocationParams,
        body: AddAliasInput,
        response: { 201: StaffLocationDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const dto = await app.withStaffCtx(req, 'taxonomy.staffAddLocationAlias', (ctx) =>
        taxonomy.addStaffLocationAlias(ctx, req.params.id, req.body),
      );
      return reply.code(201).send(dto);
    },
  );

  app.delete(
    '/v1/staff/taxonomy/locations/:id/aliases/:aliasId',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffRemoveLocationAlias',
        summary: 'Remove a feed spelling from the location',
        params: AliasParams,
        response: { 200: StaffLocationDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'taxonomy.staffRemoveLocationAlias', (ctx) =>
        taxonomy.removeStaffLocationAlias(ctx, req.params.id, req.params.aliasId),
      ),
  );

  app.get(
    '/v1/staff/taxonomy/catalog/:kind/:scope/:id',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffGetCatalogItem',
        summary: 'A property type, feature or group with all translations (and aliases of an item)',
        params: CatalogItemParams,
        response: { 200: StaffCatalogItemDto },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withStaffCtx(req, 'taxonomy.staffGetCatalogItem', (ctx) =>
        taxonomy.getStaffCatalogItem(ctx, req.params.kind, req.params.scope, req.params.id),
      );
    },
  );

  app.put(
    '/v1/staff/taxonomy/catalog-order',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffReorderCatalog',
        summary: 'Set the order of the groups of a kind, or of the items of one group',
        body: ReorderCatalogInput,
        response: { 204: NoContent },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withStaffCtx(req, 'taxonomy.staffReorderCatalog', (ctx) => taxonomy.reorderStaffCatalog(ctx, req.body));
      return reply.code(204).send(null);
    },
  );

  app.put(
    '/v1/staff/taxonomy/catalog/:id',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffUpdateCatalogItem',
        summary: 'Replace the translations of a property type, feature or group',
        params: LocationParams,
        body: UpdateCatalogItemInput,
        response: { 200: StaffCatalogItemDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'taxonomy.staffUpdateCatalogItem', (ctx) =>
        taxonomy.updateStaffCatalogItem(ctx, req.params.id, req.body),
      ),
  );

  app.post(
    '/v1/staff/taxonomy/catalog/:kind/:id/aliases',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffAddCatalogAlias',
        summary: 'Map a feed spelling to a property type or feature',
        params: CatalogKindParams,
        body: AddAliasInput,
        response: { 201: StaffCatalogItemDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const dto = await app.withStaffCtx(req, 'taxonomy.staffAddCatalogAlias', (ctx) =>
        taxonomy.addStaffCatalogAlias(ctx, req.params.kind, req.params.id, req.body),
      );
      return reply.code(201).send(dto);
    },
  );

  app.delete(
    '/v1/staff/taxonomy/catalog/:kind/:id/aliases/:aliasId',
    {
      schema: {
        tags,
        operationId: 'taxonomy.staffRemoveCatalogAlias',
        summary: 'Remove a feed spelling from a property type or feature',
        params: CatalogAliasParams,
        response: { 200: StaffCatalogItemDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'taxonomy.staffRemoveCatalogAlias', (ctx) =>
        taxonomy.removeStaffCatalogAlias(ctx, req.params.kind, req.params.id, req.params.aliasId),
      ),
  );
}
