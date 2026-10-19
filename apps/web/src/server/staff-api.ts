import {
  type AgencyStatus,
  ImpersonationDto,
  LiveImpersonationList,
  MemberPage,
  StaffAuditPage,
  type StaffAuditQuery,
  StaffMeDto,
  type StartImpersonationInput,
  TenantDetailDto,
  TenantPage,
} from '@inmolink/contracts';
import { cache } from 'react';
import { z } from 'zod';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * Staff console calls (S1-09). Every path is under `/v1/staff/`, so the token is always the staff
 * member's own, also while they impersonate someone. The API answers 403 to anyone else; pages turn
 * that into a 404.
 */

/** Once per render (S1-10 review): the shell and `requireStaff` share the answer. */
export function fetchStaffMe(session: SessionRef): Promise<ApiResult<StaffMeDto>> {
  return staffMeCached(session.userId, session.sessionVersion, session.mfaVerified);
}

const staffMeCached = cache((userId: string, sessionVersion: number, mfaVerified: boolean) =>
  apiRequest({ userId, sessionVersion, mfaVerified }, '/v1/staff/me', StaffMeDto),
);

export function fetchTenants(
  session: SessionRef,
  q: { q?: string; status?: AgencyStatus; cursor?: string },
): Promise<ApiResult<TenantPage>> {
  const qs = new URLSearchParams({
    limit: '50',
    ...(q.q ? { q: q.q } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  return apiRequest(session, `/v1/staff/agencies?${qs}`, TenantPage);
}

export function fetchTenant(session: SessionRef, agencyId: string): Promise<ApiResult<TenantDetailDto>> {
  return apiRequest(session, `/v1/staff/agencies/${encodeURIComponent(agencyId)}`, TenantDetailDto);
}

export function fetchTenantMembers(session: SessionRef, agencyId: string): Promise<ApiResult<MemberPage>> {
  return apiRequest(session, `/v1/staff/agencies/${encodeURIComponent(agencyId)}/members?limit=100`, MemberPage);
}

/** Support exempts a buyer-only agency from give-to-get, or ends it, with a reason (S5-05, S6-F1); the API audits it. */
export function setGiveToGetExemption(
  session: SessionRef,
  agencyId: string,
  change: { exempt: boolean; reason: string },
): Promise<ApiResult<TenantDetailDto>> {
  return apiRequest(session, `/v1/staff/agencies/${encodeURIComponent(agencyId)}/give-to-get`, TenantDetailDto, {
    method: 'PUT',
    body: change,
  });
}

/** The read is audited by the API (`staff.auditLog.read`). */
export function fetchStaffAuditLog(
  session: SessionRef,
  q: Partial<Omit<StaffAuditQuery, 'limit'>> & { limit?: number },
): Promise<ApiResult<StaffAuditPage>> {
  const qs = new URLSearchParams({ limit: String(q.limit ?? 50) });
  for (const key of ['agencyId', 'type', 'from', 'to', 'cursor'] as const) {
    const v = q[key];
    if (v) qs.set(key, v);
  }
  return apiRequest(session, `/v1/staff/audit-logs?${qs}`, StaffAuditPage);
}

export function startImpersonation(
  session: SessionRef,
  body: StartImpersonationInput,
): Promise<ApiResult<ImpersonationDto>> {
  return apiRequest(session, '/v1/staff/impersonations', ImpersonationDto, { method: 'POST', body });
}

export function endImpersonation(session: SessionRef, id: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/staff/impersonations/${encodeURIComponent(id)}/end`, z.null(), {
    method: 'POST',
  });
}

/** Every staff member's live session (super admins; others get 403). */
export function fetchLiveImpersonations(session: SessionRef): Promise<ApiResult<LiveImpersonationList>> {
  return apiRequest(session, '/v1/staff/impersonations', LiveImpersonationList);
}
