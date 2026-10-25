/**
 * Notifications (S11-04, PLAN §7 M12): a member's in-app feed (pushed live over apps/realtime), unread count, e-mail
 * digest and preferences per type and channel. Internal to the agency: nothing here is open in Client Mode.
 */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';

/**
 * The catalog of notification types. Each has EN + ES text in `packages/i18n/messages/<locale>/notifications.json`
 * (`types.<TYPE>`, with the `{subject}` / `{actor}` params). Adding one is a contract + i18n change, no migration.
 *
 * - `LEAD_ASSIGNED` — S12-F2: a lead assigned to the member (a new lead by the agency's rule or by hand, a reassignment).
 * - `TASK_DUE` — S12-F2: the member's task came due (with its reminder; in-app only — the reminder e-mail is the task's).
 * - `IMPORT_PAUSED` — S12-F2: the anomaly guard paused one of the agency's feed connections (to its admins).
 * - `VIEWING_REQUESTED` · `VIEWING_UPDATED` — S11-02 viewing requests.
 * - `CHAT_MESSAGE` — S11-03 chat (a message while the member is not in the thread).
 * - `NETWORK_POST` — S11-05 network board (a post matching the member's subscription).
 * - `NETWORK_MATCH` — S11-05 network board (another agency's buyer request matches the member's listings: `count`,
 *   `refs`).
 */
export const NOTIFICATION_TYPES = [
  'LEAD_ASSIGNED',
  'TASK_DUE',
  'VIEWING_REQUESTED',
  'VIEWING_UPDATED',
  'CHAT_MESSAGE',
  'NETWORK_POST',
  'NETWORK_MATCH',
  'IMPORT_PAUSED',
  // S5-06: a saved search's alert (a new listing, a price drop, back on the market) or its daily digest.
  'SAVED_SEARCH_ALERT',
] as const;
export const NotificationType = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationType>;

/** The channels a preference chooses between (web push is R2). */
export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL'] as const;

export const NOTIFICATION_LIMITS = {
  /** Recipients of one `notify` call. */
  recipients: 100,
  /** Keys of `params`. */
  paramKeys: 8,
  paramChars: 200,
  linkChars: 300,
  sourceKeyChars: 200,
  /** The unread count stops counting here (the badge shows "99+"). */
  unreadCap: 99,
  /** Notifications one "mark all read" call sets read (the newest); `more` asks the client to call again. */
  markAllMax: 500,
} as const;

const NO_CONTROL = /[\p{Cc}\u2028\u2029]/u;
const paramText = z
  .string()
  .max(NOTIFICATION_LIMITS.paramChars)
  .refine((v) => !NO_CONTROL.test(v), { message: 'no control characters' });
/** Display values for the type's message: `{ subject: 'INL-7KQ2M3P', actor: 'Ana' }`. Names and codes only. */
/** Display values look like names and codes, never contact details: an e-mail address or a phone number is refused. */
const EMAIL_LIKE = /[^@\s]+@[^@\s]+\.[^@\s]+/;
const PHONE_LIKE = /\+?\d[ \d().-]{7,}\d/;
export const NotificationParams = z
  .record(
    z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
    z.union([
      paramText.refine((v) => !EMAIL_LIKE.test(v) && !PHONE_LIKE.test(v), { message: 'no contact details' }),
      z.number().finite(),
    ]),
  )
  .refine((p) => Object.keys(p).length <= NOTIFICATION_LIMITS.paramKeys, { message: 'too many params' });
export type NotificationParams = z.infer<typeof NotificationParams>;

/**
 * S12-F2: free text a member typed (a task title, a contact's or a connection's name) as a display param that
 * `NotificationParams` always accepts: control characters become spaces, anything that looks like an e-mail address
 * or a phone number becomes `…`, cut to `NOTIFICATION_LIMITS.paramChars`.
 */
export function notificationText(value: string): string {
  const text = value
    .replace(new RegExp(NO_CONTROL.source, 'gu'), ' ')
    .replace(new RegExp(EMAIL_LIKE.source, 'g'), '…')
    .replace(new RegExp(PHONE_LIKE.source, 'g'), '…')
    .replace(/\s+/g, ' ')
    .trim();
  return [...text].slice(0, NOTIFICATION_LIMITS.paramChars).join('').trim();
}

/** A path inside the dashboard (`/crm/leads/<id>`), never an absolute or protocol-relative URL. */
export const NotificationLink = z
  .string()
  .max(NOTIFICATION_LIMITS.linkChars)
  .regex(/^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@][A-Za-z0-9\-._~%!$&'()*+,;=:@/?#]*$/, 'a path inside the app');

export const NotificationDto = z.strictObject({
  id: z.uuid(),
  type: NotificationType,
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  link: z.string().nullable(),
  actorUserId: z.uuid().nullable(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type NotificationDto = z.infer<typeof NotificationDto>;

export const NotificationPage = pageOf(NotificationDto);
export type NotificationPage = z.infer<typeof NotificationPage>;

/** `GET /v1/notifications`: the caller's feed, newest first, keyset (≤ 100 per page); `unread=true` for unread only. */
export const ListNotificationsQuery = PageQuery.extend({ unread: z.stringbool().optional() });
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;
export type ListNotificationsInput = z.input<typeof ListNotificationsQuery>;

/** `GET /v1/notifications/unread-count`: at most `unreadCap`; `capped` when there are more ("99+"). */
export const UnreadCountDto = z.strictObject({ count: z.number().int().min(0), capped: z.boolean() });
export type UnreadCountDto = z.infer<typeof UnreadCountDto>;

/**
 * `POST /v1/notifications/read`: these notifications read — each by its id and `createdAt` as the feed gave them (the
 * primary key: one partition each).
 */
export const MarkNotificationsReadBody = z.strictObject({
  items: z
    .array(z.strictObject({ id: z.uuid(), createdAt: z.iso.datetime() }))
    .min(1)
    .max(100),
});
export type MarkNotificationsReadBody = z.infer<typeof MarkNotificationsReadBody>;

export const MarkNotificationsReadDto = z.strictObject({ updated: z.number().int().min(0), unread: UnreadCountDto });
export type MarkNotificationsReadDto = z.infer<typeof MarkNotificationsReadDto>;

/**
 * `POST /v1/notifications/read-all`: the caller's newest `markAllMax` unread notifications read; `more` while older
 * unread ones remain — the client calls again.
 */
export const MarkAllNotificationsReadDto = z.strictObject({
  updated: z.number().int().min(0),
  more: z.boolean(),
  unread: UnreadCountDto,
});
export type MarkAllNotificationsReadDto = z.infer<typeof MarkAllNotificationsReadDto>;

/** A member's choice for one type: `enabled` false turns every channel off; else `inApp` / `email` pick channels. */
export const NotificationPreferenceDto = z.strictObject({
  type: NotificationType,
  enabled: z.boolean(),
  inApp: z.boolean(),
  email: z.boolean(),
});
export type NotificationPreferenceDto = z.infer<typeof NotificationPreferenceDto>;

/** `GET /v1/notifications/preferences`: every type of the catalog, defaults (all on) filled in. */
export const NotificationPreferencesDto = z.strictObject({ items: z.array(NotificationPreferenceDto) });
export type NotificationPreferencesDto = z.infer<typeof NotificationPreferencesDto>;

export const NotificationTypeParams = z.strictObject({ type: NotificationType });

/** `PATCH /v1/notifications/preferences/:type`: at least one field; the others keep their value. */
export const UpdateNotificationPreferenceBody = z
  .strictObject({ enabled: z.boolean().optional(), inApp: z.boolean().optional(), email: z.boolean().optional() })
  .refine((b) => b.enabled !== undefined || b.inApp !== undefined || b.email !== undefined, {
    message: 'nothing to change',
  });
export type UpdateNotificationPreferenceBody = z.infer<typeof UpdateNotificationPreferenceBody>;

/**
 * What apps/realtime pushes on the `/notifications` namespace (event `notification`) to the recipient's sockets only.
 * Delivery is at least once: clients drop an `id` they already have. `agencyId` tells a member of several agencies
 * which workspace it belongs to.
 */
export const NotificationPush = z.strictObject({ agencyId: z.uuid(), notification: NotificationDto });
export type NotificationPush = z.infer<typeof NotificationPush>;

/** Socket.io namespace and event names (apps/realtime ↔ web). */
export const REALTIME_NOTIFICATIONS_NAMESPACE = '/notifications';
export const REALTIME_NOTIFICATION_EVENT = 'notification';
