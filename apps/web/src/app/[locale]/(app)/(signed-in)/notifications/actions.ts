'use server';

import { NOTIFICATION_TYPES, UpdateNotificationPreferenceBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { getPathname } from '@/i18n/navigation';
import { requireSession, settle } from '@/server/actions';
import {
  markAllNotificationsRead,
  markNotificationsRead,
  updateNotificationPreference,
} from '@/server/notifications-api';

/** Notification actions (S12-F1, transport only): forms post here, the API decides; back to the page with `done`/`error`. */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function back(extra: Record<string, string>): Promise<never> {
  const query = new URLSearchParams(extra);
  redirect(`${getPathname({ href: '/notifications', locale: await getLocale() })}?${query.toString()}`);
}

export async function markReadAction(form: FormData): Promise<void> {
  const parsed = z
    .object({ id: z.uuid(), createdAt: z.iso.datetime() })
    .safeParse({ id: text(form, 'id'), createdAt: text(form, 'createdAt') });
  if (!parsed.success) return back({ error: 'VALIDATION_FAILED' });
  return settle(await markNotificationsRead(await requireSession(), [parsed.data]), back, 'read');
}

export async function markAllReadAction(): Promise<void> {
  return settle(await markAllNotificationsRead(await requireSession()), back, 'readAll');
}

/** One type's three switches; an unchecked box is absent from the form, so all three are sent. */
export async function savePreferenceAction(form: FormData): Promise<void> {
  const type = z.enum(NOTIFICATION_TYPES).safeParse(text(form, 'type'));
  const parsed = UpdateNotificationPreferenceBody.safeParse({
    enabled: form.get('enabled') === 'on',
    inApp: form.get('inApp') === 'on',
    email: form.get('email') === 'on',
  });
  if (!type.success || !parsed.success) return back({ error: 'VALIDATION_FAILED' });
  return settle(await updateNotificationPreference(await requireSession(), type.data, parsed.data), back, 'saved');
}
