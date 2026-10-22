'use server';

import { SiteFeedTokenHeaders, SiteParams } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { type ApiResult, revokeSiteFeed, rotateSiteFeed, sessionRef } from '@/server/api';
import { webConfig } from '@/server/env';
import { FEED_ERRORS, type FeedError, type IssuedFeedState } from './feed-state';

/**
 * XML feed card actions (S7-F8, transport only): turning the feed on and rotating its token return the feed URLs to
 * the form, which shows them this once (never in a URL, cookie or log); turning it off goes back to the page with a
 * notice. The feed host comes from config (`FEED_API_PUBLIC_URL`). Authorization is the API's (agency admins).
 */
async function session() {
  const s = await auth();
  if (!s?.user?.id) redirect('/session/expired');
  return sessionRef(s.user);
}

function errorOf(res: Exclude<ApiResult<unknown>, 'revoked'>): FeedError {
  if (res.ok) return 'generic';
  return FEED_ERRORS.find((c) => c === res.error?.code) ?? 'generic';
}

const siteIdOf = (form: FormData) => SiteParams.safeParse({ siteId: form.get('siteId') });

export async function rotateFeedAction(_prev: IssuedFeedState, form: FormData): Promise<IssuedFeedState> {
  const params = siteIdOf(form);
  const key = SiteFeedTokenHeaders.shape['idempotency-key'].unwrap().safeParse(form.get('idempotencyKey'));
  if (!params.success || !key.success) return { error: 'generic' };
  const res = await rotateSiteFeed(await session(), params.data.siteId, key.data);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok) return { error: errorOf(res) };
  const host = (await webConfig()).FEED_API_PUBLIC_URL;
  return { urls: { kyero: `${host}${res.data.paths.kyero}`, generic: `${host}${res.data.paths.generic}` } };
}

/** Plain form: back to the website with a notice or an error. */
export async function revokeFeedAction(form: FormData): Promise<void> {
  const params = siteIdOf(form);
  const locale = await getLocale();
  if (!params.success) redirect(getPathname({ href: '/websites', locale }));
  const path = getPathname({ href: `/websites/${params.data.siteId}`, locale });
  const res = await revokeSiteFeed(await session(), params.data.siteId);
  if (res === 'revoked') redirect('/session/expired');
  redirect(res.ok ? `${path}?feed=off` : `${path}?feedError=${errorOf(res)}`);
}
