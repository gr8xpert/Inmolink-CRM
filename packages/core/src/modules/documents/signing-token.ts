import { hmacSha256, hmacSha256Candidates, safeEqual } from '@inmolink/platform/crypto';
import type { TurnstileVerifier } from '@inmolink/platform/turnstile';

/**
 * The signing link and the one-time code (R2-05b).
 *
 * **The link** `<PUBLIC_PAGES_URL>/sign/<token>?l=<lang>`: the token is the agency's and the signer's ids (opaque UUIDs —
 * no name or e-mail) and a 120-bit HMAC over them (`HMAC_KEY`, purpose `documents.signing-link`), like the unsubscribe
 * link (R2-02g): it cannot be guessed or altered and names one signer of one agency. It is only an address: what it
 * may do is the signer's request's state (open, not expired, not superseded), read on every use, and signing needs the
 * code e-mailed to the signer's address as well. It outlives an `HMAC_KEY` rotation while the previous key verifies.
 *
 * **The code** (6 digits, 10 minutes, at most 5 guesses): derived from the `OTP_SENT` row's id and the signer's id with
 * a keyed MAC (`documents.signing-code`) — the public pages append the row, the worker derives the same code and
 * e-mails it, the page re-derives it to check a guess. The code is stored nowhere (not even hashed); one row per code
 * sent, so every code is distinct and dies with its row's expiry.
 */

const LINK_PURPOSE = 'documents.signing-link';
const CODE_PURPOSE = 'documents.signing-code';
const VERSION = 1;
const MAC_BYTES = 15;
const PAYLOAD_BYTES = 1 + 16 + 16;
/** A signing token as the link carries it: 48 bytes, base64url. */
export const SIGNING_TOKEN = /^[A-Za-z0-9_-]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A code as typed (spaces and dashes are dropped first). */
export const SIGNING_CODE = /^\d{6}$/;

export interface SigningConfig {
  tokenKey: Buffer;
  publicBaseUrl: string | null;
  /** The public pages: the Turnstile check of a code request (null: not configured). */
  turnstile: TurnstileVerifier | null;
  /** The public pages' host (Turnstile hostnames). */
  turnstileHost: string | null;
  /** Production: a code request without a configured Turnstile is refused (fail closed). */
  requireTurnstile: boolean;
}

let current: SigningConfig | undefined;

/** Boot (the worker's email and pdf pools, the public pages): `HMAC_KEY` and the public pages' origin. */
export function configureSigning(options: {
  tokenKey: string;
  publicBaseUrl?: string | null;
  turnstile?: TurnstileVerifier | null;
  requireTurnstile?: boolean;
}): void {
  if (!options.tokenKey) throw new Error('documents: signing tokenKey is required');
  const base = options.publicBaseUrl ? options.publicBaseUrl.replace(/\/+$/, '') : null;
  if (base && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(base)) {
    throw new Error('documents: signing publicBaseUrl must be an origin');
  }
  current = {
    tokenKey: Buffer.from(options.tokenKey),
    publicBaseUrl: base,
    turnstile: options.turnstile ?? null,
    turnstileHost: base ? new URL(base).hostname : null,
    requireTurnstile: options.requireTurnstile ?? false,
  };
}

export function signingConfig(): SigningConfig {
  if (!current) throw new Error('documents: configureSigning() was not called');
  return current;
}

/** Whether signing links can be made (the public origin is configured): no invitation goes out without one. */
export const signingLinksConfigured = (): boolean => !!current?.publicBaseUrl;

const uuidBytes = (id: string) => Buffer.from(id.replaceAll('-', ''), 'hex');
const uuidOf = (b: Buffer) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const macOf = (full: string) => Buffer.from(full, 'base64url').subarray(0, MAC_BYTES).toString('base64url');

/** The signer's signing token (the same in every e-mail to the signer). */
export function signingToken(agencyId: string, signerId: string): string {
  if (!UUID.test(agencyId) || !UUID.test(signerId)) throw new TypeError('documents: signing ids must be UUIDs');
  const payload = Buffer.concat([Buffer.from([VERSION]), uuidBytes(agencyId), uuidBytes(signerId)]);
  const mac = Buffer.from(macOf(hmacSha256(signingConfig().tokenKey, LINK_PURPOSE, payload)), 'base64url');
  return Buffer.concat([payload, mac]).toString('base64url');
}

/** The agency and signer a token names, or null when it is malformed, forged or altered (constant-time check). */
export function readSigningToken(token: string): { agencyId: string; signerId: string } | null {
  if (!SIGNING_TOKEN.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== PAYLOAD_BYTES + MAC_BYTES || raw[0] !== VERSION) return null;
  const payload = raw.subarray(0, PAYLOAD_BYTES);
  const presented = raw.subarray(PAYLOAD_BYTES).toString('base64url');
  let ok = false;
  for (const full of hmacSha256Candidates(signingConfig().tokenKey, LINK_PURPOSE, payload)) {
    ok = safeEqual(macOf(full), presented) || ok;
  }
  if (!ok) return null;
  return { agencyId: uuidOf(payload.subarray(1, 17)), signerId: uuidOf(payload.subarray(17, 33)) };
}

/** Where the signing page is served on the public pages host. */
export const signingPath = (token: string): string => `/sign/${token}`;

/** The signing page's link for a signer, in their language; null when the public origin is not set. */
export function signingUrl(input: { agencyId: string; signerId: string; locale: string }, suffix = ''): string | null {
  const base = current?.publicBaseUrl;
  if (!base) return null;
  const lang = /^[a-z]{2}$/.test(input.locale) ? `?l=${input.locale}` : '';
  return `${base}${signingPath(signingToken(input.agencyId, input.signerId))}${suffix}${lang}`;
}

const codeFrom = (mac: string) => String(Buffer.from(mac, 'base64url').readUInt32BE(0) % 1_000_000).padStart(6, '0');

/** The code of one `OTP_SENT` row (the current key): what the worker e-mails. */
export function signingCode(otpId: string, signerId: string): string {
  return codeFrom(hmacSha256(signingConfig().tokenKey, CODE_PURPOSE, `${otpId}:${signerId}`));
}

/** Whether `typed` is that row's code (current key, or the previous one inside a rotation window). Constant time. */
export function signingCodeMatches(otpId: string, signerId: string, typed: string): boolean {
  if (!SIGNING_CODE.test(typed)) return false;
  let ok = false;
  for (const mac of hmacSha256Candidates(signingConfig().tokenKey, CODE_PURPOSE, `${otpId}:${signerId}`)) {
    ok = safeEqual(codeFrom(mac), typed) || ok;
  }
  return ok;
}

/** A typed code without the spaces / dashes people add. */
export const normalizedCode = (raw: string): string => raw.replace(/[\s-]/g, '').slice(0, 12);

/** `j•••@example.com`: what the page shows of the address the code goes to. */
export function maskedEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}
