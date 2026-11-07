import { FormDocumentParams, SIGNED_PDF_VERIFY_MAX_BYTES } from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { webConfig } from '@/server/env';
import { verifySignedPdf } from '@/server/forms-api';
import { requestAuthCtx } from '@/server/request-id';
import { listingDocumentUploads } from '@/server/upload-slots';

/** Multipart overhead on top of the file (boundaries, part headers, the other fields). */
const FORM_OVERHEAD_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KNOWN_ERRORS = new Set([
  'FORBIDDEN',
  'FORMS_NOT_ENABLED',
  'ESIGN_NOT_ENABLED',
  'SIGNATURE_REQUEST_NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
]);

/**
 * `POST /api/forms/:id/verify` — a form page's "verify a PDF" upload (R2-05c, transport only). A route handler instead
 * of a server action, so the 25 MB limit applies to this path alone. Before reading the body it checks the origin (the
 * session cookie is SameSite=Strict as well), the declared length, the session and a per-user upload slot (the
 * document relays share them). The API hashes the file against the request's stored hashes; nothing is stored. Answers
 * with a 303 back to the form with the match (`SIGNED`, `ORIGINAL`, `NONE`) and the file's SHA-256, or an error code.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const config = await webConfig();
  const parsed = FormDocumentParams.safeParse({ id: (await params).id });
  if (!parsed.success) return new Response(null, { status: 404 });
  const formId = parsed.data.id;
  const back = (locale: string, query: Record<string, string>) =>
    Response.redirect(`${config.WEB_URL}/${locale}/forms/${formId}?${new URLSearchParams(query)}`, 303);

  if (request.headers.get('origin') !== new URL(config.WEB_URL).origin) {
    return new Response(null, { status: 403 });
  }
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return new Response(null, { status: 411 });
  // The locale is unknown until the body is read: a refused body goes back to the default locale.
  if (length > SIGNED_PDF_VERIFY_MAX_BYTES + FORM_OVERHEAD_BYTES) {
    return back(DEFAULT_UI_LOCALE, { error: 'PAYLOAD_TOO_LARGE' });
  }
  const session = await auth();
  if (!session?.user?.id) return Response.redirect(`${config.WEB_URL}/session/expired`, 303);
  // A session that still owes 2FA (S1-04) would be refused at the mint: to the challenge with a 303 before the body.
  if (!session.user.mfaVerified) {
    const status = await identity.getTwoFactorStatus(await requestAuthCtx(), { userId: session.user.id });
    if (status.enabled || status.required) {
      const path = getPathname({ href: '/two-factor', locale: DEFAULT_UI_LOCALE });
      return Response.redirect(`${config.WEB_URL}${path}`, 303);
    }
  }
  const release = listingDocumentUploads.take(session.user.id);
  if (!release) return back(DEFAULT_UI_LOCALE, { error: 'RATE_LIMITED' });
  try {
    const form = await request.formData().catch(() => null);
    const localeField = form?.get('locale');
    const locale = typeof localeField === 'string' && isUiLocale(localeField) ? localeField : DEFAULT_UI_LOCALE;
    const requestId = form?.get('requestId');
    const file = form?.get('file');
    if (typeof requestId !== 'string' || !UUID.test(requestId)) return back(locale, { error: 'VALIDATION_FAILED' });
    if (!(file instanceof File) || file.size === 0) return back(locale, { error: 'VALIDATION_FAILED' });
    if (file.size > SIGNED_PDF_VERIFY_MAX_BYTES) return back(locale, { error: 'PAYLOAD_TOO_LARGE' });
    const res = await verifySignedPdf(sessionRef(session.user), requestId, new Uint8Array(await file.arrayBuffer()));
    if (res === 'revoked') return Response.redirect(`${config.WEB_URL}/session/expired`, 303);
    if (res.ok) return back(locale, { verified: res.data.match, sha: res.data.sha256 });
    const code = res.error?.code;
    return back(locale, { error: code && KNOWN_ERRORS.has(code) ? code : 'generic' });
  } finally {
    release();
  }
}
