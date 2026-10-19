import { SHEET_UPLOAD_MAX_BYTES } from '@inmolink/contracts';
import { createUploadSlots } from '@inmolink/platform/rate-limit';
import { auth } from '@/auth';
import { sessionRef, uploadSheetFile } from '@/server/api';
import { webConfig } from '@/server/env';

const KNOWN_ERRORS = new Set([
  'FORBIDDEN',
  'FEED_SAMPLE_INVALID',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'UNSUPPORTED_MEDIA_TYPE',
]);
/** The relay buffers the body (≤ 25 MB): one per user, four per process, like the API behind it. */
const slots = createUploadSlots(1, 4);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * `POST /api/imports/sheet` — the mapper's CSV / Excel upload (S6-05, transport only). The browser sends the file as
 * the raw body (a server action would cap it at 1 MB). Before reading the body it checks the origin, the declared
 * length and the session; the API decides what the file is by its first bytes, reads the header and the first rows,
 * and stores it for the import. Answers `{ ok, data }` or `{ ok: false, error }`.
 */
export async function POST(request: Request): Promise<Response> {
  const config = await webConfig();
  if (request.headers.get('origin') !== new URL(config.WEB_URL).origin) return new Response(null, { status: 403 });
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return new Response(null, { status: 411 });
  if (length > SHEET_UPLOAD_MAX_BYTES) return json(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
  const session = await auth();
  if (!session?.user?.id) return json(401, { ok: false, error: 'revoked' });
  const release = slots.take(session.user.id);
  if (!release) return json(429, { ok: false, error: 'RATE_LIMITED' });
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > SHEET_UPLOAD_MAX_BYTES) {
      return json(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
    }
    const res = await uploadSheetFile(sessionRef(session.user), bytes);
    if (res === 'revoked') return json(401, { ok: false, error: 'revoked' });
    if (res.ok) return json(200, { ok: true, data: res.data });
    const code = res.error?.code;
    const reason = (res.error?.details as { reason?: unknown } | undefined)?.reason;
    return json(res.status ?? 422, {
      ok: false,
      error: code && KNOWN_ERRORS.has(code) ? code : 'generic',
      ...(typeof reason === 'string' ? { reason: reason.slice(0, 40) } : {}),
    });
  } finally {
    release();
  }
}
