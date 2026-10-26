import { MigrationValidationDto, MigrationValidationPage, type MigrationValidationStatus } from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * Staff console: the legacy migration's validation reports (S14-03). Transport only — the API authorizes (403 for
 * anyone who is not active staff).
 */

export function fetchValidationReports(
  session: SessionRef,
  q: { status?: MigrationValidationStatus; cursor?: string } = {},
): Promise<ApiResult<MigrationValidationPage>> {
  const qs = new URLSearchParams({
    limit: '50',
    ...(q.status ? { status: q.status } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  return apiRequest(session, `/v1/staff/migration/validations?${qs}`, MigrationValidationPage);
}

export function fetchValidationReport(session: SessionRef, id: string): Promise<ApiResult<MigrationValidationDto>> {
  return apiRequest(session, `/v1/staff/migration/validations/${encodeURIComponent(id)}`, MigrationValidationDto);
}
