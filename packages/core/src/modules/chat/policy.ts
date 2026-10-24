import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what in chat (PATTERNS §6). Deny by default; services call `assertCan`. */
export const CHAT_ACTIONS = [
  /** The caller's threads, their messages and read state (only threads the caller takes part in: RLS). */
  'chat.read',
  /** Start a thread, open a viewing request's thread, send a message, mark a thread read. */
  'chat.write',
] as const;
export type ChatAction = (typeof CHAT_ACTIONS)[number];

/**
 * Client Mode (PATTERNS §6) is read-only — and chat is between agents, about clients and partners: nothing of it is
 * shown to a client.
 */
export const CLIENT_MODE_ALLOWED: ReadonlySet<ChatAction> = new Set<ChatAction>();

/**
 * Staff impersonating a member (S1-09) may look at the member's threads to diagnose a problem, never write in the
 * member's name nor mark their threads read (the member would miss them). apps/realtime gives them no socket.
 */
export const CHAT_IMPERSONATION: ImpersonationRules<ChatAction> = {
  'chat.read': 'allowed',
  'chat.write': 'forbidden',
};

export function can(ctx: Ctx, action: ChatAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, CHAT_IMPERSONATION, action)) return false;
  if (resource && resource.agencyId !== ctx.tenant.agencyId) return false;
  switch (action) {
    // every member may talk to colleagues; a viewing thread also needs mls.viewings.read (checked by mls)
    case 'chat.read':
    case 'chat.write':
      return true;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
