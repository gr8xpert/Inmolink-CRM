'use server';

import { auth } from '@/auth';
import { sessionRef } from '@/server/api';
import { lookupContacts } from '@/server/contacts-api';
import { contactName, lookupBody } from './lookup';

/**
 * "Find a contact by e-mail or phone" (S11-F14): a POST server action, so the e-mail or phone typed never lands in a
 * URL, the browser history or an access log. The lookup goes on to the API in a request body. Used by the contacts
 * list, the merge form and the acquisition seller picker.
 */
export interface FoundContact {
  id: string;
  name: string | null;
  detail: string;
}
export type FindResult =
  | { status: 'idle' | 'invalid' | 'none' | 'error'; items: FoundContact[] }
  | { status: 'found'; items: FoundContact[] };

export async function findContactsAction(input: string): Promise<FindResult> {
  const s = await auth();
  if (!s?.user?.id) return { status: 'error', items: [] };
  const body = lookupBody(input);
  if (!body) return { status: 'invalid', items: [] };
  const res = await lookupContacts(sessionRef(s.user), body);
  if (res === 'revoked' || !res.ok) return { status: 'error', items: [] };
  if (res.data.items.length === 0) return { status: 'none', items: [] };
  return {
    status: 'found',
    items: res.data.items.map((c) => ({
      id: c.id,
      name: contactName(c),
      detail: [c.primaryEmail, c.primaryPhone].filter(Boolean).join(' · '),
    })),
  };
}

/** The form flavour of the same action, for `useActionState`. */
export async function findContactsFormAction(_prev: FindResult, form: FormData): Promise<FindResult> {
  const v = form.get('find');
  return findContactsAction(typeof v === 'string' ? v : '');
}
