import {
  ListNotificationsQuery,
  MarkAllNotificationsReadDto,
  MarkNotificationsReadBody,
  MarkNotificationsReadDto,
  NotificationPage,
  NotificationPreferenceDto,
  NotificationPreferencesDto,
  NotificationTypeParams,
  UnreadCountDto,
  UpdateNotificationPreferenceBody,
} from '@inmolink/contracts';
import * as notifications from '@inmolink/core/modules/notifications';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

// the badge polls the count on focus / reconnect: reads are generous
const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'notifications.read.ip', scope: 'ip', limit: 900, windowSeconds: 60 },
  { name: 'notifications.read.user', scope: 'user', limit: 300, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'notifications.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'notifications.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
];

// "mark all read" rewrites up to 500 rows a call: a handful a minute is what a person clicks
const MARK_ALL_LIMITS: readonly RateLimitRule[] = [
  { name: 'notifications.readAll.ip', scope: 'ip', limit: 30, windowSeconds: 60 },
  { name: 'notifications.readAll.user', scope: 'user', limit: 10, windowSeconds: 60 },
];

const tags = ['notifications'];

/**
 * The caller's notifications (S11-04): feed, unread count, mark read, preferences per type and channel. Live delivery
 * is apps/realtime's (`/notifications` namespace). Personal: every answer is `no-store`.
 */
export async function notificationsRoutes(app: FastifyZod): Promise<void> {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '/v1/notifications',
    {
      schema: {
        tags,
        operationId: 'notifications.listNotifications',
        summary: 'The caller’s notifications, newest first (keyset, ≤ 100 per page); unread=true for unread only',
        querystring: ListNotificationsQuery,
        response: { 200: NotificationPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => notifications.listNotifications(ctx, req.query)),
  );

  app.get(
    '/v1/notifications/unread-count',
    {
      schema: {
        tags,
        operationId: 'notifications.getUnreadCount',
        summary: 'How many of the caller’s notifications are unread (at most 99; capped=true beyond)',
        response: { 200: UnreadCountDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => notifications.getUnreadCount(ctx)),
  );

  app.post(
    '/v1/notifications/read',
    {
      schema: {
        tags,
        operationId: 'notifications.markNotificationsRead',
        summary: 'Mark these of the caller’s notifications read ({ items: [{ id, createdAt }] }); the new unread count',
        body: MarkNotificationsReadBody,
        response: { 200: MarkNotificationsReadDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => notifications.markNotificationsRead(ctx, req.body)),
  );

  app.post(
    '/v1/notifications/read-all',
    {
      schema: {
        tags,
        operationId: 'notifications.markAllNotificationsRead',
        summary: 'Mark the caller’s newest 500 unread notifications read; more=true while older unread ones remain',
        response: { 200: MarkAllNotificationsReadDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: MARK_ALL_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => notifications.markAllNotificationsRead(ctx)),
  );

  app.get(
    '/v1/notifications/preferences',
    {
      schema: {
        tags,
        operationId: 'notifications.getNotificationPreferences',
        summary: 'The caller’s choice per notification type: on/off, in-app, e-mail digest (default: all on)',
        response: { 200: NotificationPreferencesDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => notifications.getNotificationPreferences(ctx)),
  );

  app.patch(
    '/v1/notifications/preferences/:type',
    {
      schema: {
        tags,
        operationId: 'notifications.updateNotificationPreference',
        summary:
          'Change the caller’s choice for one type: enabled=false stops it in-app and by e-mail (also e-mails still waiting)',
        params: NotificationTypeParams,
        body: UpdateNotificationPreferenceBody,
        response: { 200: NotificationPreferenceDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => notifications.updateNotificationPreference(ctx, req.params.type, req.body)),
  );
}
