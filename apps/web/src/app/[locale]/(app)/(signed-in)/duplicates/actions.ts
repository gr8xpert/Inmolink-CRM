'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { getPathname } from '@/i18n/navigation';
import { requireSession } from '@/server/actions';
import { decideDuplicateReview, openDuplicateDispute } from '@/server/dedupe-api';
import { backQuery, parseDecision, parseDispute } from './query';

/**
 * The duplicate pages' moves (R2-03b, transport only): decide a pending pair, or dispute a grouped listing, then back to
 * the same view with the outcome (`done`) or the API's error code. Every rule is the API's.
 */
async function go(back: Record<string, string>, extra: Record<string, string>): Promise<never> {
  const q = new URLSearchParams({ ...back, ...extra });
  redirect(`${getPathname({ href: '/duplicates', locale: await getLocale() })}?${q.toString()}`);
}

export async function decideDuplicateAction(form: FormData): Promise<void> {
  const back = backQuery(form);
  const move = parseDecision(form);
  if (!move) return go(back, { error: 'VALIDATION_FAILED' });
  const res = await decideDuplicateReview(await requireSession(), move.id, move.move);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return go(back, { error: res.error?.code ?? 'generic' });
  return go(back, { done: res.data.status });
}

export async function disputeDuplicateAction(form: FormData): Promise<void> {
  const back = backQuery(form);
  const body = parseDispute(form);
  if (!body) return go(back, { error: 'VALIDATION_FAILED' });
  const res = await openDuplicateDispute(await requireSession(), body);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return go(back, { error: res.error?.code ?? 'generic' });
  return go(back, { done: 'disputed' });
}
