import { DEVELOPMENT_DOCUMENT_MAX_BYTES, DevelopmentDocumentKind } from '@inmolink/contracts';
import { auth } from '@/auth';
import { sessionRef, uploadDevelopmentDocument } from '@/server/api';
import { webConfig } from '@/server/env';
import { listingDocumentUploads } from '@/server/upload-slots';

const KNOWN_ERRORS = new Set([
  'FORBIDDEN',
  'DEVELOPMENT_NOT_FOUND',
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
 * `POST /api/developments/:id/documents` — the development page's document upload (S4-F4, transport only), the
 * listing documents' relay (S3-F5) for developments. The browser sends the PDF as the raw body with XHR (upload
 * progress), its name in `x-file-name`, and `?kind=&shared=`. Before reading the body it checks the origin, the
 * declared length and the session; the API checks the file's real type and size. Listing and development
 * documents share the per-user and per-process buffer slots. Answers `{ ok, data }` or `{ ok: false, error }`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const config = await webConfig();
  if (request.headers.get('origin') !== new URL(config.WEB_URL).origin) return new Response(null, { status: 403 });
  const { id } = await params;
  if (!UUID.test(id)) return json(400, { ok: false, error: 'VALIDATION_FAILED' });
  const url = new URL(request.url);
  const kind = DevelopmentDocumentKind.safeParse(url.searchParams.get('kind') ?? 'OTHER');
  if (!kind.success) return json(400, { ok: false, error: 'VALIDATION_FAILED' });
  const shared = url.searchParams.get('shared') === 'true';
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return new Response(null, { status: 411 });
  if (length > DEVELOPMENT_DOCUMENT_MAX_BYTES) return json(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
  const session = await auth();
  if (!session?.user?.id) return json(401, { ok: false, error: 'revoked' });
  const release = listingDocumentUploads.take(session.user.id);
  if (!release) return json(429, { ok: false, error: 'RATE_LIMITED' });
  try {
    return await relay(request, id, { kind: kind.data, shared }, session.user);
  } finally {
    release();
  }
}

async function relay(
  request: Request,
  id: string,
  options: { kind: string; shared: boolean },
  user: Parameters<typeof sessionRef>[0],
): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > DEVELOPMENT_DOCUMENT_MAX_BYTES) {
    return json(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
  }
  const raw = request.headers.get('x-file-name') ?? '';
  let fileName = 'document.pdf';
  try {
    fileName = decodeURIComponent(raw).slice(0, 200) || fileName;
  } catch {
    // a malformed name: keep the neutral one
  }
  const res = await uploadDevelopmentDocument(sessionRef(user), id, { fileName, ...options }, bytes);
  if (res === 'revoked') return json(401, { ok: false, error: 'revoked' });
  if (res.ok) return json(201, { ok: true, data: res.data });
  const code = res.error?.code;
  return json(res.status ?? 422, { ok: false, error: code && KNOWN_ERRORS.has(code) ? code : 'generic' });
}
