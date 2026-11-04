'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { getPathname } from '@/i18n/navigation';
import { requireSession } from '@/server/actions';
import { updateContact } from '@/server/contacts-api';
import { duplicateIds } from '../../new/parse';
import { contactEditBody, contactEditValues, type EditContactState } from './parse';

const Version = z.coerce.number().int().min(1);

/**
 * Saves the edit form (S17-F28, transport only): the API checks the version, the field rules and who may, and records
 * a consent change. Returns state rather than redirecting on a refusal, so the form keeps its values.
 */
export async function editContactFormAction(_prev: EditContactState, form: FormData): Promise<EditContactState> {
  const values = contactEditValues(form);
  const id = z.uuid().safeParse(form.get('id'));
  const version = Version.safeParse(form.get('version'));
  const initial = { emails: String(form.get('initialEmails') ?? ''), phones: String(form.get('initialPhones') ?? '') };
  const body = id.success && version.success ? contactEditBody(values, version.data, initial) : null;
  if (!id.success || !body) return { values, error: 'VALIDATION_FAILED', duplicates: [] };

  const res = await updateContact(await requireSession(), id.data, body);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) {
    const code = res.error?.code ?? 'generic';
    return { values, error: code, duplicates: code === 'CONTACT_DUPLICATE' ? duplicateIds(res.error?.details) : [] };
  }
  const list = getPathname({ href: '/contacts', locale: await getLocale() });
  redirect(`${list}/${encodeURIComponent(res.data.id)}?done=edited`);
}
