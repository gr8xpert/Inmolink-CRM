import {
  AiSpendDto,
  AiSpendQuery,
  FeatureFlagList,
  FeatureFlagParams,
  GrantPlanBody,
  MigrationValidationDto,
  MigrationValidationListQuery,
  MigrationValidationPage,
  MigrationValidationParams,
  PlanGrantDto,
  PlanGrantParams,
  PriceLockBody,
  PriceLockIdDto,
  QueueHealthDto,
  RevokePlanGrantBody,
  SetFeatureFlagBody,
  StaffAgencyBillingDto,
  StaffOperationDto,
  StaffOperationListQuery,
  StaffOperationPage,
  StaffOperationParams,
  StartStaffOperationBody,
  TenantParams,
} from '@inmolink/contracts';
import * as admin from '@inmolink/core/modules/admin';
import * as migration from '@inmolink/core/modules/migration';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.admin.read.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'staff.admin.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.admin.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'staff.admin.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
];

const tags = ['staff', 'admin'];

/**
 * Staff console operations (S13-03, PLAN §7 M20): bulk operations as audited, cancellable jobs with progress; an
 * agency's plan grants and price locks; feature flags; queue health; AI spend per tenant; the legacy migration's
 * validation reports (S14-03). `withStaffCtx` answers 403 to
 * anyone who is not active staff; the admin and billing policies decide which staff role may do what. Never cached.
 */
export async function adminRoutes(app: FastifyZod): Promise<void> {
  const staff = [app.requireSession];
  // ---- bulk operations ----

  app.get(
    '/v1/staff/operations',
    {
      schema: {
        tags,
        operationId: 'admin.listStaffOperations',
        summary: 'Bulk operations, newest first, with their state and progress',
        querystring: StaffOperationListQuery,
        response: { 200: StaffOperationPage },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'admin.listStaffOperations', (ctx) => admin.listOperations(ctx, req.query)),
  );

  app.post(
    '/v1/staff/operations',
    {
      schema: {
        tags,
        operationId: 'admin.startStaffOperation',
        summary:
          'Start a bulk operation (reindex, rebuild read models, re-import, replay outbox) for one agency or all; audited, one at a time per kind and scope',
        body: StartStaffOperationBody,
        response: { 200: StaffOperationDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'admin.startStaffOperation', (ctx) => admin.startOperation(ctx, req.body)),
  );

  app.get(
    '/v1/staff/operations/:id',
    {
      schema: {
        tags,
        operationId: 'admin.getStaffOperation',
        summary: "A bulk operation's state and progress",
        params: StaffOperationParams,
        response: { 200: StaffOperationDto },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'admin.getStaffOperation', (ctx) => admin.getOperation(ctx, req.params.id)),
  );

  app.post(
    '/v1/staff/operations/:id/cancel',
    {
      schema: {
        tags,
        operationId: 'admin.cancelStaffOperation',
        summary: 'Cancel a bulk operation: queued ones end now, running ones before their next step (audited)',
        params: StaffOperationParams,
        response: { 200: StaffOperationDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'admin.cancelStaffOperation', (ctx) => admin.cancelOperation(ctx, req.params.id)),
  );

  // ---- plan grants and price locks ----

  app.get(
    '/v1/staff/agencies/:agencyId/billing',
    {
      schema: {
        tags,
        operationId: 'admin.getAgencyBilling',
        summary: "An agency's plan grants (trials, staff grants, revoked ones) and founding price locks",
        params: TenantParams,
        response: { 200: StaffAgencyBillingDto },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'admin.getAgencyBilling', (ctx) => admin.listAgencyBilling(ctx, req.params.agencyId)),
  );

  app.post(
    '/v1/staff/plan-grants',
    {
      schema: {
        tags,
        operationId: 'admin.grantPlan',
        summary: 'Put an agency on a plan until a date without a subscription (super admins; audited)',
        body: GrantPlanBody,
        response: { 200: PlanGrantDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'admin.grantPlan', (ctx) => admin.grantPlan(ctx, req.body)),
  );

  app.post(
    '/v1/staff/plan-grants/:id/revoke',
    {
      schema: {
        tags,
        operationId: 'admin.revokePlanGrant',
        summary: 'End a plan grant now, with a reason (super admins; audited)',
        params: PlanGrantParams,
        body: RevokePlanGrantBody,
        response: { 200: PlanGrantDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'admin.revokePlanGrant', (ctx) => admin.revokePlanGrant(ctx, req.params.id, req.body)),
  );

  app.put(
    '/v1/staff/price-locks',
    {
      schema: {
        tags,
        operationId: 'admin.setPriceLock',
        summary: "Set an agency's founding price for a plan price until a date (super admins; audited)",
        body: PriceLockBody,
        response: { 200: PriceLockIdDto },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'admin.setPriceLock', (ctx) => admin.setPriceLock(ctx, req.body)),
  );

  // ---- feature flags ----

  app.get(
    '/v1/staff/feature-flags',
    {
      schema: {
        tags,
        operationId: 'admin.listFeatureFlags',
        summary: 'Every feature flag with its default and per-agency overrides',
        response: { 200: FeatureFlagList },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'admin.listFeatureFlags', (ctx) => admin.listFeatureFlags(ctx)),
  );

  app.put(
    '/v1/staff/feature-flags/:key',
    {
      schema: {
        tags,
        operationId: 'admin.setFeatureFlag',
        summary: "Set a flag's default, or one agency's override (super admins; audited; live within 60 s)",
        params: FeatureFlagParams,
        body: SetFeatureFlagBody,
        response: { 200: FeatureFlagList },
      },
      onRequest: staff,
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'admin.setFeatureFlag', (ctx) => admin.setFeatureFlag(ctx, req.params.key, req.body)),
  );

  // ---- queue health and AI spend ----

  app.get(
    '/v1/staff/queues/health',
    {
      schema: {
        tags,
        operationId: 'admin.getQueueHealth',
        summary: 'Waiting, active, delayed, failed and dead-lettered jobs per worker pool',
        response: { 200: QueueHealthDto },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    (req) => admin.getQueueHealth((fn) => app.withStaffCtx(req, 'admin.getQueueHealth', fn), req.log),
  );

  app.get(
    '/v1/staff/ai-spend',
    {
      schema: {
        tags,
        operationId: 'admin.getAiSpend',
        summary: "A month's AI spend per agency, highest first",
        querystring: AiSpendQuery,
        response: { 200: AiSpendDto },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withStaffCtx(req, 'admin.getAiSpend', (ctx) => admin.getAiSpend(ctx, req.query)),
  );

  // ---- legacy migration validation reports (S14-03) ----

  app.get(
    '/v1/staff/migration/validations',
    {
      schema: {
        tags: ['staff', 'migration'],
        operationId: 'migration.listValidationReports',
        summary: "Each legacy agency's latest migration validation report (PASS / FAIL), newest first",
        querystring: MigrationValidationListQuery,
        response: { 200: MigrationValidationPage },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'migration.listValidationReports', (ctx) =>
        migration.listValidationReports(ctx, req.query),
      ),
  );

  app.get(
    '/v1/staff/migration/validations/:id',
    {
      schema: {
        tags: ['staff', 'migration'],
        operationId: 'migration.getValidationReport',
        summary: 'A migration validation report: counts per entity, images, sampled field diffs and URL checks',
        params: MigrationValidationParams,
        response: { 200: MigrationValidationDto },
      },
      onRequest: staff,
      config: { rateLimit: READ_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'migration.getValidationReport', (ctx) =>
        migration.getValidationReport(ctx, req.params.id),
      ),
  );
}
