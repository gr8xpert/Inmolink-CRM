'use server';

import { CreateContactNoteBody, MergeContactsBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import type { ApiResult, SessionRef } from '@/server/api';
import { sessionRef } from '@/server/api';
import { addContactNote, mergeContacts } from '@/server/contacts-api';

/**
 * Contact actions (S11-F14, transport only): forms post here, the contracts validate, the API decides (admins merge).
 * Each returns to the contact with `done` or the error code (i18n keys under `contacts.errors`).
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function requireSession(): Promise<SessionRef> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

async function back(id: string, extra: Record<string, string>): Promise<never> {
  const path = `${getPathname({ href: '/contacts', locale: await getLocale() })}/${encodeURIComponent(id)}`;
  redirect(`${path}?${new URLSearchParams(extra).toString()}`);
}

async function toList(): Promise<never> {
  redirect(getPathname({ href: '/contacts', locale: await getLocale() }));
}

async function settle(id: string, res: ApiResult<unknown>, done: string): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  return back(id, res.ok ? { done } : { error: res.error?.code ?? 'generic' });
}

export async function addNoteAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  if (!z.uuid().safeParse(id).success) return toList();
  const parsed = CreateContactNoteBody.safeParse({ body: text(form, 'body') });
  if (!parsed.success) return back(id, { error: 'VALIDATION_FAILED' });
  return settle(id, await addContactNote(await requireSession(), id, parsed.data), 'noted');
}

/** Merges `duplicateId` into the contact `id` (the survivor, at the `version` the member saw). */
export async function mergeContactAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  if (!z.uuid().safeParse(id).success) return toList();
  const parsed = MergeContactsBody.safeParse({
    duplicateId: text(form, 'duplicateId'),
    version: Number(text(form, 'version')),
  });
  if (!parsed.success || parsed.data.duplicateId === id) return back(id, { error: 'VALIDATION_FAILED' });
  return settle(id, await mergeContacts(await requireSession(), id, parsed.data), 'merged');
}
