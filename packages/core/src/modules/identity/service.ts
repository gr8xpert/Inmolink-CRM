import type {
  AccessTokenDto,
  Audience,
  LoginInput,
  RegisterInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  SessionUser,
  VerifyEmailInput,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { hmacSha256 } from '@inmolink/platform/crypto';
import { dummyVerify, hashPassword, needsRehash, verifyPassword } from '@inmolink/platform/crypto/password';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { AuthCtx } from '../../context';
import { identityConfig } from './config';
import { identityEvents } from './events';
import { canIssueAccessToken, loginDecision } from './policy';
import * as repo from './repo';

/**
 * Anonymous auth flows (S0-09). Inputs are already validated against the contracts by the app.
 * Responses never reveal whether an email is registered: sign-up and reset requests always succeed,
 * and a wrong password, an unknown email and a disabled account are the same error.
 */

/** `hmacSha256(HMAC_KEY, 'auth-token', token)` — what `auth_tokens.token_hash` stores. */
export function hashLinkToken(token: string): string {
  return hmacSha256(identityConfig().hmacKey, 'auth-token', token);
}

/**
 * Creates the account (unverified) and queues the confirmation email. A repeat sign-up for an email
 * that was never confirmed replaces that pending account (and a fresh link retires the old one); a
 * confirmed email queues an "account exists" email to its owner instead. Same screen either way.
 */
export async function register(ctx: AuthCtx, input: RegisterInput): Promise<void> {
  // Hash before the transaction, and for a taken email too, so timing does not reveal accounts.
  const passwordHash = await hashPassword(input.password);
  const now = clock.now();
  await ctx.transaction(async (tx) => {
    const profile = { passwordHash, name: input.name, locale: input.locale };
    const id =
      (await repo.insertUserIfAbsent(tx, { id: newId(), email: input.email, ...profile })) ??
      (await repo.replaceUnverifiedSignup(tx, input.email, profile, now));
    if (id) {
      await emit(tx, identityEvents.registered({ userId: id }));
      return;
    }
    const existing = await repo.findUserIdByEmail(tx, input.email);
    if (existing?.status === 'ACTIVE') await emit(tx, identityEvents.signupDuplicated({ userId: existing.id }));
  });
}

/**
 * Confirms an email: needs the link **and** the account password. Someone who signed up with another
 * person's address cannot get it confirmed by that person clicking the link (pre-account hijack);
 * the real owner signs up again or resets the password instead. Unknown, used and expired links are
 * `TOKEN_INVALID`; a wrong password is `INVALID_CREDENTIALS` and leaves the link usable.
 */
export async function verifyEmail(ctx: AuthCtx, input: VerifyEmailInput): Promise<{ userId: string }> {
  const tokenHash = hashLinkToken(input.token);
  const now = clock.now();
  const owner = await ctx.transaction((tx) => repo.findTokenOwner(tx, tokenHash, 'EMAIL_VERIFY', now));
  if (!owner) throw new AppError('TOKEN_INVALID');
  if (!(await verifyPassword(owner.passwordHash, input.password))) throw new AppError('INVALID_CREDENTIALS');
  return ctx.transaction(async (tx) => {
    const userId = await repo.consumeToken(tx, tokenHash, 'EMAIL_VERIFY', now);
    if (userId !== owner.userId || !(await repo.markEmailVerified(tx, userId, owner.passwordHash, now))) {
      throw new AppError('TOKEN_INVALID');
    }
    return { userId };
  });
}

/**
 * The credential check behind Auth.js `authorize()`. Rate limits (per IP and per email) are the
 * caller's job and must run before this. An unconfirmed email gets a fresh link and
 * `EMAIL_NOT_VERIFIED` — only after the password matched, so it reveals nothing to a guesser.
 */
export async function verifyCredentials(ctx: AuthCtx, input: LoginInput): Promise<SessionUser> {
  const user = await ctx.transaction((tx) => repo.findCredentialsByEmail(tx, input.email));
  const matches = user ? await verifyPassword(user.passwordHash, input.password) : await dummyVerify(input.password);
  if (!user || !matches) throw new AppError('INVALID_CREDENTIALS');

  const decision = loginDecision(user);
  if (decision === 'invalid') throw new AppError('INVALID_CREDENTIALS');
  if (decision === 'unverified') {
    await ctx.transaction((tx) => emit(tx, identityEvents.verificationRequested({ userId: user.id })));
    throw new AppError('EMAIL_NOT_VERIFIED');
  }

  const rehash = needsRehash(user.passwordHash)
    ? { from: user.passwordHash, to: await hashPassword(input.password) }
    : undefined;
  await ctx.transaction((tx) => repo.recordLogin(tx, user.id, clock.now(), rehash));
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    locale: user.locale,
    sessionVersion: user.sessionVersion,
  };
}

/** Always succeeds; an active account gets a reset link (60 minutes, single use) by email. */
export async function requestPasswordReset(ctx: AuthCtx, input: RequestPasswordResetInput): Promise<void> {
  await ctx.transaction(async (tx) => {
    const user = await repo.findUserIdByEmail(tx, input.email);
    if (user?.status === 'ACTIVE') await emit(tx, identityEvents.passwordResetRequested({ userId: user.id }));
  });
}

/**
 * Consumes a reset link and sets the new password. Existing sessions are revoked: `session_version`
 * moves on, so the web session can no longer mint access tokens.
 */
export async function resetPassword(ctx: AuthCtx, input: ResetPasswordInput): Promise<{ userId: string }> {
  const tokenHash = hashLinkToken(input.token);
  const passwordHash = await hashPassword(input.password);
  const now = clock.now();
  return ctx.transaction(async (tx) => {
    const userId = await repo.consumeToken(tx, tokenHash, 'PASSWORD_RESET', now);
    // Throwing rolls the consumption back too; the link stays unusable only if the reset committed.
    if (!userId || !(await repo.setPassword(tx, userId, passwordHash, now))) throw new AppError('TOKEN_INVALID');
    return { userId };
  });
}

/**
 * Whether a web session may continue: the user is active and verified and the session was not
 * revoked (password reset bumps `session_version`). Auth.js re-checks this every few minutes.
 */
export async function isSessionValid(
  ctx: AuthCtx,
  input: { userId: string; sessionVersion: number },
): Promise<boolean> {
  const user = await ctx.transaction((tx) => repo.findUserForToken(tx, input.userId));
  return user !== null && canIssueAccessToken(user, input.sessionVersion);
}

/**
 * Mints a 15-minute access token for `api` or `realtime` from a web session. Re-checks the user on
 * every mint, so a password reset or deactivation ends API access within one token lifetime.
 */
export async function issueAccessToken(
  ctx: AuthCtx,
  input: { userId: string; sessionVersion: number; audience: Audience },
): Promise<AccessTokenDto> {
  const { signer } = identityConfig();
  if (!signer) throw new Error('identity: no access token signer configured');
  const user = await ctx.transaction((tx) => repo.findUserForToken(tx, input.userId));
  if (!user || !canIssueAccessToken(user, input.sessionVersion)) throw new AppError('SESSION_REVOKED');
  const { token, expiresAt } = await signer.sign({ sub: input.userId, aud: input.audience, sv: user.sessionVersion });
  return { token, expiresAt: expiresAt.toISOString() };
}
