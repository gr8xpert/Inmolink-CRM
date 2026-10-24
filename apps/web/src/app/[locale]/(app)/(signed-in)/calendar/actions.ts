'use server';

import { CreateCalendarEventBody, UpdateCalendarEventBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { readAgencyTimeZone } from '@/server/agency-time-zone';
import type { ApiResult, SessionRef } from '@/server/api';
import { sessionRef } from '@/server/api';
import {
  createCalendarEvent,
  revokeCalendarFeed,
  rotateCalendarFeed,
  updateCalendarEvent,
} from '@/server/calendar-api';
import { webConfig } from '@/server/env';
import { parseLocalDateTime } from '../tasks/time';
import { FEED_ERRORS, type FeedError, type IssuedCalendarFeed } from './feed-state';

/**
 * Calendar actions (S10-06, transport only): forms post here, the contracts validate, the API decides. Each action
 * returns to the view the member came from (`view`, `week`, `scope`) with `done` or the error code (i18n keys under
 * `calendar.errors`). The feed URL is returned to its form and shown once (never in a URL, cookie or log).
 */

const WEEK = /^\d{4}-\d{2}-\d{2}$/;
const DURATIONS = new Set([15, 30, 45, 60, 90, 120, 180]);

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

async function back(form: FormData, extra: Record<string, string>): Promise<never> {
  const week = text(form, 'week');
  const query = new URLSearchParams({
    ...(text(form, 'view') === 'list' ? { view: 'list' } : {}),
    ...(WEEK.test(week) ? { week } : {}),
    ...(text(form, 'scope') === 'all' ? { scope: 'all' } : {}),
    ...extra,
  });
  redirect(`${getPathname({ href: '/calendar', locale: await getLocale() })}?${query.toString()}`);
}

async function requireSession(): Promise<SessionRef> {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

async function settle(form: FormData, res: ApiResult<unknown>): Promise<never> {
  if (res === 'revoked') redirect('/session/expired');
  return back(form, res.ok ? { done: '1' } : { error: res.error?.code ?? 'generic' });
}

export async function addEventAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const timeZone = await readAgencyTimeZone(session);
  if (!timeZone) return back(form, { error: 'generic' });
  const startsAt = parseLocalDateTime(text(form, 'startsAt'), timeZone);
  const duration = Number(text(form, 'duration'));
  const remind = text(form, 'remind');
  const key = text(form, 'idempotencyKey');
  if (!startsAt || !DURATIONS.has(duration) || !/^[A-Za-z0-9-]{16,64}$/.test(key)) {
    return back(form, { error: 'VALIDATION_FAILED' });
  }
  const parsed = CreateCalendarEventBody.safeParse({
    type: text(form, 'type'),
    title: text(form, 'title'),
    ...(text(form, 'location') ? { location: text(form, 'location') } : {}),
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + duration * 60_000).toISOString(),
    remindMinutes: remind === 'none' ? null : Number(remind),
  });
  if (!parsed.success) return back(form, { error: 'VALIDATION_FAILED' });
  return settle(form, await createCalendarEvent(session, parsed.data, key));
}

/** Cancels or restores one event (`intent`), at the `version` the member saw. */
export async function eventIntentAction(form: FormData): Promise<void> {
  const id = text(form, 'id');
  const intent = text(form, 'intent');
  if (!z.uuid().safeParse(id).success || !['cancel', 'restore'].includes(intent)) {
    return back(form, { error: 'VALIDATION_FAILED' });
  }
  const parsed = UpdateCalendarEventBody.safeParse({
    version: Number(text(form, 'version')),
    status: intent === 'cancel' ? 'CANCELLED' : 'SCHEDULED',
  });
  if (!parsed.success) return back(form, { error: 'VALIDATION_FAILED' });
  return settle(form, await updateCalendarEvent(await requireSession(), id, parsed.data));
}

/** A new feed URL (the previous one stops working), shown once in the form. */
export async function rotateCalendarFeedAction(
  _prev: IssuedCalendarFeed,
  _form: FormData,
): Promise<IssuedCalendarFeed> {
  const res = await rotateCalendarFeed(await requireSession());
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return { error: FEED_ERRORS.find((c): c is FeedError => c === res.error?.code) ?? 'generic' };
  const host = (await webConfig()).FEED_API_PUBLIC_URL;
  const lang = encodeURIComponent(await getLocale());
  return { url: `${host}${res.data.path}?lang=${lang}` };
}

export async function revokeCalendarFeedAction(form: FormData): Promise<void> {
  const res = await revokeCalendarFeed(await requireSession());
  if (res === 'revoked') redirect('/session/expired');
  return back(form, res.ok ? { feed: 'off' } : { error: res.error?.code ?? 'generic' });
}
