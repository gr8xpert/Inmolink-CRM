import { IdempotencyKey, WebsiteLeadBody } from '@inmolink/contracts';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { isAppError } from '@inmolink/platform/errors';
import { rateLimiter } from '@inmolink/platform/rate-limit';
import { readFormBody } from '@/embed/form-body';
import { clientAddress } from '@/server/embed';
import { portalOriginOf, publicConfig } from '@/server/env';
import { PORTAL_LOCALES } from './data';
import { ENQUIRY_NOTICES, type EnquiryNotice } from './enquiry-notices';
import { localRedirectTarget } from './legacy';

/**
 * The portal's enquiry form post (S15-02): `POST /api/portal/enquiry` from a listing page (`EnquiryForm`). Thin, like
 * the embed form's post (S7-F8): urlencoded only, read up to `MAX_FORM_BYTES`; the fields through the website lead
 * contract; then core `submitPortalLead` (the client's lead limits, Turnstile, the listing's
 * owner, the S7-05 intake → CRM as `MARKETPLACE`). `Accept: application/json` (the form's script) → JSON; otherwise (no
 * JavaScript) → 303 back to the listing page with `?enquiry=<result>`. A browser post from another origin is refused
 * (403). Limits (all in core): per client address, per listing and per listing agency. No cookie is read or set; nothing
 * is logged about the visitor.
 *
 * S15-03: the same form on an agency's profile page posts `agency` (its id) instead of `code`: a general enquiry for
 * that listed agency (core `submitPortalLead` with `agencyId`); limits per client address and per agency.
 */

export { ENQUIRY_NOTICES, type EnquiryNotice } from './enquiry-notices';

/** A form post's body cap (the embed form's). */
const MAX_FORM_BYTES = 16 * 1024;

/** A listing page path the form may send the visitor back to (a portal listing URL on this origin, nothing else). */
const LISTING_PAGE = /^\/[a-z]{2}\/property\/[a-z0-9-]{1,200}$/;
/** S15-03: an agency profile page path (its id, its name slug). */
const AGENCY_PAGE =
  /^\/[a-z]{2}\/agency\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z0-9-]{1,200}$/;

const known = (code: string): EnquiryNotice =>
  (ENQUIRY_NOTICES as readonly string[]).includes(code) && code !== 'sent' ? (code as EnquiryNotice) : 'generic';

export async function enquiryResponse(request: Request): Promise<Response> {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const config = await publicConfig();
  // A browser names the page's origin: a post from another site's page is refused (S15-02 review). No Origin (an old
  // browser, a plain client) is left to Turnstile, which binds the token to the portal's host.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== portalOriginOf(config)) {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const read = await readFormBody(request, MAX_FORM_BYTES);
  if (!read.ok) return new Response(null, { status: read.status, headers: { 'Cache-Control': 'no-store' } });
  const form = read.fields;
  const text = (name: string) => (form.get(name) ?? '').trim();
  const locale = PORTAL_LOCALES.includes(text('locale')) ? text('locale') : (PORTAL_LOCALES[0] as string);
  const backPath = localRedirectTarget(text('back'));
  const back = backPath && (LISTING_PAGE.test(backPath) || AGENCY_PAGE.test(backPath)) ? backPath : `/${locale}`;
  const answer = (result: EnquiryNotice): Response =>
    wantsJson
      ? Response.json(result === 'sent' ? { status: 'sent' } : { status: 'error', error: result }, {
          status: result === 'sent' ? 200 : result === 'RATE_LIMITED' ? 429 : 400,
          headers: { 'Cache-Control': 'no-store' },
        })
      : new Response(null, {
          status: 303,
          headers: { Location: `${back}?enquiry=${result}#enquiry`, 'Cache-Control': 'no-store' },
        });

  // Made in the browser (the form's script); a plain post without JavaScript has none — it cannot pass Turnstile anyway.
  const key = IdempotencyKey.safeParse(text('idempotencyKey') || `portal-${crypto.randomUUID()}`);
  const phone = text('phone');
  const token = text('cf-turnstile-response');
  const code = text('code');
  // S15-03: an agency profile's form names the agency instead (exactly one of the two).
  const agencyId = code === '' ? text('agency').toLowerCase() : '';
  const body = WebsiteLeadBody.safeParse({
    name: text('name'),
    email: text('email'),
    ...(phone ? { phone } : {}),
    message: text('message'),
    ...(code ? { ref: code } : {}),
    privacyAccepted: form.get('privacyAccepted') === 'on' ? true : undefined,
    marketingConsent: form.get('marketingConsent') === 'on',
    ...(token ? { turnstileToken: token } : {}),
  });
  if (!key.success || !body.success || (code === '' && agencyId === '')) return answer('VALIDATION_FAILED');
  const client = await clientAddress(request.headers.get('x-forwarded-for'));
  try {
    // One core call (S15 review): the client's limits, Turnstile, the listing's owner, the intake.
    await websiteApi.submitPortalLead(
      { locale, ...(code ? { code } : { agencyId }), body: body.data },
      {
        ...(client.ip ? { ip: client.ip } : {}),
        clientBucket: client.bucket,
        idempotencyKey: key.data,
        limiter: rateLimiter(),
      },
    );
    return answer('sent');
  } catch (err) {
    if (isAppError(err)) return answer(known(err.code));
    throw err;
  }
}
