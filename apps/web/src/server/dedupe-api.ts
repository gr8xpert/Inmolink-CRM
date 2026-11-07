import {
  DedupeClusterPage,
  DedupeDisputeDto,
  DedupeDisputePage,
  type DedupeDisputeStatus,
  DedupeReviewMoveDto,
  DedupeReviewPage,
  type DedupeReviewStatus,
  type OpenDedupeDisputeBody,
  type ResolveDedupeDisputeBody,
  StaffDedupeDisputeDto,
  StaffDedupeDisputePage,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/** Duplicate listings (R2-03b): the review queue, clustered listings and disputes; the staff dispute queue. Transport only. */

const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
};

export function fetchDuplicateReviews(
  session: SessionRef,
  o: { status: DedupeReviewStatus; cursor?: string },
): Promise<ApiResult<DedupeReviewPage>> {
  return apiRequest(session, `/v1/duplicates/reviews?${qs({ limit: 25, ...o })}`, DedupeReviewPage);
}

export function decideDuplicateReview(
  session: SessionRef,
  id: string,
  move: 'confirm' | 'not-duplicate',
): Promise<ApiResult<DedupeReviewMoveDto>> {
  return apiRequest(session, `/v1/duplicates/reviews/${encodeURIComponent(id)}/${move}`, DedupeReviewMoveDto, {
    method: 'POST',
  });
}

export function fetchDuplicateClusters(session: SessionRef, cursor?: string): Promise<ApiResult<DedupeClusterPage>> {
  return apiRequest(session, `/v1/duplicates/clusters?${qs({ limit: 25, cursor })}`, DedupeClusterPage);
}

export function fetchDuplicateDisputes(session: SessionRef): Promise<ApiResult<DedupeDisputePage>> {
  return apiRequest(session, `/v1/duplicates/disputes?${qs({ limit: 25 })}`, DedupeDisputePage);
}

export function openDuplicateDispute(
  session: SessionRef,
  body: OpenDedupeDisputeBody,
): Promise<ApiResult<DedupeDisputeDto>> {
  return apiRequest(session, '/v1/duplicates/disputes', DedupeDisputeDto, { method: 'POST', body });
}

export function fetchStaffDuplicateDisputes(
  session: SessionRef,
  o: { status: DedupeDisputeStatus; cursor?: string },
): Promise<ApiResult<StaffDedupeDisputePage>> {
  return apiRequest(session, `/v1/staff/duplicates/disputes?${qs({ limit: 50, ...o })}`, StaffDedupeDisputePage);
}

export function resolveDuplicateDispute(
  session: SessionRef,
  id: string,
  body: ResolveDedupeDisputeBody,
): Promise<ApiResult<StaffDedupeDisputeDto>> {
  return apiRequest(session, `/v1/staff/duplicates/disputes/${encodeURIComponent(id)}/resolve`, StaffDedupeDisputeDto, {
    method: 'POST',
    body,
  });
}
