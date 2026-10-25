import {
  AiSpendDto,
  FeatureFlagList,
  type GrantPlanBody,
  PlanGrantDto,
  type PriceLockBody,
  PriceLockIdDto,
  QueueHealthDto,
  type SetFeatureFlagBody,
  StaffAgencyBillingDto,
  StaffOperationDto,
  StaffOperationPage,
  type StaffOperationState,
  type StartStaffOperationBody,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * Staff console operations (S13-03): bulk operations, plan grants and price locks, feature flags, queue health and AI
 * spend. Transport only — the API authorizes (403 for the wrong staff role) and audits.
 */

export function fetchStaffOperations(
  session: SessionRef,
  q: { state?: StaffOperationState; cursor?: string } = {},
): Promise<ApiResult<StaffOperationPage>> {
  const qs = new URLSearchParams({
    limit: '50',
    ...(q.state ? { state: q.state } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  return apiRequest(session, `/v1/staff/operations?${qs}`, StaffOperationPage);
}

export function startStaffOperation(
  session: SessionRef,
  body: StartStaffOperationBody,
): Promise<ApiResult<StaffOperationDto>> {
  return apiRequest(session, '/v1/staff/operations', StaffOperationDto, { method: 'POST', body });
}

export function cancelStaffOperation(session: SessionRef, id: string): Promise<ApiResult<StaffOperationDto>> {
  return apiRequest(session, `/v1/staff/operations/${encodeURIComponent(id)}/cancel`, StaffOperationDto, {
    method: 'POST',
  });
}

export function fetchAgencyBilling(session: SessionRef, agencyId: string): Promise<ApiResult<StaffAgencyBillingDto>> {
  return apiRequest(session, `/v1/staff/agencies/${encodeURIComponent(agencyId)}/billing`, StaffAgencyBillingDto);
}

export function grantPlan(session: SessionRef, body: GrantPlanBody): Promise<ApiResult<PlanGrantDto>> {
  return apiRequest(session, '/v1/staff/plan-grants', PlanGrantDto, { method: 'POST', body });
}

export function revokePlanGrant(
  session: SessionRef,
  id: string,
  body: { reason: string },
): Promise<ApiResult<PlanGrantDto>> {
  return apiRequest(session, `/v1/staff/plan-grants/${encodeURIComponent(id)}/revoke`, PlanGrantDto, {
    method: 'POST',
    body,
  });
}

export function setPriceLock(session: SessionRef, body: PriceLockBody): Promise<ApiResult<PriceLockIdDto>> {
  return apiRequest(session, '/v1/staff/price-locks', PriceLockIdDto, { method: 'PUT', body });
}

export function fetchFeatureFlags(session: SessionRef): Promise<ApiResult<FeatureFlagList>> {
  return apiRequest(session, '/v1/staff/feature-flags', FeatureFlagList);
}

export function setFeatureFlag(
  session: SessionRef,
  key: string,
  body: SetFeatureFlagBody,
): Promise<ApiResult<FeatureFlagList>> {
  return apiRequest(session, `/v1/staff/feature-flags/${encodeURIComponent(key)}`, FeatureFlagList, {
    method: 'PUT',
    body,
  });
}

export function fetchQueueHealth(session: SessionRef): Promise<ApiResult<QueueHealthDto>> {
  return apiRequest(session, '/v1/staff/queues/health', QueueHealthDto);
}

export function fetchAiSpend(session: SessionRef, month?: string): Promise<ApiResult<AiSpendDto>> {
  const qs = month ? `?${new URLSearchParams({ month })}` : '';
  return apiRequest(session, `/v1/staff/ai-spend${qs}`, AiSpendDto);
}
