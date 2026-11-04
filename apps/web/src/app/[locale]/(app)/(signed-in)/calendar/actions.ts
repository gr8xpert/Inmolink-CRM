'use server';

import { UpdateCalendarEventBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { getPathname } from '@/i18n/navigation';
import { requireSession, settle } from '@/server/actions';
import { readAgencyTimeZone } from '@/server/agency-time-zone';
import {
  createCalendarEvent,
  revokeCalendarFeed,
  rotateCalendarFeed,
  updateCalendarEvent,
} from '@/server/calendar-api';
import { webConfig } from '@/server/env';
import { type EditEventState, eventFormBody, eventFormValues } from './event-values';
import { FEED_ERRORS, type FeedError, type IssuedCalendarFeed } from './feed-state';

/**
 * Calendar actions (S10-06, transport only): forms post here, the contracts validate, the API decides. Each action
 * returns to the view the member came from (`view`, `week`, `scope`) with `done` or the error code (i18n keys under
 * `calendar.errors`). The feed URL is returned to its form and shown once (never in a URL, cookie or log).
 */

const WEEK = /^\d{4}-\d{2}-\d{2}$/;

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

export async function addEventAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const timeZone = await readAgencyTimeZone(session);
  if (!timeZone) return back(form, { error: 'generic' });
  const key = text(form, 'idempotencyKey');
  const body = /^[A-Za-z0-9-]{16,64}$/.test(key) ? eventFormBody(eventFormValues(form), timeZone) : null;
  if (!body) return back(form, { error: 'VALIDATION_FAILED' });
  return settle(await createCalendarEvent(session, body, key), (e) => back(form, e));
}

/**
 * Saves the edit form (S17-F42, transport only): the same fields and rules as create, sent with the `version` the member
 * saw. The API checks the version and who may (the organizer or an admin). A refusal returns state, so the form keeps what
 * was typed; success goes back to the view the member came from.
 */
export async function editEventAction(_prev: EditEventState, form: FormData): Promise<EditEventState> {
  const values = eventFormValues(form);
  const id = z.uuid().safeParse(text(form, 'id'));
  const version = z.coerce.number().int().min(1).safeParse(text(form, 'version'));
  const session = await requireSession();
  const timeZone = await readAgencyTimeZone(session);
  if (!timeZone) return { values, error: 'generic' };
  const body = eventFormBody(values, timeZone);
  if (!id.success || !version.success || !body) return { values, error: 'VALIDATION_FAILED' };
  const res = await updateCalendarEvent(session, id.data, {
    version: version.data,
    type: body.type,
    title: body.title,
    location: body.location ?? null,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    remindMinutes: body.remindMinutes ?? null,
  });
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return { values, error: res.error?.code ?? 'generic' };
  return back(form, {});
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
  return settle(await updateCalendarEvent(await requireSession(), id, parsed.data), (e) => back(form, e));
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
