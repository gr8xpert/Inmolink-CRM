'use server';

import {
  CreateSupportTicketBody,
  PostSupportMessageBody,
  SupportAttachmentParams,
  SupportTicketParams,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import {
  createSupportTicket,
  fetchSupportAttachmentUrl,
  postSupportMessage,
  resolveSupportTicket,
} from '@/server/support-api';

/** Support tickets, agency side (S13-05, transport only): the API authorizes and validates again. */
const KNOWN_ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'RATE_LIMITED'] as const;

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

async function to(href: string, query: Record<string, string>): Promise<never> {
  const path = getPathname({ href, locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

const errorOf = (code: string | undefined) => KNOWN_ERRORS.find((c) => c === code) ?? 'generic';

export async function createTicketAction(form: FormData): Promise<void> {
  const body = CreateSupportTicketBody.safeParse({
    subject: text(form, 'subject'),
    category: text(form, 'category'),
    priority: text(form, 'priority'),
    body: text(form, 'body'),
  });
  if (!body.success) return to('/support', { error: 'VALIDATION_FAILED' });
  const res = await createSupportTicket(await session(), body.data);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return to(`/support/${res.data.id}`, { notice: 'created' });
  return to('/support', { error: errorOf(res.error?.code) });
}

export async function replyAction(form: FormData): Promise<void> {
  const params = SupportTicketParams.safeParse({ id: text(form, 'id') });
  if (!params.success) redirect('/');
  const body = PostSupportMessageBody.safeParse({ body: text(form, 'body') });
  if (!body.success) return to(`/support/${params.data.id}`, { error: 'VALIDATION_FAILED' });
  const res = await postSupportMessage(await session(), params.data.id, body.data);
  if (res === 'revoked') redirect('/session/expired');
  return to(`/support/${params.data.id}`, res.ok ? { notice: 'replied' } : { error: errorOf(res.error?.code) });
}

export async function resolveAction(form: FormData): Promise<void> {
  const params = SupportTicketParams.safeParse({ id: text(form, 'id') });
  if (!params.success) redirect('/');
  const res = await resolveSupportTicket(await session(), params.data.id);
  if (res === 'revoked') redirect('/session/expired');
  return to(`/support/${params.data.id}`, res.ok ? { notice: 'resolved' } : { error: errorOf(res.error?.code) });
}

/** Mints a 5-minute download link on demand and sends the browser to it (never rendered into the page). */
export async function openAttachmentAction(form: FormData): Promise<void> {
  const params = SupportAttachmentParams.safeParse({ id: text(form, 'id'), attachmentId: text(form, 'attachmentId') });
  if (!params.success) redirect('/');
  const res = await fetchSupportAttachmentUrl(await session(), params.data.id, params.data.attachmentId);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return to(`/support/${params.data.id}`, { error: errorOf(res.error?.code) });
  redirect(res.data.url);
}
