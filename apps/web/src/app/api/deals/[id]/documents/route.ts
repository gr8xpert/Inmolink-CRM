import { DEAL_DOCUMENT_KINDS, DEAL_DOCUMENT_MAX_BYTES, DealParams, DocumentFileName } from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { auth } from '@/auth';
import { getPathname } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { uploadDealDocument } from '@/server/deals-api';
import { webConfig } from '@/server/env';
import { requestAuthCtx } from '@/server/request-id';
import { listingDocumentUploads } from '@/server/upload-slots';

/** Multipart overhead on top of the file (boundaries, part headers, the other fields). */
const FORM_OVERHEAD_BYTES = 64 * 1024;

const KNOWN_ERRORS = new Set([
  'FORBIDDEN',
  'DEAL_NOT_FOUND',
  'DEAL_STATE',
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_LIMIT_REACHED',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
]);

/**
 * `POST /api/deals/:id/documents` — the deal room's upload form (R2-04c, transport only). A route handler instead of a
 * server action, so the 20 MB limit applies to this path alone. Before reading the body it checks the origin (the
 * session cookie is SameSite=Strict as well), the declared length, the session and a per-user upload slot (the
 * document relays share them). The API checks the file's real type (magic bytes), its size, the deal and who may
 * upload. Answers with a 303 back to the deal and a notice or an error code.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const config = await webConfig();
  const parsed = DealParams.safeParse({ id: (await params).id });
  if (!parsed.success) return new Response(null, { status: 404 });
  const dealId = parsed.data.id;
  const back = (locale: string, query: Record<string, string>) =>
    Response.redirect(`${config.WEB_URL}/${locale}/deals/${dealId}?${new URLSearchParams(query)}`, 303);

  if (request.headers.get('origin') !== new URL(config.WEB_URL).origin) {
    return new Response(null, { status: 403 });
  }
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return new Response(null, { status: 411 });
  // The locale is unknown until the body is read: a refused body goes back to the default locale.
  if (length > DEAL_DOCUMENT_MAX_BYTES + FORM_OVERHEAD_BYTES) {
    return back(DEFAULT_UI_LOCALE, { error: 'PAYLOAD_TOO_LARGE' });
  }
  const session = await auth();
  if (!session?.user?.id) return Response.redirect(`${config.WEB_URL}/session/expired`, 303);
  // A session that still owes 2FA (S1-04) would be refused at the mint: send it to the challenge with a 303 before
  // reading the body (a 307 from the shared API helper would re-post the file there).
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
    const file = form?.get('file');
    if (!(file instanceof File) || file.size === 0) return back(locale, { error: 'VALIDATION_FAILED' });
    if (file.size > DEAL_DOCUMENT_MAX_BYTES) return back(locale, { error: 'PAYLOAD_TOO_LARGE' });
    // Browsers send the bare name; anything unusable becomes a neutral one.
    const name = DocumentFileName.safeParse(file.name);
    const res = await uploadDealDocument(sessionRef(session.user), dealId, {
      kind: DEAL_DOCUMENT_KINDS.find((k) => k === form?.get('kind')) ?? 'OTHER',
      fileName: name.success ? name.data : 'document.pdf',
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    if (res === 'revoked') return Response.redirect(`${config.WEB_URL}/session/expired`, 303);
    if (res.ok) return back(locale, { done: 'uploaded' });
    const code = res.error?.code;
    const reason = (res.error?.details as { reason?: unknown } | undefined)?.reason;
    return back(locale, {
      error: code && KNOWN_ERRORS.has(code) ? code : 'generic',
      ...(code === 'DEAL_STATE' && typeof reason === 'string' && /^[a-z_]{1,40}$/.test(reason) ? { reason } : {}),
    });
  } finally {
    release();
  }
}
