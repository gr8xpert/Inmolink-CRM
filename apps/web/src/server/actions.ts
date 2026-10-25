import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { type ApiResult, type SessionRef, sessionRef } from './api';

/** Helpers every dashboard server action shares (transport only; S13-F12). */

/** The signed-in member as an API session, or a redirect to `/session/expired`. */
export async function requireSession(): Promise<SessionRef> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

/**
 * Ends a form action: a revoked session goes to `/session/expired`, otherwise the member returns to the view
 * (`back`) with `done` (default `1`) or the API's error code (an i18n key) in the query.
 */
export async function settle(
  res: ApiResult<unknown>,
  back: (extra: Record<string, string>) => Promise<never>,
  done = '1',
): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  return back(res.ok ? { done } : { error: res.error?.code ?? 'generic' });
}

/**
 * Euros to cents; undefined when empty, null when invalid. `decimals` accepts euros and cents (`250000`, `250000,50`);
 * without it only whole euros.
 */
export function cents(v: string, decimals = true): number | undefined | null {
  if (!v) return undefined;
  if (!(decimals ? /^\d{1,12}([.,]\d{1,2})?$/ : /^\d{1,12}$/).test(v)) return null;
  return Math.round(Number(v.replace(',', '.')) * 100);
}
