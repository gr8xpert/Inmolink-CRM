import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/**
 * Login identity (PLAN §3 #30 #31, S0-09). Global tables with `access: 'auth'`: looked up by email
 * before any tenant is known, so only `app_auth` (`withAuth()`) and `app_system` reach them — never
 * `app_user`, which would expose password hashes to every tenant session. Agency membership and role
 * live in `agency_members` (STRICT).
 */
export const userStatusEnum = pgEnum('user_status', ['ACTIVE', 'DISABLED']);
/** Tenant roles (PLAN §3 #2). Staff roles are not memberships (S1-09). */
export const memberRoleEnum = pgEnum('member_role', [
  'AGENCY_ADMIN',
  'AGENT',
  'DEVELOPER_ADMIN',
  'DEVELOPER_AGENT',
  'PARTNER',
]);
export const authTokenKindEnum = pgEnum('auth_token_kind', ['EMAIL_VERIFY', 'PASSWORD_RESET']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    /** Trimmed and lower-cased by the identity module; unique. */
    email: text('email').notNull(),
    /** Argon2id (platform/crypto/password). Never selected outside credential checks. */
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    /** UI locale for emails and the dashboard. */
    locale: text('locale').notNull(),
    status: userStatusEnum('status').notNull().default('ACTIVE'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** Bumped on password reset (and later: logout everywhere, deactivation); access tokens carry it. */
    sessionVersion: integer('session_version').notNull().default(1),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // login, sign-up and reset requests: where email = ?
    uniqueIndex('users_email_uq').on(t.email),
  ],
);

/** Single-use tokens for email links. Only an HMAC of the token is stored. */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: authTokenKindEnum('kind').notNull(),
    /** `hmacSha256(HMAC_KEY, 'auth-token', token)`. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // consume: where token_hash = ? and kind = ?
    uniqueIndex('auth_tokens_hash_uq').on(t.tokenHash),
    // FK + "retire older unused tokens of this kind" on issue
    index('auth_tokens_user_kind_idx').on(t.userId, t.kind).where(sql`used_at is null`),
  ],
);

/**
 * A user's agency and role. One agency per user (PLAN §3 #1): `user_id` is unique. STRICT tenant table;
 * the sign-up transaction (`app_auth`) may create the founding admin's row and read a user's own
 * membership to mint access tokens (registry `auth` predicates).
 */
export const agencyMembers = pgTable(
  'agency_members',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agencyId, t.userId] }),
    // access-token mint and request ctx: where user_id = ?
    uniqueIndex('agency_members_user_uq').on(t.userId),
  ],
);
