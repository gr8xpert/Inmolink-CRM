import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what in notifications (PATTERNS §6). Deny by default; services call `assertCan`. */
export const NOTIFICATIONS_ACTIONS = [
  /** The caller's own feed and unread count. */
  'notifications.read',
  /** Mark the caller's own notifications read. */
  'notifications.markRead',
  /** The caller's own preferences per type and channel (reading them is `notifications.read`). */
  'notifications.preferences',
] as const;
export type NotificationsAction = (typeof NOTIFICATIONS_ACTIONS)[number];

/**
 * Client Mode (PATTERNS §6) is read-only — and a member's notifications name clients, leads and colleagues: nothing
 * of them is open in Client Mode.
 */
export const CLIENT_MODE_ALLOWED: ReadonlySet<NotificationsAction> = new Set<NotificationsAction>();

/**
 * Staff impersonating a member (S1-09) may look at the member's feed to diagnose a problem, never mark it read (the
 * member would miss them) nor change the member's choices.
 */
export const NOTIFICATIONS_IMPERSONATION: ImpersonationRules<NotificationsAction> = {
  'notifications.read': 'allowed',
  'notifications.markRead': 'forbidden',
  'notifications.preferences': 'forbidden',
};

export function can(ctx: Ctx, action: NotificationsAction): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, NOTIFICATIONS_IMPERSONATION, action)) return false;
  switch (action) {
    // every member has a feed of their own: the rows are theirs (RLS `user_id = app_user_id()`)
    case 'notifications.read':
    case 'notifications.markRead':
    case 'notifications.preferences':
      return true;
  }
}

export function assertCan(ctx: Ctx, action: NotificationsAction): void {
  if (!can(ctx, action)) throw new AppError('FORBIDDEN');
}
