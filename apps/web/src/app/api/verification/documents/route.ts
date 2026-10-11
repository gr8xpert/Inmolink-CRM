import { DocumentFileName, VERIFICATION_DOCUMENT_MAX_BYTES, VerificationDocumentKind } from '@inmolink/contracts';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@inmolink/i18n';
import { auth } from '@/auth';
import { uploadVerificationDocument } from '@/server/api';
import { webConfig } from '@/server/env';

/** Multipart overhead on top of the file (boundaries, part headers, the other fields). */
const FORM_OVERHEAD_BYTES = 64 * 1024;

const KNOWN_ERRORS = new Set([
  'FORBIDDEN',
  'VERIFICATION_ALREADY_SUBMITTED',
  'VERIFICATION_NOT_OPEN',
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_LIMIT_REACHED',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
]);

/**
 * `POST /api/verification/documents` — the verification page's upload form (S1-03, transport only).
 * A route handler instead of a server action, so the 10 MB limit applies to this path alone (server
 * actions keep Next's 1 MB default). Before reading the body it checks the origin (the session cookie
 * is SameSite=Strict as well), the declared length and the session. The API checks the file's real
 * type and size. Answers with a 303 back to the page and a notice or an error code.
 */
export async function POST(request: Request): Promise<Response> {
  const config = await webConfig();
  const back = (locale: string, query: Record<string, string>) =>
    Response.redirect(`${config.WEB_URL}/${locale}/verification?${new URLSearchParams(query)}`, 303);

  if (request.headers.get('origin') !== new URL(config.WEB_URL).origin) {
    return new Response(null, { status: 403 });
  }
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return new Response(null, { status: 411 });
  // The locale is unknown until the body is read: a refused body goes back to the default locale.
  if (length > VERIFICATION_DOCUMENT_MAX_BYTES + FORM_OVERHEAD_BYTES) {
    return back(DEFAULT_UI_LOCALE, { error: 'PAYLOAD_TOO_LARGE' });
  }
  const session = await auth();
  if (!session?.user?.id) return Response.redirect(`${config.WEB_URL}/session/expired`, 303);

  const form = await request.formData().catch(() => null);
  const localeField = form?.get('locale');
  const locale = typeof localeField === 'string' && isUiLocale(localeField) ? localeField : DEFAULT_UI_LOCALE;
  const file = form?.get('file');
  const kind = VerificationDocumentKind.safeParse(form?.get('kind'));
  if (!(file instanceof File) || file.size === 0 || !kind.success) return back(locale, { error: 'VALIDATION_FAILED' });
  if (file.size > VERIFICATION_DOCUMENT_MAX_BYTES) return back(locale, { error: 'PAYLOAD_TOO_LARGE' });
  // Browsers send the bare name; anything unusable becomes a neutral one.
  const name = DocumentFileName.safeParse(file.name);

  const res = await uploadVerificationDocument(
    { userId: session.user.id, sessionVersion: session.user.sessionVersion },
    { kind: kind.data, fileName: name.success ? name.data : 'document' },
    { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type },
  );
  if (res === 'revoked') return Response.redirect(`${config.WEB_URL}/session/expired`, 303);
  if (res.ok) return back(locale, { notice: 'uploaded' });
  const code = res.error?.code;
  return back(locale, { error: code && KNOWN_ERRORS.has(code) ? code : 'generic' });
}
