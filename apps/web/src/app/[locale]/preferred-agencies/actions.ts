'use server';

import { AddPreferredAgencyBody, PreferredAgencyParams, UpdatePreferredAgencyBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import {
  type ApiResult,
  addPreferredAgency,
  removePreferredAgency,
  sessionRef,
  updatePreferredAgency,
} from '@/server/api';

/**
 * Preferred agencies form actions (transport only, S1-07): validate with the contracts, call the API,
 * and come back to the page with a notice or an error code (i18n keys under `agency.preferred`). Plain
 * forms: they work without JavaScript.
 */
const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

async function back(query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: '/preferred-agencies', locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

const KNOWN_ERRORS = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'VERIFICATION_REQUIRED',
  'PREFERRED_AGENCY_INVALID',
  'PREFERRED_AGENCY_EXISTS',
  'PREFERRED_AGENCY_LIMIT_REACHED',
] as const;

async function finish(res: ApiResult<unknown>, done: 'added' | 'removed' | 'noted'): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back({ done });
  const code = KNOWN_ERRORS.find((c) => c === res.error?.code) ?? 'generic';
  return back({ error: code });
}

export async function addPreferredAction(form: FormData): Promise<void> {
  const parsed = AddPreferredAgencyBody.safeParse({ agencyId: text(form, 'agencyId') });
  if (!parsed.success) return back({ error: 'VALIDATION_FAILED' });
  return finish(await addPreferredAgency(await session(), parsed.data), 'added');
}

export async function saveNoteAction(form: FormData): Promise<void> {
  const params = PreferredAgencyParams.safeParse({ agencyId: text(form, 'agencyId') });
  const body = UpdatePreferredAgencyBody.safeParse({ note: text(form, 'note') ?? null });
  if (!params.success || !body.success) return back({ error: 'VALIDATION_FAILED' });
  return finish(await updatePreferredAgency(await session(), params.data.agencyId, body.data), 'noted');
}

export async function removePreferredAction(form: FormData): Promise<void> {
  const params = PreferredAgencyParams.safeParse({ agencyId: text(form, 'agencyId') });
  if (!params.success) return back({ error: 'VALIDATION_FAILED' });
  return finish(await removePreferredAgency(await session(), params.data.agencyId), 'removed');
}
