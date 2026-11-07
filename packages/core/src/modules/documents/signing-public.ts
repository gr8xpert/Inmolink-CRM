/**
 * The public signing page's core (R2-05b): `GET /sign/<token>` and its actions on the public pages host. No login: the
 * signed link names the signer (`signing-token.ts`), and signing also needs the one-time code e-mailed to the signer's
 * address. What a token may do is read on every use from the signer's request (`signing_signer()`, app_public): open,
 * not expired, not superseded, the signer's turn, not signed yet — and read again under the signer's lock inside the
 * writing transaction (app_intake), with the database's clock (code review: no app-clock / DB-clock mix).
 *
 * - **Code** (`requestSigningCode`): Turnstile (when configured; required in production), then — as `app_intake`
 *   pinned to the signer's agency, one signer at a time (advisory lock) — at most one code a minute and
 *   `SIGNING_CODES_PER_DAY` a day: an `OTP_SENT` row (10 minutes) and `documents.signature.codeRequested` (the worker
 *   derives and e-mails the code; it is stored nowhere).
 * - **Sign** (`submitSignature`): the name (typed or with a drawn PNG), the consent and the hash the page showed (it must
 *   be the request's); the signer's latest code, live, with fewer than `SIGNING_GUESSES_PER_CODE` wrong guesses and
 *   fewer than `SIGNING_FAILURES_PER_DAY` in a day; a wrong code is recorded (`OTP_FAILED`), the right one records the
 *   signature (`SIGNED`, once per signer — a unique index) with the IP and user agent and
 *   `documents.signature.signed` (the worker applies it).
 * - **Files** (`signingFileUrl`): a 5-minute signed link to the original (while it can be signed) or to the signed PDF
 *   (90 days after completion).
 * - **Limits** (`checkSigningLimits`): page views and invalid links per client address; codes and signatures per link
 *   and per address. One Redis round trip; keyed by the token's keyed hash, never the token.
 */
import { withIntake, withPublicRead } from '@inmolink/db';
import { hmacSha256 } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { RateLimitCheck, RateLimiter } from '@inmolink/platform/rate-limit';
import { storage } from '@inmolink/platform/storage';
import { documentsEvents } from './events';
import { formDocumentKey } from './forms';
import { signedFormKey } from './signature-keys';
import * as repo from './signatures-repo';
import {
  maskedEmail,
  normalizedCode,
  readSigningToken,
  SIGNING_CODE,
  signingCodeMatches,
  signingConfig,
} from './signing-token';

export const SIGNING_CODE_TTL_SECONDS = 600;
export const SIGNING_CODE_RESEND_SECONDS = 60;
export const SIGNING_CODES_PER_DAY = 10;
export const SIGNING_GUESSES_PER_CODE = 5;
export const SIGNING_FAILURES_PER_DAY = 20;
/** The signed PDF stays downloadable from the signing link this long after completion (then: ask the agency). */
export const SIGNED_FILE_DAYS = 90;
/** The Turnstile action of the code form. */
export const SIGNING_TURNSTILE_ACTION = 'signing-code';
const DAY_MS = 86_400_000;
const FILE_LINK_SECONDS = 300;

export type SigningState = 'OPEN' | 'WAITING' | 'SIGNED' | 'COMPLETED' | 'CLOSED';

export interface SigningPageModel {
  agencyId: string;
  signerId: string;
  /** The agency's name as the form states it. */
  agencyName: string | null;
  name: string;
  /** `j•••@example.com`. */
  emailHint: string;
  role: string;
  locale: string;
  formTemplate: string;
  documentLabel: string;
  documentSha256: string;
  signedSha256: string | null;
  state: SigningState;
}

const toMs = (d: Date | string | null) => (d ? new Date(d).getTime() : null);

/** The database's now() as the row carries it. */
const dbNow = (r: repo.SigningSignerRow) => toMs(r.db_now) ?? 0;

function stateOf(r: repo.SigningSignerRow): SigningState {
  if (r.request_status === 'COMPLETED') return 'COMPLETED';
  // an applied signature stays signed; a SIGNED event not applied yet counts only while the request is open
  if (r.signed_at) return 'SIGNED';
  if (r.request_status !== 'OPEN' || r.superseded || (toMs(r.expires_at) ?? 0) <= dbNow(r)) return 'CLOSED';
  if (r.signed) return 'SIGNED';
  return r.waiting ? 'WAITING' : 'OPEN';
}

async function signerOf(token: string): Promise<repo.SigningSignerRow | null> {
  const target = readSigningToken(token);
  if (!target) return null;
  return withPublicRead((tx) => repo.signingSigner(tx, target.agencyId, target.signerId));
}

function modelOf(r: repo.SigningSignerRow): SigningPageModel {
  return {
    agencyId: r.agency_id,
    signerId: r.signer_id,
    agencyName: r.agency_name,
    name: r.name,
    emailHint: maskedEmail(r.email),
    role: r.role,
    locale: r.locale,
    formTemplate: r.form_template,
    documentLabel: r.form_label,
    documentSha256: r.document_sha256,
    signedSha256: r.signed_sha256,
    state: stateOf(r),
  };
}

/** The page's model (`GET /sign/<token>`), or null for an invalid link (the page answers a neutral 404). */
export async function signingPage(token: string): Promise<SigningPageModel | null> {
  const r = await signerOf(token);
  return r ? modelOf(r) : null;
}

const clip = (s: string | null | undefined, max: number) => (s ? s.slice(0, max) : null);

export interface SigningFacts {
  ip?: string | undefined;
  userAgent?: string | null;
}

export type CodeOutcome =
  | { outcome: 'SENT'; emailHint: string }
  | { outcome: 'WAIT' | 'CODE_LIMIT' | 'TURNSTILE' | 'UNAVAILABLE' }
  | { outcome: 'STATE'; state: Exclude<SigningState, 'OPEN'> }
  | { outcome: 'INVALID' };

/** `POST /sign/<token>` (`action=code`): a one-time code e-mailed to the signer (see the file's comment). */
export async function requestSigningCode(
  token: string,
  facts: SigningFacts & { turnstileToken?: string | null },
): Promise<CodeOutcome> {
  const r = await signerOf(token);
  if (!r) return { outcome: 'INVALID' };
  const page = modelOf(r);
  if (page.state !== 'OPEN') return { outcome: 'STATE', state: page.state };
  const cfg = signingConfig();
  if (cfg.turnstile) {
    if (!facts.turnstileToken || !cfg.turnstileHost) return { outcome: 'TURNSTILE' };
    const ok = await cfg.turnstile.verify(facts.turnstileToken, {
      action: SIGNING_TURNSTILE_ACTION,
      ...(facts.ip ? { remoteIp: facts.ip } : {}),
      hostnames: [cfg.turnstileHost],
    });
    if (!ok) return { outcome: 'TURNSTILE' };
  } else if (cfg.requireTurnstile) {
    return { outcome: 'UNAVAILABLE' };
  }
  return withIntake({ agencyId: r.agency_id }, async (tx): Promise<CodeOutcome> => {
    await repo.lockSigner(tx, r.signer_id);
    const live = await repo.signingSigner(tx, r.agency_id, r.signer_id);
    if (!live) return { outcome: 'INVALID' };
    const state = stateOf(live);
    if (state !== 'OPEN') return { outcome: 'STATE', state };
    const now = dbNow(live);
    const codes = await repo.codesSince(tx, r.signer_id, new Date(now - DAY_MS), SIGNING_CODES_PER_DAY);
    const latest = codes[0];
    if (latest && latest.createdAt.getTime() > now - SIGNING_CODE_RESEND_SECONDS * 1_000) return { outcome: 'WAIT' };
    if (codes.length >= SIGNING_CODES_PER_DAY) return { outcome: 'CODE_LIMIT' };
    const otpId = newId();
    await repo.insertEvent(tx, {
      id: otpId,
      agencyId: r.agency_id,
      signerId: r.signer_id,
      kind: 'OTP_SENT',
      otpTtlSeconds: SIGNING_CODE_TTL_SECONDS,
      ip: clip(facts.ip, 64),
      userAgent: clip(facts.userAgent, 512),
    });
    await emit(tx, documentsEvents.signatureCodeRequested({ agencyId: r.agency_id, signerId: r.signer_id, otpId }), {
      agencyId: r.agency_id,
    });
    return { outcome: 'SENT', emailHint: page.emailHint };
  });
}

// ---- signing ----------------------------------------------------------------------------------------------------------

/** The drawn signature as the page posts it: a PNG data URL. */
const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Largest drawn signature (bytes of PNG; base64 ≤ 90,000 characters as the table allows). */
export const SIGNATURE_PNG_MAX_BYTES = 64 * 1024;
const PNG_MAX_WIDTH = 2_000;
const PNG_MAX_HEIGHT = 1_000;

/** A drawn signature's PNG, checked (magic bytes, IHDR first, size, dimensions) and rebuilt from its critical chunks; null if not one. */
export function drawnSignature(dataUrl: string): string | null {
  if (dataUrl.length > 100_000) return null;
  const m = PNG_DATA_URL.exec(dataUrl);
  if (!m?.[1]) return null;
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length < 67 || bytes.length > SIGNATURE_PNG_MAX_BYTES) return null;
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > PNG_MAX_WIDTH || height > PNG_MAX_HEIGHT) return null;
  const kept = criticalChunks(bytes);
  return kept ? kept.toString('base64') : null;
}

/** PNG chunks a drawn signature may keep: the image itself, nothing ancillary (text, metadata, private chunks). */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

/**
 * The PNG rebuilt from its critical chunks only (security review: no text or private chunk reaches the audit page's
 * renderer); null when the chunk structure is broken (a length past the end, no IEND, data after it).
 */
function criticalChunks(bytes: Buffer): Buffer | null {
  const parts: Buffer[] = [PNG_MAGIC];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > bytes.length) return null;
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (PNG_KEEP.has(type)) parts.push(bytes.subarray(at, end));
    at = end;
    if (type === 'IEND') return at === bytes.length ? Buffer.concat(parts) : null;
  }
  return null;
}

/** A name as signed: one line, no control characters, NFC, 1–200 characters. */
export function signedName(raw: string): string | null {
  const name = raw
    .normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name.length >= 1 && name.length <= 200 ? name : null;
}

export interface SignatureInput {
  code: string;
  kind: 'TYPED' | 'DRAWN';
  name: string;
  /** `DRAWN`: the canvas's PNG data URL. */
  drawing?: string | null;
  consent: boolean;
  /** The SHA-256 the page showed (it must still be the request's). */
  documentSha256: string;
}

export type SignOutcome =
  | { outcome: 'SIGNED' }
  | { outcome: 'BAD_CODE'; attemptsLeft: number }
  | {
      outcome:
        | 'CODE_EXPIRED'
        | 'NO_CODE'
        | 'LOCKED'
        | 'CHANGED'
        | 'NAME_MISSING'
        | 'DRAWING_MISSING'
        | 'CONSENT_MISSING';
    }
  | { outcome: 'STATE'; state: Exclude<SigningState, 'OPEN'> }
  | { outcome: 'INVALID' };

const isUniqueViolation = (err: unknown, constraint: string) => {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const c = e.cause ?? e;
  return c.code === '23505' && c.constraint === constraint;
};

/** `POST /sign/<token>` (`action=sign`): the signature, with the code (see the file's comment). */
export async function submitSignature(token: string, input: SignatureInput, facts: SigningFacts): Promise<SignOutcome> {
  const r = await signerOf(token);
  if (!r) return { outcome: 'INVALID' };
  const page = modelOf(r);
  if (page.state !== 'OPEN') return { outcome: 'STATE', state: page.state };
  const name = signedName(input.name);
  if (!name) return { outcome: 'NAME_MISSING' };
  const png = input.kind === 'DRAWN' ? drawnSignature(input.drawing ?? '') : null;
  if (input.kind === 'DRAWN' && !png) return { outcome: 'DRAWING_MISSING' };
  if (!input.consent) return { outcome: 'CONSENT_MISSING' };
  if (input.documentSha256 !== r.document_sha256) return { outcome: 'CHANGED' };
  const code = normalizedCode(input.code);
  try {
    return await withIntake({ agencyId: r.agency_id }, async (tx): Promise<SignOutcome> => {
      await repo.lockSigner(tx, r.signer_id);
      // read again under the lock: the request may have closed, been superseded or expired since (code review)
      const live = await repo.signingSigner(tx, r.agency_id, r.signer_id);
      if (!live) return { outcome: 'INVALID' };
      const state = stateOf(live);
      if (state !== 'OPEN') return { outcome: 'STATE', state };
      if (input.documentSha256 !== live.document_sha256) return { outcome: 'CHANGED' };
      const now = dbNow(live);
      const [latest] = await repo.codesSince(tx, r.signer_id, new Date(now - DAY_MS), 1);
      const failures = await repo.failuresSince(
        tx,
        r.signer_id,
        new Date(now - DAY_MS),
        latest?.id ?? null,
        SIGNING_FAILURES_PER_DAY,
      );
      if (failures.total >= SIGNING_FAILURES_PER_DAY) return { outcome: 'LOCKED' };
      if (!latest) return { outcome: 'NO_CODE' };
      if (!latest.expiresAt || latest.expiresAt.getTime() <= now) return { outcome: 'CODE_EXPIRED' };
      if (failures.ofCode >= SIGNING_GUESSES_PER_CODE) return { outcome: 'CODE_EXPIRED' };
      const common = {
        agencyId: r.agency_id,
        signerId: r.signer_id,
        otpId: latest.id,
        ip: clip(facts.ip, 64),
        userAgent: clip(facts.userAgent, 512),
      };
      if (!SIGNING_CODE.test(code) || !signingCodeMatches(latest.id, r.signer_id, code)) {
        await repo.insertEvent(tx, { id: newId(), kind: 'OTP_FAILED', ...common });
        return { outcome: 'BAD_CODE', attemptsLeft: Math.max(0, SIGNING_GUESSES_PER_CODE - failures.ofCode - 1) };
      }
      const eventId = newId();
      await repo.insertEvent(tx, {
        id: eventId,
        kind: 'SIGNED',
        ...common,
        signatureKind: input.kind,
        signatureText: name,
        signaturePng: png,
        documentSha256: r.document_sha256,
      });
      await emit(tx, documentsEvents.signatureSigned({ agencyId: r.agency_id, signerId: r.signer_id, eventId }), {
        agencyId: r.agency_id,
      });
      return { outcome: 'SIGNED' };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'signature_events_signed_uq')) return { outcome: 'STATE', state: 'SIGNED' };
    throw err;
  }
}

// ---- files ------------------------------------------------------------------------------------------------------------

/**
 * `GET /sign/<token>/document` and `/signed`: a 5-minute signed link to the original (while the signer can sign or
 * has signed and the others have not finished) or to the signed PDF (`COMPLETED`, for `SIGNED_FILE_DAYS`). Null when
 * the link does not open that file (or storage is not configured on this host: `UNAVAILABLE`).
 */
export async function signingFileUrl(
  token: string,
  which: 'original' | 'signed',
): Promise<{ url: string } | 'UNAVAILABLE' | null> {
  const r = await signerOf(token);
  if (!r) return null;
  const state = stateOf(r);
  let key: string;
  let name: string;
  if (which === 'original') {
    if (state !== 'OPEN' && state !== 'WAITING' && state !== 'SIGNED') return null;
    key = formDocumentKey(r.agency_id, r.form_id);
    name = `document-${r.form_id}.pdf`;
  } else {
    const done = toMs(r.completed_at);
    if (state !== 'COMPLETED' || !done || done + SIGNED_FILE_DAYS * DAY_MS <= dbNow(r)) return null;
    key = signedFormKey(r.agency_id, r.form_id, r.request_id);
    name = `signed-${r.form_id}.pdf`;
  }
  let url: string;
  try {
    url = await storage().signedGetUrl('private', key, {
      expiresInSeconds: FILE_LINK_SECONDS,
      downloadName: name,
      responseContentType: 'application/pdf',
    });
  } catch {
    return 'UNAVAILABLE';
  }
  return { url };
}

// ---- limits -----------------------------------------------------------------------------------------------------------

export const SIGNING_LIMITS = {
  viewsPerMinute: 60,
  invalidPerMinute: 30,
  codesPerLinkPerHour: 5,
  codesPerIpPerHour: 30,
  signsPerLinkPerHour: 20,
  signsPerIpPerMinute: 30,
} as const;

/**
 * Request limits of `/sign/<token>`: page views and file links per client address; a code request per link and per
 * address; a signature per link and per address; an invalid token's actions per address. Fails open with the limiter.
 */
export async function checkSigningLimits(
  limiter: RateLimiter,
  facts: { ip: string; action: 'view' | 'code' | 'sign'; token: string },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const valid = !!readSigningToken(facts.token);
  const slot = valid ? hmacSha256(signingConfig().tokenKey, 'documents.signing-limit', facts.token).slice(0, 22) : null;
  const checks: RateLimitCheck[] = [];
  if (facts.action === 'view') {
    checks.push({
      rule: { name: 'signing.page', scope: 'ip', limit: SIGNING_LIMITS.viewsPerMinute, windowSeconds: 60 },
      identity: facts.ip,
    });
  } else if (!slot) {
    checks.push({
      rule: { name: 'signing.invalid', scope: 'ip', limit: SIGNING_LIMITS.invalidPerMinute, windowSeconds: 60 },
      identity: facts.ip,
    });
  } else if (facts.action === 'code') {
    checks.push(
      {
        rule: {
          name: 'signing.code.link',
          scope: 'key',
          limit: SIGNING_LIMITS.codesPerLinkPerHour,
          windowSeconds: 3_600,
        },
        identity: slot,
      },
      {
        rule: { name: 'signing.code.ip', scope: 'ip', limit: SIGNING_LIMITS.codesPerIpPerHour, windowSeconds: 3_600 },
        identity: facts.ip,
      },
    );
  } else {
    checks.push(
      {
        rule: {
          name: 'signing.sign.link',
          scope: 'key',
          limit: SIGNING_LIMITS.signsPerLinkPerHour,
          windowSeconds: 3_600,
        },
        identity: slot,
      },
      {
        rule: { name: 'signing.sign.ip', scope: 'ip', limit: SIGNING_LIMITS.signsPerIpPerMinute, windowSeconds: 60 },
        identity: facts.ip,
      },
    );
  }
  const results = await limiter.consumeMany(checks, { slot: slot ?? facts.ip });
  const refused = results.filter((x) => !x.allowed);
  if (refused.length === 0) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.max(0, ...refused.map((x) => x.retryAfterSeconds)) };
}
