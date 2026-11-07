import * as crm from '@inmolink/core/modules/crm';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { rateLimiter } from '@inmolink/platform/rate-limit';
import { clientAddress } from '@/server/embed';
import { NO_BRANDING, renderUnsubscribeConfirm, renderUnsubscribeDone, renderUnsubscribeRefused } from './page';

/**
 * The unsubscribe link's transport (R2-02g, RFC 8058): `GET /u/<token>` renders the confirm page and never
 * unsubscribes (link scanners and previews fetch links); `POST /u/<token>` — the page's button or the mail client's
 * one-click `List-Unsubscribe=One-Click` — records the request (`crm.requestUnsubscribe`: the consent is withdrawn by
 * the worker) and answers 200 with the done page. What a token names and what is recorded is core's; here: limits,
 * the language and the answer.
 *
 * - **No login, no Origin check on POST:** RFC 8058 POSTs come from the mail provider's servers without cookies or an
 *   Origin; the signed token is the only credential, and a repeat is harmless (idempotent). The body is not read (its
 *   content is fixed by the RFC and changes nothing).
 * - **Limits** (`crm.checkUnsubscribeLimits`): a valid link per link only (mail providers post from few addresses), an
 *   invalid one and page views per client address.
 * - **No enumeration:** a malformed, forged or altered token gets the same neutral 404, branded as nobody.
 * - Headers: the selection pages' (`withSelectionHeaders`: no-store, no-referrer, DENY, noindex, CSP).
 */

/** The page's language: `?l=` when it is a UI language, else the default (never echoed unchecked). */
const langOf = (request: Request): string => {
  const l = new URL(request.url).searchParams.get('l');
  return isUiLocale(l) ? l : DEFAULT_UI_LOCALE;
};

const html = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

const refused = (lang: string, status: 404 | 429, retryAfterSeconds = 0) =>
  html(
    renderUnsubscribeRefused({ lang, t: translator(lang, 'embed'), limited: status === 429 }),
    status,
    status === 429 ? { 'Retry-After': String(Math.max(1, retryAfterSeconds)) } : {},
  );

async function brandingOf(token: string) {
  const model = await crm.unsubscribePage(token);
  if (!model) return null;
  return model.presenter ? websiteApi.embedBranding(model.presenter) : NO_BRANDING;
}

/** GET `/u/<token>`: the confirm page (nothing is changed). */
export async function unsubscribeResponse(request: Request, token: string): Promise<Response> {
  const lang = langOf(request);
  const client = await clientAddress(request.headers.get('x-forwarded-for'));
  const limit = await crm.checkUnsubscribeLimits(rateLimiter(), { ip: client.bucket });
  if (!limit.allowed) return refused(lang, 429, limit.retryAfterSeconds);
  const branding = await brandingOf(token);
  if (!branding) return refused(lang, 404);
  const action = `${crm.unsubscribePath(token)}?l=${lang}`;
  return html(renderUnsubscribeConfirm({ lang, t: translator(lang, 'embed'), branding, action }), 200);
}

/** POST `/u/<token>`: one-click (RFC 8058) or the confirm button — the request recorded, 200 with the done page. */
export async function unsubscribeActionResponse(request: Request, token: string): Promise<Response> {
  const lang = langOf(request);
  if (!crm.UNSUBSCRIBE_TOKEN.test(token)) return refused(lang, 404);
  const client = await clientAddress(request.headers.get('x-forwarded-for'));
  const limit = await crm.checkUnsubscribeLimits(rateLimiter(), { ip: client.bucket, post: { token } });
  if (!limit.allowed) return refused(lang, 429, limit.retryAfterSeconds);
  if (!(await crm.requestUnsubscribe(token))) return refused(lang, 404);
  const branding = (await brandingOf(token)) ?? NO_BRANDING;
  return html(renderUnsubscribeDone({ lang, t: translator(lang, 'embed'), branding }), 200);
}
