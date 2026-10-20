'use server';

import { FeedConnectionParams } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { staffResumeFeedConnection } from '@/server/staff-api';

const KNOWN_ERRORS = ['FORBIDDEN', 'FEED_CONNECTION_NOT_FOUND', 'VALIDATION_FAILED'] as const;

/** Resume a paused feed from the import health dashboard (S6-08, transport only; the API authorizes and audits). */
export async function staffResumeFeedAction(form: FormData): Promise<void> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const path = getPathname({ href: '/staff/imports', locale: await getLocale() });
  const back = (query: Record<string, string>): never => redirect(`${path}?${new URLSearchParams(query)}`);
  const params = FeedConnectionParams.safeParse({ id: form.get('connectionId') });
  if (!params.success) return back({ error: 'VALIDATION_FAILED' });
  const res = await staffResumeFeedConnection(sessionRef(s.user), params.data.id, form.get('acceptChange') === 'on');
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back({ notice: 'resumed' });
  return back({ error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}
