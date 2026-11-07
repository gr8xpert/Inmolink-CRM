'use server';

import { DedupeDisputeParams, ResolveDedupeDisputeBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { resolveDuplicateDispute } from '@/server/dedupe-api';

/** Staff duplicate disputes (R2-03b, transport only): the API decides who is staff and which role may resolve. */
const KNOWN_ERRORS = ['FORBIDDEN', 'DEDUPE_DISPUTE_NOT_FOUND', 'DEDUPE_DISPUTE_STATE', 'VALIDATION_FAILED'] as const;

async function back(query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: '/staff/duplicates', locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

export async function resolveDisputeAction(form: FormData): Promise<void> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const params = DedupeDisputeParams.safeParse({ id: form.get('id') });
  if (!params.success) redirect('/');
  const body = ResolveDedupeDisputeBody.safeParse({ outcome: form.get('outcome'), note: form.get('note') });
  if (!body.success) return back({ error: 'VALIDATION_FAILED' });
  const res = await resolveDuplicateDispute(sessionRef(s.user), params.data.id, body.data);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back({ notice: 'resolved' });
  return back({ error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}
