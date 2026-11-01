import { ConsentRecordList, RetentionSettingsDto, type UpdateRetentionSettingsBody } from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * GDPR calls of the dashboard (S16-F5): the agency's retention period and a contact's consent history, as the
 * signed-in member. Transport only: the API decides who may read or change them.
 */

/** `GET /v1/agency/retention` (admins). */
export function fetchRetention(session: SessionRef): Promise<ApiResult<RetentionSettingsDto>> {
  return apiRequest(session, '/v1/agency/retention', RetentionSettingsDto);
}

/** `PUT /v1/agency/retention`: a fresh second-factor code travels in the body and the API checks it. */
export function saveRetention(
  session: SessionRef,
  body: UpdateRetentionSettingsBody,
): Promise<ApiResult<RetentionSettingsDto>> {
  return apiRequest(session, '/v1/agency/retention', RetentionSettingsDto, { method: 'PUT', body });
}

/** `GET /v1/crm/contacts/:id/consents`: newest first, at most `CONSENT_HISTORY_LIMIT`. */
export function fetchContactConsents(session: SessionRef, contactId: string): Promise<ApiResult<ConsentRecordList>> {
  return apiRequest(session, `/v1/crm/contacts/${encodeURIComponent(contactId)}/consents`, ConsentRecordList);
}
