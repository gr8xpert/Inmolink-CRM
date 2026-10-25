/**
 * Tables owned by the social module (S12-07, PATTERNS §2, PLAN §7 M25). Only `packages/core/src/modules/social`
 * imports this file (`pnpm check:boundaries`).
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';
import { properties } from './properties';

export const socialPlatformEnum = pgEnum('social_platform', ['FACEBOOK_PAGE', 'INSTAGRAM_BUSINESS']);
export const socialAccountStatusEnum = pgEnum('social_account_status', ['ACTIVE', 'NEEDS_RECONNECT']);
export const socialPostStatusEnum = pgEnum('social_post_status', [
  'DRAFT',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'CANCELLED',
]);
export const socialCaptionStatusEnum = pgEnum('social_caption_status', ['NONE', 'PENDING', 'READY', 'FAILED']);

/**
 * An agency's connected Facebook Page or Instagram Business account (S12-07). Its Page access token and the
 * long-lived user token it came from (refreshed by the worker before it expires) are `platform/crypto` envelopes bound
 * to (agency, table, column, row), never returned and hidden from `app_user` (it only writes them, when connecting).
 * NEEDS_RECONNECT: the token expired or was revoked (`status_reason`); posts to it fail until it is connected again.
 */
export const socialAccounts = pgTable(
  'social_accounts',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    platform: socialPlatformEnum('platform').notNull(),
    /** The Page's or Instagram account's id at Meta. */
    externalId: text('external_id').notNull(),
    /** Instagram: the Facebook Page it is published through (its Page token publishes). Null for a Page. */
    pageId: text('page_id'),
    name: text('name').notNull(),
    /** `platform/crypto` envelope of the Page access token. */
    tokenEnc: text('token_enc').notNull(),
    /** `platform/crypto` envelope of the long-lived user token (to refresh the Page token); null: none kept. */
    userTokenEnc: text('user_token_enc'),
    /**
     * S13-F5: the Meta user whose login connected it (app-scoped id from `GET /me`): the app's grant at Meta is revoked
     * only when the last non-disconnected account of that user, in any agency, goes. Null: connected before S13-F5 (never
     * revoked). Hidden from `app_user` like the tokens.
     */
    metaUserId: text('meta_user_id'),
    /** When the user token expires (Meta's `expires_in`); null: unknown or never. */
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    status: socialAccountStatusEnum('status').notNull().default('ACTIVE'),
    statusReason: text('status_reason'),
    /** When the worker last checked or refreshed the token. */
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    connectedBy: uuid('connected_by').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // reconnecting the same Page or account updates its row: where agency_id = ? and platform = ? and external_id = ?
    unique('social_accounts_external_uq').on(t.agencyId, t.platform, t.externalId),
    // target of the posts' composite FK: a post's account belongs to its agency
    unique('social_accounts_agency_id_uq').on(t.agencyId, t.id),
    // the dashboard list: where agency_id = ? order by created_at, id
    index('social_accounts_agency_created_idx').on(t.agencyId, t.createdAt, t.id),
    // the token check sweep: where status = 'ACTIVE' order by token_expires_at
    index('social_accounts_expiry_idx').on(t.tokenExpiresAt).where(sql`${t.status} = 'ACTIVE'`),
    // S13-F5: the revoke job's check across agencies: where meta_user_id = ? and status_reason is distinct from ?
    index('social_accounts_meta_user_idx').on(t.metaUserId).where(sql`${t.metaUserId} is not null`),
    check('social_accounts_external_ck', sql`length(${t.externalId}) between 1 and 64`),
    check('social_accounts_meta_user_ck', sql`${t.metaUserId} is null or length(${t.metaUserId}) between 1 and 64`),
    check('social_accounts_name_ck', sql`length(${t.name}) between 1 and 200`),
  ],
);

/**
 * A post of one listing to one social account (S12-07): its images (listing media ids, in order), the caption that
 * publishes (`locale`, `caption`) and the AI drafts per language (`captions`, JSON: AI output), the schedule and the
 * history of its publishing — attempts, the last error, the post's id at Meta. Published once: the sweep claims a due
 * post (SCHEDULED → PUBLISHING, `claimed_at`), the publish job marks `publish_started_at` before calling Meta, and a
 * job that finds it set without an outcome fails the post as `OUTCOME_UNKNOWN` instead of posting again.
 */
export const socialPosts = pgTable(
  'social_posts',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    status: socialPostStatusEnum('status').notNull().default('DRAFT'),
    locale: text('locale').notNull(),
    caption: text('caption'),
    /** `[{ locale, text, origin: 'AI_DRAFT' | 'HUMAN' }]`. */
    captions: jsonb('captions')
      .$type<{ locale: string; text: string; origin: 'AI_DRAFT' | 'HUMAN' }[]>()
      .notNull()
      .default([]),
    captionStatus: socialCaptionStatusEnum('caption_status').notNull().default('NONE'),
    /** The caption request the AI job answers (a newer request makes an older job's answer stale). */
    captionRequestId: uuid('caption_request_id'),
    mediaIds: uuid('media_ids').array().notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    publishStartedAt: timestamp('publish_started_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    externalPostId: text('external_post_id'),
    attempts: integer('attempts').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdBy: uuid('created_by').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.agencyId, t.accountId],
      foreignColumns: [socialAccounts.agencyId, socialAccounts.id],
      name: 'social_posts_account_fk',
    }).onDelete('cascade'),
    // the history: where agency_id = ? order by created_at desc, id desc
    index('social_posts_agency_created_idx').on(t.agencyId, t.createdAt, t.id),
    // FKs
    index('social_posts_account_idx').on(t.accountId),
    index('social_posts_listing_idx').on(t.listingId),
    // the publish sweep: where status = 'SCHEDULED' and scheduled_at <= now() order by scheduled_at
    index('social_posts_due_idx').on(t.scheduledAt).where(sql`${t.status} = 'SCHEDULED'`),
    // S13-F9, the retention prune: where status in ('PUBLISHED', 'FAILED') and updated_at < ? limit ?
    index('social_posts_finished_idx').on(t.updatedAt).where(sql`${t.status} in ('PUBLISHED', 'FAILED')`),
    check('social_posts_media_ck', sql`cardinality(${t.mediaIds}) between 1 and 10`),
    check('social_posts_caption_ck', sql`${t.caption} is null or length(${t.caption}) <= 2200`),
    check('social_posts_scheduled_ck', sql`${t.status} <> 'SCHEDULED' or ${t.scheduledAt} is not null`),
    check(
      'social_posts_captions_ck',
      sql`jsonb_typeof(${t.captions}) = 'array' and octet_length(${t.captions}::text) <= 32768`,
    ),
  ],
);
