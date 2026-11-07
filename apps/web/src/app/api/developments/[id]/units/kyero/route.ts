import { KYERO_UNITS_MAX_BYTES } from '@inmolink/contracts';
import { auth } from '@/auth';
import { readKyeroUnits, sessionRef } from '@/server/api';
import { webConfig } from '@/server/env';
import { listingDocumentUploads } from '@/server/upload-slots';

const KNOWN_ERRORS = new Set([
  'FORBIDDEN',
  'DEVELOPMENT_NOT_FOUND',
  'KYERO_FILE_INVALID',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'UNSUPPORTED_MEDIA_TYPE',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * `POST /api/developments/:id/units/kyero` — the units panel's Kyero file (R2-07a, transport only): the browser sends
 * the XML as the raw body (larger than a server action takes). Before reading the body it checks the origin, the
 * declared length and the session; the API checks the content. Shares the development documents' per-user upload
 * slots. Answers `{ ok, data }` (the units to import, or the problems) or `{ ok: false, error }`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const config = await webConfig();
  if (request.headers.get('origin') !== new URL(config.WEB_URL).origin) return new Response(null, { status: 403 });
  const { id } = await params;
  if (!UUID.test(id)) return json(400, { ok: false, error: 'VALIDATION_FAILED' });
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return new Response(null, { status: 411 });
  if (length > KYERO_UNITS_MAX_BYTES) return json(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
  const session = await auth();
  if (!session?.user?.id) return json(401, { ok: false, error: 'revoked' });
  const release = listingDocumentUploads.take(session.user.id);
  if (!release) return json(429, { ok: false, error: 'RATE_LIMITED' });
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > KYERO_UNITS_MAX_BYTES) {
      return json(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
    }
    const res = await readKyeroUnits(sessionRef(session.user), id, bytes);
    if (res === 'revoked') return json(401, { ok: false, error: 'revoked' });
    if (res.ok) return json(200, { ok: true, data: res.data });
    const code = res.error?.code;
    return json(res.status || 422, { ok: false, error: code && KNOWN_ERRORS.has(code) ? code : 'generic' });
  } finally {
    release();
  }
}
