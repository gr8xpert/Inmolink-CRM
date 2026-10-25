import {
  MarkAllNotificationsReadDto,
  MarkNotificationsReadDto,
  NotificationPage,
  NotificationPreferenceDto,
  NotificationPreferencesDto,
  type NotificationType,
  UnreadCountDto,
  type UpdateNotificationPreferenceBody,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/** Notification calls of the dashboard (S12-F1), as the signed-in member: transport only. */

export function fetchNotifications(
  session: SessionRef,
  o: { limit: number; cursor?: string | undefined; unread?: boolean | undefined },
): Promise<ApiResult<NotificationPage>> {
  const q = new URLSearchParams({ limit: String(o.limit) });
  if (o.cursor) q.set('cursor', o.cursor);
  if (o.unread) q.set('unread', 'true');
  return apiRequest(session, `/v1/notifications?${q}`, NotificationPage);
}

export function fetchUnreadCount(session: SessionRef): Promise<ApiResult<UnreadCountDto>> {
  return apiRequest(session, '/v1/notifications/unread-count', UnreadCountDto);
}

export function markNotificationsRead(
  session: SessionRef,
  items: { id: string; createdAt: string }[],
): Promise<ApiResult<MarkNotificationsReadDto>> {
  return apiRequest(session, '/v1/notifications/read', MarkNotificationsReadDto, { method: 'POST', body: { items } });
}

export function markAllNotificationsRead(session: SessionRef): Promise<ApiResult<MarkAllNotificationsReadDto>> {
  return apiRequest(session, '/v1/notifications/read-all', MarkAllNotificationsReadDto, { method: 'POST' });
}

export function fetchNotificationPreferences(session: SessionRef): Promise<ApiResult<NotificationPreferencesDto>> {
  return apiRequest(session, '/v1/notifications/preferences', NotificationPreferencesDto);
}

export function updateNotificationPreference(
  session: SessionRef,
  type: NotificationType,
  body: UpdateNotificationPreferenceBody,
): Promise<ApiResult<NotificationPreferenceDto>> {
  return apiRequest(session, `/v1/notifications/preferences/${type}`, NotificationPreferenceDto, {
    method: 'PATCH',
    body,
  });
}
