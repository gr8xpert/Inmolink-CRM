/** ai-features DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';
import { ContentLocaleCode } from './properties';

// ---- Listing Studio (S12-02, PLAN §8 #1, §3 #15) ----------------------------------------------------------------

/** Tone presets the agent picks; the prompt file says what each one means. */
export const LISTING_STUDIO_TONES = ['PROFESSIONAL', 'WARM', 'LUXURY', 'CONCISE', 'INVESTOR'] as const;
export const ListingStudioTone = z.enum(LISTING_STUDIO_TONES);
export type ListingStudioTone = z.infer<typeof ListingStudioTone>;

/** Listings per bulk request (one batch job; its payload stays under the 10 KB job cap). */
export const LISTING_STUDIO_BULK_MAX = 100;
/** Bulk batches one agency may have running at once (`LISTING_STUDIO_BATCH_LIMIT`). */
export const LISTING_STUDIO_RUNNING_MAX = 3;

const studioOptions = {
  tone: ListingStudioTone.default('PROFESSIONAL'),
  /** Content locales to write; default: every locale the agency has enabled. Each must be enabled. */
  locales: z
    .array(ContentLocaleCode)
    .min(1)
    .max(20)
    .refine((l) => new Set(l).size === l.length, 'duplicate locale')
    .optional(),
  /**
   * Also regenerate texts a person wrote or reviewed (HUMAN, REVIEWED) when they are not locked. Default: only
   * missing locales and earlier AI drafts. A locked locale is never overwritten.
   */
  replaceReviewed: z.boolean().default(false),
};

/** `POST /v1/listings/:id/studio`: AI drafts of title, description and SEO text for one listing (a worker job). */
export const ListingStudioBody = z.object(studioOptions).strict();
export type ListingStudioBody = z.infer<typeof ListingStudioBody>;

/** `POST /v1/listings/studio/bulk`: the same for many listings, as one discounted batch job. */
export const ListingStudioBulkBody = z
  .object({
    ...studioOptions,
    listingIds: z
      .array(z.uuid())
      .min(1)
      .max(LISTING_STUDIO_BULK_MAX)
      .refine((l) => new Set(l).size === l.length, 'duplicate listing'),
  })
  .strict();
export type ListingStudioBulkBody = z.infer<typeof ListingStudioBulkBody>;

/**
 * 202 of both: the job is queued. Drafts arrive as `AI_DRAFT` translations (the editor reloads the listing's
 * content); `skipped` are listings the caller may not edit (bulk only).
 */
export const ListingStudioAcceptedDto = z.object({
  requestId: z.uuid(),
  listings: z.number().int(),
  skipped: z.number().int(),
  locales: z.array(z.string()),
});
export type ListingStudioAcceptedDto = z.infer<typeof ListingStudioAcceptedDto>;

// ---- AI feature toggles (S13-F17, PLAN §8) ------------------------------------------------------------------------

/**
 * The AI features an agency switches on and off, one toggle each, every one off until an admin switches it on:
 * - `WEBSITE_SEARCH`: `/v2/search/ai` understands a visitor's sentence (off: it answers the keyword search).
 * - `WHITE_LABEL`: the white-label sanitizer's model pass (off: the deterministic pass only).
 * - `LISTING_STUDIO`: AI listing copy in the agency's main language (off: panel hidden, API `AI_NOT_ENABLED`).
 * - `SOCIAL_CAPTIONS`: AI captions for social posts (off: refused, captions typed by hand).
 * - `TRANSLATION_DRAFTS`: Listing Studio drafts in the agency's other languages (off: its main language only).
 * Every feature runs on the FAST tier (the cheapest configured model).
 */
export const AI_FEATURES = [
  'WEBSITE_SEARCH',
  'WHITE_LABEL',
  'LISTING_STUDIO',
  'SOCIAL_CAPTIONS',
  'TRANSLATION_DRAFTS',
] as const;
export const AiFeature = z.enum(AI_FEATURES);
export type AiFeature = z.infer<typeof AiFeature>;

/** `GET /v1/agency/ai-features`: each toggle (true: on). */
export const AgencyAiFeaturesDto = z.object({
  features: z.object({
    WEBSITE_SEARCH: z.boolean(),
    WHITE_LABEL: z.boolean(),
    LISTING_STUDIO: z.boolean(),
    SOCIAL_CAPTIONS: z.boolean(),
    TRANSLATION_DRAFTS: z.boolean(),
  }),
});
export type AgencyAiFeaturesDto = z.infer<typeof AgencyAiFeaturesDto>;

/** `PUT /v1/agency/ai-features/:feature`: switch one feature on or off (admins). */
export const AiFeatureParams = z.object({ feature: AiFeature });
export type AiFeatureParams = z.infer<typeof AiFeatureParams>;
export const SetAiFeatureBody = z.object({ enabled: z.boolean() });
export type SetAiFeatureBody = z.infer<typeof SetAiFeatureBody>;
