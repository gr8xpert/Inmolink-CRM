'use server';

import {
  StaffPostSupportMessageBody,
  StaffUpdateSupportTicketBody,
  SupportAttachmentParams,
  SupportTicketParams,
} from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import {
  fetchStaffSupportAttachmentUrl,
  postStaffSupportMessage,
  updateStaffSupportTicket,
} from '@/server/support-api';

/** Staff support actions (S13-05, transport only): the API decides who is staff and which role may write. */
const KNOWN_ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'RATE_LIMITED'] as const;

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
};

async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

async function back(id: string, query: Record<string, string>): Promise<never> {
  const path = getPathname({ href: `/staff/support/${id}`, locale: await getLocale() });
  redirect(`${path}?${new URLSearchParams(query)}`);
}

const errorOf = (code: string | undefined) => KNOWN_ERRORS.find((c) => c === code) ?? 'generic';

export async function postMessageAction(form: FormData): Promise<void> {
  const params = SupportTicketParams.safeParse({ id: text(form, 'id') });
  if (!params.success) redirect('/');
  const body = StaffPostSupportMessageBody.safeParse({
    body: text(form, 'body'),
    internal: form.get('internal') === 'on',
  });
  if (!body.success) return back(params.data.id, { error: 'VALIDATION_FAILED' });
  const res = await postStaffSupportMessage(await session(), params.data.id, body.data);
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back(params.data.id, { notice: body.data.internal ? 'noted' : 'posted' });
  return back(params.data.id, { error: errorOf(res.error?.code) });
}

export async function updateTicketAction(form: FormData): Promise<void> {
  const params = SupportTicketParams.safeParse({ id: text(form, 'id') });
  if (!params.success) redirect('/');
  const body = StaffUpdateSupportTicketBody.safeParse({
    status: text(form, 'status'),
    priority: text(form, 'priority'),
    assignee: text(form, 'assignee'),
  });
  if (!body.success) return back(params.data.id, { error: 'VALIDATION_FAILED' });
  const res = await updateStaffSupportTicket(await session(), params.data.id, body.data);
  if (res === 'revoked') redirect('/session/expired');
  return back(params.data.id, res.ok ? { notice: 'updated' } : { error: errorOf(res.error?.code) });
}

/** Mints a 5-minute download link on demand and sends the browser to it (never rendered into the page). */
export async function openAttachmentAction(form: FormData): Promise<void> {
  const params = SupportAttachmentParams.safeParse({ id: text(form, 'id'), attachmentId: text(form, 'attachmentId') });
  if (!params.success) redirect('/');
  const res = await fetchStaffSupportAttachmentUrl(await session(), params.data.id, params.data.attachmentId);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return back(params.data.id, { error: errorOf(res.error?.code) });
  redirect(res.data.url);
}
