import { z } from 'zod';
import { CompanyName, SignupAgencyKind } from './agencies';
import { pageOf } from './common';

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

/** Tenant roles (PLAN §3 #2); staff roles are not agency memberships. */
export const MemberRole = z.enum(['AGENCY_ADMIN', 'AGENT', 'DEVELOPER_ADMIN', 'DEVELOPER_AGENT', 'PARTNER']);
export type MemberRole = z.infer<typeof MemberRole>;

/** Sign-up creates the user and their agency-of-one (PENDING) together (PLAN §3 #1, S1-01). */
export const RegisterInput = z.object({
  email: Email,
  password: Password,
  name: PersonName,
  locale: UiLocale,
  accountKind: SignupAgencyKind,
  companyName: CompanyName,
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
  /** The login already passed the second factor (a remembered browser, S1-04). */
  mfaVerified: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUser>;

/**
 * A second-factor code (S1-04): a 6-digit TOTP code or a recovery code (`xxxxx-xxxxx`). Spaces and
 * dashes are ignored; identity tells the two apart.
 */
export const TwoFactorCode = z
  .string()
  .transform((v) => v.replaceAll(/[\s-]/g, '').toLowerCase())
  .pipe(z.string().regex(/^(?:\d{6}|[a-z2-7]{10})$/));
export type TwoFactorCode = z.infer<typeof TwoFactorCode>;

export const TwoFactorChallengeInput = z.object({
  code: TwoFactorCode,
  /** Skip the challenge on this browser for 30 days. */
  rememberDevice: z.boolean().default(false),
});
export type TwoFactorChallengeInput = z.infer<typeof TwoFactorChallengeInput>;

/** Enrolment, disabling and new recovery codes all need a current code (TOTP only for enrolment). */
export const TwoFactorCodeInput = z.object({ code: TwoFactorCode });
export type TwoFactorCodeInput = z.infer<typeof TwoFactorCodeInput>;

/** What the security page and the challenge screen need to know. */
export const TwoFactorStatusDto = z.object({
  enabled: z.boolean(),
  /** Staff and admins must use 2FA and cannot turn it off. */
  required: z.boolean(),
  recoveryCodesLeft: z.number().int(),
});
export type TwoFactorStatusDto = z.infer<typeof TwoFactorStatusDto>;

export const Audience = z.enum(['api', 'realtime']);
export type Audience = z.infer<typeof Audience>;

export const AccessTokenDto = z.object({ token: z.string(), expiresAt: z.iso.datetime() });
export type AccessTokenDto = z.infer<typeof AccessTokenDto>;

/** `GET /v1/me` — who the access token belongs to. `agencyId` is null for users without an agency (staff). */
export const MeDto = z.object({
  userId: z.uuid(),
  agencyId: z.uuid().nullable(),
  sessionVersion: z.number().int(),
  tokenExpiresAt: z.iso.datetime(),
});
export type MeDto = z.infer<typeof MeDto>;

/** Dashboard areas a member may open (S1-10): the shell's navigation shows exactly these. */
export const DashboardSection = z.enum(['team', 'apiKeys', 'profile', 'settings', 'verification', 'preferredAgencies']);
export type DashboardSection = z.infer<typeof DashboardSection>;

/**
 * `GET /v1/me/capabilities` (S1-10): what the caller may do in their agency, computed by the module
 * policies — the dashboard shell derives its navigation from it and holds no rules of its own.
 */
export const MyCapabilitiesDto = z.object({
  role: MemberRole,
  clientMode: z.boolean(),
  /** A staff member is acting as this user (S1-09). */
  impersonating: z.boolean(),
  sections: z.array(DashboardSection),
});
export type MyCapabilitiesDto = z.infer<typeof MyCapabilitiesDto>;

/**
 * Invite link token (S1-02): the agency id (32 hex digits, no dashes) followed by the random part, so
 * the anonymous accept flow can pin its database scope to that agency before it looks the token up.
 */
export const InviteToken = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{32}[A-Za-z0-9_-]{32,96}$/);

/** Roles an admin hands out: their own family (agency or developer). PARTNER arrives in R4. */
export const InvitableRole = z.enum(['AGENCY_ADMIN', 'AGENT', 'DEVELOPER_ADMIN', 'DEVELOPER_AGENT']);
export type InvitableRole = z.infer<typeof InvitableRole>;

/** A member of the caller's agency (team list). */
export const MemberDto = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: MemberRole,
  status: z.enum(['ACTIVE', 'DEACTIVATED']),
  joinedAt: z.iso.datetime(),
});
export type MemberDto = z.infer<typeof MemberDto>;
export const MemberPage = pageOf(MemberDto);
export type MemberPage = z.infer<typeof MemberPage>;

export const MemberParams = z.object({ userId: z.uuid() });
export type MemberParams = z.infer<typeof MemberParams>;

/** `PUT /v1/members/:userId/role`. Admins only, never on their own membership. */
export const ChangeMemberRoleBody = z.object({ role: InvitableRole }).strict();
export type ChangeMemberRoleInput = z.infer<typeof ChangeMemberRoleBody> & MemberParams;

/**
 * `POST /v1/invites`: the invitee gets a 7-day, single-use link by email, in `locale` (default: the
 * inviter's request locale). Inviting the same email again replaces the open invite.
 */
export const InviteMemberBody = z.object({ email: Email, role: InvitableRole, locale: UiLocale.optional() }).strict();
export type InviteMemberInput = z.infer<typeof InviteMemberBody>;

export const InviteDto = z.object({
  id: z.uuid(),
  email: z.string(),
  role: MemberRole,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type InviteDto = z.infer<typeof InviteDto>;
export const InvitePage = pageOf(InviteDto);
export type InvitePage = z.infer<typeof InvitePage>;

export const InviteParams = z.object({ inviteId: z.uuid() });
export type InviteParams = z.infer<typeof InviteParams>;

/** Accepting an invite creates the account: the link proves the email, so it is confirmed at once. */
export const AcceptInviteInput = z.object({ token: InviteToken, name: PersonName, password: Password });
export type AcceptInviteInput = z.infer<typeof AcceptInviteInput>;
