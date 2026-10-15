/** media DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';

/**
 * Listing media upload (S3-03, PLAN §3 #33). The browser hashes each file (SHA-256) and asks which hashes the
 * platform already stores; only unknown ones are uploaded, straight to object storage with a signed PUT bound
 * to the file's exact size and hash; then it registers the files on a listing.
 */

/** Largest original accepted (a 48 MP PNG fits; a 12 MP JPEG is ~5 MB). */
export const MEDIA_MAX_BYTES = 40 * 1024 * 1024;
/** Files per check or register call. */
export const MEDIA_BATCH_MAX = 100;
/** Media rows one listing may have. */
export const MEDIA_PER_LISTING_MAX = 100;
/** Image types accepted as originals, detected by magic bytes (HEIC is converted by the media worker, S3-04). */
export const MEDIA_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
/** How long a signed upload URL works. */
export const MEDIA_UPLOAD_URL_TTL_SECONDS = 900;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex SHA-256');
export const MediaUploadType = z.enum(MEDIA_UPLOAD_TYPES);
/** Kinds a listing's media rows take from uploads (videos and documents arrive with their own tasks). */
export const ListingMediaKind = z.enum(['IMAGE', 'FLOOR_PLAN']);
export type ListingMediaKind = z.infer<typeof ListingMediaKind>;

const uniqueHashes = (files: { sha256: string }[]) => new Set(files.map((f) => f.sha256)).size === files.length;

export const MediaCheckBody = z
  .object({
    files: z
      .array(
        z
          .object({
            sha256: Sha256Hex,
            sizeBytes: z.number().int().min(1).max(MEDIA_MAX_BYTES),
            /** What the browser believes the file is; the stored bytes decide at register. */
            contentType: MediaUploadType,
          })
          .strict(),
      )
      .min(1)
      .max(MEDIA_BATCH_MAX)
      .refine(uniqueHashes, 'each file once'),
  })
  .strict();
export type MediaCheckBody = z.infer<typeof MediaCheckBody>;

export const MediaUpload = z.object({
  url: z.string(),
  method: z.literal('PUT'),
  /** Send exactly these headers with the PUT: they are signed (type, length, checksum). */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type MediaUpload = z.infer<typeof MediaUpload>;

/** One entry per requested file, in order: STORED needs no upload (zero bytes sent); UPLOAD carries the URL. */
export const MediaCheckResult = z.object({
  files: z.array(
    z.object({
      sha256: Sha256Hex,
      status: z.enum(['STORED', 'UPLOAD']),
      upload: MediaUpload.nullable(),
    }),
  ),
});
export type MediaCheckResult = z.infer<typeof MediaCheckResult>;

export const RegisterMediaBody = z
  .object({
    listingId: z.uuid(),
    /** Insert the files here (0 = first); default: after the listing's last one. */
    position: z.number().int().min(0).max(MEDIA_PER_LISTING_MAX).optional(),
    files: z
      .array(
        z
          .object({
            sha256: Sha256Hex,
            kind: ListingMediaKind.default('IMAGE'),
            /** Make this image the listing's cover. */
            cover: z.boolean().optional(),
            altText: z.string().trim().min(1).max(300).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MEDIA_BATCH_MAX)
      .refine(uniqueHashes, 'each file once')
      .refine((files) => files.filter((f) => f.cover).length <= 1, 'at most one cover')
      .refine((files) => files.every((f) => !f.cover || f.kind === 'IMAGE'), 'only an image can be the cover'),
  })
  .strict();
export type RegisterMediaBody = z.infer<typeof RegisterMediaBody>;

export const ListingMediaDto = z.object({
  id: z.uuid(),
  sha256: Sha256Hex,
  kind: z.enum(['IMAGE', 'FLOOR_PLAN', 'VIDEO', 'DOCUMENT']),
  position: z.number().int(),
  isCover: z.boolean(),
  altText: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type ListingMediaDto = z.infer<typeof ListingMediaDto>;

/** A listing's media in order (at most `MEDIA_PER_LISTING_MAX`, so never paginated). */
export const ListingMediaList = z.object({ items: z.array(ListingMediaDto) });
export type ListingMediaList = z.infer<typeof ListingMediaList>;

export const ListingMediaParams = z.object({ id: z.uuid(), mediaId: z.uuid() }).strict();
export type ListingMediaParams = z.infer<typeof ListingMediaParams>;
