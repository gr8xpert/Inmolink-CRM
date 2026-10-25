'use server';

import { SendChatMessageBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { markThreadRead, sendMessage } from '@/server/chat-api';

/** Chat actions (S12-F1, transport only): the message form posts here, the API decides; back to the thread. */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

export async function sendMessageAction(form: FormData): Promise<void> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  const id = text(form, 'threadId');
  if (!z.uuid().safeParse(id).success) redirect(getPathname({ href: '/chat', locale: await getLocale() }));
  const path = getPathname({ href: `/chat/${id}`, locale: await getLocale() });
  const parsed = SendChatMessageBody.safeParse({ body: text(form, 'body'), clientKey: text(form, 'clientKey') });
  if (!parsed.success) redirect(`${path}?error=VALIDATION_FAILED`);
  const res = await sendMessage(sessionRef(s.user), id, parsed.data);
  if (res === 'revoked') redirect('/session/expired');
  redirect(res.ok ? path : `${path}?error=${encodeURIComponent(res.error?.code ?? 'generic')}`);
}

/** Marks a thread read; called by the thread page once it is on screen (a page render does not write). */
export async function markThreadReadAction(threadId: string): Promise<void> {
  const s = await auth();
  if (!s?.user?.id || !z.uuid().safeParse(threadId).success) return;
  await markThreadRead(sessionRef(s.user), threadId);
}
