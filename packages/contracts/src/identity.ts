import { z } from 'zod';

/**
 * Identity DTOs (S0-09): sign-up, email verification, login, password reset, access tokens.
 * Passwords: 10–128 characters (NIST 800-63B length rule, no composition rules); hashing caps input at
 * 1 KiB anyway (platform/crypto/password).
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const Password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
/** UI locale code (`en`, `es`, …); the set comes from `@inmolink/i18n`. */
export const UiLocale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
/** base64url token from an email link (`newToken()`: 32 bytes → 43 chars). */
export const LinkToken = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{32,128}$/);

/**
 * Display name. It appears in emails we send, so no links or markup: a sign-up with someone else's
 * address must not turn our confirmation email into a phishing message.
 */
export const PersonName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\p{L}\p{M}' .-]+$/u, 'letters, spaces, apostrophes, dots and hyphens only')
  // "J. R. Smith" yes, "evil.example" (auto-linked by mail clients) no.
  .refine((v) => !/\.[\p{L}\p{M}]/u.test(v), 'a dot must be followed by a space');

export const RegisterInput = z.object({
  email: Email,
  password: Password,
  name: PersonName,
  locale: UiLocale,
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email: Email,
  // Login accepts any length up to the cap: a policy change must not lock out existing users.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof LoginInput>;

/** The account password is required too, so only the account's creator can confirm it (ADR 0004). */
export const VerifyEmailInput = z.object({ token: LinkToken, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
export type VerifyEmailInput = z.infer<typeof VerifyEmailInput>;

/** The email goes out in the account's stored locale. */
export const RequestPasswordResetInput = z.object({ email: Email });
export type RequestPasswordResetInput = z.infer<typeof RequestPasswordResetInput>;

export const ResetPasswordInput = z.object({ token: LinkToken, password: Password });
export type ResetPasswordInput = z.infer<typeof ResetPasswordInput>;

/** What a verified login puts in the web session (never the password hash). */
export const SessionUser = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  locale: z.string(),
  sessionVersion: z.number().int(),
});
export type SessionUser = z.infer<typeof SessionUser>;

export const Audience = z.enum(['api', 'realtime']);
export type Audience = z.infer<typeof Audience>;

export const AccessTokenDto = z.object({ token: z.string(), expiresAt: z.iso.datetime() });
export type AccessTokenDto = z.infer<typeof AccessTokenDto>;

/** `GET /v1/me` — who the access token belongs to. `agencyId` is null until memberships exist (S1-01). */
export const MeDto = z.object({
  userId: z.uuid(),
  agencyId: z.uuid().nullable(),
  sessionVersion: z.number().int(),
  tokenExpiresAt: z.iso.datetime(),
});
export type MeDto = z.infer<typeof MeDto>;
