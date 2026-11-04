'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { getPathname } from '@/i18n/navigation';
import { requireSession } from '@/server/actions';
import { createContact } from '@/server/contacts-api';
import { type CreateContactState, contactBody, contactFormValues, duplicateIds } from './parse';

/**
 * Creates a contact, or adds the details to the duplicate the person picked (transport only: the API decides who may
 * and what counts as a duplicate). Returns state rather than redirecting on a refusal, so the form keeps its values.
 */
export async function createContactFormAction(_prev: CreateContactState, form: FormData): Promise<CreateContactState> {
  const values = contactFormValues(form);
  const mergeInto = z.uuid().safeParse(form.get('mergeInto'));
  const body = contactBody(values, mergeInto.success ? mergeInto.data : undefined);
  if (!body) return { values, error: 'VALIDATION_FAILED', duplicates: [] };

  const key = z.string().min(16).max(128).safeParse(form.get('idempotencyKey'));
  const res = await createContact(await requireSession(), body, key.success ? key.data : undefined);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) {
    const code = res.error?.code ?? 'generic';
    return {
      values,
      error: code,
      duplicates: code === 'CONTACT_DUPLICATE' ? duplicateIds(res.error?.details) : [],
    };
  }
  const list = getPathname({ href: '/contacts', locale: await getLocale() });
  redirect(`${list}/${encodeURIComponent(res.data.id)}`);
}
