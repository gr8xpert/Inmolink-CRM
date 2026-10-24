import { randomBytes } from 'node:crypto';
import type { TwoFactorCode, TwoFactorStatusDto } from '@inmolink/contracts';
import { setAuthScope, type Tx } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import {
  aadFor,
  base32Encode,
  generateTotpSecret,
  hmacSha256,
  matchTotp,
  safeEqual,
  totpUri,
} from '@inmolink/platform/crypto';
import { dummyVerify, verifyPassword } from '@inmolink/platform/crypto/password';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit, PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import type { AuthCtx } from '../../context';
import * as compliance from '../compliance';
import { identityConfig, TWO_FACTOR } from './config';
import { identityEvents } from './events';
import { identityLog } from './log';
import { requiresSecondFactor } from './policy';
import * as repo from './repo';

/**
 * Two-factor authentication (S1-04, PLAN §3 #30 §12): TOTP plus 10 single-use recovery codes. Runs as
 * `app_auth` scoped to the signed-in user; the web passes the user id from its session. Rate limits on
 * code checks are the caller's job and run first (like login).
 *
 * The session learns that the factor was passed through a short-lived **proof** (HMAC over user and
 * session version): Auth.js lets the browser send arbitrary data with a session update, so the session
 * callback trusts only a proof it can verify. "Remember this browser" is a signed cookie value bound to
 * the user, the session version and the enrolment, so a password reset or a new enrolment ends it.
 */

const secretAad = (userId: string) =>
  aadFor({ agencyId: null, table: 'user_mfa', column: 'totp_secret', rowId: userId });

function keyring() {
  const { keyring } = identityConfig();
  if (!keyring) throw new Error('identity: no keyring configured (TOTP secrets)');
  return keyring;
}

const decryptSecret = (userId: string, envelope: string) => keyring().decrypt(envelope, secretAad(userId));

function hashRecoveryCode(code: string): string {
  return hmacSha256(identityConfig().hmacKey, 'recovery-code', code);
}

/** 10 base32 characters (50 bits), shown as `xxxxx-xxxxx`; stored as an HMAC of the 10 characters. */
function newRecoveryCodes(): { shown: string[]; hashes: string[] } {
  const shown: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < TWO_FACTOR.RECOVERY_CODES; i++) {
    const code = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    shown.push(`${code.slice(0, 5)}-${code.slice(5)}`);
    hashes.push(hashRecoveryCode(code));
  }
  return { shown, hashes };
}

async function replaceRecoveryCodes(tx: Tx, userId: string, now: Date): Promise<string[]> {
  const { shown, hashes } = newRecoveryCodes();
  await repo.retireRecoveryCodes(tx, userId, now);
  await repo.insertRecoveryCodes(
    tx,
    hashes.map((codeHash) => ({ id: newId(), userId, codeHash, createdAt: now })),
  );
  return shown;
}

/** Opens an `app_auth` transaction scoped to the user. */
function asUser<T>(ctx: AuthCtx, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.transaction(async (tx) => {
    await setAuthScope(tx, { userId });
    return fn(tx);
  });
}

/**
 * Audit (S1-08) of a 2FA change, under the user's agency (the platform for staff and users without one).
 * `tx` is scoped to the user; this narrows the scope to the user and that agency.
 */
async function auditTwoFactor(
  tx: Tx,
  requestId: string,
  userId: string,
  type: Extract<compliance.AuditType, `identity.twoFactor.${string}`>,
  metadata: compliance.AuditMetadata = {},
): Promise<void> {
  const member = await repo.findMembership(tx, userId);
  await compliance.auditAuth(tx, {
    type,
    userId,
    agencyId: member?.agencyId ?? null,
    // A failed challenge proves nothing about who typed the code.
    authenticated: type !== 'identity.twoFactor.failed',
    requestId,
    metadata,
  });
}

async function isStaff(tx: Tx, userId: string): Promise<boolean> {
  return (await repo.findStaffRole(tx, userId)) !== null;
}

/**
 * Whether the user's role requires 2FA (staff, agency admins). `tx` is scoped to the user; pass the
 * membership when the caller already loaded it.
 */
export async function isSecondFactorRequired(
  tx: Tx,
  userId: string,
  member?: { role: string; deactivatedAt: Date | null } | null,
): Promise<boolean> {
  const m = member === undefined ? await repo.findMembership(tx, userId) : member;
  return requiresSecondFactor(m, await isStaff(tx, userId));
}

export async function getTwoFactorStatus(ctx: AuthCtx, input: { userId: string }): Promise<TwoFactorStatusDto> {
  return asUser(ctx, input.userId, async (tx) => {
    const mfa = await repo.findMfa(tx, input.userId);
    const enabled = Boolean(mfa?.confirmedAt);
    return {
      enabled,
      required: await isSecondFactorRequired(tx, input.userId),
      recoveryCodesLeft: enabled ? await repo.countRecoveryCodes(tx, input.userId) : 0,
    };
  });
}

const enrolmentOf = (email: string, secret: string) => ({
  secret,
  uri: totpUri({ issuer: TWO_FACTOR.ISSUER, account: email, secret }),
});

/**
 * Starts (or resumes) enrolment: the secret for the authenticator app and its `otpauth://` URI. Needs
 * the account password again (S1-F8): an unattended session alone cannot enrol its own authenticator
 * and so lock the owner out. A POST creates the pending secret; the enrolment page only reads it
 * (`getPendingEnrolment`). A pending secret is kept until it is confirmed, so reloading does not
 * invalidate a scan. The password is checked outside the transaction (hashing is slow).
 */
export async function startEnrolment(
  ctx: AuthCtx,
  input: { userId: string; password: string },
): Promise<{ secret: string; uri: string }> {
  const hash = await asUser(ctx, input.userId, (tx) => repo.findPasswordHash(tx, input.userId));
  const matches = hash ? await verifyPassword(hash, input.password) : await dummyVerify(input.password);
  if (!matches) throw new AppError('INVALID_CREDENTIALS');
  return asUser(ctx, input.userId, async (tx) => {
    const user = await repo.findUserForEmail(tx, input.userId);
    if (!user) throw new AppError('NOT_FOUND', { entity: 'user' });
    const mfa = await repo.findMfa(tx, input.userId);
    if (mfa?.confirmedAt) throw new AppError('MFA_ALREADY_ENABLED');
    let secret = mfa?.totpSecret ? decryptSecret(input.userId, mfa.totpSecret) : null;
    if (!secret) {
      secret = generateTotpSecret();
      const envelope = keyring().encrypt(secret, secretAad(input.userId));
      if (!(await repo.upsertPendingMfa(tx, input.userId, envelope, clock.now()))) {
        throw new AppError('MFA_ALREADY_ENABLED');
      }
    }
    return enrolmentOf(user.email, secret);
  });
}

/** The pending enrolment started by `startEnrolment`, or null — a read, so a GET never creates a secret. */
export async function getPendingEnrolment(
  ctx: AuthCtx,
  input: { userId: string },
): Promise<{ secret: string; uri: string } | null> {
  return asUser(ctx, input.userId, async (tx) => {
    const mfa = await repo.findMfa(tx, input.userId);
    if (mfa?.confirmedAt || !mfa?.totpSecret) return null;
    const user = await repo.findUserForEmail(tx, input.userId);
    return user ? enrolmentOf(user.email, decryptSecret(input.userId, mfa.totpSecret)) : null;
  });
}

/**
 * Confirms enrolment with the first code from the app: 2FA is on, and the 10 recovery codes are
 * returned — the only time they are shown. The calling session has just passed the factor (proof).
 */
export async function confirmEnrolment(
  ctx: AuthCtx,
  input: { userId: string; sessionVersion: number; code: TwoFactorCode },
): Promise<{ recoveryCodes: string[]; proof: string }> {
  const now = clock.now();
  const recoveryCodes = await asUser(ctx, input.userId, async (tx) => {
    const mfa = await repo.findMfa(tx, input.userId);
    if (mfa?.confirmedAt) throw new AppError('MFA_ALREADY_ENABLED');
    if (!mfa?.totpSecret) throw new AppError('MFA_CODE_INVALID');
    const step = matchTotp(decryptSecret(input.userId, mfa.totpSecret), input.code, now);
    if (step === null || !(await repo.confirmMfa(tx, input.userId, mfa.totpSecret, step, now))) {
      throw new AppError('MFA_CODE_INVALID');
    }
    const codes = await replaceRecoveryCodes(tx, input.userId, now);
    await emit(tx, identityEvents.twoFactorEnabled({ userId: input.userId }), { agencyId: PLATFORM_AGENCY_ID });
    await auditTwoFactor(tx, ctx.requestId, input.userId, 'identity.twoFactor.enabled');
    return codes;
  });
  return { recoveryCodes, proof: mfaProof(input.userId, input.sessionVersion, now) };
}

/**
 * Checks a TOTP code (once per time step) or uses a recovery code (once, ever). Null when neither
 * matches or 2FA is not enabled. `tx` is scoped to the user.
 */
async function consumeCode(
  tx: Tx,
  userId: string,
  code: TwoFactorCode,
  now: Date,
  requestId: string,
): Promise<{ method: 'totp' | 'recovery'; confirmedAt: Date; deviceEpoch: number } | null> {
  const mfa = await repo.findMfa(tx, userId);
  if (!mfa?.confirmedAt || !mfa.totpSecret) return null;
  if (/^\d{6}$/.test(code)) {
    const step = matchTotp(decryptSecret(userId, mfa.totpSecret), code, now);
    const used = step !== null && (await repo.useTotpStep(tx, userId, step, now));
    return used ? { method: 'totp', confirmedAt: mfa.confirmedAt, deviceEpoch: mfa.deviceEpoch } : null;
  }
  if (!(await repo.consumeRecoveryCode(tx, userId, hashRecoveryCode(code), now))) return null;
  await emit(tx, identityEvents.recoveryCodeUsed({ userId }), { agencyId: PLATFORM_AGENCY_ID });
  await auditTwoFactor(tx, requestId, userId, 'identity.twoFactor.recoveryCodeUsed');
  return { method: 'recovery', confirmedAt: mfa.confirmedAt, deviceEpoch: mfa.deviceEpoch };
}

/**
 * The login challenge: a TOTP or recovery code. Returns the proof for the session and, when asked, a
 * 30-day "remember this browser" token. A recovery code is used up even if the caller fails later.
 */
export async function verifySecondFactor(
  ctx: AuthCtx,
  input: { userId: string; sessionVersion: number; code: TwoFactorCode; rememberDevice: boolean },
): Promise<{ proof: string; device?: { token: string; expiresAt: Date }; method: 'totp' | 'recovery' }> {
  const now = clock.now();
  const result = await asUser(ctx, input.userId, async (tx) => {
    const used = await consumeCode(tx, input.userId, input.code, now, ctx.requestId);
    if (used) {
      await auditTwoFactor(tx, ctx.requestId, input.userId, 'identity.twoFactor.verified', { method: used.method });
      // A new remembered browser is an access path worth telling the owner about (S1-F8).
      if (input.rememberDevice)
        await emit(tx, identityEvents.deviceRemembered({ userId: input.userId }), { agencyId: PLATFORM_AGENCY_ID });
    }
    return used;
  });
  // Thrown outside the transaction: a failed check changes nothing, so there is nothing to roll back. The
  // failure is audited in its own transaction (like a failed login); a failed audit write is not fatal.
  if (!result) {
    await asUser(ctx, input.userId, (tx) =>
      auditTwoFactor(tx, ctx.requestId, input.userId, 'identity.twoFactor.failed'),
    ).catch((err: unknown) =>
      identityLog().error({ err, requestId: ctx.requestId }, 'identity: failed-2FA audit not written'),
    );
    throw new AppError('MFA_CODE_INVALID');
  }
  const proof = mfaProof(input.userId, input.sessionVersion, now);
  if (!input.rememberDevice) return { proof, method: result.method };
  return {
    proof,
    method: result.method,
    device: deviceToken(input.userId, input.sessionVersion, result.confirmedAt, result.deviceEpoch, now),
  };
}

/**
 * Step-up re-authentication (S11-F14): a fresh TOTP (once per time step) or recovery code before a sensitive act, such as
 * copying the agency's data out. Unlike the login challenge it hands out no proof and no remembered browser; the use is
 * audited as `identity.twoFactor.verified` with `purpose: stepUp`. `MFA_CODE_INVALID` when the code is wrong or 2FA is
 * not enabled for the user (the caller rate-limits).
 */
export async function verifyStepUp(
  ctx: AuthCtx,
  input: {
    userId: string;
    code: TwoFactorCode /** What the code unlocks, for the audit trail. */;
    unlocks: { action: string; kind?: string };
  },
): Promise<void> {
  const purpose = {
    purpose: 'stepUp',
    action: input.unlocks.action,
    ...(input.unlocks.kind ? { kind: input.unlocks.kind } : {}),
  };
  const used = await asUser(ctx, input.userId, async (tx) => {
    const result = await consumeCode(tx, input.userId, input.code, clock.now(), ctx.requestId);
    if (result) {
      await auditTwoFactor(tx, ctx.requestId, input.userId, 'identity.twoFactor.verified', {
        method: result.method,
        ...purpose,
      });
    }
    return result;
  });
  if (!used) {
    await asUser(ctx, input.userId, (tx) =>
      auditTwoFactor(tx, ctx.requestId, input.userId, 'identity.twoFactor.failed', purpose),
    ).catch((err: unknown) =>
      identityLog().error({ err, requestId: ctx.requestId }, 'identity: failed step-up audit not written'),
    );
    throw new AppError('MFA_CODE_INVALID');
  }
}

/** Turns 2FA off (opted-in users only — staff and admins must keep it). Needs a current code. */
export async function disableTwoFactor(ctx: AuthCtx, input: { userId: string; code: TwoFactorCode }): Promise<void> {
  const now = clock.now();
  const ok = await asUser(ctx, input.userId, async (tx) => {
    if (await isSecondFactorRequired(tx, input.userId)) throw new AppError('FORBIDDEN', { reason: 'mfa_required' });
    if (!(await consumeCode(tx, input.userId, input.code, now, ctx.requestId))) return false;
    await repo.disableMfa(tx, input.userId, now);
    await repo.retireRecoveryCodes(tx, input.userId, now);
    await emit(tx, identityEvents.twoFactorDisabled({ userId: input.userId }), { agencyId: PLATFORM_AGENCY_ID });
    await auditTwoFactor(tx, ctx.requestId, input.userId, 'identity.twoFactor.disabled');
    return true;
  });
  if (!ok) throw new AppError('MFA_CODE_INVALID');
}

/**
 * "Forget all remembered browsers" (S1-F8): bumps the per-user epoch in every browser token's signature,
 * so the next login on each of them asks for the code again. Needs a signed-in session only — it can
 * never weaken anything.
 */
export async function forgetRememberedBrowsers(ctx: AuthCtx, input: { userId: string }): Promise<void> {
  const now = clock.now();
  await asUser(ctx, input.userId, async (tx) => {
    await repo.bumpDeviceEpoch(tx, input.userId, now);
    await auditTwoFactor(tx, ctx.requestId, input.userId, 'identity.twoFactor.devicesForgotten');
  });
}

/** A fresh set of 10 recovery codes (the old ones stop working). Needs a current code. */
export async function regenerateRecoveryCodes(
  ctx: AuthCtx,
  input: { userId: string; code: TwoFactorCode },
): Promise<{ recoveryCodes: string[] }> {
  const now = clock.now();
  const codes = await asUser(ctx, input.userId, async (tx) => {
    if (!(await consumeCode(tx, input.userId, input.code, now, ctx.requestId))) return null;
    const fresh = await replaceRecoveryCodes(tx, input.userId, now);
    await auditTwoFactor(tx, ctx.requestId, input.userId, 'identity.twoFactor.recoveryCodesRegenerated');
    return fresh;
  });
  if (!codes) throw new AppError('MFA_CODE_INVALID');
  return { recoveryCodes: codes };
}

// ── Proofs and remembered browsers ──────────────────────────────────────────────────────────────

function sign(purpose: string, parts: (string | number)[]): string {
  return hmacSha256(identityConfig().hmacKey, purpose, parts.join('.'));
}

/** `<expiresAtMs>.<mac>`: "this user passed the second factor for this session version". */
function mfaProof(userId: string, sessionVersion: number, now: Date): string {
  const exp = now.getTime() + TWO_FACTOR.PROOF_TTL_MS;
  return `${exp}.${sign('mfa-proof', [userId, sessionVersion, exp])}`;
}

function parseSigned(value: unknown): { exp: number; mac: string } | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  return match ? { exp: Number(match[1]), mac: match[2] as string } : null;
}

/** Checks a proof from `verifySecondFactor` / `confirmEnrolment` (the session callback calls this). */
export function checkMfaProof(input: { userId: string; sessionVersion: number; proof: unknown }): boolean {
  const parsed = parseSigned(input.proof);
  const now = clock.now().getTime();
  if (!parsed || parsed.exp <= now || parsed.exp > now + TWO_FACTOR.PROOF_TTL_MS) return false;
  return safeEqual(sign('mfa-proof', [input.userId, input.sessionVersion, parsed.exp]), parsed.mac);
}

function deviceToken(
  userId: string,
  sessionVersion: number,
  confirmedAt: Date,
  deviceEpoch: number,
  now: Date,
): { token: string; expiresAt: Date } {
  const exp = now.getTime() + TWO_FACTOR.REMEMBER_DEVICE_MS;
  const mac = sign('mfa-device', [userId, sessionVersion, confirmedAt.getTime(), deviceEpoch, exp]);
  return { token: `${exp}.${mac}`, expiresAt: new Date(exp) };
}

/** Whether a "remember this browser" token is valid for this user, session version, enrolment and device epoch. */
export function isDeviceRemembered(input: {
  userId: string;
  sessionVersion: number;
  confirmedAt: Date | null;
  deviceEpoch: number;
  token: unknown;
}): boolean {
  const parsed = parseSigned(input.token);
  if (!parsed || !input.confirmedAt || parsed.exp <= clock.now().getTime()) return false;
  const expected = sign('mfa-device', [
    input.userId,
    input.sessionVersion,
    input.confirmedAt.getTime(),
    input.deviceEpoch,
    parsed.exp,
  ]);
  return safeEqual(expected, parsed.mac);
}
