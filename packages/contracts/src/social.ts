import { z } from 'zod';

/**
 * Social posting DTOs (S12-07, PLAN §3 #58, §7 M25): an agency connects its Facebook Pages and Instagram Business
 * accounts (Meta OAuth), composes a post from a listing (image or carousel), gets AI captions per language, schedules
 * it and sees the history with errors. Behind the `social.posting` feature flag; real Meta access waits on H3.
 */

export const SOCIAL_PLATFORMS = ['FACEBOOK_PAGE', 'INSTAGRAM_BUSINESS'] as const;
export const SocialPlatform = z.enum(SOCIAL_PLATFORMS);
export type SocialPlatform = z.infer<typeof SocialPlatform>;

/** ACTIVE: posts publish · NEEDS_RECONNECT: its token expired or was revoked — connect it again (posts wait). */
export const SOCIAL_ACCOUNT_STATUSES = ['ACTIVE', 'NEEDS_RECONNECT'] as const;
export const SocialAccountStatus = z.enum(SOCIAL_ACCOUNT_STATUSES);
export type SocialAccountStatus = z.infer<typeof SocialAccountStatus>;

/**
 * DRAFT: not scheduled · SCHEDULED: publishes at `scheduledAt` · PUBLISHING: being published (claimed) ·
 * PUBLISHED · FAILED: see `error` · CANCELLED.
 */
export const SOCIAL_POST_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED'] as const;
export const SocialPostStatus = z.enum(SOCIAL_POST_STATUSES);
export type SocialPostStatus = z.infer<typeof SocialPostStatus>;

/** NONE: never asked · PENDING: the AI job runs · READY · FAILED: write the caption by hand. */
export const SOCIAL_CAPTION_STATUSES = ['NONE', 'PENDING', 'READY', 'FAILED'] as const;
export const SocialCaptionStatus = z.enum(SOCIAL_CAPTION_STATUSES);

export const SOCIAL_LIMITS = {
  /** Images of one post: Instagram's carousel maximum. */
  maxImages: 10,
  /** Instagram's caption limit (Facebook allows more; one limit for both). */
  captionChars: 2_200,
  /** Languages one caption request drafts. */
  captionLocales: 5,
  /** How far ahead a post may be scheduled. */
  maxScheduleDays: 75,
} as const;

export const SocialAccountDto = z.object({
  id: z.uuid(),
  platform: SocialPlatform,
  /** The Page's or Instagram account's own id at Meta. */
  externalId: z.string(),
  name: z.string(),
  status: SocialAccountStatus,
  /** Why it needs reconnecting (`TOKEN_EXPIRED`, `TOKEN_REVOKED`), null when ACTIVE. */
  statusReason: z.string().nullable(),
  /** When its access expires (null: no expiry known). */
  tokenExpiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SocialAccountDto = z.infer<typeof SocialAccountDto>;

export const SocialAccountList = z.object({ items: z.array(SocialAccountDto) });
export type SocialAccountList = z.infer<typeof SocialAccountList>;

export const SocialAccountParams = z.object({ accountId: z.uuid() }).strict();

/** `POST /v1/social/connect`: where to send the member (Meta's login dialog, with a signed `state`). */
export const StartSocialConnectDto = z.object({ url: z.string().url() });
export type StartSocialConnectDto = z.infer<typeof StartSocialConnectDto>;

/** `POST /v1/social/connect/callback`: what Meta sent back to the web app's callback. */
export const CompleteSocialConnectBody = z
  .object({ code: z.string().min(1).max(2_000), state: z.string().min(1).max(2_000) })
  .strict();
export type CompleteSocialConnectBody = z.infer<typeof CompleteSocialConnectBody>;

const Locale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const Caption = z.string().trim().max(SOCIAL_LIMITS.captionChars);

export const SocialCaptionDto = z.object({
  locale: z.string(),
  text: z.string(),
  /** AI_DRAFT: drafted by the model (captions may publish as drafted, PLAN §3 #58) · HUMAN: typed or edited. */
  origin: z.enum(['AI_DRAFT', 'HUMAN']),
});
export type SocialCaptionDto = z.infer<typeof SocialCaptionDto>;

export const SocialPostDto = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  platform: SocialPlatform,
  listingId: z.uuid(),
  status: SocialPostStatus,
  /** The caption that publishes, in `locale`. */
  locale: z.string(),
  caption: z.string().nullable(),
  /** AI drafts and the typed caption, per language. */
  captions: z.array(SocialCaptionDto),
  captionStatus: SocialCaptionStatus,
  /** The listing's images, in order (one: an image post; several: a carousel). */
  mediaIds: z.array(z.uuid()),
  scheduledAt: z.iso.datetime().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  /** The post's id at Meta once published. */
  externalPostId: z.string().nullable(),
  attempts: z.number().int(),
  /** Why the last attempt failed (code and Meta's message). */
  error: z.object({ code: z.string(), message: z.string().nullable() }).nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SocialPostDto = z.infer<typeof SocialPostDto>;

export const SocialPostPage = z.object({ items: z.array(SocialPostDto), nextCursor: z.string().nullable() });
export type SocialPostPage = z.infer<typeof SocialPostPage>;

export const ListSocialPostsQuery = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: SocialPostStatus.optional(),
  })
  .strict();
export type ListSocialPostsQuery = z.infer<typeof ListSocialPostsQuery>;

export const SocialPostParams = z.object({ postId: z.uuid() }).strict();

/**
 * `POST /v1/social/posts`: a post of one listing to one account. No `scheduledAt`: a DRAFT. No `mediaIds`: the cover
 * and the next images (up to the maximum). `captionLocales`: AI drafts are requested at once.
 */
export const CreateSocialPostBody = z
  .object({
    accountId: z.uuid(),
    listingId: z.uuid(),
    mediaIds: z.array(z.uuid()).min(1).max(SOCIAL_LIMITS.maxImages).optional(),
    locale: Locale,
    caption: Caption.nullable().optional(),
    scheduledAt: z.iso.datetime().nullable().optional(),
    captionLocales: z.array(Locale).min(1).max(SOCIAL_LIMITS.captionLocales).optional(),
  })
  .strict();
export type CreateSocialPostBody = z.infer<typeof CreateSocialPostBody>;

/** `PATCH /v1/social/posts/:postId`: DRAFT and SCHEDULED posts only, on the version read. `scheduledAt: null` unschedules. */
export const UpdateSocialPostBody = z
  .object({
    version: z.number().int().min(1),
    mediaIds: z.array(z.uuid()).min(1).max(SOCIAL_LIMITS.maxImages).optional(),
    locale: Locale.optional(),
    caption: Caption.nullable().optional(),
    scheduledAt: z.iso.datetime().nullable().optional(),
  })
  .strict();
export type UpdateSocialPostBody = z.infer<typeof UpdateSocialPostBody>;

/** `POST /v1/social/posts/:postId/captions`: AI drafts in these languages (a worker job; the post shows PENDING). */
export const RequestSocialCaptionsBody = z
  .object({ version: z.number().int().min(1), locales: z.array(Locale).min(1).max(SOCIAL_LIMITS.captionLocales) })
  .strict();
export type RequestSocialCaptionsBody = z.infer<typeof RequestSocialCaptionsBody>;

export const SocialVersionBody = z.object({ version: z.number().int().min(1) }).strict();
