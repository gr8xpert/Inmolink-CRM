import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { auth } from '@/auth';
import { getPathname, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { completeSocialConnect } from '@/server/social-api';
import { SOCIAL_NOTICE_ERRORS } from '../errors';

const PARAM = /^[\w.~%-]{1,2000}$/;

/**
 * Meta's OAuth callback (S12-07, `SOCIAL_OAUTH_REDIRECT_URL`): hands `code` and the signed `state` to the API, which
 * checks the state is this member's and agency's, exchanges the code and stores the Pages and Instagram accounts.
 * Back to `/social` with the outcome; a member who declined at Meta (`error=`) just goes back.
 */
export default async function SocialCallbackPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const back = (query: Record<string, string>) =>
    redirect(`${getPathname({ href: '/social', locale })}?${new URLSearchParams(query).toString()}`);
  const code = typeof params.code === 'string' && PARAM.test(params.code) ? params.code : null;
  const state = typeof params.state === 'string' && PARAM.test(params.state) ? params.state : null;
  if (!code || !state) return back({ error: 'SOCIAL_CONNECT_FAILED' });
  const res = await completeSocialConnect(sessionRef(session.user), { code, state });
  if (res === 'revoked') redirect('/session/expired');
  if (res.ok) return back({ done: 'connected' });
  return back({ error: SOCIAL_NOTICE_ERRORS.find((c) => c === res.error?.code) ?? 'generic' });
}
