/**
 * Where a notification's stored link opens in the dashboard (S12-F1). Links are paths the modules built before the
 * pages existed: chat threads match (`/chat/:id`); a board post opens the board, a viewing request the collaborations
 * page. Anything else that is a plain in-app path is used as it is; null when there is none.
 */
/** In-app areas a notification may open as stored. */
const ALLOWED = ['/chat/', '/tasks', '/pipeline', '/inbox', '/imports', '/calendar', '/listings/', '/contacts/'];

export function notificationHref(link: string | null): string | null {
  if (!link?.startsWith('/') || link.startsWith('//')) return null;
  if (link.startsWith('/network/posts/')) return '/network/board';
  if (link.startsWith('/mls/viewings/') || link.startsWith('/mls/received-viewings/')) return '/collaborations';
  return ALLOWED.some((p) => link.startsWith(p)) ? link : null;
}
