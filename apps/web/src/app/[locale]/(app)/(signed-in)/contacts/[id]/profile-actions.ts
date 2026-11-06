'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { getPathname } from '@/i18n/navigation';
import { requireSession } from '@/server/actions';
import type { ApiResult } from '@/server/api';
import { createClientProfile, deleteClientProfile, updateClientProfile } from '@/server/matching-api';
import { parseProfileForm, parseVersion } from './profile-form';

/**
 * Client profile actions (R2-02d, transport only): the contact page's profile forms post here, the contracts
 * validate, the API decides. Each returns to the contact's profiles with `done` or the API's error code; a version
 * conflict reopens the edit form at the latest version.
 */

const UUID = z.uuid();

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function back(contactId: string, extra: Record<string, string>): Promise<never> {
  const query = new URLSearchParams(extra);
  const path = getPathname({ href: `/contacts/${contactId}`, locale: await getLocale() });
  redirect(`${path}?${query.toString()}#profiles`);
}

async function settleProfile(
  contactId: string,
  res: ApiResult<unknown>,
  done: string,
  editing?: string,
): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back(contactId, { done });
  const code = res.error?.code ?? 'generic';
  return back(contactId, { error: code, ...(editing && code === 'VERSION_CONFLICT' ? { profile: editing } : {}) });
}

export async function saveProfileAction(form: FormData): Promise<void> {
  const contactId = text(form, 'contactId');
  if (!UUID.safeParse(contactId).success) redirect('/contacts');
  const id = text(form, 'id');
  const parsed = parseProfileForm(form);
  if (id && !UUID.safeParse(id).success) return back(contactId, { error: 'VALIDATION_FAILED' });
  if (!parsed.ok) return back(contactId, { error: 'VALIDATION_FAILED', ...(id ? { profile: id } : {}) });
  const session = await requireSession();
  if (!id) return settleProfile(contactId, await createClientProfile(session, contactId, parsed.body), 'profileSaved');
  const version = parseVersion(form);
  if (version === null) return back(contactId, { error: 'VALIDATION_FAILED', profile: id });
  return settleProfile(
    contactId,
    await updateClientProfile(session, id, { ...parsed.body, version }),
    'profileSaved',
    id,
  );
}

export async function deleteProfileAction(form: FormData): Promise<void> {
  const contactId = text(form, 'contactId');
  const id = text(form, 'id');
  if (!UUID.safeParse(contactId).success) redirect('/contacts');
  if (!UUID.safeParse(id).success) return back(contactId, { error: 'VALIDATION_FAILED' });
  return settleProfile(contactId, await deleteClientProfile(await requireSession(), id), 'profileDeleted');
}
