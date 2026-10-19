'use server';

import { FeedConnectionParams } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { requestFeedRun, sessionRef } from '@/server/api';

/**
 * Feed imports form actions (transport only, S6-01): validate with the contracts, call the API, and come back to
 * the page the form was on with a notice or an error code (i18n keys under `imports`). Plain forms: they work
 * without JavaScript.
 */
const KNOWN_ERRORS = [
  'FORBIDDEN',
  'FEED_RUN_ACTIVE',
  'FEED_CONNECTION_DISABLED',
  'FEED_CONNECTION_NOT_FOUND',
  'VALIDATION_FAILED',
] as const;

export async function runNowAction(form: FormData): Promise<void> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const params = FeedConnectionParams.safeParse({ id: form.get('connectionId') });
  const id = params.success ? params.data.id : null;
  const path = getPathname({
    href: id && form.get('from') === 'detail' ? `/imports/${id}` : '/imports',
    locale: await getLocale(),
  });
  const back = (query: Record<string, string>): never => redirect(`${path}?${new URLSearchParams(query)}`);
  if (!id) return back({ error: 'VALIDATION_FAILED' });
  const res = await requestFeedRun(sessionRef(s.user), id);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back({ done: 'queued' });
  return back({ error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}
