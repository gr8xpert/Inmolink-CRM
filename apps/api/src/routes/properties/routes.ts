import {
  BookmarkDto,
  BookmarkFolderBody,
  BookmarkFolderDto,
  BookmarkFolderList,
  BookmarkFolderParams,
  BookmarkPage,
  BookmarkParams,
  CreateBookmarkBody,
  CreateListingBody,
  ListBookmarksQuery,
  ListingBookmarkList,
  ListingBulkDto,
  ListingBulkParams,
  ListingContentDto,
  ListingDto,
  ListingOverrideDto,
  ListingOverrideList,
  ListingOverrideParams,
  ListingOverrideTargetParams,
  ListingPage,
  ListingParams,
  ListingTranslationParams,
  ListingVersionQuery,
  ListingViewBody,
  ListingViewDto,
  ListingViewList,
  ListingViewParams,
  ListListingsQuery,
  PutListingOverrideBody,
  PutListingTranslationBody,
  SetListingFeaturesBody,
  StartListingBulkBody,
  UpdateBookmarkBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import * as properties from '@inmolink/core/modules/properties';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'properties.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'properties.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'properties.write.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'properties.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
  { name: 'properties.write.tenant', scope: 'tenant', limit: 1_200, windowSeconds: 60 },
];

/** Bulk actions are heavy (up to 5,000 listings each): a few per minute per member. */
const BULK_LIMITS: readonly RateLimitRule[] = [
  { name: 'properties.bulk.ip', scope: 'ip', limit: 60, windowSeconds: 60 },
  { name: 'properties.bulk.user', scope: 'user', limit: 10, windowSeconds: 60 },
  { name: 'properties.bulk.tenant', scope: 'tenant', limit: 30, windowSeconds: 60 },
];

/**
 * Listings (S3-02): the agency's own, plus shared ones other agencies can read (network view). Owner views
 * carry private fields (cadastral reference, exact position, notes), so no response is cached on the way.
 */
export async function propertiesRoutes(app: FastifyZod): Promise<void> {
  app.post(
    '/v1/listings',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.createListing',
        summary: 'Create a DRAFT, PRIVATE listing; commission and split default to the agency settings',
        body: CreateListingBody,
        response: { 201: ListingDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(await app.withCtx(req, (ctx) => properties.createListing(ctx, req.body)));
    },
  );

  app.get(
    '/v1/listings',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.listListings',
        summary: "The agency's listings: filters, sort (newest, oldest, updated, price), cursor ≤ 100, tags",
        querystring: ListListingsQuery,
        response: { 200: ListingPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.listListings(ctx, req.query));
    },
  );

  app.get(
    '/v1/listings/:id',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.getListing',
        summary: "A listing: the owner view for the agency's own, the network view for a shared one",
        params: ListingParams,
        response: { 200: ListingDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.getListing(ctx, req.params.id));
    },
  );

  app.patch(
    '/v1/listings/:id',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.updateListing',
        summary: 'Change a listing (optimistic `version`; status lifecycle; PUBLIC needs a CEE rating)',
        params: ListingParams,
        body: UpdateListingBody,
        response: { 200: ListingDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.updateListing(ctx, req.params.id, req.body));
    },
  );

  app.delete(
    '/v1/listings/:id',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.deleteListing',
        summary: 'Soft-delete a listing: it leaves the network and websites at once, restorable for 30 days',
        params: ListingParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await app.withCtx(req, (ctx) => properties.deleteListing(ctx, req.params.id));
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/listings/:id/restore',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.restoreListing',
        summary: 'Restore a deleted listing within 30 days',
        params: ListingParams,
        response: { 200: ListingDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.restoreListing(ctx, req.params.id));
    },
  );

  app.post(
    '/v1/listings/:id/confirm',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.confirmListing',
        summary: 'Confirm the listing is still on the market (S3-08): resets the 90/120-day clock, back on the network',
        params: ListingParams,
        response: { 200: ListingDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.confirmListing(ctx, req.params.id));
    },
  );

  // ---- Content (S3-05): the listing editor's translations and features ----

  app.get(
    '/v1/listings/:id/content',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.getListingContent',
        summary: "A listing's translations (per content locale, with origin) and feature ids",
        params: ListingParams,
        response: { 200: ListingContentDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.getListingContent(ctx, req.params.id));
    },
  );

  app.put(
    '/v1/listings/:id/translations/:locale',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.putListingTranslation',
        summary: "Write one locale's title, description and SEO text (optimistic listing `version`)",
        params: ListingTranslationParams,
        body: PutListingTranslationBody,
        response: { 200: ListingContentDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) =>
        properties.saveListingTranslation(ctx, req.params.id, req.params.locale, req.body),
      );
    },
  );

  app.delete(
    '/v1/listings/:id/translations/:locale',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.deleteListingTranslation',
        summary: "Remove one locale's text (optimistic listing `version`)",
        params: ListingTranslationParams,
        querystring: ListingVersionQuery,
        response: { 200: ListingContentDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) =>
        properties.deleteListingTranslation(ctx, req.params.id, req.params.locale, req.query.version),
      );
    },
  );

  app.put(
    '/v1/listings/:id/features',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.setListingFeatures',
        summary: "Replace the listing's features (optimistic listing `version`)",
        params: ListingParams,
        body: SetListingFeaturesBody,
        response: { 200: ListingContentDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.setListingFeatures(ctx, req.params.id, req.body));
    },
  );

  // ---- Saved views and bulk actions (S3-07) ----

  app.get(
    '/v1/listing-views',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.listListingViews',
        summary: "The caller's saved listing views (filters, sort, columns), by name",
        response: { 200: ListingViewList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.listListingViews(ctx));
    },
  );

  app.post(
    '/v1/listing-views',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.createListingView',
        summary: 'Save a listing view (≤ 50 per member, names unique)',
        body: ListingViewBody,
        response: { 201: ListingViewDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(await app.withCtx(req, (ctx) => properties.createListingView(ctx, req.body)));
    },
  );

  app.put(
    '/v1/listing-views/:id',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.updateListingView',
        summary: "Replace a saved view's name, filters, sort and columns",
        params: ListingViewParams,
        body: ListingViewBody,
        response: { 200: ListingViewDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.updateListingView(ctx, req.params.id, req.body));
    },
  );

  app.delete(
    '/v1/listing-views/:id',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.deleteListingView',
        summary: 'Delete a saved view',
        params: ListingViewParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await app.withCtx(req, (ctx) => properties.deleteListingView(ctx, req.params.id));
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/listing-bulk-actions',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.startListingBulkAction',
        summary: 'Change status, visibility, share scope, price (%), owner or tags of many listings (≤ 5,000) in a job',
        body: StartListingBulkBody,
        response: { 202: ListingBulkDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: BULK_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(202).send(await app.withCtx(req, (ctx) => properties.startBulkAction(ctx, req.body)));
    },
  );

  app.get(
    '/v1/listing-bulk-actions/:id',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.getListingBulkAction',
        summary: "A bulk action's progress: counters and the first failures",
        params: ListingBulkParams,
        response: { 200: ListingBulkDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.getBulkAction(ctx, req.params.id));
    },
  );

  // ---- Bookmarks (S3-09) ----

  app.get(
    '/v1/bookmark-folders',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.listBookmarkFolders',
        summary: "The caller's bookmark folders by name, with their sizes",
        response: { 200: BookmarkFolderList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.listBookmarkFolders(ctx));
    },
  );

  app.post(
    '/v1/bookmark-folders',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.createBookmarkFolder',
        summary: 'Create a bookmark folder (≤ 100 per member, names unique)',
        body: BookmarkFolderBody,
        response: { 201: BookmarkFolderDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(await app.withCtx(req, (ctx) => properties.createBookmarkFolder(ctx, req.body)));
    },
  );

  app.put(
    '/v1/bookmark-folders/:id',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.renameBookmarkFolder',
        summary: 'Rename a bookmark folder',
        params: BookmarkFolderParams,
        body: BookmarkFolderBody,
        response: { 200: BookmarkFolderDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.renameBookmarkFolder(ctx, req.params.id, req.body));
    },
  );

  app.delete(
    '/v1/bookmark-folders/:id',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.deleteBookmarkFolder',
        summary: 'Delete a bookmark folder and its bookmarks',
        params: BookmarkFolderParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await app.withCtx(req, (ctx) => properties.deleteBookmarkFolder(ctx, req.params.id));
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/v1/bookmark-folders/:id/bookmarks',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.listBookmarks',
        summary: "A folder's bookmarks, newest first; listings no longer visible are marked unavailable",
        params: BookmarkFolderParams,
        querystring: ListBookmarksQuery,
        response: { 200: BookmarkPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.listBookmarks(ctx, req.params.id, req.query));
    },
  );

  app.get(
    '/v1/listings/:id/bookmarks',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.listListingBookmarks',
        summary: "The caller's bookmarks of one listing (which folders hold it)",
        params: ListingParams,
        response: { 200: ListingBookmarkList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.listListingBookmarks(ctx, req.params.id));
    },
  );

  app.post(
    '/v1/bookmarks',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.createBookmark',
        summary: 'Bookmark a visible listing into one of your folders, with a note (≤ 500 per folder)',
        body: CreateBookmarkBody,
        response: { 201: BookmarkDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(await app.withCtx(req, (ctx) => properties.createBookmark(ctx, req.body)));
    },
  );

  app.patch(
    '/v1/bookmarks/:id',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.updateBookmark',
        summary: "Change a bookmark's note or move it to another folder",
        params: BookmarkParams,
        body: UpdateBookmarkBody,
        response: { 200: BookmarkDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => properties.updateBookmark(ctx, req.params.id, req.body));
    },
  );

  app.delete(
    '/v1/bookmarks/:id',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.deleteBookmark',
        summary: 'Remove a bookmark',
        params: BookmarkParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await app.withCtx(req, (ctx) => properties.deleteBookmark(ctx, req.params.id));
      return reply.code(204).send(null);
    },
  );
  // ---- Listing overrides (S3-10): the agency's own text for listings it presents -------------------------

  app.get(
    '/v1/listing-overrides/:targetKind/:targetId',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.listListingOverrides',
        summary: "The caller agency's overrides of a network listing, development or unit, every locale",
        params: ListingOverrideTargetParams,
        response: { 200: ListingOverrideList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) =>
        properties.listListingOverrides(ctx, req.params.targetKind, req.params.targetId),
      );
    },
  );

  app.put(
    '/v1/listing-overrides/:targetKind/:targetId/:locale',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.saveListingOverride',
        summary: "Override another agency's title and/or description in one locale, for the caller's channels",
        params: ListingOverrideParams,
        body: PutListingOverrideBody,
        response: { 200: ListingOverrideDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const { targetKind, targetId, locale } = req.params;
      return app.withCtx(req, (ctx) => properties.saveListingOverride(ctx, targetKind, targetId, locale, req.body));
    },
  );

  app.delete(
    '/v1/listing-overrides/:targetKind/:targetId/:locale',
    {
      schema: {
        tags: ['properties'],
        operationId: 'properties.deleteListingOverride',
        summary: "Remove an override: the caller's channels show the owner's text again",
        params: ListingOverrideParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const { targetKind, targetId, locale } = req.params;
      await app.withCtx(req, (ctx) => properties.deleteListingOverride(ctx, targetKind, targetId, locale));
      return reply.code(204).send(null);
    },
  );
}
