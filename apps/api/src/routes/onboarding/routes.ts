import { OnboardingChecklistDto, StaffOnboardingDto, TenantParams } from '@inmolink/contracts';
import * as onboarding from '@inmolink/core/modules/onboarding';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'onboarding.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'onboarding.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const STAFF_LIMITS: readonly RateLimitRule[] = [
  { name: 'staff.onboarding.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'staff.onboarding.user', scope: 'user', limit: 300, windowSeconds: 60 },
];

/**
 * Onboarding checklist (S13-04, PLAN §7 M21). Read-only: steps complete from the agency's events, never by a request.
 * The member's checklist under `/v1/onboarding`; an agency's progress for staff under `/v1/staff/agencies/:id/onboarding`
 * (`withStaffCtx`: 403 for non-staff).
 */
export async function onboardingRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/onboarding',
    {
      schema: {
        tags: ['onboarding'],
        operationId: 'onboarding.getOnboardingChecklist',
        summary: "The caller's onboarding checklist (the steps of their role, done or to do)",
        response: { 200: OnboardingChecklistDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => onboarding.getChecklist(ctx)),
  );

  app.get(
    '/v1/staff/agencies/:agencyId/onboarding',
    {
      schema: {
        tags: ['staff'],
        operationId: 'onboarding.getStaffOnboarding',
        summary: "An agency's onboarding progress (every step)",
        params: TenantParams,
        response: { 200: StaffOnboardingDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STAFF_LIMITS },
    },
    (req) =>
      app.withStaffCtx(req, 'onboarding.getStaffOnboarding', (ctx) => onboarding.getStaffOnboarding(ctx, req.params)),
  );
}
