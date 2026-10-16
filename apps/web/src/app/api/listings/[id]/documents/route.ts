import { LISTING_DOCUMENT_MAX_BYTES } from '@inmolink/contracts';
import { auth } from '@/auth';
import { sessionRef, uploadListingDocument } from '@/server/api';
import { webConfig } from '@/server/env';
import { listingDocumentUploads } from '@/server/upload-slots';

const KNOWN_ERRORS = new Set([
  'FORBIDDEN',
  'LISTING_NOT_FOUND',
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_LIMIT_REACHED',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * `POST /api/listings/:id/documents` — the media manager's document upload (S3-F5, transport only). The browser
 * sends the PDF as the raw body with XHR (so it can show upload progress) and its name in `x-file-name`. A route
 * handler instead of a server action, so the 20 MB limit applies to this path alone. Before reading the body it
 * checks the origin (the session cookie is SameSite=Strict as well), the declared length and the session; the
 * API checks the file's real type and size. At most `LISTING_DOCUMENT_UPLOAD_SLOTS` bodies per user are buffered at
 * once (S3-F8): one more is refused with 429 before it is read. Answers JSON: `{ ok, data }` or `{ ok: false, error }`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const config = await webConfig();
  if (request.headers.get('origin') !== new URL(config.WEB_URL).origin) return new Response(null, { status: 403 });
  const { id } = await params;
  if (!UUID.test(id)) return json(400, { ok: false, error: 'VALIDATION_FAILED' });
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return new Response(null, { status: 411 });
  if (length > LISTING_DOCUMENT_MAX_BYTES) return json(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
  const session = await auth();
  if (!session?.user?.id) return json(401, { ok: false, error: 'revoked' });
  const release = listingDocumentUploads.take(session.user.id);
  if (!release) return json(429, { ok: false, error: 'RATE_LIMITED' });
  try {
    return await relay(request, id, session.user);
  } finally {
    release();
  }
}

async function relay(request: Request, id: string, user: Parameters<typeof sessionRef>[0]): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > LISTING_DOCUMENT_MAX_BYTES) {
    return json(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
  }
  const raw = request.headers.get('x-file-name') ?? '';
  let fileName = 'document.pdf';
  try {
    fileName = decodeURIComponent(raw).slice(0, 200) || fileName;
  } catch {
    // a malformed name: keep the neutral one
  }
  const res = await uploadListingDocument(sessionRef(user), id, fileName, bytes);
  if (res === 'revoked') return json(401, { ok: false, error: 'revoked' });
  if (res.ok) return json(201, { ok: true, data: res.data });
  const code = res.error?.code;
  return json(res.status ?? 422, { ok: false, error: code && KNOWN_ERRORS.has(code) ? code : 'generic' });
}
