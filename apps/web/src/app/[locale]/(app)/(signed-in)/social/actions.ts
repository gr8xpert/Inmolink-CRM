'use server';

import { CreateSocialPostBody } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { readAgencyTimeZone } from '@/server/agency-time-zone';
import { sessionRef } from '@/server/api';
import { cancelSocialPost, createSocialPost, disconnectSocialAccount, startSocialConnect } from '@/server/social-api';
import { parseLocalDateTime } from '../tasks/time';
import { SOCIAL_NOTICE_ERRORS } from './errors';

/**
 * Social posting forms (S12-07, transport only): connect accounts (off to Meta's login), disconnect one, compose a
 * post from a listing, cancel one. Plain forms: they work without JavaScript. Results come back as `?done=` / `?error=`
 * (i18n keys under `social`).
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

const to = async (href: string, query?: Record<string, string>): Promise<never> =>
  redirect(
    `${getPathname({ href, locale: await getLocale() })}${query ? `?${new URLSearchParams(query).toString()}` : ''}`,
  );

const known = (code: string | undefined) => SOCIAL_NOTICE_ERRORS.find((c) => c === code) ?? 'generic';

async function session() {
  const s = await auth();
  if (!s?.user?.id) return to('/login');
  return sessionRef(s.user);
}

export async function connectAccountsAction(): Promise<void> {
  const res = await startSocialConnect(await session());
  if (res === 'revoked') return redirect('/session/expired');
  if (!res.ok) return to('/social', { error: known(res.error?.code) });
  // Meta's login dialog (its host comes from the API's configuration, never from the browser).
  return redirect(res.data.url);
}

export async function disconnectAccountAction(form: FormData): Promise<void> {
  const id = text(form, 'accountId');
  const res = await disconnectSocialAccount(await session(), id);
  if (res === 'revoked') return redirect('/session/expired');
  return to('/social', res.ok ? { done: 'disconnected' } : { error: known(res.error?.code) });
}

export async function createPostAction(form: FormData): Promise<void> {
  const ref = await session();
  const listingId = text(form, 'listingId');
  const scheduled = text(form, 'scheduledAt');
  // A typed local time is the agency's (S11-F11): no zone, no instant — refused rather than guessed.
  const timeZone = scheduled ? await readAgencyTimeZone(ref) : null;
  if (scheduled && !timeZone) return to('/social/new', { listingId, error: 'generic' });
  const when = scheduled && timeZone ? parseLocalDateTime(scheduled, timeZone) : null;
  if (scheduled && !when) return to('/social/new', { listingId, error: 'VALIDATION_FAILED' });
  const locales = form.getAll('captionLocales').filter((v): v is string => typeof v === 'string' && v !== '');
  const parsed = CreateSocialPostBody.safeParse({
    accountId: text(form, 'accountId'),
    listingId,
    locale: text(form, 'locale'),
    caption: text(form, 'caption') || null,
    scheduledAt: when ? when.toISOString() : null,
    ...(locales.length > 0 ? { captionLocales: locales } : {}),
  });
  if (!parsed.success) return to('/social/new', { listingId, error: 'VALIDATION_FAILED' });
  const res = await createSocialPost(ref, parsed.data);
  if (res === 'revoked') return redirect('/session/expired');
  if (!res.ok) return to('/social/new', { listingId: parsed.data.listingId, error: known(res.error?.code) });
  return to('/social', { done: parsed.data.scheduledAt ? 'scheduled' : 'drafted' });
}

export async function cancelPostAction(form: FormData): Promise<void> {
  const version = Number(text(form, 'version'));
  const res = await cancelSocialPost(await session(), text(form, 'postId'), Number.isInteger(version) ? version : 0);
  if (res === 'revoked') return redirect('/session/expired');
  return to('/social', res.ok ? { done: 'cancelled' } : { error: known(res.error?.code) });
}
