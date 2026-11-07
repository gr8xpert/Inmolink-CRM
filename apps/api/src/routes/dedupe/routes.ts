import {
  DedupeClusterPage,
  DedupeDisputeDto,
  DedupeDisputePage,
  DedupeDisputeParams,
  DedupeReviewMoveDto,
  DedupeReviewPage,
  DedupeReviewParams,
  ListDedupeClustersQuery,
  ListDedupeDisputesQuery,
  ListDedupeReviewsQuery,
  OpenDedupeDisputeBody,
  ResolveDedupeDisputeBody,
  StaffDedupeDisputeDto,
  StaffDedupeDisputePage,
  StaffDedupeDisputesQuery,
} from '@inmolink/contracts';
import * as dedupe from '@inmolink/core/modules/dedupe';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'dedupe.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'dedupe.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'dedupe.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'dedupe.write.user', scope: 'user', limit: 60, windowSeconds: 60 },
];
const STAFF_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.dedupe.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'staff.dedupe.user', scope: 'user', limit: 300, windowSeconds: 60 },
];

const tags = ['dedupe'];

/**
 * Duplicate listings (R2-03b, PLAN §10): the agency's review queue of likely duplicates (0.7–0.9), its listings in a
 * duplicate cluster, and its disputes; the staff dispute queue. Per caller: every rule (who, what may be seen) is the
 * service's.
 */
export async function dedupeRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/duplicates/reviews',
    {
      schema: {
        tags,
        operationId: 'dedupe.listDuplicateReviews',
        summary: 'Likely duplicates of the agency’s listings to review (or decided ones), newest first',
        querystring: ListDedupeReviewsQuery,
        response: { 200: DedupeReviewPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => dedupe.listDuplicateReviews(ctx, req.query)),
  );

  for (const [verb, decision, summary] of [
    ['confirm', 'CONFIRMED', 'Confirm a pending pair is one property (the listings join one duplicate cluster)'],
    [
      'not-duplicate',
      'NOT_DUPLICATE',
      'Answer that a pending pair is not one property (final: the pair is never clustered again)',
    ],
  ] as const) {
    app.post(
      `/v1/duplicates/reviews/:id/${verb}`,
      {
        schema: {
          tags,
          operationId: verb === 'confirm' ? 'dedupe.confirmDuplicateReview' : 'dedupe.rejectDuplicateReview',
          summary,
          params: DedupeReviewParams,
          response: { 200: DedupeReviewMoveDto },
        },
        onRequest: [app.requireSession],
        config: { rateLimit: WRITE_LIMITS },
      },
      (req) => app.withCtx(req, (ctx) => dedupe.decideDuplicateReview(ctx, req.params.id, decision)),
    );
  }

  app.get(
    '/v1/duplicates/clusters',
    {
      schema: {
        tags,
        operationId: 'dedupe.listDuplicateClusters',
        summary: 'The agency’s listings in a duplicate cluster, with the members the caller may see in canonical order',
        querystring: ListDedupeClustersQuery,
        response: { 200: DedupeClusterPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => dedupe.listDuplicateClusters(ctx, req.query)),
  );

  app.get(
    '/v1/duplicates/disputes',
    {
      schema: {
        tags,
        operationId: 'dedupe.listDuplicateDisputes',
        summary: 'The agency’s disputes of its listings’ clustering, newest first',
        querystring: ListDedupeDisputesQuery,
        response: { 200: DedupeDisputePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => dedupe.listDuplicateDisputes(ctx, req.query)),
  );

  app.post(
    '/v1/duplicates/disputes',
    {
      schema: {
        tags,
        operationId: 'dedupe.openDuplicateDispute',
        summary:
          'Dispute the clustering of an own listing (not a duplicate, or it should be the canonical one); staff decide. One open dispute a listing: a repeat answers 409',
        body: OpenDedupeDisputeBody,
        response: { 200: DedupeDisputeDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => dedupe.openDuplicateDispute(ctx, req.body)),
  );

  // ── Staff ────────────────────────────────────────────────────────────────────────────────────

  app.get(
    '/v1/staff/duplicates/disputes',
    {
      schema: {
        tags: ['staff'],
        operationId: 'dedupe.listStaffDuplicateDisputes',
        summary: 'Every agency’s duplicate disputes by status, oldest first, with the cluster now',
        querystring: StaffDedupeDisputesQuery,
        response: { 200: StaffDedupeDisputePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'dedupe.listStaffDisputes', (ctx) => dedupe.listStaffDuplicateDisputes(ctx, req.query)),
  );

  app.post(
    '/v1/staff/duplicates/disputes/:id/resolve',
    {
      schema: {
        tags: ['staff'],
        operationId: 'dedupe.resolveDuplicateDispute',
        summary: 'Uphold (applied to the clusters by the worker) or reject an open dispute, with a note; audited',
        params: DedupeDisputeParams,
        body: ResolveDedupeDisputeBody,
        response: { 200: StaffDedupeDisputeDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'dedupe.resolveDispute', (ctx) =>
        dedupe.resolveDuplicateDispute(ctx, req.params.id, req.body),
      ),
  );
}
