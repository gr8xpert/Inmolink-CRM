import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';
import { websiteSites } from './websites';

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
    // maintenance prune (S1-F4): where expires_at < ? or used_at < ? (BitmapOr of these two)
    index('auth_tokens_expires_idx').on(t.expiresAt),
    index('auth_tokens_used_idx').on(t.usedAt).where(sql`used_at is not null`),
  ],
);

/**
 * A user's agency and role. One agency per user (PLAN §3 #1): `user_id` is unique. STRICT tenant table;
 * the sign-up and invite-accept transactions (`app_auth`) create a member row and read a user's own
 * membership to mint access tokens (registry `auth` predicates). Role and deactivation change only
 * through an admin of the agency, never on their own row (guard trigger, migration 0008).
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
    /**
     * Team directory copy of the user's name and email: `users` is reachable only by `app_auth`, so
     * this is what the agency's own sessions list. Written when the member joins (S1-02).
     */
    name: text('name').notNull(),
    email: text('email').notNull(),
    /** Set by an admin: the user can no longer log in, mint tokens or reach tenant routes. */
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agencyId, t.userId] }),
    // access-token mint and request ctx: where user_id = ?
    uniqueIndex('agency_members_user_uq').on(t.userId),
    // team list: where agency_id = ? order by created_at, user_id (keyset)
    index('agency_members_agency_created_idx').on(t.agencyId, t.createdAt, t.userId),
  ],
);

/**
 * Invites to join an agency with a role (S1-02). STRICT tenant table. The link token is created by the
 * email job and only its HMAC is stored; the link also names the agency, so the anonymous accept flow
 * (`app_auth`) can pin its scope before it looks the token up. Single use (`accepted_at`), 7 days.
 */
export const agencyInvites = pgTable(
  'agency_invites',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    /** Trimmed and lower-cased by the contract; the account is created with this email. */
    email: text('email').notNull(),
    role: memberRoleEnum('role').notNull(),
    /** The admin who invited (audit; no FK, so removing that user keeps the history). */
    invitedBy: uuid('invited_by').notNull(),
    /** UI locale of the invite email and the new account. */
    locale: text('locale').notNull(),
    /** `hmacSha256(HMAC_KEY, 'invite-token', token)`; null until the email job sends the link. */
    tokenHash: text('token_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedUserId: uuid('accepted_user_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // accept: where token_hash = ? (agency pinned by RLS)
    uniqueIndex('agency_invites_token_uq').on(t.tokenHash),
    // one open invite per email and agency; re-inviting revokes the open one first
    uniqueIndex('agency_invites_open_email_uq')
      .on(t.agencyId, t.email)
      .where(sql`accepted_at is null and revoked_at is null`),
    // FK + open invites list: where agency_id = ? and open order by created_at, id (keyset)
    index('agency_invites_agency_created_idx').on(t.agencyId, t.createdAt, t.id),
  ],
);

/** Inmolink staff roles (PLAN §3 #2). Staff have no agency: their role lives here, not in `agency_members`. */
export const staffRoleEnum = pgEnum('staff_role', ['SUPER_ADMIN', 'STAFF_SUPPORT', 'STAFF_DATA_OPS']);

/**
 * Who is Inmolink staff (S1-03, ADR 0015). Global `access: 'staff'` table: granted by `pnpm staff:grant`
 * (`app_system`); `app_staff` reads only the row of the user it acts for (`app_is_staff()`, policy
 * `staff_self`); no other role reaches it. A staff user has no `agency_members` row, so their access token has no agency.
 */
export const staffUsers = pgTable('staff_users', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: staffRoleEnum('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set when staff access is withdrawn; `app_is_staff()` is then false at once. */
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
});

/** Longest impersonation session (S1-09); the CHECK below and the 0026 guard enforce it too. */
export const IMPERSONATION_MAX_MINUTES = 60;

/**
 * Staff impersonation sessions (S1-09, PLAN §7 M20, §12): a staff member acts as one member of an
 * agency, with a reason, for a bounded time. STRICT tenant table (the agency acted on): the request
 * `ctx` of an impersonated call reads its row (`app_user`, own agency) to check the session is still
 * open; the access-token mint (`app_auth`) reads the staff member's own rows; staff (`app_staff`) start
 * and end only their own. Tenants never write it (guard trigger, migration 0026). The reason stays here
 * (free text never goes into `audit_logs`).
 */
export const staffImpersonations = pgTable(
  'staff_impersonations',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when staff end it (or a newer session or `pnpm staff:revoke` replaces it); never reopened. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one open session per staff member: start ends the previous one first; mint + `GET /v1/staff/me`
    uniqueIndex('staff_impersonations_open_uq').on(t.staffUserId).where(sql`ended_at is null`),
    // FK + the agency's staff access list (S2-F1): where agency_id = ? order by the keyset time desc, id desc
    // (`keysetOrder`: `date_trunc('milliseconds', started_at, 'UTC')`); scanned backwards, no sort
    index('staff_impersonations_agency_idx').on(
      t.agencyId,
      sql`date_trunc('milliseconds', ${t.startedAt}, 'UTC')`,
      t.id,
    ),
    // S12-F20: raw keyset (`keysetAfterRaw`): the cursor is an index condition under RLS; replaces the one above
    index('staff_impersonations_agency_raw_idx').on(t.agencyId, t.startedAt, t.id),
    // FK + the staff member's history: where staff_user_id = ? order by started_at
    index('staff_impersonations_staff_idx').on(t.staffUserId, t.startedAt),
    // FK: removing a user
    index('staff_impersonations_target_idx').on(t.targetUserId),
    check('staff_impersonations_reason_ck', sql`char_length(${t.reason}) between 10 and 500`),
    check(
      'staff_impersonations_window_ck',
      sql`${t.expiresAt} > ${t.startedAt} and ${t.expiresAt} <= ${t.startedAt} + interval '60 minutes'`,
    ),
    check('staff_impersonations_ended_ck', sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`),
    check('staff_impersonations_not_self_ck', sql`${t.staffUserId} <> ${t.targetUserId}`),
  ],
);

/**
 * TOTP second factor (S1-04, PLAN §3 #30). Global `access: 'auth'` table, one row per user. The secret
 * is AES-256-GCM encrypted (platform/crypto keyring, AAD bound to this row). `confirmed_at` is null
 * while enrolment waits for the first code, and null again after 2FA is disabled. `last_used_step` is
 * the TOTP time step of the last accepted code: a code is accepted once (no replay within its window).
 */
export const userMfa = pgTable('user_mfa', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  totpSecret: text('totp_secret'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  /** Part of every "remember this browser" signature: bumping it forgets all remembered browsers (S1-F8). */
  deviceEpoch: integer('device_epoch').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Recovery codes (S1-04): 10 per enrolment, each usable once. Only an HMAC is stored. Regenerating or
 * disabling 2FA retires the open ones (`used_at`): `app_auth` never deletes.
 */
export const userRecoveryCodes = pgTable(
  'user_recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `hmacSha256(HMAC_KEY, 'recovery-code', normalised code)`. */
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK + consume (where user_id = ? and code_hash = ? and used_at is null) + count left
    index('user_recovery_codes_user_idx').on(t.userId, t.codeHash),
  ],
);

/** Website API keys (S1-05, PLAN §3 #30 §9.1): server-to-server secret keys and browser publishable keys. */
export const apiKeyKindEnum = pgEnum('api_key_kind', ['SECRET', 'PUBLISHABLE']);
/** Per-key request rate on the website API; the limits per tier live in identity `API_KEYS.RATE_TIERS`. */
export const apiKeyRateTierEnum = pgEnum('api_key_rate_tier', ['STANDARD', 'HIGH']);

/**
 * API keys (S1-05). Key format `inl_<env>_<prefix>_<secret>`: only the prefix (the lookup id, shown in
 * the dashboard) and `hmacSha256(HMAC_KEY, 'api-key', whole key)` are stored; the key itself is shown
 * once. PUBLIC_READ tenant table: feed-api (`app_public`) looks a key up by prefix before it knows the
 * tenant, and sees only usable keys (not revoked, agency verified). `agency_active` mirrors the agency's
 * status (set by the `identity.syncApiKeyAgencyStatus` job on `agencies.status.changed`), because
 * `app_public` cannot read `agencies`. `last_used_at` is written in batches by `identity.flushApiKeyUsage`.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: apiKeyKindEnum('kind').notNull(),
    /** `pk…`/`sk…` + random; changes on rotation. Not secret. */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    /** Contract `ApiKeyScope` values. */
    scopes: text('scopes').array().notNull(),
    /** Publishable keys only: normalised origins (`https://host[:port]`) allowed to use the key. */
    allowedOrigins: text('allowed_origins').array().notNull().default(sql`'{}'::text[]`),
    rateTier: apiKeyRateTierEnum('rate_tier').notNull().default('STANDARD'),
    /**
     * The website the key serves (S7-01): its inventory policy, prefix, locales and contacts. Set at creation and
     * never changed (guard trigger); null only for keys created before sites existed — the website API v2 refuses them.
     */
    siteId: uuid('site_id'),
    agencyActive: boolean('agency_active').notNull().default(true),
    /**
     * S8-02: a key migrated from legacy Inmolink, which legacy websites send as the `api_key` query parameter of the v1
     * shim (`/v1/*` only). Every other key is refused there. Set by the legacy key import / `pnpm legacy:key-flag`
     * (`app_system`), never by a dashboard path.
     */
    legacyQueryKey: boolean('legacy_query_key').notNull().default(false),
    /** The admin who created the key (audit; no FK, so removing that user keeps the history). */
    createdBy: uuid('created_by').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // website API auth (feed-api, cached): where prefix = ?
    uniqueIndex('api_keys_prefix_uq').on(t.prefix),
    // FK + dashboard list: where agency_id = ? order by created_at, id (keyset); active-key count
    index('api_keys_agency_created_idx').on(t.agencyId, t.createdAt, t.id),
    // FK: a key's site belongs to the key's agency
    index('api_keys_site_idx').on(t.siteId),
    foreignKey({
      name: 'api_keys_site_fk',
      columns: [t.agencyId, t.siteId],
      foreignColumns: [websiteSites.agencyId, websiteSites.id],
      // Not cascade: a cascade runs as the owner and would delete keys past the guard (keys are revoked, never
      // deleted). An agency's deletion removes both in one statement, which NO ACTION allows.
    }).onDelete('no action'),
  ],
);
