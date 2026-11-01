import { z } from 'zod';
import { AGENCY_LOGO_TYPES, ContactPhone } from './agency-profile';
import { Email } from './identity';

/**
 * A member's published portal profile (S15-F10, PLAN §7 M14): opt-in. The member chooses the name shown, a photo, the
 * languages they speak and the phone / e-mail they publish; nothing else of theirs reaches the portal. Shown on
 * inmolink.es (`/{locale}/agent/{id}/{name}`, linked from the agency's profile) only while it is published and the
 * agency is verified and listed in the directory. Each member reads and edits only their own.
 */

/** Photo uploads: PNG, JPEG or WebP by magic bytes, ≤ 900 KB (inside the dashboard's 1 MB server-action body); the portal shows a re-encoded copy. */
export const MEMBER_PHOTO_TYPES = AGENCY_LOGO_TYPES;
export const MEMBER_PHOTO_MAX_BYTES = 900 * 1024;
export const MEMBER_PROFILE_MAX_LANGUAGES = 12;

/** The name the member publishes: 2–80 characters, no control characters or < >. */
export const MemberDisplayName = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[^\p{Cc}<>]*$/u, 'no control characters or < >');

const LocaleCode = z.string().regex(/^[a-z]{2}$/);

export const MemberPhotoDto = z.object({
  contentType: z.enum(MEMBER_PHOTO_TYPES),
});

export const MemberPublicProfileDto = z.object({
  /** The portal page id; null until the first save. */
  id: z.uuid().nullable(),
  published: z.boolean(),
  displayName: z.string(),
  /** Content locale codes the member speaks. */
  languages: z.array(z.string()),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  photo: MemberPhotoDto.nullable(),
  /** 0 until the first save. */
  version: z.number().int().nonnegative(),
});
export type MemberPublicProfileDto = z.infer<typeof MemberPublicProfileDto>;

/** `PUT /v1/me/public-profile` — replaces the member's own profile (optimistic `version`; 0 for the first save). */
export const UpdateMemberPublicProfileBody = z
  .object({
    version: z.number().int().nonnegative(),
    published: z.boolean(),
    displayName: MemberDisplayName,
    languages: z
      .array(LocaleCode)
      .max(MEMBER_PROFILE_MAX_LANGUAGES)
      .refine((v) => new Set(v).size === v.length, 'each language once'),
    phone: ContactPhone.nullable(),
    email: Email.nullable(),
  })
  .strict();
export type UpdateMemberPublicProfileBody = z.infer<typeof UpdateMemberPublicProfileBody>;
export type UpdateMemberPublicProfileInput = z.input<typeof UpdateMemberPublicProfileBody>;
