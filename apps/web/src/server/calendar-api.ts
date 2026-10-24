import {
  CalendarEventDto,
  CalendarEventPage,
  CalendarFeedDto,
  CalendarFeedSecretDto,
  type CreateCalendarEventBody,
  type UpdateCalendarEventBody,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/** CRM calendar calls of the dashboard (S10-06), as the signed-in member: events, and the member's ICS feed URL. */

export interface CalendarListOptions {
  from: Date;
  to: Date;
  attendee: 'me' | 'any';
  cursor?: string | undefined;
}

export function fetchCalendarEvents(
  session: SessionRef,
  o: CalendarListOptions,
): Promise<ApiResult<CalendarEventPage>> {
  const q = new URLSearchParams({
    limit: '100',
    from: o.from.toISOString(),
    to: o.to.toISOString(),
    attendee: o.attendee,
  });
  if (o.cursor) q.set('cursor', o.cursor);
  return apiRequest(session, `/v1/crm/calendar/events?${q.toString()}`, CalendarEventPage);
}

export function createCalendarEvent(
  session: SessionRef,
  body: CreateCalendarEventBody,
  idempotencyKey: string,
): Promise<ApiResult<CalendarEventDto>> {
  return apiRequest(session, '/v1/crm/calendar/events', CalendarEventDto, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function updateCalendarEvent(
  session: SessionRef,
  id: string,
  body: UpdateCalendarEventBody,
): Promise<ApiResult<CalendarEventDto>> {
  return apiRequest(session, `/v1/crm/calendar/events/${encodeURIComponent(id)}`, CalendarEventDto, {
    method: 'PATCH',
    body,
  });
}

export function fetchCalendarFeed(session: SessionRef): Promise<ApiResult<CalendarFeedDto>> {
  return apiRequest(session, '/v1/crm/calendar/feed', CalendarFeedDto);
}

export function rotateCalendarFeed(session: SessionRef): Promise<ApiResult<CalendarFeedSecretDto>> {
  return apiRequest(session, '/v1/crm/calendar/feed', CalendarFeedSecretDto, { method: 'POST' });
}

export function revokeCalendarFeed(session: SessionRef): Promise<ApiResult<CalendarFeedDto>> {
  return apiRequest(session, '/v1/crm/calendar/feed', CalendarFeedDto, { method: 'DELETE' });
}
