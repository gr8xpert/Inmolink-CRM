import { SelectionPageAction } from '@inmolink/contracts';
import * as presentations from '@inmolink/core/modules/presentations';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { formatter } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { isAppError } from '@inmolink/platform/errors';
import { createLogger } from '@inmolink/platform/logger';
import { rateLimiter } from '@inmolink/platform/rate-limit';
import { embedCsp } from '@/embed/csp';
import { readFormBody } from '@/embed/form-body';
import type { ViewText } from '@/embed/views';
import { clientAddress, embedPageConfig } from '@/server/embed';
import { LOCAL_PUBLIC_URL, publicConfig } from '@/server/env';
import { renderGonePage, renderSelectionPage, type SelectionNotice } from './page';

/**
 * The selection page's transport (S12-04): `GET /s/<token>` renders the live page, `POST /s/<token>` takes a like,
 * an unlike or an enquiry (a plain form post, answered by a 303 back with a notice). What a selection shows and
 * records is core's (`presentations/public.ts`); here: limits, the request's own checks, cookies and headers.
 *
 * - Never cached anywhere (`no-store`): the token is a secret and the page is live (an owner's price change shows on
 *   the next view). No referrer leaves the page (`Referrer-Policy: no-referrer`): links out never carry the token.
 *   Nothing may frame it.
 * - A view is recorded once per browser per `VIEW_COOKIE_HOURS` (a path-scoped cookie), and never for link-preview
 *   bots (WhatsApp, e-mail apps and crawlers fetch the link when it is shared).
 * - Likes this browser made are remembered in a path-scoped cookie (the page shows "remove like" for them).
 */

const log = createLogger({ service: 'public', level: process.env.LOG_LEVEL ?? 'info' });

const UI_LOCALES = new Set(['en', 'es']);
const MAX_FORM_BYTES = 8 * 1024;
const VIEW_COOKIE_HOURS = 6;
const LIKES_COOKIE_DAYS = 365;
const NOTICES: readonly SelectionNotice[] = ['liked', 'unliked', 'sent', 'invalid', 'limited', 'error'];
/** Link previews and crawlers: their fetch of a shared link is not the client's view. */
const PREVIEW_BOT =
  /bot|crawl|spider|preview|whatsapp|facebookexternalhit|telegram|slack|discord|skype|linkedin|outlook|googleimageproxy|yahoo|bing/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const textFor = (lang: string): ViewText => {
  const ui = UI_LOCALES.has(lang) ? lang : 'en';
  return { t: translator(ui, 'embed'), fmt: formatter(lang) };
};

async function headers(extra: Record<string, string> = {}): Promise<Headers> {
  const { mediaOrigin } = await embedPageConfig();
  const h = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': embedCsp({ frameAncestors: [], mediaOrigin }),
    ...extra,
  });
  return h;
}

function cookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return out;
}

/** Cookies are scoped to the page's path; their names carry no part of the token. */
const cookieFor = (token: string, name: string, value: string, maxAgeSeconds: number, secure: boolean) =>
  `${name}=${value}; Path=/s/${token}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

const likedOf = (request: Request): Set<string> =>
  new Set((cookies(request).get('liked') ?? '').split('.').filter((id) => UUID.test(id)));

async function secure(): Promise<boolean> {
  return (await publicConfig()).NODE_ENV === 'production';
}

/** A language as the page may name it (anything else: English) — never echoed unchecked. */
const LANG = /^[a-z]{2}(-[A-Z]{2})?$/;
const langOf = (lang: string | null | undefined): string => (lang && LANG.test(lang) ? lang : 'en');

/** What a failure is, for the log: its code and message — never the request's fields (an enquiry's text). */
const failure = (err: unknown) =>
  isAppError(err)
    ? { code: err.code }
    : { error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : 'unknown' };

async function gone(lang: string, status: number): Promise<Response> {
  return new Response(renderGonePage({ lang, text: textFor(lang) }), { status, headers: await headers() });
}

/** GET `/s/<token>`. */
export async function selectionResponse(request: Request, token: string): Promise<Response> {
  const url = new URL(request.url);
  const asked = url.searchParams.get('lang');
  const lang = asked && LANG.test(asked) ? asked : undefined;
  const client = await clientAddress(request.headers.get('x-forwarded-for'));
  const limit = await presentations.checkSelectionLimits(rateLimiter(), { ip: client.bucket });
  if (!limit.allowed) {
    const h = await headers({ 'Retry-After': String(Math.max(1, limit.retryAfterSeconds)) });
    return new Response(renderGonePage({ lang: 'en', text: textFor('en') }), { status: 429, headers: h });
  }
  let model: presentations.SelectionPageModel;
  try {
    model = await presentations.selectionPage(token, lang);
  } catch (err) {
    if (isAppError(err) && err.code === 'SELECTION_NOT_FOUND') return gone(langOf(lang), 404);
    throw err;
  }
  const h = await headers();
  const jar = cookies(request);
  const bot = PREVIEW_BOT.test(request.headers.get('user-agent') ?? '');
  if (!bot && !jar.has('seen')) {
    try {
      // The page's own selection (no second token lookup); once per selection and client address per window.
      await presentations.recordSelectionPageView(rateLimiter(), model, { ip: client.bucket });
      h.append('Set-Cookie', cookieFor(token, 'seen', '1', VIEW_COOKIE_HOURS * 3_600, await secure()));
    } catch (err) {
      // The page still renders: a lost view is better than no page.
      log.warn(failure(err), 'selection view not recorded');
    }
  }
  const n = url.searchParams.get('n');
  const notice = NOTICES.find((k) => k === n);
  const { mediaOrigin } = await embedPageConfig();
  const body = renderSelectionPage({
    model,
    branding: websiteApi.embedBranding(model.presenter),
    action: `/s/${token}`,
    mediaOrigin,
    text: textFor(model.locale),
    ...(notice ? { notice: { kind: notice } } : {}),
    liked: likedOf(request),
  });
  return new Response(body, { status: 200, headers: h });
}

/**
 * Whether a form post came from the page itself (no cross-site post may like or enquire for the client): its `Origin`
 * is the public pages' own (`PUBLIC_URL`); without one, only a browser's `Sec-Fetch-Site: same-origin` passes.
 */
async function sameOrigin(request: Request): Promise<boolean> {
  const config = await publicConfig();
  const own = new URL(config.PUBLIC_URL ?? LOCAL_PUBLIC_URL).origin;
  const origin = request.headers.get('origin');
  if (origin === null) return request.headers.get('sec-fetch-site') === 'same-origin';
  return origin === own;
}

/** POST `/s/<token>`: a like, an unlike or an enquiry. */
export async function selectionActionResponse(request: Request, token: string): Promise<Response> {
  const back = (notice: SelectionNotice, item?: string, setCookie?: string) => {
    const h = new Headers({
      Location: `/s/${token}?n=${notice}${item ? `#item-${item}` : ''}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    if (setCookie) h.append('Set-Cookie', setCookie);
    return new Response(null, { status: 303, headers: h });
  };
  if (!presentations.SELECTION_TOKEN.test(token)) return gone('en', 404);
  if (!(await sameOrigin(request))) {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const read = await readFormBody(request, MAX_FORM_BYTES);
  if (!read.ok) return new Response(null, { status: read.status, headers: { 'Cache-Control': 'no-store' } });
  const form = read.fields;
  const item = (form.get('item') ?? '').trim();
  const parsed = SelectionPageAction.safeParse({
    action: form.get('action') ?? '',
    ...(item ? { item } : {}),
    ...(form.get('action') === 'enquire' ? { message: form.get('message') ?? '' } : {}),
  });
  if (!parsed.success) return back('invalid', UUID.test(item) ? item : undefined);
  const client = await clientAddress(request.headers.get('x-forwarded-for'));
  const limit = await presentations.checkSelectionLimits(rateLimiter(), {
    ip: client.bucket,
    write: { token, enquiry: parsed.data.action === 'enquire' },
  });
  if (!limit.allowed) return back('limited');
  try {
    await presentations.recordSelectionInteraction(token, presentations.interactionOf(parsed.data));
  } catch (err) {
    if (isAppError(err) && err.code === 'SELECTION_NOT_FOUND') return gone('en', 404);
    if (isAppError(err) && err.code === 'VALIDATION_FAILED') return back('invalid');
    log.warn(failure(err), 'selection action not recorded');
    return back('error', parsed.data.action === 'enquire' ? undefined : parsed.data.item);
  }
  const action = parsed.data;
  if (action.action === 'enquire') return back('sent', action.item);
  const liked = likedOf(request);
  if (action.action === 'like') liked.add(action.item);
  else liked.delete(action.item);
  const cookie = cookieFor(token, 'liked', [...liked].slice(-50).join('.'), LIKES_COOKIE_DAYS * 86_400, await secure());
  return back(action.action === 'like' ? 'liked' : 'unliked', action.item, cookie);
}
