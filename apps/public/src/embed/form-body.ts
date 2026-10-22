/**
 * The embed enquiry form's body (S7-F8 security review): `application/x-www-form-urlencoded` only, read through a
 * byte-counting reader that stops at the cap — a declared `Content-Length` is never trusted (a chunked body has none),
 * and nothing past the cap is buffered.
 */

export type FormBody = { ok: true; fields: URLSearchParams } | { ok: false; status: 413 | 415 };

const URLENCODED = 'application/x-www-form-urlencoded';

export async function readFormBody(request: Request, maxBytes: number): Promise<FormBody> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== URLENCODED) return { ok: false, status: 415 };
  const declared = request.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= maxBytes)) return { ok: false, status: 413 };
  if (!request.body) return { ok: true, fields: new URLSearchParams() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop the upload here: the rest is never read.
      await reader.cancel();
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, fields: new URLSearchParams(new TextDecoder().decode(bytes)) };
}
