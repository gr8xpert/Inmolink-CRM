/** @jsxImportSource @/embed/html */
import { IdempotencyKey, WebsiteLeadBody, WebsiteListingParams, WebsiteListingsQuery } from '@inmolink/contracts';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { formatter } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { isAppError } from '@inmolink/platform/errors';
import { cacheControl, etagFor, weakCompareEtag } from '@inmolink/platform/http';
import { rateLimiter } from '@inmolink/platform/rate-limit';
import { clientAddress, embedPageConfig, embedSiteFor, passedGate } from '@/server/embed';
import { EMBED_GATE_HEADER, embedCsp } from './csp';
import { readFormBody } from './form-body';
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
 * same for every visitor: canonical URLs are cacheable at the edge with the feed cache shape (`EMBED_PAGE_CACHE`) and
 * the S7-06 edge tags of what they showed, so a listing or site change purges them like the website API's answers;
 * every page carries a strong ETag of what it serves (`If-None-Match` → 304, S8-F2).
 */

/**
 * How long the edge may serve a page while the origin fails (S8-F2 review): short, like the XML feeds' — a page whose
 * purge failed must not keep an old `frame-ancestors` (a removed domain) framing it for a day.
 */
export const EMBED_STALE_IF_ERROR = 300;
/** Edge lifetime of a canonical page, the feed cache shape (S8-F2) with a short `stale-if-error`. */
export const EMBED_PAGE_CACHE = cacheControl.feed({
  sMaxAge: 60,
  staleWhileRevalidate: 300,
  staleIfError: EMBED_STALE_IF_ERROR,
});

/**
 * How a page may be stored (S8-F2): `public` — a canonical URL, at the edge; `private` — any other URL (unknown or
 * repeated parameters, free text, a cursor, a non-canonical value: cache-busting URLs never reach a shared cache, the
 * browser revalidates with the ETag); `no-store` — one visitor's answer (a lead notice).
 */
export type EmbedCache = 'public' | 'private' | 'no-store';

/** Edge-cacheable only with purge tags; a public page without them (`null`) is `no-store` (see `html`). */
export function pageCacheHeaders(cache: EmbedCache, tags: readonly string[] | null): Record<string, string> {
  if (cache === 'private') return { 'Cache-Control': cacheControl.private(0) };
  return cache === 'no-store' || tags === null || tags.length === 0
    ? { 'Cache-Control': 'no-store' }
    : { 'Cache-Control': EMBED_PAGE_CACHE, 'Cache-Tag': tags.join(',') };
}

/** The search page's parameters, in the order its form submits them (and its links are built in). */
export const EMBED_SEARCH_PARAMS = ['q', 'transaction', 'priceMin', 'priceMax', 'bedsMin', 'sort'] as const;
/** Whole euros as typed, no leading zero: one URL per amount. */
const EUROS = /^(0|[1-9]\d{0,9})$/;
const BEDS = /^(0|[1-9]\d?)$/;

/**
 * Whether a search URL's query is canonical (S8-F2), so the page may be stored at the edge: only the search page's
 * parameters, each at most once, in the form's order; no free-text `q` and no `cursor` (deep pages stay with the
 * origin, like the website API's, S7-06); every value in its one written form — and either no empty value (the
 * page's own links) or all of them present (the form's submission). The raw query must be what `URLSearchParams`
 * writes back from its own parse, with no value padded by blanks (S8-F2 review: `%53ALE`, `SALE+`, `%74ransaction`,
 * `%31000` or a bare `?` would each be another edge entry for the same page). Each filter combination has at most two
 * canonical URLs. `requestUrl`: the URL as received; `valid`: the filters passed the contract.
 */
export function canonicalSearch(requestUrl: string, valid: boolean): boolean {
  if (!valid) return false;
  const mark = requestUrl.indexOf('?');
  if (mark < 0) return true;
  const raw = requestUrl.slice(mark + 1);
  const params = new URLSearchParams(raw);
  if (raw === '' || params.toString() !== raw) return false;
  const entries = [...params];
  let at = -1;
  for (const [k, v] of entries) {
    const i = (EMBED_SEARCH_PARAMS as readonly string[]).indexOf(k);
    if (i <= at) return false; // unknown (`cursor` too), repeated or out of order
    at = i;
    if (v !== v.trim()) return false;
    if (v === '') continue;
    if (k === 'q') return false;
    if ((k === 'priceMin' || k === 'priceMax') && !EUROS.test(v)) return false;
    if (k === 'bedsMin' && !BEDS.test(v)) return false;
  }
  const empties = entries.filter(([, v]) => v === '').length;
  return empties === 0 || entries.length === EMBED_SEARCH_PARAMS.length;
}

/** A lead post's body cap (the website API's form cap). */
const MAX_FORM_BYTES = 16 * 1024;
const PAGE_SIZE = 12;
/** A page's strong ETag: its body and its CSP (a domain change re-frames the same body: a new tag). */
const pageEtag = (body: string, csp: string) => etagFor(`${csp}\n${body}`);

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

/**
 * An embed page. Cached at the edge only with its purge tags: a page without them (tags not configured, or more than
 * `EDGE_MAX_TAGS`) could not be purged when the site changes — its old `frame-ancestors` would outlive a mode or
 * domain change — so it is `no-store` (security review). An `If-None-Match` naming its ETag → 304 with the same
 * headers and no body (S8-F2).
 */
function html(
  request: Request,
  body: string,
  site: websiteApi.EmbedSite,
  mediaOrigin: string | null,
  cache: EmbedCache,
): Response {
  const csp = embedCsp({ frameAncestors: site.frameAncestors, mediaOrigin });
  const etag = pageEtag(body, csp);
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': csp,
    Vary: 'Accept-Encoding',
    ...pageCacheHeaders(cache, cache === 'public' ? websiteApi.edgeTagsOf(site.api) : null),
    ETag: etag,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };
  if (weakCompareEtag(request.headers.get('if-none-match') ?? undefined, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
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
  const url = new URL(request.url);
  const sp = url.searchParams;
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
  const invalid = !parsed.success;
  const query = parsed.success ? parsed.data : WebsiteListingsQuery.parse({ lang, limit: PAGE_SIZE });
  const b = base(site.siteId, lang);
  const keep = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) keep.set(k, v);
  const first = `${b}${keep.size > 0 ? `?${keep}` : ''}`;
  const toFirst = () => new Response(null, { status: 303, headers: { Location: first, 'Cache-Control': 'no-store' } });
  // A cursor the contract refuses is forged: the first page's URL, like one core refuses.
  if (!parsed.success && parsed.error.issues.some((i) => i.path[0] === 'cursor')) return toFirst();
  let page: Awaited<ReturnType<typeof websiteApi.embedSearch>>;
  try {
    page = await websiteApi.embedSearch(site, query);
  } catch (err) {
    // A stale or forged cursor: to the first page's URL (S8-F2) — no second search here; that URL is edge-cacheable
    // when canonical.
    // Anything else is a real failure.
    if (!isCursorError(err)) throw err;
    return toFirst();
  }
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
    firstHref: query.cursor ? first : null,
    nextHref: page.nextCursor ? `${b}?${new URLSearchParams([...keep, ['cursor', page.nextCursor]])}` : null,
  });
  return html(request, body, site, mediaOrigin, canonicalSearch(request.url, parsed.success) ? 'public' : 'private');
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
  const url = new URL(request.url);
  const leadParam = url.searchParams.get('lead') ?? '';
  const notice = NOTICES.has(leadParam) ? (leadParam as EmbedLeadNotice) : undefined;
  const b = base(site.siteId, lang);
  // A notice page answers one visitor's post: never stored anywhere (security review). The canonical detail URL is the
  // listing's reference as the site shows it, written by `encodeURIComponent`, with no query, not even a bare `?`
  // (S8-F2): anything else (another spelling, another reference of the same listing, a parameter) is private.
  const canonical = !request.url.includes('?') && url.pathname === `${b}/listing/${encodeURIComponent(detail.ref)}`;
  const cache: EmbedCache = url.searchParams.has('lead') ? 'no-store' : canonical ? 'public' : 'private';
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
  return html(request, body, site, mediaOrigin, cache);
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

  // Urlencoded only, at most MAX_FORM_BYTES read whatever Content-Length says (security review).
  const read = await readFormBody(request, MAX_FORM_BYTES);
  if (!read.ok) return plain(read.status);
  const form = read.fields;
  const text = (name: string) => (form.get(name) ?? '').trim();
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
