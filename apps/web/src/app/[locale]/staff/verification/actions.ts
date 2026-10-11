'use server';

import { DecideVerificationBody, VerificationDocumentParams, VerificationRequestParams } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { decideVerification, fetchVerificationDocumentUrl } from '@/server/api';

/**
 * Staff verification actions (transport only, S1-03). The API decides who is staff; a 403 here means
 * the caller is not (or no longer) staff.
 */
const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

async function back(id: string, query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: `/staff/verification/${id}`, locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return { userId: s.user.id, sessionVersion: s.user.sessionVersion };
}

const KNOWN_ERRORS = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VERIFICATION_STALE',
  'VERIFICATION_NOT_OPEN',
  'VALIDATION_FAILED',
] as const;

export async function decideAction(form: FormData): Promise<void> {
  const params = VerificationRequestParams.safeParse({ id: text(form, 'id') });
  if (!params.success) redirect('/');
  const body = DecideVerificationBody.safeParse({
    decision: text(form, 'decision'),
    agencyVersion: Number(text(form, 'agencyVersion')),
    reason: text(form, 'reason'),
  });
  if (!body.success) return back(params.data.id, { error: 'VALIDATION_FAILED' });
  const res = await decideVerification(await session(), params.data.id, body.data);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back(params.data.id, { notice: body.data.decision });
  return back(params.data.id, { error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}

/** Mints a 5-minute download link on demand and sends the browser to it (never rendered into the page). */
export async function openDocumentAction(form: FormData): Promise<void> {
  const params = VerificationDocumentParams.safeParse({ id: text(form, 'id'), documentId: text(form, 'documentId') });
  if (!params.success) redirect('/');
  const res = await fetchVerificationDocumentUrl(await session(), params.data.id, params.data.documentId);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return back(params.data.id, { error: KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
  redirect(res.data.url);
}
