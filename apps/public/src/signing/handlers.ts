import * as documents from '@inmolink/core/modules/documents';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { type Translate, translator } from '@inmolink/i18n/server';
import { rateLimiter } from '@inmolink/platform/rate-limit';
import { readFormBody } from '@/embed/form-body';
import { clientAddress, embedPageConfig } from '@/server/embed';
import { LOCAL_PUBLIC_URL, publicConfig } from '@/server/env';
import { SIGNING_SCRIPT_PATH } from './client';
import { renderSigningPage, renderSigningRefused, renderSigningState, type SigningNotice } from './page';

/**
 * The signing link's transport (R2-05b): `GET /sign/<token>` renders the page (nothing is changed: link scanners fetch
 * links); `POST /sign/<token>` with `action=code` asks for a one-time code, with `action=sign` signs;
 * `GET /sign/<token>/document` and `/signed` redirect (303) to a 5-minute signed link of the original or the signed
 * PDF. What a token names, may do and records is core's (`documents.signingPage`, `requestSigningCode`,
 * `submitSignature`, `signingFileUrl`); here: limits, the origin check, the body, the language and the answer.
 *
 * - **Limits** (`documents.checkSigningLimits`): views per client address; codes and signatures per link and address.
 * - **Origin:** posts only from this host's own pages (the forms have no other use).
 * - **No enumeration:** a malformed, forged or altered token gets the same neutral 404.
 * - Headers: the selection pages' (`withSelectionHeaders`: no-store, no-referrer, DENY, noindex, CSP with `script-src
 *   'self'` + Turnstile).
 */

const MAX_FORM_BYTES = 128 * 1024;

const langOf = (request: Request, fallback?: string): string => {
  const l = new URL(request.url).searchParams.get('l');
  if (isUiLocale(l)) return l;
  return fallback && isUiLocale(fallback) ? fallback : DEFAULT_UI_LOCALE;
};

const html = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

const tOf = (lang: string) => translator(lang, 'documents');

const refused = (lang: string, status: 403 | 404 | 413 | 415 | 429, retryAfterSeconds = 0) =>
  html(
    renderSigningRefused({ lang, t: tOf(lang), limited: status === 429 }),
    status,
    status === 429 ? { 'Retry-After': String(Math.max(1, retryAfterSeconds)) } : {},
  );

/** A page path of this token on this host, in this language. */
const pathOf = (token: string, lang: string, suffix = '') => `${documents.signingPath(token)}${suffix}?l=${lang}`;

/**
 * POSTs come only from this host's pages: `Origin` must be the public pages' own; without one (`Referrer-Policy:
 * no-referrer` makes browsers send `Origin: null` on the page's forms) only `Sec-Fetch-Site: same-origin` passes.
 */
async function sameOrigin(request: Request): Promise<boolean> {
  const config = await publicConfig();
  const own = new URL(config.PUBLIC_URL ?? LOCAL_PUBLIC_URL).origin;
  const origin = request.headers.get('origin');
  if (origin === null || origin === 'null') return request.headers.get('sec-fetch-site') === 'same-origin';
  return origin === own;
}

function roleLabel(t: Translate, role: string): string {
  const key = `forms.signers.${role}`;
  const label = t(key);
  return label === key ? role : label;
}

async function answer(
  token: string,
  lang: string,
  model: documents.SigningPageModel,
  extra: { notice?: SigningNotice | null; codeSent?: boolean; status?: number } = {},
): Promise<Response> {
  const t = tOf(lang);
  const documentHref = model.state === 'CLOSED' ? null : pathOf(token, lang, '/document');
  if (model.state !== 'OPEN') {
    const signedHref = model.state === 'COMPLETED' ? pathOf(token, lang, '/signed') : null;
    return html(renderSigningState({ lang, t, model, documentHref, signedHref }), extra.status ?? 200);
  }
  const { turnstileSiteKey } = await embedPageConfig();
  return html(
    renderSigningPage({
      lang,
      t,
      model,
      roleLabel: roleLabel(t, model.role),
      action: pathOf(token, lang),
      documentHref,
      turnstileSiteKey,
      turnstileAction: documents.SIGNING_TURNSTILE_ACTION,
      scriptPath: SIGNING_SCRIPT_PATH,
      notice: extra.notice ?? null,
      codeSent: extra.codeSent ?? false,
    }),
    extra.status ?? 200,
  );
}

/** GET `/sign/<token>`: the page (nothing is changed). */
export async function signingResponse(request: Request, token: string): Promise<Response> {
  const lang = langOf(request);
  const client = await clientAddress(request.headers.get('x-forwarded-for'));
  const limit = await documents.checkSigningLimits(rateLimiter(), { ip: client.bucket, action: 'view', token });
  if (!limit.allowed) return refused(lang, 429, limit.retryAfterSeconds);
  const model = await documents.signingPage(token);
  if (!model) return refused(lang, 404);
  return answer(token, langOf(request, model.locale), model);
}

const errorKey: Record<string, string> = {
  WAIT: 'wait',
  CODE_LIMIT: 'codeLimit',
  TURNSTILE: 'turnstile',
  UNAVAILABLE: 'unavailable',
  CODE_EXPIRED: 'codeExpired',
  NO_CODE: 'noCode',
  LOCKED: 'locked',
  CHANGED: 'changed',
  NAME_MISSING: 'nameMissing',
  DRAWING_MISSING: 'drawingMissing',
  CONSENT_MISSING: 'consentMissing',
};

/** POST `/sign/<token>`: `action=code` (a one-time code e-mailed) or `action=sign` (the signature). */
export async function signingActionResponse(request: Request, token: string): Promise<Response> {
  const lang = langOf(request);
  if (!documents.SIGNING_TOKEN.test(token)) return refused(lang, 404);
  if (!(await sameOrigin(request))) return refused(lang, 403);
  const read = await readFormBody(request, MAX_FORM_BYTES);
  if (!read.ok) return refused(lang, read.status);
  const form = read.fields;
  const action = form.get('action') === 'sign' ? 'sign' : 'code';
  const client = await clientAddress(request.headers.get('x-forwarded-for'));
  const limit = await documents.checkSigningLimits(rateLimiter(), { ip: client.bucket, action, token });
  if (!limit.allowed) return refused(lang, 429, limit.retryAfterSeconds);
  const facts = { ip: client.ip, userAgent: request.headers.get('user-agent') };
  const t = tOf(lang);
  const errorOf = (code: string): SigningNotice => ({ kind: 'error', text: t(`signing.errors.${errorKey[code]}`) });

  if (action === 'code') {
    const res = await documents.requestSigningCode(token, {
      ...facts,
      turnstileToken: form.get('cf-turnstile-response'),
    });
    if (res.outcome === 'INVALID') return refused(lang, 404);
    const model = await documents.signingPage(token);
    if (!model) return refused(lang, 404);
    if (res.outcome === 'SENT') {
      return answer(token, lang, model, {
        notice: { kind: 'info', text: t('signing.page.codeSent', { email: res.emailHint }) },
        codeSent: true,
      });
    }
    if (res.outcome === 'STATE') return answer(token, lang, model);
    return answer(token, lang, model, { notice: errorOf(res.outcome), status: res.outcome === 'WAIT' ? 429 : 422 });
  }

  const kind = form.get('kind') === 'DRAWN' ? 'DRAWN' : 'TYPED';
  const res = await documents.submitSignature(
    token,
    {
      code: form.get('code') ?? '',
      kind,
      name: form.get('name') ?? '',
      drawing: form.get('drawing'),
      consent: form.get('consent') === 'yes',
      documentSha256: form.get('documentSha256') ?? '',
    },
    facts,
  );
  if (res.outcome === 'INVALID') return refused(lang, 404);
  const model = await documents.signingPage(token);
  if (!model) return refused(lang, 404);
  if (res.outcome === 'SIGNED') {
    // the worker applies it within seconds: the page says it is recorded (the event is)
    return answer(token, lang, { ...model, state: model.state === 'OPEN' ? 'SIGNED' : model.state });
  }
  if (res.outcome === 'STATE') return answer(token, lang, model);
  if (res.outcome === 'BAD_CODE') {
    return answer(token, lang, model, {
      notice: { kind: 'error', text: t('signing.errors.badCode', { left: res.attemptsLeft }) },
      codeSent: true,
      status: 422,
    });
  }
  return answer(token, lang, model, { notice: errorOf(res.outcome), codeSent: true, status: 422 });
}

/** GET `/sign/<token>/document` or `/signed`: 303 to a 5-minute signed link of the PDF, else the neutral 404. */
export async function signingFileResponse(
  request: Request,
  token: string,
  which: 'original' | 'signed',
): Promise<Response> {
  const lang = langOf(request);
  const client = await clientAddress(request.headers.get('x-forwarded-for'));
  const limit = await documents.checkSigningLimits(rateLimiter(), { ip: client.bucket, action: 'view', token });
  if (!limit.allowed) return refused(lang, 429, limit.retryAfterSeconds);
  const file = await documents.signingFileUrl(token, which);
  if (file === null) return refused(lang, 404);
  if (file === 'UNAVAILABLE') {
    return html(renderSigningRefused({ lang, t: tOf(lang) }), 503, { 'Retry-After': '300' });
  }
  return new Response(null, {
    status: 303,
    headers: { Location: file.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}
