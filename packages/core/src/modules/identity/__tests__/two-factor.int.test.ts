import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import {
  configureHmacRotation,
  createKeyring,
  generateKey,
  newToken,
  totpCode,
  totpStep,
} from '@inmolink/platform/crypto';
import { hashPassword } from '@inmolink/platform/crypto/password';
import { closeEmail, configureEmail, createMemoryMailer, type MemoryMailer } from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authCtx } from '../../../context';
import { createFounder } from '../../../testing/factories';
import * as identity from '../index';

/** Two-factor authentication on the real test database (S1-04): `app_auth`, as the web runs it. */

const pair = generateAccessKeyPair();
const verifier = createAccessTokenVerifier({ publicKeys: parsePublicKeys(`t1:${pair.publicKey}`) });
const anon = () => authCtx(newId());
const PASSWORD = 'correct horse battery'; // createFounder's
const log = createLogger({ service: 'identity-test', level: 'silent' });
let mail: MemoryMailer;
const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);

const HMAC_KEY = 'test-hmac-key-0123456789abcdef0123456789';
const TOTP_KEY = generateKey();
const identityConfigWith = (hmacKey: string) => ({
  hmacKey,
  webUrl: 'http://web.test',
  signer: createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' }),
  keyring: createKeyring({ keys: { t1: TOTP_KEY }, activeKeyId: 't1' }),
});

beforeAll(async () => {
  await setupTestDb('worker');
  identity.configureIdentity(identityConfigWith(HMAC_KEY));
}, 120_000); // setupTestDb under a full parallel verify (S1-F1)

beforeEach(async () => {
  mail = createMemoryMailer();
  await configureEmail(mail);
});

afterEach(() => restoreClock());

afterAll(async () => {
  await closeEmail();
  await closeDb();
});

const mint = (userId: string, mfaVerified: boolean, sessionVersion = 1) =>
  identity.issueAccessToken(anon(), { userId, sessionVersion, audience: 'api', mfaVerified });

/** The current code of the authenticator app, at the fake clock's time plus `steps` × 30 s. */
const codeAt = (secret: string, clock: { now(): Date }, steps = 0) => totpCode(secret, totpStep(clock.now()) + steps);

/** Founder (AGENCY_ADMIN) demoted to AGENT: a role that may opt in to 2FA but does not have to. */
async function agent() {
  const founder = await createFounder();
  await withSystem('2fa test: demote founder', (tx) =>
    tx.execute(sql`update agency_members set role = 'AGENT' where user_id = ${founder.userId}`),
  );
  return founder;
}

/** A staff user (no agency), written directly as `pnpm staff:grant` would. */
async function staffUser(): Promise<string> {
  const id = newId();
  await withSystem('2fa test: staff user', async (tx) => {
    await tx.execute(
      sql`insert into users (id, email, password_hash, name, locale, email_verified_at)
          values (${id}, ${`staff-${newToken(6).toLowerCase()}@staff.inmolink.test`}, ${await hashPassword(PASSWORD)}, 'Support', 'en', now())`,
    );
    await tx.execute(sql`insert into staff_users (user_id, role) values (${id}, 'STAFF_SUPPORT')`);
  });
  return id;
}

/** Enrols `userId` at the fake clock's time and returns the secret and recovery codes. */
async function enrol(userId: string, clock: { now(): Date }) {
  const { secret, uri } = await identity.startEnrolment(anon(), { userId, password: PASSWORD });
  expect(uri).toMatch(/^otpauth:\/\/totp\/Inmolink:/);
  const done = await identity.confirmEnrolment(anon(), { userId, sessionVersion: 1, code: codeAt(secret, clock) });
  expect(identity.checkMfaProof({ userId, sessionVersion: 1, proof: done.proof })).toBe(true);
  return { secret, recoveryCodes: done.recoveryCodes };
}

const eventCount = (userId: string, type: string) =>
  withSystem('2fa test: read outbox', async (tx) => {
    const r = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from outbox_events where type = ${type} and payload->>'userId' = ${userId}`,
    );
    return r.rows[0]?.n ?? 0;
  });

describe('two-factor authentication', () => {
  it('[S1-04] required roles cannot reach the dashboard without completing 2FA', async () => {
    const clock = useFakeClock(T0);
    const admin = await createFounder();
    const staff = await staffUser();
    const optional = await agent();

    // Staff and agency admins get no access token until the session passed 2FA — they must enrol first.
    await expect(mint(admin.userId, false)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await expect(mint(staff, false)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    expect(await identity.getTwoFactorStatus(anon(), { userId: admin.userId })).toEqual({
      enabled: false,
      required: true,
      recoveryCodesLeft: 0,
    });
    // Other roles may work without it.
    await expect(mint(optional.userId, false)).resolves.toMatchObject({ token: expect.any(String) });
    expect((await identity.getTwoFactorStatus(anon(), { userId: optional.userId })).required).toBe(false);

    await enrol(admin.userId, clock);
    await enrol(staff, clock);
    const { token } = await mint(admin.userId, true);
    expect((await verifier.verify(token, 'api')).agency).toBe(admin.agencyId);
    await expect(mint(staff, true)).resolves.toMatchObject({ token: expect.any(String) });
    // A new session (not yet challenged) is refused again.
    await expect(mint(admin.userId, false)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    clock.advance(30_000);
    const { secret } = await identity.startEnrolment(anon(), { userId: optional.userId, password: PASSWORD });
    await identity.confirmEnrolment(anon(), {
      userId: optional.userId,
      sessionVersion: 1,
      code: codeAt(secret, clock),
    });
    // Once a user opted in, their sessions need it too.
    await expect(mint(optional.userId, false)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });

  it('[S1-04] staff and admins cannot disable 2FA; opted-in users can, with a current code', async () => {
    const clock = useFakeClock(T0);
    const admin = await createFounder();
    const { secret } = await enrol(admin.userId, clock);
    clock.advance(30_000);
    await expect(
      identity.disableTwoFactor(anon(), { userId: admin.userId, code: codeAt(secret, clock) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const optional = await agent();
    const own = await enrol(optional.userId, clock);
    await expect(identity.disableTwoFactor(anon(), { userId: optional.userId, code: '000000' })).rejects.toMatchObject({
      code: 'MFA_CODE_INVALID',
    });
    clock.advance(30_000);
    await identity.disableTwoFactor(anon(), { userId: optional.userId, code: codeAt(own.secret, clock) });
    expect(await identity.getTwoFactorStatus(anon(), { userId: optional.userId })).toMatchObject({ enabled: false });
    await expect(mint(optional.userId, false)).resolves.toMatchObject({ token: expect.any(String) });
    // Its recovery codes died with it.
    await expect(
      identity.verifySecondFactor(anon(), {
        userId: optional.userId,
        sessionVersion: 1,
        code: own.recoveryCodes[0]?.replace('-', '') ?? '',
        rememberDevice: false,
      }),
    ).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
    expect(await eventCount(optional.userId, 'identity.twoFactor.disabled')).toBe(1);
  });

  it('[S1-08] 2FA changes and challenges are audited under the user’s agency — staff under the platform', async () => {
    const clock = useFakeClock(T0);
    const optional = await agent();
    const own = await enrol(optional.userId, clock);
    const challenge = (code: string) =>
      identity.verifySecondFactor(anon(), { userId: optional.userId, sessionVersion: 1, code, rememberDevice: false });
    await expect(challenge('000000')).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
    clock.advance(30_000);
    await challenge(codeAt(own.secret, clock));
    clock.advance(30_000);
    const fresh = await identity.regenerateRecoveryCodes(anon(), {
      userId: optional.userId,
      code: codeAt(own.secret, clock),
    });
    // A wrong code on a change changes nothing, so it records nothing.
    await expect(identity.disableTwoFactor(anon(), { userId: optional.userId, code: '000000' })).rejects.toMatchObject({
      code: 'MFA_CODE_INVALID',
    });
    const staff = await staffUser();
    await enrol(staff, clock);

    const audit = (userId: string) =>
      withSystem('2fa test: read audit log', async (tx) => {
        const r = await tx.execute<{
          type: string;
          agency_id: string;
          actor_user_id: string | null;
          metadata: unknown;
        }>(
          sql`select type, agency_id, actor_user_id, metadata from audit_logs where target_id = ${userId}
               and type like 'identity.twoFactor.%' order by occurred_at, id`,
        );
        return r.rows;
      });
    const row = (type: string, metadata: unknown = {}, actor: string | null = optional.userId) => ({
      type,
      agency_id: optional.agencyId,
      actor_user_id: actor,
      metadata,
    });
    expect(await audit(optional.userId)).toEqual([
      row('identity.twoFactor.enabled'),
      row('identity.twoFactor.failed', {}, null),
      row('identity.twoFactor.verified', { method: 'totp' }),
      row('identity.twoFactor.recoveryCodesRegenerated'),
    ]);
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(await audit(staff)).toEqual([
      { type: 'identity.twoFactor.enabled', agency_id: PLATFORM_AGENCY_ID, actor_user_id: staff, metadata: {} },
    ]);
  });

  it('[S1-08] disabling 2FA with a recovery code: the audit inside the code check leaves the transaction’s scope intact', async () => {
    const clock = useFakeClock(T0);
    const optional = await agent();
    const own = await enrol(optional.userId, clock);
    await identity.disableTwoFactor(anon(), {
      userId: optional.userId,
      code: (own.recoveryCodes[0] ?? '').replace('-', ''),
    });
    // The statements after the recovery-code audit (disable, retire codes) ran under the user's scope.
    expect(await identity.getTwoFactorStatus(anon(), { userId: optional.userId })).toMatchObject({
      enabled: false,
      recoveryCodesLeft: 0,
    });
    const types = await withSystem('2fa test: read audit log', async (tx) => {
      const r = await tx.execute<{ type: string }>(
        sql`select type from audit_logs where target_id = ${optional.userId} order by occurred_at, id`,
      );
      return r.rows.map((x) => x.type);
    });
    expect(types).toEqual([
      'identity.twoFactor.enabled',
      'identity.twoFactor.recoveryCodeUsed',
      'identity.twoFactor.disabled',
    ]);
  });

  it('[S1-04] a TOTP code is accepted once; codes outside the drift window are refused', async () => {
    const clock = useFakeClock(T0);
    const admin = await createFounder();
    const { secret } = await enrol(admin.userId, clock);
    const challenge = (code: string) =>
      identity.verifySecondFactor(anon(), { userId: admin.userId, sessionVersion: 1, code, rememberDevice: false });

    // The enrolment code's step is used up; the next step works once.
    await expect(challenge(codeAt(secret, clock))).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
    clock.advance(30_000);
    const passed = await challenge(codeAt(secret, clock));
    expect(passed.method).toBe('totp');
    expect(identity.checkMfaProof({ userId: admin.userId, sessionVersion: 1, proof: passed.proof })).toBe(true);
    await expect(challenge(codeAt(secret, clock))).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
    // Too old, too new.
    clock.advance(90_000);
    await expect(challenge(codeAt(secret, clock, -2))).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
    await expect(challenge(codeAt(secret, clock, 2))).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
    await expect(challenge(codeAt(secret, clock, 1))).resolves.toMatchObject({ method: 'totp' });
  });

  it('[S1-04] recovery codes are single-use, stored hashed, and replaced by a new set', async () => {
    const clock = useFakeClock(T0);
    const admin = await createFounder();
    const { secret, recoveryCodes } = await enrol(admin.userId, clock);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);

    const stored = await withSystem('2fa test: read stored codes', async (tx) => {
      const r = await tx.execute<{ code_hash: string }>(
        sql`select code_hash from user_recovery_codes where user_id = ${admin.userId}`,
      );
      const m = await tx.execute<{ totp_secret: string }>(
        sql`select totp_secret from user_mfa where user_id = ${admin.userId}`,
      );
      return { hashes: r.rows.map((x) => x.code_hash), secret: m.rows[0]?.totp_secret ?? '' };
    });
    expect(stored.hashes).toHaveLength(10);
    for (const code of recoveryCodes) {
      expect(stored.hashes.some((h) => h.includes(code.replace('-', '')))).toBe(false);
    }
    expect(stored.secret).not.toContain(secret);
    expect(stored.secret).toMatch(/^v1\.t1\./);

    const useCode = (code: string) =>
      identity.verifySecondFactor(anon(), { userId: admin.userId, sessionVersion: 1, code, rememberDevice: false });
    const first = (recoveryCodes[0] ?? '').replace('-', '');
    await expect(useCode(first)).resolves.toMatchObject({ method: 'recovery' });
    await expect(useCode(first)).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
    expect((await identity.getTwoFactorStatus(anon(), { userId: admin.userId })).recoveryCodesLeft).toBe(9);
    expect(await eventCount(admin.userId, 'identity.twoFactor.recoveryCodeUsed')).toBe(1);

    // A new set retires every open code of the old one.
    clock.advance(30_000);
    const fresh = await identity.regenerateRecoveryCodes(anon(), { userId: admin.userId, code: codeAt(secret, clock) });
    await expect(useCode((recoveryCodes[1] ?? '').replace('-', ''))).rejects.toMatchObject({
      code: 'MFA_CODE_INVALID',
    });
    await expect(useCode((fresh.recoveryCodes[0] ?? '').replace('-', ''))).resolves.toMatchObject({
      method: 'recovery',
    });
    expect((await identity.getTwoFactorStatus(anon(), { userId: admin.userId })).recoveryCodesLeft).toBe(9);
  });

  it('[S12-F15] a recovery code issued under the previous HMAC_KEY works during the rotation window', async () => {
    const PREVIOUS = 'test-hmac-key-previous-0123456789abcdef01';
    const clock = useFakeClock(T0);
    const admin = await createFounder();
    identity.configureIdentity(identityConfigWith(PREVIOUS));
    const { recoveryCodes } = await enrol(admin.userId, clock).finally(() =>
      identity.configureIdentity(identityConfigWith(HMAC_KEY)),
    );
    const useCode = (code: string) =>
      identity.verifySecondFactor(anon(), { userId: admin.userId, sessionVersion: 1, code, rememberDevice: false });
    const code = (i: number) => (recoveryCodes[i] ?? '').replace('-', '');
    try {
      // No window: the previous key's codes are refused (and not used up).
      await expect(useCode(code(0))).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
      configureHmacRotation({ current: HMAC_KEY, previous: PREVIOUS, previousUntil: new Date(T0 + 86_400_000) });
      await expect(useCode(code(0))).resolves.toMatchObject({ method: 'recovery' });
      // Still single-use, and only that one code is spent.
      await expect(useCode(code(0))).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
      expect((await identity.getTwoFactorStatus(anon(), { userId: admin.userId })).recoveryCodesLeft).toBe(9);
      // The window ends at HMAC_KEY_PREVIOUS_UNTIL.
      clock.advance(86_400_000);
      await expect(useCode(code(1))).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
    } finally {
      configureHmacRotation({ current: HMAC_KEY });
    }
  });

  it('[S1-04] a remembered browser skips the challenge for 30 days, until the password or the enrolment changes', async () => {
    const clock = useFakeClock(T0);
    const admin = await createFounder();
    const { secret } = await enrol(admin.userId, clock);
    clock.advance(30_000);
    const passed = await identity.verifySecondFactor(anon(), {
      userId: admin.userId,
      sessionVersion: 1,
      code: codeAt(secret, clock),
      rememberDevice: true,
    });
    const deviceToken = passed.device?.token;
    expect(passed.device?.expiresAt.getTime()).toBe(clock.now().getTime() + 30 * 24 * 60 * 60_000);
    const login = (token?: string) =>
      identity.verifyCredentials(anon(), { email: admin.email, password: admin.password, deviceToken: token });

    expect((await login(deviceToken)).mfaVerified).toBe(true);
    expect((await login()).mfaVerified).toBe(false);
    expect((await login(`${deviceToken}x`)).mfaVerified).toBe(false);
    clock.advance(30 * 24 * 60 * 60_000);
    expect((await login(deviceToken)).mfaVerified).toBe(false);

    // A password reset (session version 2) ends remembered browsers.
    const again = await identity.verifySecondFactor(anon(), {
      userId: admin.userId,
      sessionVersion: 1,
      code: codeAt(secret, clock),
      rememberDevice: true,
    });
    await withSystem('2fa test: password reset', (tx) =>
      tx.execute(sql`update users set session_version = 2 where id = ${admin.userId}`),
    );
    expect((await login(again.device?.token)).mfaVerified).toBe(false);
    // Proofs are bound to the session version and expire within minutes.
    expect(identity.checkMfaProof({ userId: admin.userId, sessionVersion: 2, proof: again.proof })).toBe(false);
    expect(identity.checkMfaProof({ userId: newId(), sessionVersion: 1, proof: again.proof })).toBe(false);
    clock.advance(3 * 60_000);
    expect(identity.checkMfaProof({ userId: admin.userId, sessionVersion: 1, proof: again.proof })).toBe(false);
  });
});

const pendingRows = (userId: string) =>
  withSystem('2fa test: read user_mfa', async (tx) => {
    const r = await tx.execute<{ n: number }>(sql`select count(*)::int as n from user_mfa where user_id = ${userId}`);
    return r.rows[0]?.n ?? 0;
  });

/** Runs the notice job for the user's latest event of `type`; returns the email it sent. */
async function sendNotice(
  userId: string,
  type: string,
  kind: 'enabled' | 'disabled' | 'recoveryUsed' | 'deviceRemembered',
) {
  const eventId = await withSystem('2fa test: read outbox', async (tx) => {
    const r = await tx.execute<{ id: string }>(
      sql`select id from outbox_events where type = ${type} and payload->>'userId' = ${userId} order by created_at desc, id desc limit 1`,
    );
    return r.rows[0]?.id;
  });
  if (!eventId) throw new Error(`no ${type} event`);
  const before = mail.sent.length;
  await identity.identityJobs.sendTwoFactorNotice.spec.run(
    { eventId, userId, kind },
    { log, jobId: eventId, attempt: 1, progress: async () => {}, signal: new AbortController().signal },
  );
  expect(mail.sent.length).toBe(before + 1);
  return mail.sent[before] as MemoryMailer['sent'][number];
}

describe('two-factor follow-ups (S1-F8)', () => {
  it('[S1-F8] enrolment needs a fresh password check; viewing the page creates no secret', async () => {
    const clock = useFakeClock(T0);
    const admin = await createFounder();
    // The page's read: nothing pending, and nothing written.
    expect(await identity.getPendingEnrolment(anon(), { userId: admin.userId })).toBeNull();
    expect(await pendingRows(admin.userId)).toBe(0);
    await expect(
      identity.startEnrolment(anon(), { userId: admin.userId, password: 'not the password' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(await pendingRows(admin.userId)).toBe(0);
    // Without a secret there is nothing to confirm.
    await expect(
      identity.confirmEnrolment(anon(), { userId: admin.userId, sessionVersion: 1, code: '123456' }),
    ).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });

    const started = await identity.startEnrolment(anon(), { userId: admin.userId, password: PASSWORD });
    expect(await identity.getPendingEnrolment(anon(), { userId: admin.userId })).toEqual(started);
    await identity.confirmEnrolment(anon(), {
      userId: admin.userId,
      sessionVersion: 1,
      code: codeAt(started.secret, clock),
    });
    expect(await identity.getPendingEnrolment(anon(), { userId: admin.userId })).toBeNull();
  });

  it('[S1-F8] each 2FA change emails the account owner, in their language', async () => {
    const clock = useFakeClock(T0);
    const optional = await agent(); // Spanish (createFounder's default)
    const own = await enrol(optional.userId, clock);
    const enabled = await sendNotice(optional.userId, 'identity.twoFactor.enabled', 'enabled');
    expect(enabled.to).toBe(optional.email);
    expect(enabled.subject).toBe('Se activó la verificación en dos pasos');
    expect(enabled.text).toContain('http://web.test/es/account/security');

    // A recovery code at the challenge, and "remember this browser".
    await identity.verifySecondFactor(anon(), {
      userId: optional.userId,
      sessionVersion: 1,
      code: (own.recoveryCodes[0] ?? '').replace('-', ''),
      rememberDevice: true,
    });
    expect((await sendNotice(optional.userId, 'identity.twoFactor.recoveryCodeUsed', 'recoveryUsed')).subject).toBe(
      'Se usó un código de recuperación en tu cuenta',
    );
    expect((await sendNotice(optional.userId, 'identity.twoFactor.deviceRemembered', 'deviceRemembered')).subject).toBe(
      'Se recordó un navegador nuevo en tu cuenta',
    );
    // No device event when the box was not ticked.
    clock.advance(30_000);
    await identity.verifySecondFactor(anon(), {
      userId: optional.userId,
      sessionVersion: 1,
      code: codeAt(own.secret, clock),
      rememberDevice: false,
    });
    expect(await eventCount(optional.userId, 'identity.twoFactor.deviceRemembered')).toBe(1);

    clock.advance(30_000);
    await identity.disableTwoFactor(anon(), { userId: optional.userId, code: codeAt(own.secret, clock) });
    expect((await sendNotice(optional.userId, 'identity.twoFactor.disabled', 'disabled')).subject).toBe(
      'Se desactivó la verificación en dos pasos',
    );

    const english = await createFounder({ locale: 'en' });
    await enrol(english.userId, clock);
    const en = await sendNotice(english.userId, 'identity.twoFactor.enabled', 'enabled');
    expect(en.subject).toBe('Two-step verification was turned on');
    expect(en.text).toContain('http://web.test/en/account/security');
  });

  it('[S1-F8] forgetting remembered browsers ends every remembered browser, and only those', async () => {
    const clock = useFakeClock(T0);
    const admin = await createFounder();
    const { secret } = await enrol(admin.userId, clock);
    const remember = async () => {
      clock.advance(30_000);
      const r = await identity.verifySecondFactor(anon(), {
        userId: admin.userId,
        sessionVersion: 1,
        code: codeAt(secret, clock),
        rememberDevice: true,
      });
      return r.device?.token;
    };
    const login = (token?: string) =>
      identity.verifyCredentials(anon(), { email: admin.email, password: admin.password, deviceToken: token });
    const a = await remember();
    const b = await remember();
    expect((await login(a)).mfaVerified).toBe(true);
    expect((await login(b)).mfaVerified).toBe(true);

    await identity.forgetRememberedBrowsers(anon(), { userId: admin.userId });
    expect((await login(a)).mfaVerified).toBe(false);
    expect((await login(b)).mfaVerified).toBe(false);
    // The account itself still works, and a browser remembered afterwards is good again.
    expect((await login(await remember())).mfaVerified).toBe(true);
    const types = await withSystem('2fa test: read audit log', async (tx) => {
      const r = await tx.execute<{ type: string }>(
        sql`select type from audit_logs where target_id = ${admin.userId} and type = 'identity.twoFactor.devicesForgotten'`,
      );
      return r.rows.length;
    });
    expect(types).toBe(1);
  });
});
