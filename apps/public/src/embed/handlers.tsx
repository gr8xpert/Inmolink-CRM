/** @jsxImportSource @/embed/html */
import { IdempotencyKey, WebsiteLeadBody, WebsiteListingParams, WebsiteListingsQuery } from '@inmolink/contracts';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { formatter } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { isAppError } from '@inmolink/platform/errors';
import { rateLimiter } from '@inmolink/platform/rate-limit';
import { clientAddress, embedPageConfig, embedSiteFor, passedGate } from '@/server/embed';
import { EMBED_GATE_HEADER, embedCsp } from './csp';
import {
  EMBED_LEAD_ERRORS,
  type EmbedFilters,
  type EmbedLeadError,
  EmbedLeadForm,
  type EmbedLeadNotice,
  renderDetailPage,
  renderSearchPage,
} from './pages';
import type { ViewText } from './views';

/**
 * The embed routes' transport (S7-F8): check the proxy's marker, load the site (core `embedSite` — checked again, the
 * URL is never trusted), parse the query or form with the contracts, call core, render HTML or redirect. Pages are the
 * same for every visitor: cacheable per URL (`public, s-maxage=60, stale-while-revalidate=300`) with the S7-06 edge
 * tags of what they showed, so a listing or site change purges them like the website API's answers.
 */

export const EMBED_PAGE_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
/** A lead post's body cap (the website API's form cap). */
const MAX_FORM_BYTES = 16 * 1024;
const PAGE_SIZE = 12;

type Params = { site: string; lang: string };

function plain(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      ...extra,
    },
  });
}

function html(body: string, site: websiteApi.EmbedSite, mediaOrigin: string | null, cache: boolean): Response {
  const tags = cache ? websiteApi.edgeTagsOf(site.api) : null;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': embedCsp({ frameAncestors: site.frameAncestors, mediaOrigin }),
      'Cache-Control': cache ? EMBED_PAGE_CACHE : 'no-store',
      ...(tags ? { 'Cache-Tag': tags.join(',') } : {}),
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** The site and language of an embed request, or the refusal (no marker, refused site, not one of its languages). */
async function siteOf(
  request: Request,
  params: Params,
): Promise<{ site: websiteApi.EmbedSite; lang: string; text: ViewText } | Response> {
  if (!(await passedGate(params.site, request.headers.get(EMBED_GATE_HEADER)))) return plain(404);
  const site = await embedSiteFor(params.site);
  if (!site?.locales.includes(params.lang)) return plain(404);
  const t = translator(params.lang, 'embed');
  return { site, lang: params.lang, text: { t, fmt: formatter(params.lang) } };
}

const base = (siteId: string, lang: string) => `/embed/${siteId}/${lang}`;
const one = (sp: URLSearchParams, k: string) => (sp.get(k) ?? '').trim();
/** Whole euros as typed → cents; anything else is dropped. */
const euros = (v: string) => (/^\d{1,10}$/.test(v) ? Number(v) * 100 : undefined);

/** `true` for the error a stale or forged search cursor raises (the only one answered with the first page). */
const isCursorError = (err: unknown) =>
  isAppError(err) && err.code === 'VALIDATION_FAILED' && err.details?.field === 'cursor';

/** GET `/embed/<site>/<lang>`: search and results. */
export async function searchResponse(request: Request, params: Params): Promise<Response> {
  const ok = await siteOf(request, params);
  if (ok instanceof Response) return ok;
  const { site, lang, text } = ok;
  const sp = new URL(request.url).searchParams;
  const filters: EmbedFilters = {
    q: one(sp, 'q'),
    transaction: one(sp, 'transaction'),
    priceMin: one(sp, 'priceMin'),
    priceMax: one(sp, 'priceMax'),
    bedsMin: one(sp, 'bedsMin'),
    sort: one(sp, 'sort'),
  };
  const raw = {
    lang,
    limit: PAGE_SIZE,
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.transaction ? { transaction: filters.transaction } : {}),
    ...(euros(filters.priceMin) !== undefined ? { priceMin: euros(filters.priceMin) } : {}),
    ...(euros(filters.priceMax) !== undefined ? { priceMax: euros(filters.priceMax) } : {}),
    ...(/^\d{1,2}$/.test(filters.bedsMin) ? { bedsMin: filters.bedsMin } : {}),
    ...(filters.sort ? { sort: filters.sort } : {}),
    ...(one(sp, 'cursor') ? { cursor: one(sp, 'cursor') } : {}),
  };
  const parsed = WebsiteListingsQuery.safeParse(raw);
  let invalid = !parsed.success;
  const query = parsed.success ? parsed.data : WebsiteListingsQuery.parse({ lang, limit: PAGE_SIZE });
  let page: Awaited<ReturnType<typeof websiteApi.embedSearch>>;
  try {
    page = await websiteApi.embedSearch(site, query);
  } catch (err) {
    // A stale or forged cursor: the first page instead. Anything else is a real failure.
    if (!isCursorError(err)) throw err;
    page = await websiteApi.embedSearch(site, { ...query, cursor: undefined });
    invalid = true;
  }
  const b = base(site.siteId, lang);
  const keep = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) keep.set(k, v);
  const { mediaOrigin } = await embedPageConfig();
  const body = renderSearchPage({
    lang,
    base: b,
    branding: site.branding,
    mediaOrigin,
    text,
    filters,
    page,
    invalid,
    firstHref: query.cursor ? `${b}${keep.size > 0 ? `?${keep}` : ''}` : null,
    nextHref: page.nextCursor ? `${b}?${new URLSearchParams([...keep, ['cursor', page.nextCursor]])}` : null,
  });
  return html(body, site, mediaOrigin, true);
}

/** A route parameter as text (whether or not the router decoded it already). */
function decoded(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

const NOTICES = new Set<string>(['sent', ...EMBED_LEAD_ERRORS]);

/** GET `/embed/<site>/<lang>/listing/<ref>`: the detail and the enquiry form (`?lead=` after a plain post). */
export async function detailResponse(request: Request, params: Params & { ref: string }): Promise<Response> {
  const ok = await siteOf(request, params);
  if (ok instanceof Response) return ok;
  const { site, lang, text } = ok;
  const ref = WebsiteListingParams.safeParse({ ref: decoded(params.ref) });
  if (!ref.success) return plain(404);
  let detail: Awaited<ReturnType<typeof websiteApi.embedDetail>>;
  try {
    detail = await websiteApi.embedDetail(site, ref.data.ref, lang);
  } catch (err) {
    if (isAppError(err) && err.code === 'LISTING_NOT_FOUND') return plain(404);
    throw err;
  }
  const { mediaOrigin, turnstileSiteKey } = await embedPageConfig();
  const leadParam = new URL(request.url).searchParams.get('lead') ?? '';
  const notice = NOTICES.has(leadParam) ? (leadParam as EmbedLeadNotice) : undefined;
  const b = base(site.siteId, lang);
  const form = turnstileSiteKey ? (
    <EmbedLeadForm
      action={`${b}/listing/${encodeURIComponent(detail.ref)}`}
      ref={detail.ref}
      agency={site.branding.name}
      turnstileSiteKey={turnstileSiteKey}
      turnstileAction={websiteApi.LEAD_TURNSTILE_ACTION}
      t={text.t}
      notice={notice}
    />
  ) : (
    <p className="embed-panel embed-muted">{text.t('lead.unavailable')}</p>
  );
  const body = renderDetailPage({
    lang,
    base: b,
    detail,
    branding: site.branding,
    mediaOrigin,
    text,
    form,
    withScript: turnstileSiteKey !== null && notice !== 'sent',
  });
  return html(body, site, mediaOrigin, true);
}

const known = (code: string | undefined): EmbedLeadError => EMBED_LEAD_ERRORS.find((c) => c === code) ?? 'generic';

/**
 * POST `/embed/<site>/<lang>/listing/<ref>`: an enquiry. The site, language and reference come from the URL and are
 * checked again (a tampered id for a site that may not be embedded is a 404); fields through the website lead
 * contract; the post counted against the embed limits; then core `submitEmbedLead` (S7-05 intake: Turnstile, the
 * presenting agency). `Accept: application/json` (the script) → JSON; otherwise (no JavaScript) → 303 back with
 * `?lead=`. No cookie is read or set.
 */
export async function leadResponse(request: Request, params: Params & { ref: string }): Promise<Response> {
  const ok = await siteOf(request, params);
  if (ok instanceof Response) return ok;
  const { site, lang } = ok;
  const ref = WebsiteListingParams.safeParse({ ref: decoded(params.ref) });
  if (!ref.success) return plain(404);
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const back = `${base(site.siteId, lang)}/listing/${encodeURIComponent(ref.data.ref)}`;
  const answer = (result: EmbedLeadNotice): Response =>
    wantsJson
      ? Response.json(result === 'sent' ? { status: 'sent' } : { status: 'error', error: result }, {
          status: result === 'sent' ? 200 : result === 'RATE_LIMITED' ? 429 : 400,
          headers: { 'Cache-Control': 'no-store' },
        })
      : new Response(null, {
          status: 303,
          headers: { Location: `${back}?lead=${result}`, 'Cache-Control': 'no-store' },
        });

  const length = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length > MAX_FORM_BYTES) return answer('VALIDATION_FAILED');
  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    if (err instanceof TypeError) return answer('VALIDATION_FAILED');
    throw err;
  }
  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === 'string' ? v.trim() : '';
  };
  // Made in the browser (`client.ts`); a plain post without JavaScript has none: a fresh one (no replay protection
  // needed — it cannot pass Turnstile without JavaScript anyway).
  const key = IdempotencyKey.safeParse(text('idempotencyKey') || `embed-${crypto.randomUUID()}`);
  const phone = text('phone');
  const token = text('cf-turnstile-response');
  const body = WebsiteLeadBody.safeParse({
    name: text('name'),
    email: text('email'),
    ...(phone ? { phone } : {}),
    message: text('message'),
    ref: ref.data.ref,
    lang,
    privacyAccepted: form.get('privacyAccepted') === 'on' ? true : undefined,
    marketingConsent: form.get('marketingConsent') === 'on',
    ...(token ? { turnstileToken: token } : {}),
  });
  if (!key.success || !body.success) return answer('VALIDATION_FAILED');
  const client = await clientAddress(request.headers.get('x-forwarded-for'));
  const limit = await websiteApi.checkEmbedLimits(rateLimiter(), {
    ip: client.bucket,
    write: { siteId: site.siteId },
  });
  if (!limit.allowed) return answer('RATE_LIMITED');
  try {
    await websiteApi.submitEmbedLead(
      site,
      { kind: 'ENQUIRY', body: body.data },
      { ...(client.ip ? { ip: client.ip } : {}), idempotencyKey: key.data },
    );
    return answer('sent');
  } catch (err) {
    if (isAppError(err)) return answer(known(err.code));
    throw err;
  }
}
