'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { getPathname } from '@/i18n/navigation';
import { requireSession } from '@/server/actions';
import { moveClientProfileMatch } from '@/server/matching-api';
import { backQuery, parseMove } from './query';

/**
 * The review queue's moves (R2-02d, transport only): approve, dismiss or restore one match, then back to the same
 * view (status and filter) with the match's new status (`done`, and the selection an approval went into) or the
 * API's error code.
 */
export async function moveMatchAction(form: FormData): Promise<void> {
  const back = backQuery(form);
  const go = async (extra: Record<string, string>): Promise<never> => {
    const q = new URLSearchParams({ ...back, ...extra });
    redirect(`${getPathname({ href: '/matches', locale: await getLocale() })}?${q.toString()}`);
  };
  const move = parseMove(form);
  if (!move) return go({ error: 'VALIDATION_FAILED' });
  const res = await moveClientProfileMatch(await requireSession(), move.id, move.move);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return go({ error: res.error?.code ?? 'generic' });
  return go({ done: res.data.status, ...(res.data.selectionId ? { selection: res.data.selectionId } : {}) });
}
